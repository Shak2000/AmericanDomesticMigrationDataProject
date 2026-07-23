"""
scripts/convert_legacy_xls_data.py — Milestone 11.5

Pre-2004-05 IRS migration data is not published as flat per-direction CSVs.
Instead it ships as a ZIP archive containing one .xls workbook per state:

  State files  (2003to2004statemigration.zip):
    One workbook per destination state (inflow) or origin state (outflow),
    e.g. "Cali04in.xls" / "cali04ot.xls". The fixed state is named in a
    header cell ("TO: 06-CALIFORNIA" / "FROM: 06-CALIFORNIA"); each data row
    gives the *other* state's FIPS code, postal abbreviation, name, and the
    three migration counts.

  County files (2003to2004countymigration.zip):
    One workbook per state, e.g. "co0304NYi.xls" / "co0304NYo.xls". Unlike
    the state files, every row already carries both origin and destination
    state+county FIPS codes directly (no header-derived FIPS needed), in the
    exact column order the standard raw CSV schema expects.

This script downloads and parses both ZIPs for a given year tag and writes
out data/original/{state,county}_{inflow,outflow}/*{year}.csv in the same
"legacy" raw schema already produced by later years' CSVs (State_Code_Dest,
County_Code_Dest, State_Code_Origin, County_Code_Origin, State_Abbrv,
State_Name/County_Name, Return_Num, Exmpt_Num, Aggr_AGI) — so the existing
enrich_state_data.py / enrich_county_data.py pipelines handle them unchanged.

Usage
-----
    python scripts/convert_legacy_xls_data.py <year_tag>   # e.g. 0304
"""

import csv
import io
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

import xlrd

BASE_URL = "https://www.irs.gov/pub/irs-soi"

# Zip filenames per supported legacy year tag.
LEGACY_ZIPS: dict[str, dict[str, str]] = {
    "0304": {
        "state": "2003to2004statemigration.zip",
        "county": "2003to2004countymigration.zip",
    },
    "0203": {
        "state": "2002to2003statemigration.zip",
        "county": "2002to2003countymigration.zip",
    },
    "0102": {
        "state": "2001to2002statemigration.zip",
        "county": "2001to2002countymigration.zip",
    },
    "0001": {
        "state": "2000to2001statemigration.zip",
        "county": "2000to2001countymigration.zip",
    },
    "9900": {
        "state": "1999to2000statemigration.zip",
        "county": "1999to2000countymigration.zip",
    },
    "9899": {
        "state": "1998to1999statemigration.zip",
        "county": "1998to1999countymigration.zip",
    },
    "9798": {
        "state": "1997to1998statemigration.zip",
        "county": "1997to1998countymigration.zip",
    },
    "9697": {
        "state": "1996to1997statemigration.zip",
        "county": "1996to1997countymigration.zip",
    },
    "9596": {
        "state": "1995to1996statemigration.zip",
        "county": "1995to1996countymigration.zip",
    },
    "9495": {
        "state": "1994to1995statemigration.zip",
        "county": "1994to1995countymigration.zip",
    },
    "9394": {
        "state": "1993to1994statemigration.zip",
        "county": "1993to1994countymigration.zip",
    },
    "9293": {
        "state": "1992to1993statemigration.zip",
        "county": "1992to1993countymigration.zip",
    },
    "9192": {
        "state": "1991to1992statemigration.zip",
        "county": "1991to1992countymigration.zip",
    },
    "9091": {
        "state": "1990to1991statemigration.zip",
        "county": "1990to1991countymigration.zip",
    },
}

# 1991-92 and 1990-91 predate AGI reporting entirely — neither the state nor
# county source files have an income column, only returns/exemptions plus two
# "percent of migrants" columns. State files are still .xls but 7 columns
# instead of 6; county files are plain fixed-width .txt, not .xls at all.
# AGI is written out as "0" for these years — see YEARS_WITHOUT_AGI in
# script.js for how the app hides AGI-based views for them.
LEGACY_7COL_STATE_YEARS = {"9192", "9091"}
LEGACY_TXT_COUNTY_YEARS = {"9192", "9091"}

