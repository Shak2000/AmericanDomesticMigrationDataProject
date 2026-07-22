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
}

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


def convert_state_zip(zf: zipfile.ZipFile, year: str, out_dir: Path) -> None:
    inflow_rows: dict[str, list[dict]] = {}
    outflow_rows: dict[str, list[dict]] = {}

    for name in zf.namelist():
        if not name.lower().endswith(".xls"):
            continue
        direction, fixed_fips, rows = parse_state_workbook(zf.read(name))
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

    for name in zf.namelist():
        base = Path(name).name
        if not base.lower().endswith(".xls"):
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
        elif lower_base.endswith("i.xls"):
            direction = "inflow"
        elif lower_base.endswith("o.xls"):
            direction = "outflow"
        else:
            print(f"    WARNING: could not classify direction for {base}, skipping")
            continue

        fields = COUNTY_INFLOW_FIELDS if direction == "inflow" else COUNTY_OUTFLOW_FIELDS
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
