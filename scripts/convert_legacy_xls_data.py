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
}

STATE_HEADER_DATA_ROW = 8   # first data row in state workbooks (0-indexed)
COUNTY_HEADER_DATA_ROW = 8  # first data row in county workbooks (0-indexed)

TO_FROM_RE = re.compile(r"^\s*(?:TO|FROM):\s*(\d+)-", re.IGNORECASE)


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
def parse_state_workbook(raw_bytes: bytes) -> tuple[str, str, list[dict]]:
    """Return (direction, fixed_fips, rows) for one state workbook."""
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    sh = wb.sheet_by_index(0)

    header_cell = str(sh.cell_value(3, 0))
    m = TO_FROM_RE.match(header_cell)
    if not m:
        raise ValueError(f"Could not parse header cell: {header_cell!r}")
    fixed_fips = m.group(1).zfill(2)
    direction = "inflow" if header_cell.strip().upper().startswith("TO") else "outflow"

    rows = []
    for r in range(STATE_HEADER_DATA_ROW, sh.nrows):
        row_vals = sh.row_values(r)
        if not any(str(v).strip() for v in row_vals):
            continue
        other_fips = cell_fips(row_vals[0], 2)
        abbrv = str(row_vals[1]).strip()
        name = str(row_vals[2]).strip()
        n1 = cell_int(row_vals[3])
        n2 = cell_int(row_vals[4])
        agi = cell_int(row_vals[5])

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


def parse_county_workbook(raw_bytes: bytes, direction: str) -> tuple[str, list[dict]]:
    wb = xlrd.open_workbook(file_contents=raw_bytes)
    sh = wb.sheet_by_index(0)

    fields = COUNTY_INFLOW_FIELDS if direction == "inflow" else COUNTY_OUTFLOW_FIELDS
    fixed_fips = cell_fips(sh.cell_value(COUNTY_HEADER_DATA_ROW, 0), 2)

    rows = []
    for r in range(COUNTY_HEADER_DATA_ROW, sh.nrows):
        row_vals = sh.row_values(r)
        if not any(str(v).strip() for v in row_vals):
            continue
        rows.append({
            fields[0]: cell_fips(row_vals[0], 2),
            fields[1]: cell_fips(row_vals[1], 3),
            fields[2]: cell_fips(row_vals[2], 2),
            fields[3]: cell_fips(row_vals[3], 3),
            fields[4]: str(row_vals[4]).strip(),
            fields[5]: str(row_vals[5]).strip(),
            fields[6]: cell_int(row_vals[6]),
            fields[7]: cell_int(row_vals[7]),
            fields[8]: cell_int(row_vals[8]),
        })

    return fixed_fips, rows


def convert_county_zip(zf: zipfile.ZipFile, year: str, out_dir: Path) -> None:
    inflow_rows: dict[str, list[dict]] = {}
    outflow_rows: dict[str, list[dict]] = {}

    for name in zf.namelist():
        base = Path(name).name
        if not base.lower().endswith(".xls"):
            continue
        lower = base.lower()
        if lower.endswith("i.xls"):
            direction = "inflow"
        elif lower.endswith("o.xls") or lower[-5] == "0":  # co0304OH0.xls typo
            direction = "outflow"
        else:
            print(f"    WARNING: could not classify direction for {base}, skipping")
            continue

        fixed_fips, rows = parse_county_workbook(zf.read(name), direction)
        target = inflow_rows if direction == "inflow" else outflow_rows
        if fixed_fips in target:
            continue  # duplicate/typo-named file for a state already processed
        target[fixed_fips] = rows

    write_csv(out_dir / "county_inflow" / f"countyinflow{year}.csv", COUNTY_INFLOW_FIELDS,
               [row for fips in sorted(inflow_rows) for row in inflow_rows[fips]])
    write_csv(out_dir / "county_outflow" / f"countyoutflow{year}.csv", COUNTY_OUTFLOW_FIELDS,
               [row for fips in sorted(outflow_rows) for row in outflow_rows[fips]])

    print(f"  County: {sum(len(v) for v in inflow_rows.values()):,} inflow rows "
          f"({len(inflow_rows)} states), "
          f"{sum(len(v) for v in outflow_rows.values()):,} outflow rows "
          f"({len(outflow_rows)} states)")


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