# The "TO: NN-STATE" / "FROM: NN-STATE" label is sometimes one cell, sometimes
# split across two or three cells (e.g. ['FROM:', '', '21-KENTUCKY']) —
# depends on the year/file. Join the whole header row before matching.
TO_FROM_RE = re.compile(r"(TO|FROM):\s*(\d+)-", re.IGNORECASE)


def fetch_zip(url: str) -> zipfile.ZipFile:
    print(f"  Downloading {url} …")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    return zipfile.ZipFile(io.BytesIO(data))


def cell_fips(value, width: int) -> str:
    """Format a FIPS cell (may arrive as float, int, or already-padded string)."""
    if isinstance(value, float):
        value = int(value)
    return str(value).strip().zfill(width)


def cell_int(value) -> str:
    if isinstance(value, float):
        value = int(round(value))
    return str(value)


# ---------------------------------------------------------------------------
# State workbooks
# ---------------------------------------------------------------------------
def find_state_header_row(sh) -> int:
    """
    Locate the "TO:"/"FROM:" header row. Normally row 3, but at least one
    file (Alaska, 1995-96 outflow) has several extra blank rows inserted
    above it, shifting everything down — scan instead of assuming a constant.
    """
    for r in range(sh.nrows):
        row_upper = " ".join(str(v) for v in sh.row_values(r)).upper()
        if "TO:" in row_upper or "FROM:" in row_upper:
            return r
    raise ValueError("Could not locate TO:/FROM: header row")


def find_state_data_start(sh) -> int:
    """Locate the first data row by scanning for the first numeric Return_Num
    column (index 3) — mirrors find_county_data_start's approach, since the
    header block length isn't reliably a fixed number of rows across files."""
    for r in range(sh.nrows):
        if sh.cell_type(r, 3) == xlrd.XL_CELL_NUMBER:
            return r
    raise ValueError("Could not locate data start row (no numeric Return_Num column found)")


def parse_state_workbook(raw_bytes: bytes) -> tuple[str, str, list[dict]]:
    """Return (direction, fixed_fips, rows) for one state workbook."""
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    sh = wb.sheet_by_index(0)

    header_r = find_state_header_row(sh)
    data_start = find_state_data_start(sh)
    header_row = " ".join(str(v) for v in sh.row_values(header_r))
    m = TO_FROM_RE.search(header_row)
    header_upper = header_row.upper()
    if "FROM" in header_upper:
        direction = "outflow"
    elif "TO" in header_upper:
        direction = "inflow"
    elif m:
        direction = "inflow" if m.group(1).upper() == "TO" else "outflow"
    else:
        raise ValueError(f"Could not parse header row: {header_row!r}")

    # The state's own FIPS is read from its self-referential row (a
    # "Non-Migrants" row, or — in years using the "Total Inflow"/"Total
    # Outflow" aggregate convention — that row itself, which is always
    # self-to-self) rather than trusting the header text, which has been
    # wrong more than once: some files omit the "TO: NN-STATE" FIPS entirely
    # (e.g. New Hampshire, 1998-99 outflow), at least one has a stale
    # copy-pasted FIPS from a different state's template (New Jersey,
    # 1997-98 inflow: header reads "TO: 12-FLORIDA 34-NEW JERSEY" — 12 is
    # Florida's FIPS, not New Jersey's), and at least one state simply lacks
    # a "Non-Migrants" row at all (Alaska, 1993-94 outflow — only its "Total
    # Outflow" row is present). A self-referential row can't be corrupted by
    # any of these, so it's the authoritative source whenever one exists.
    fixed_fips = None
    for r in range(data_start, sh.nrows):
        row_vals = sh.row_values(r)
        if len(row_vals) <= 2:
            continue
        name_lower = str(row_vals[2]).lower()
        if "non-migrant" in name_lower or name_lower in ("total inflow", "total outflow"):
            fixed_fips = cell_fips(row_vals[0], 2)
            break
    if fixed_fips is None:
        if not m:
            raise ValueError(f"Could not recover FIPS for headerless workbook (no self-referential row found)")
        fixed_fips = m.group(2).zfill(2)

    rows = []
    for r in range(data_start, sh.nrows):
        row_vals = sh.row_values(r)
        if not any(str(v).strip() for v in row_vals):
            continue
        other_fips = cell_fips(row_vals[0], 2)
        abbrv = str(row_vals[1]).strip()
        name = str(row_vals[2]).strip()
        n1 = cell_int(row_vals[3])
        n2 = cell_int(row_vals[4])
        agi = cell_int(row_vals[5])

        # 1994-95 uses a different aggregation convention than every other
        # year: instead of separate "Total Mig - US & For" / "US" / "Foreign"
        # rows keyed by the standard 96/97/98 codes, there's a single lump
        # "Total Inflow"/"Total Outflow" row, self-referential (origin FIPS
        # == the state's own FIPS) rather than using an aggregate code at
        # all. Left as-is, downstream enrichment would misread it as a
        # "Non-Migrants" row (same-FIPS check) and the app would never see
        # any "Total Migration-US and Foreign" label — the default Population
        # metric would be blank for every state this year. Rewrite it to the
        # standard 96 aggregate code; enrich_state_data.py's FIPS-based
        # lookup then labels it correctly on its own.
        if other_fips == fixed_fips and name.lower() in ("total inflow", "total outflow"):
            other_fips = "96"

        # 1992-93 uses yet another aggregate marker for the same kind of row:
        # origin FIPS "63" with abbreviation "XX" (real FIPS codes never
        # exceed 56, so this pair is unambiguous), name equal to the state's
        # own name rather than "Total Inflow"/"Total Outflow". Same fix.
        if other_fips == "63" and abbrv.upper() == "XX":
            other_fips = "96"

        if direction == "inflow":
            rows.append({
                "State_Code_Dest": fixed_fips, "County_Code_Dest": "000",
                "State_Code_Origin": other_fips, "County_Code_Origin": "000",
                "State_Abbrv": abbrv, "State_Name": name,
                "Return_Num": n1, "Exmpt_Num": n2, "Aggr_AGI": agi,
            })
        else:
            rows.append({
                "State_Code_Origin": fixed_fips, "County_Code_Origin": "000",
                "State_Code_Dest": other_fips, "County_Code_Dest": "000",
                "State_Abbrv": abbrv, "State_Name": name,
                "Return_Num": n1, "Exmpt_Num": n2, "Aggr_AGI": agi,
            })

    return direction, fixed_fips, rows


