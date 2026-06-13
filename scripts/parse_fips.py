"""
parse_fips.py — Milestone 1.1

Reads two U.S. Census Bureau geocode CSVs and produces two unified CSV files
that downstream scripts use to enrich IRS migration data:

    state_fips.csv   — all U.S. states + DC (identical in both vintages)
                       columns: fips_code, state_name, state_postal

    county_fips.csv  — all counties/equivalents from BOTH vintages, merged:
                         • All states other than CT: taken from all-geocodes-v2021.csv
                         • Connecticut: traditional counties (09001–09015, from v2021)
                           AND planning regions (09130–09190, from v2025) are BOTH
                           included so that 2021-22 and 2022-23 IRS data rows can each
                           find their respective geography in a single lookup.
                       columns: state_fips, county_fips, county_name, state_name,
                                state_postal

Each geocode CSV uses Summary Level codes:
    040  →  state-level row
    050  →  county / planning-region row

Usage
-----
    python parse_fips.py
"""

import csv
from pathlib import Path

# ---------------------------------------------------------------------------
# Source files
# ---------------------------------------------------------------------------
SOURCE_2021 = Path("data/fips/all-geocodes-v2021.csv")
SOURCE_2025 = Path("data/fips/all-geocodes-v2025.csv")

# ---------------------------------------------------------------------------
# State name → two-letter postal abbreviation
# ---------------------------------------------------------------------------
STATE_POSTAL: dict[str, str] = {
    "ALABAMA": "AL",
    "ALASKA": "AK",
    "ARIZONA": "AZ",
    "ARKANSAS": "AR",
    "CALIFORNIA": "CA",
    "COLORADO": "CO",
    "CONNECTICUT": "CT",
    "DELAWARE": "DE",
    "DISTRICT OF COLUMBIA": "DC",
    "FLORIDA": "FL",
    "GEORGIA": "GA",
    "HAWAII": "HI",
    "IDAHO": "ID",
    "ILLINOIS": "IL",
    "INDIANA": "IN",
    "IOWA": "IA",
    "KANSAS": "KS",
    "KENTUCKY": "KY",
    "LOUISIANA": "LA",
    "MAINE": "ME",
    "MARYLAND": "MD",
    "MASSACHUSETTS": "MA",
    "MICHIGAN": "MI",
    "MINNESOTA": "MN",
    "MISSISSIPPI": "MS",
    "MISSOURI": "MO",
    "MONTANA": "MT",
    "NEBRASKA": "NE",
    "NEVADA": "NV",
    "NEW HAMPSHIRE": "NH",
    "NEW JERSEY": "NJ",
    "NEW MEXICO": "NM",
    "NEW YORK": "NY",
    "NORTH CAROLINA": "NC",
    "NORTH DAKOTA": "ND",
    "OHIO": "OH",
    "OKLAHOMA": "OK",
    "OREGON": "OR",
    "PENNSYLVANIA": "PA",
    "RHODE ISLAND": "RI",
    "SOUTH CAROLINA": "SC",
    "SOUTH DAKOTA": "SD",
    "TENNESSEE": "TN",
    "TEXAS": "TX",
    "UTAH": "UT",
    "VERMONT": "VT",
    "VIRGINIA": "VA",
    "WASHINGTON": "WA",
    "WEST VIRGINIA": "WV",
    "WISCONSIN": "WI",
    "WYOMING": "WY",
}

# Summary Level codes of interest
SUMMARY_STATE  = "040"
SUMMARY_COUNTY = "050"

# Connecticut state FIPS (zero-padded 2-digit)
CT_FIPS = "09"

# The two geocode CSVs have slightly different header names for one column.
_FIELD_ALIASES: dict[str, str] = {
    # 2021 file uses a typo: "Consolidtated"
    "Consolidtated City Code (FIPS)": "Consolidated City Code (FIPS)",
}


def _normalise_headers(fieldnames: list[str]) -> list[str]:
    return [_FIELD_ALIASES.get(f, f) for f in fieldnames]


# ---------------------------------------------------------------------------
# Core parser
# ---------------------------------------------------------------------------
def parse_geocodes(
    source_path: Path,
) -> tuple[list[dict], list[dict]]:
    """
    Parse a Census all-geocodes CSV into state and county record lists.

    Returns
    -------
    state_rows  : list of dict  — keys: fips_code, state_name, state_postal
    county_rows : list of dict  — keys: state_fips, county_fips, county_name,
                                         state_name, state_postal
    """
    state_rows: list[dict] = []
    county_rows: list[dict] = []

    # state_fips → (state_name, state_postal)
    state_context: dict[str, tuple[str, str]] = {}

    with open(source_path, newline="", encoding="utf-8") as fh:
        raw_reader = csv.DictReader(fh)
        assert raw_reader.fieldnames is not None, f"Empty file: {source_path}"
        raw_reader.fieldnames = _normalise_headers(list(raw_reader.fieldnames))

        for row in raw_reader:
            level = row.get("Summary Level", "").strip()
            state_fips  = row.get("State Code (FIPS)",  row.get("State FIPS Code", "")).strip().zfill(2)
            county_fips = row.get("County Code (FIPS)", row.get("County FIPS Code", "")).strip().zfill(3)
            area_name   = row.get(
                "Area Name (including legal/statistical area description)",
                row.get("Area Name", ""),
            ).strip()

            if level == SUMMARY_STATE:
                upper_name = area_name.upper()
                postal = STATE_POSTAL.get(upper_name, "")
                state_context[state_fips] = (area_name, postal)
                state_rows.append(
                    {
                        "fips_code":    state_fips,
                        "state_name":   area_name,
                        "state_postal": postal,
                    }
                )

            elif level == SUMMARY_COUNTY:
                state_name, state_postal = state_context.get(state_fips, ("", ""))
                county_rows.append(
                    {
                        "state_fips":   state_fips,
                        "county_fips":  county_fips,
                        "county_name":  area_name,
                        "state_name":   state_name,
                        "state_postal": state_postal,
                    }
                )
            # All other summary levels (010, 061, 162, 170, …) are ignored.

    return state_rows, county_rows