def parse_state_workbook_legacy7col(raw_bytes: bytes) -> tuple[str, str, list[dict]]:
    """
    Parse the pre-1992-93 7-column state format (1991-92, 1990-91): columns
    are [fips, abbrv, name, returns, pct_of_migrants_returns, exemptions,
    pct_of_migrants_exemptions] — no AGI column at all. Return_Num is
    normally at index 3, but at least one file (Alabama, 1990-91 outflow)
    has a duplicated abbreviation column shifting everything right by one —
    detect the actual column instead of assuming a fixed index.

    Unlike parse_state_workbook, the header reliably includes the FIPS
    directly in every file across both years (e.g. "FROM: 39-Ohio") — no
    Non-Migrants-row fallback needed. The aggregate row already uses the
    standard 96 marker directly (e.g. [96.0, '', 'TOTAL FLOW', ...]), so no
    aggregate-code rewrite is needed either.
    """
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    sh = wb.sheet_by_index(0)

    header_r = find_state_header_row(sh)
    header_row = " ".join(str(v) for v in sh.row_values(header_r))
    m = TO_FROM_RE.search(header_row)
    if not m:
        raise ValueError(f"Could not parse header row: {header_row!r}")
    direction = "inflow" if m.group(1).upper() == "TO" else "outflow"
    fixed_fips = m.group(2).zfill(2)

    returns_col = data_start = None
    for candidate_col in (3, 4):
        for r in range(header_r, sh.nrows):
            if sh.cell_type(r, candidate_col) == xlrd.XL_CELL_NUMBER:
                returns_col, data_start = candidate_col, r
                break
        if returns_col is not None:
            break
    if returns_col is None:
        raise ValueError("Could not locate Return_Num column")
    name_col = returns_col - 1
    exempt_col = returns_col + 2  # returns_col+1 is a percent — discard

    rows = []
    for r in range(data_start, sh.nrows):
        # Trailing footer text ("SOURCE: INTERNAL REVENUE SERVICE", etc.) is
        # non-blank, so a blank-row check alone won't skip it — require a
        # genuinely numeric Return_Num instead.
        if sh.cell_type(r, returns_col) != xlrd.XL_CELL_NUMBER:
            continue
        row_vals = sh.row_values(r)
        other_fips = cell_fips(row_vals[0], 2)
        abbrv = str(row_vals[1]).strip()
        name = str(row_vals[name_col]).strip()
        n1 = cell_int(row_vals[returns_col])
        n2 = cell_int(row_vals[exempt_col])
        agi = "0"  # no AGI column exists in this format

        if direction == "inflow":
            rows.append({
                "State_Code_Dest": fixed_fips, "County_Code_Dest": "000",
                "State_Code_Origin": other_fips, "County_Code_Origin": "000",
                "State_Abbrv": abbrv, "State_Name": name,
                "Return_Num": n1, "Exmpt_Num": n2, "Aggr_AGI": agi,
            })
        else:
            rows.append({
                "State_Code_Origin": fixed_fips, "County_Code_Origin": "000",
                "State_Code_Dest": other_fips, "County_Code_Dest": "000",
                "State_Abbrv": abbrv, "State_Name": name,
                "Return_Num": n1, "Exmpt_Num": n2, "Aggr_AGI": agi,
            })

    return direction, fixed_fips, rows


def convert_state_zip(zf: zipfile.ZipFile, year: str, out_dir: Path) -> None:
    inflow_rows: dict[str, list[dict]] = {}
    outflow_rows: dict[str, list[dict]] = {}
    parser = parse_state_workbook_legacy7col if year in LEGACY_7COL_STATE_YEARS else parse_state_workbook

    for name in zf.namelist():
        if not name.lower().endswith(".xls"):
            continue
        direction, fixed_fips, rows = parser(zf.read(name))
        target = inflow_rows if direction == "inflow" else outflow_rows
        if fixed_fips in target:
            continue  # duplicate/typo-named file for a state already processed
        target[fixed_fips] = rows

    inflow_fields = ["State_Code_Dest", "County_Code_Dest", "State_Code_Origin",
                      "County_Code_Origin", "State_Abbrv", "State_Name",
                      "Return_Num", "Exmpt_Num", "Aggr_AGI"]
    outflow_fields = ["State_Code_Origin", "County_Code_Origin", "State_Code_Dest",
                       "County_Code_Dest", "State_Abbrv", "State_Name",
                       "Return_Num", "Exmpt_Num", "Aggr_AGI"]

    write_csv(out_dir / "state_inflow" / f"stateinflow{year}.csv", inflow_fields,
               [row for fips in sorted(inflow_rows) for row in inflow_rows[fips]])
    write_csv(out_dir / "state_outflow" / f"stateoutflow{year}.csv", outflow_fields,
               [row for fips in sorted(outflow_rows) for row in outflow_rows[fips]])

    print(f"  State: {sum(len(v) for v in inflow_rows.values()):,} inflow rows "
          f"({len(inflow_rows)} states), "
          f"{sum(len(v) for v in outflow_rows.values()):,} outflow rows "
          f"({len(outflow_rows)} states)")


# ---------------------------------------------------------------------------
# County workbooks
# ---------------------------------------------------------------------------
COUNTY_INFLOW_FIELDS = ["State_Code_Dest", "County_Code_Dest", "State_Code_Origin",
                         "County_Code_Origin", "State_Abbrv", "County_Name",
                         "Return_Num", "Exmpt_Num", "Aggr_AGI"]
COUNTY_OUTFLOW_FIELDS = ["State_Code_Origin", "County_Code_Origin", "State_Code_Dest",
                          "County_Code_Dest", "State_Abbrv", "County_Name",
                          "Return_Num", "Exmpt_Num", "Aggr_AGI"]


def find_county_data_start(sh) -> int:
    """
    Locate the first data row by scanning for the first row whose Return_Num
    column (index 6) is numeric. Most years fix this at row 8, but some
    single-file national-aggregate workbooks (e.g. "United States" outflow)
    use a shorter header block and start at row 6 instead — with a header
    row count that can't be assumed, scanning is more robust than a constant.
    """
    for r in range(sh.nrows):
        if sh.cell_type(r, 6) == xlrd.XL_CELL_NUMBER:
            return r
    raise ValueError("Could not locate data start row (no numeric Return_Num column found)")