# ---------------------------------------------------------------------------
# Merge logic
# ---------------------------------------------------------------------------
def build_unified_county(
    rows_2021: list[dict],
    rows_2025: list[dict],
) -> list[dict]:
    """
    Produce a single unified county lookup that covers both the pre-2022
    and 2022+ IRS data files.

    Strategy
    --------
    • For every state *other than Connecticut*: use the 2021 rows only (the
      county definitions are identical in both vintages).
    • For Connecticut (state FIPS 09):
        – Include the traditional counties from 2021 (FIPS 001–015).
        – Also include the planning regions from 2025 (FIPS 130–190).
      Both sets are needed because IRS data files for 2021-22 reference the
      old county codes while 2022-23 files reference the new planning-region
      codes.

    Deduplication is performed on (state_fips, county_fips) so that if any
    non-CT row somehow differs between vintages, the 2021 version wins.
    """
    seen: set[tuple[str, str]] = set()
    unified: list[dict] = []

    # 1. Add all 2021 county rows (covers non-CT states AND CT old counties)
    for row in rows_2021:
        key = (row["state_fips"], row["county_fips"])
        if key not in seen:
            seen.add(key)
            unified.append(row)

    # 2. Add only CT rows from 2025 (the planning regions not in 2021)
    for row in rows_2025:
        if row["state_fips"] != CT_FIPS:
            continue
        key = (row["state_fips"], row["county_fips"])
        if key not in seen:
            seen.add(key)
            unified.append(row)

    return unified


# ---------------------------------------------------------------------------
# CSV writer
# ---------------------------------------------------------------------------
def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    print(f"  Wrote {len(rows):,} rows → {path}")


# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
def _check_postal(rows: list[dict], label: str) -> None:
    missing = [r for r in rows if not r.get("state_postal")]
    if missing:
        print(f"  WARNING [{label}]: {len(missing)} row(s) have no postal code:")
        for r in missing[:10]:
            print(f"    {r}")
    else:
        print(f"  ✓ [{label}] All rows have postal codes")


def _spot_check_connecticut(unified: list[dict]) -> None:
    """Confirm that both old and new CT geographies are present."""
    ct_rows = [r for r in unified if r["state_fips"] == CT_FIPS]
    codes = sorted(r["county_fips"] for r in ct_rows)
    old_codes = [c for c in codes if int(c) < 100]   # 001-099: traditional counties
    new_codes = [c for c in codes if int(c) >= 100]  # 130-190: planning regions
    print(f"\n  Connecticut spot-check in county_fips.csv:")
    print(f"    Traditional counties ({len(old_codes)}): {old_codes}")
    print(f"    Planning regions     ({len(new_codes)}): {new_codes}")
    if old_codes and new_codes:
        print("  ✓ Both pre-2022 and 2022+ CT geographies are present")
    elif not old_codes:
        print("  WARNING: No traditional CT county codes found!")
    elif not new_codes:
        print("  WARNING: No CT planning region codes found!")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    for src in (SOURCE_2021, SOURCE_2025):
        if not src.exists():
            raise FileNotFoundError(
                f"Required source file not found: {src}\n"
                "Please place it in the project directory before running this script."
            )

    # ── Parse both geocode vintages ────────────────────────────────────────
    print(f"Parsing {SOURCE_2021} …")
    state_rows_2021, county_rows_2021 = parse_geocodes(SOURCE_2021)
    print(f"  {len(state_rows_2021)} state entries, {len(county_rows_2021):,} county entries")

    print(f"\nParsing {SOURCE_2025} …")
    state_rows_2025, county_rows_2025 = parse_geocodes(SOURCE_2025)
    print(f"  {len(state_rows_2025)} state entries, {len(county_rows_2025):,} county entries")

    # ── State FIPS: both vintages should be identical; use 2021 rows ───────
    # (We emit one state_fips.csv — states do not change between vintages.)
    state_rows = state_rows_2021

    # ── County FIPS: merge old CT counties + new CT planning regions ───────
    county_rows = build_unified_county(county_rows_2021, county_rows_2025)

    # ── Write output files ─────────────────────────────────────────────────
    print("\nWriting output files …")
    write_csv(
        Path("data/fips/state_fips.csv"),
        fieldnames=["fips_code", "state_name", "state_postal"],
        rows=state_rows,
    )
    write_csv(
        Path("data/fips/county_fips.csv"),
        fieldnames=["state_fips", "county_fips", "county_name", "state_name", "state_postal"],
        rows=county_rows,
    )

    # ── Sanity checks ──────────────────────────────────────────────────────
    print("\nSanity checks …")
    _check_postal(state_rows,  "state_fips")
    _check_postal(county_rows, "county_fips")
    _spot_check_connecticut(county_rows)

    print("\nDone.")


if __name__ == "__main__":
    main()