def parse_county_workbook(raw_bytes: bytes, direction: str) -> tuple[str, list[dict]]:
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    sh = wb.sheet_by_index(0)

    fields = COUNTY_INFLOW_FIELDS if direction == "inflow" else COUNTY_OUTFLOW_FIELDS
    data_start = find_county_data_start(sh)

    # The "fixed" state (column 0) is constant for every row in the file — the
    # county code in column 1 varies (one destination/origin county at a
    # time), but the state itself never does. Some source files leave it
    # blank on just the first data row (e.g. Ohio/Texas outflow, 2001-02);
    # at least one (Wyoming, 1993-94 inflow) has scattered rows where it's
    # silently overwritten with a stray value copied from another column,
    # rather than left blank — a handful of rows out of hundreds, no
    # detectable pattern to when it happens. Since a *blank* value is easy to
    # tell apart from a *wrong* one, don't trust column 0 on any individual
    # row at all: take the file-wide majority value instead, and reuse it for
    # every row regardless of what that row's own column 0 happens to hold.
    fips_counts: dict[str, int] = {}
    for r in range(data_start, sh.nrows):
        v = str(sh.cell_value(r, 0)).strip()
        if v:
            fips = cell_fips(sh.cell_value(r, 0), 2)
            fips_counts[fips] = fips_counts.get(fips, 0) + 1
    if not fips_counts:
        raise ValueError("Could not determine fixed state FIPS (column 0 blank throughout)")
    fixed_fips = max(fips_counts, key=fips_counts.get)

    rows = []
    for r in range(data_start, sh.nrows):
        row_vals = sh.row_values(r)
        if not any(str(v).strip() for v in row_vals):
            continue

        # Use the row's own value only if it's blank, already correct, or one
        # of the recognized special aggregate codes (e.g. a whole erroneous
        # duplicate national-aggregate block, as in Alabama's 1996-97 inflow
        # file — those rows carry "00" and must keep it, since a downstream
        # row-identity dedup relies on it matching the standalone national
        # file's own copy of the same rows). Anything else non-blank is
        # exactly the Wyoming-style corruption: some other real state/county
        # number leaking in from a different column — replace with the
        # file-wide majority value.
        raw_col0 = str(row_vals[0]).strip()
        if raw_col0:
            candidate = cell_fips(row_vals[0], 2)
            col0 = candidate if candidate == fixed_fips or candidate in ("00", "96", "97", "98", "57") else fixed_fips
        else:
            col0 = fixed_fips

        other_sf = cell_fips(row_vals[2], 2)
        other_cf = cell_fips(row_vals[3], 3)

        # 1994-95's county-level "Total Inflow"/"Total Outflow" aggregate row
        # (the county-level counterpart of the state-level quirk above) uses
        # a special "00"/"001" marker on the other side instead of the
        # standard 96/000 aggregate convention every other year uses. Rewrite
        # it so enrich_county_data.py's lookup resolves it correctly.
        if other_sf == "00":
            other_sf, other_cf = "96", "000"

        rows.append({
            fields[0]: col0,
            fields[1]: cell_fips(row_vals[1], 3),
            fields[2]: other_sf,
            fields[3]: other_cf,
            fields[4]: str(row_vals[4]).strip(),
            fields[5]: str(row_vals[5]).strip(),
            fields[6]: cell_int(row_vals[6]),
            fields[7]: cell_int(row_vals[7]),
            fields[8]: cell_int(row_vals[8]),
        })

    return fixed_fips, rows


# A numeric token: "1234", "18.02", or ".66" (IRS drops the leading 0 on
# percentages under 1%).
_TXT_NUM_TOKEN_RE = re.compile(r"^-?(?:\d+\.\d+|\.\d+|\d+)$")
# Every real data line starts with "<state fips> <county fips> ..."; every
# summary/breakdown line (see below) does not, so this single check is
# sufficient to separate real rows from noise — verified against all 208
# 1991-92/1990-91 county files with zero lines slipping through uncaught.
_TXT_LEADING_FIPS_RE = re.compile(r"^(\d{1,2})\s+(\d{1,3})\s+(.*)$")


def parse_county_txt(text: str, direction: str) -> list[dict]:
    """
    Parse 1991-92/1990-91's plain fixed-width county migration text files
    (e.g. "C9192nyo.txt") — a different file format entirely from every
    other year (not Excel), with inconsistent row alignment (confirmed via
    direct testing that character-offset slicing does not line up reliably),
    so rows are classified by shape via whitespace tokenization instead.

    Each state's file is a sequence of per-county blocks. A block opens with
    an aggregate/total row giving that county's own FIPS (2 trailing
    numbers: returns, exemptions — no percents, since they'd trivially be
    100%), followed by detail rows for each real origin/destination county
    (4 trailing numbers: returns, pct, exemptions, pct) and closed by a
    "County Non-Migrants" row (2 trailing numbers again). Only the block's
    aggregate row states its own FIPS+name; detail rows give the *other*
    county's FIPS/name directly but rely on the still-open block for which
    county they belong to — so this parser is stateful across lines, unlike
    every other parser in this file.

    Interspersed "Same Region, Diff. State", "Different Region",
    "All Migration Flows", "Foreign", "Region N: <name>", and "Same State"
    lines are aggregate breakdowns, not real per-county data — they carry no
    leading FIPS pair at all, so they're excluded by construction (the
    leading-FIPS check is the only gate needed, confirmed against every line
    in every file for both years — see convert_legacy_xls_data test sweep).
    """
    fields = COUNTY_INFLOW_FIELDS if direction == "inflow" else COUNTY_OUTFLOW_FIELDS
    rows: list[dict] = []
    fixed_sf: str | None = None
    fixed_cf: str | None = None
    fixed_abbrv: str | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = _TXT_LEADING_FIPS_RE.match(line)
        if not m:
            continue  # region/breakdown summary line — not real county data
        sf, cf, rest = m.group(1).zfill(2), m.group(2).zfill(3), m.group(3)

        tokens = rest.split()
        num_count = 0
        for tok in reversed(tokens):
            if _TXT_NUM_TOKEN_RE.match(tok):
                num_count += 1
            else:
                break
        if num_count not in (2, 4):
            continue  # unrecognized shape — be defensive, skip rather than guess

        label_tokens = tokens[:-num_count]
        nums = [t.replace(",", "") for t in tokens[-num_count:]]
        # The last label token is always a clean 2-letter postal abbreviation
        # (verified against every aggregate and detail row in both years'
        # files — 155,390+ rows, zero exceptions) — except the Non-Migrants
        # row, whose label never includes one; it reuses the block's own
        # abbreviation instead. This isn't cosmetic: enrich_county_data.py
        # only resolves the *county name* via FIPS lookup for the "other"
        # side of a normal detail row — the postal abbreviation has no
        # lookup fallback there and comes straight from this field, so a
        # blank value here causes a false "unresolved" report even though
        # the row is fully valid (confirmed against Autauga County, AL,
        # whose own FIPS "01/001" also collides with the special "same
        # state total" aggregate marker "001", tripping the enrichment
        # script's is_non_migrant check and forcing it down the
        # lookup-for-name-only path).
        row_abbrv = label_tokens[-1] if label_tokens else ""

        if num_count == 2:
            n1, n2 = nums
            if "non-migrant" in " ".join(label_tokens).lower():
                if fixed_sf is None:
                    continue  # malformed file — non-migrant row before any block opened
                other_sf, other_cf, abbrv, name = fixed_sf, fixed_cf, fixed_abbrv or "", "Non-Migrants"
            else:
                # Opens a new block — this row's own FIPS becomes "fixed" for
                # subsequent detail rows. The "other" side (96/000, the
                # national aggregate marker) has no label of its own in this
                # row — mirror the convention every other year's XLS parser
                # already relies on (see the 1994-95+ "Total Migration" rewrite
                # above): echo the fixed side's own abbreviation and give the
                # name a "Total Migration" substring so enrich_county_data.py's
                # dedicated aggregate-row branch resolves the state name via
                # SPECIAL_STATE_FIPS lookup instead of misreporting it unresolved.
                fixed_sf, fixed_cf, fixed_abbrv = sf, cf, row_abbrv
                other_sf, other_cf, abbrv, name = "96", "000", row_abbrv, "Total Migration"
        else:
            if fixed_sf is None:
                continue  # malformed file — detail row before any block opened
            other_sf, other_cf = sf, cf
            abbrv = row_abbrv
            name = " ".join(label_tokens[:-1]) if len(label_tokens) > 1 else ""
            n1, _pct1, n2, _pct2 = nums

        rows.append({
            fields[0]: fixed_sf, fields[1]: fixed_cf,
            fields[2]: other_sf, fields[3]: other_cf,
            fields[4]: abbrv, fields[5]: name,
            fields[6]: cell_int(float(n1)), fields[7]: cell_int(float(n2)), fields[8]: "0",
        })

    return rows


def convert_county_zip(zf: zipfile.ZipFile, year: str, out_dir: Path) -> None:
    # Deduplicate at the row level (by the 4 FIPS columns), not at the file
    # level. A file-level dedup (keyed on the first data row's FIPS) breaks
    # when a file straddles two geographies — e.g. 1996-97's Alabama inflow
    # workbook erroneously has the national aggregate's rows duplicated as a
    # prefix before Alabama's own data, so the file's "first row" FIPS is
    # "00" (national), not "01" (Alabama). Deduping whole files by that
    # value would either collide with the real national file (dropping
    # Alabama's unique per-county rows entirely) or vice versa. Row-level
    # identity handles this correctly regardless of which file a stray
    # duplicate block ends up attached to.
    inflow_rows: dict[tuple, dict] = {}
    outflow_rows: dict[tuple, dict] = {}

    is_txt_year = year in LEGACY_TXT_COUNTY_YEARS
    ext = ".txt" if is_txt_year else ".xls"

    for name in zf.namelist():
        base = Path(name).name
        if not base.lower().endswith(ext):
            continue
        lower_path = name.lower()
        lower_base = base.lower()
        # Prefer the containing folder name (e.g. ".../CountyMigrationInflow/...")
        # over the filename suffix, since filenames have typos across years
        # (e.g. "co0304OH0.xls" for outflow instead of the usual "...o.xls").
        if "inflow" in lower_path:
            direction = "inflow"
        elif "outflow" in lower_path:
            direction = "outflow"
        elif lower_base.endswith(f"i{ext}"):
            direction = "inflow"
        elif lower_base.endswith(f"o{ext}"):
            direction = "outflow"
        else:
            print(f"    WARNING: could not classify direction for {base}, skipping")
            continue

        fields = COUNTY_INFLOW_FIELDS if direction == "inflow" else COUNTY_OUTFLOW_FIELDS
        if is_txt_year:
            rows = parse_county_txt(zf.read(name).decode("ascii"), direction)
        else:
            _fixed_fips, rows = parse_county_workbook(zf.read(name), direction)
        target = inflow_rows if direction == "inflow" else outflow_rows
        for row in rows:
            key = (row[fields[0]], row[fields[1]], row[fields[2]], row[fields[3]])
            target.setdefault(key, row)  # first occurrence wins; later duplicates ignored

    write_csv(out_dir / "county_inflow" / f"countyinflow{year}.csv", COUNTY_INFLOW_FIELDS,
               list(inflow_rows.values()))
    write_csv(out_dir / "county_outflow" / f"countyoutflow{year}.csv", COUNTY_OUTFLOW_FIELDS,
               list(outflow_rows.values()))

    print(f"  County: {len(inflow_rows):,} inflow rows, "
          f"{len(outflow_rows):,} outflow rows")


# ---------------------------------------------------------------------------
def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames, quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(rows)
    print(f"    → wrote {path}")


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in LEGACY_ZIPS:
        sys.exit(f"Usage: python {sys.argv[0]} <year_tag>\nSupported: {list(LEGACY_ZIPS)}")

    year = sys.argv[1]
    zips = LEGACY_ZIPS[year]
    out_dir = Path("data/original")

    print(f"Converting legacy IRS ZIP/XLS data for {year} …\n")

    print("State migration data:")
    state_zf = fetch_zip(f"{BASE_URL}/{zips['state']}")
    convert_state_zip(state_zf, year, out_dir)

    print("\nCounty migration data:")
    county_zf = fetch_zip(f"{BASE_URL}/{zips['county']}")
    convert_county_zip(county_zf, year, out_dir)

    print("\nDone.")


if __name__ == "__main__":
    main()
