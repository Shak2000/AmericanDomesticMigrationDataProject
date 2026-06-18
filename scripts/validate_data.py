"""
validate_data.py — Milestone 1.4

Validates all enriched IRS migration CSV files against five criteria:

  1. Row counts match raw originals (no rows silently dropped or duplicated).
  2. No unexpected empty values in key join columns.
     Expected empties: IRS pseudo-FIPS 58 (same-state aggregate) and 59
     (different-state aggregate) are passed through without labels — these
     are flagged separately as "known" rather than treated as errors.
  3. Special aggregate FIPS codes (96 / 97 / 98) are present in every
     enriched file that should contain them.
  4. State FIPS codes are zero-padded to 2 digits throughout.
  5. County FIPS codes are zero-padded to 3 digits throughout.
  6. Connecticut: all CT county rows (state FIPS 09) resolve to a non-empty
     county/planning-region name.  Both 2121-22 and 2022-23 IRS county
     files use planning-region FIPS (09110-09190); this check confirms
     those codes resolve correctly against the unified lookup.

Usage
-----
    python scripts/validate_data.py          # validate all files
    python scripts/validate_data.py --quick  # skip per-row scans (fast)
"""

import csv
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# File pairs: (original, enriched, "state"|"county", year_tag)
# year_tag is used only for the CT check label.
# ---------------------------------------------------------------------------
FILE_PAIRS: list[tuple[str, str, str, str]] = [
    # State inflow
    ("data/original/state_inflow/stateinflow0910.csv",
     "data/enriched/state_inflow/stateinflow0910_enriched.csv",   "state",  "0910"),
    ("data/original/state_inflow/stateinflow1011.csv",
     "data/enriched/state_inflow/stateinflow1011_enriched.csv",   "state",  "1011"),
    ("data/original/state_inflow/stateinflow1112.csv",
     "data/enriched/state_inflow/stateinflow1112_enriched.csv",   "state",  "1112"),
    ("data/original/state_inflow/stateinflow1213.csv",
     "data/enriched/state_inflow/stateinflow1213_enriched.csv",   "state",  "1213"),
    ("data/original/state_inflow/stateinflow1314.csv",
     "data/enriched/state_inflow/stateinflow1314_enriched.csv",   "state",  "1314"),
    ("data/original/state_inflow/stateinflow1415.csv",
     "data/enriched/state_inflow/stateinflow1415_enriched.csv",   "state",  "1415"),
    ("data/original/state_inflow/stateinflow1516.csv",
     "data/enriched/state_inflow/stateinflow1516_enriched.csv",   "state",  "1516"),
    ("data/original/state_inflow/stateinflow1617.csv",
     "data/enriched/state_inflow/stateinflow1617_enriched.csv",   "state",  "1617"),
    ("data/original/state_inflow/stateinflow1718.csv",
     "data/enriched/state_inflow/stateinflow1718_enriched.csv",   "state",  "1718"),
    ("data/original/state_inflow/stateinflow1819.csv",
     "data/enriched/state_inflow/stateinflow1819_enriched.csv",   "state",  "1819"),
    ("data/original/state_inflow/stateinflow1920.csv",
     "data/enriched/state_inflow/stateinflow1920_enriched.csv",   "state",  "1920"),
    ("data/original/state_inflow/stateinflow2021.csv",
     "data/enriched/state_inflow/stateinflow2021_enriched.csv",   "state",  "2021"),
    ("data/original/state_inflow/stateinflow2122.csv",
     "data/enriched/state_inflow/stateinflow2122_enriched.csv",   "state",  "2122"),
    ("data/original/state_inflow/stateinflow2223.csv",
     "data/enriched/state_inflow/stateinflow2223_enriched.csv",   "state",  "2223"),
    # State outflow
    ("data/original/state_outflow/stateoutflow0910.csv",
     "data/enriched/state_outflow/stateoutflow0910_enriched.csv", "state",  "0910"),
    ("data/original/state_outflow/stateoutflow1011.csv",
     "data/enriched/state_outflow/stateoutflow1011_enriched.csv", "state",  "1011"),
    ("data/original/state_outflow/stateoutflow1112.csv",
     "data/enriched/state_outflow/stateoutflow1112_enriched.csv", "state",  "1112"),
    ("data/original/state_outflow/stateoutflow1213.csv",
     "data/enriched/state_outflow/stateoutflow1213_enriched.csv", "state",  "1213"),
    ("data/original/state_outflow/stateoutflow1314.csv",
     "data/enriched/state_outflow/stateoutflow1314_enriched.csv", "state",  "1314"),
    ("data/original/state_outflow/stateoutflow1415.csv",
     "data/enriched/state_outflow/stateoutflow1415_enriched.csv", "state",  "1415"),
    ("data/original/state_outflow/stateoutflow1516.csv",
     "data/enriched/state_outflow/stateoutflow1516_enriched.csv", "state",  "1516"),
    ("data/original/state_outflow/stateoutflow1617.csv",
     "data/enriched/state_outflow/stateoutflow1617_enriched.csv", "state",  "1617"),
    ("data/original/state_outflow/stateoutflow1718.csv",
     "data/enriched/state_outflow/stateoutflow1718_enriched.csv", "state",  "1718"),
    ("data/original/state_outflow/stateoutflow1819.csv",
     "data/enriched/state_outflow/stateoutflow1819_enriched.csv", "state",  "1819"),
    ("data/original/state_outflow/stateoutflow1920.csv",
     "data/enriched/state_outflow/stateoutflow1920_enriched.csv", "state",  "1920"),
    ("data/original/state_outflow/stateoutflow2021.csv",
     "data/enriched/state_outflow/stateoutflow2021_enriched.csv", "state",  "2021"),
    ("data/original/state_outflow/stateoutflow2122.csv",
     "data/enriched/state_outflow/stateoutflow2122_enriched.csv", "state",  "2122"),
    ("data/original/state_outflow/stateoutflow2223.csv",
     "data/enriched/state_outflow/stateoutflow2223_enriched.csv", "state",  "2223"),
    # County inflow
    ("data/original/county_inflow/countyinflow0910.csv",
     "data/enriched/county_inflow/countyinflow0910_enriched.csv", "county", "0910"),
    ("data/original/county_inflow/countyinflow1011.csv",
     "data/enriched/county_inflow/countyinflow1011_enriched.csv", "county", "1011"),
    ("data/original/county_inflow/countyinflow1112.csv",
     "data/enriched/county_inflow/countyinflow1112_enriched.csv", "county", "1112"),
    ("data/original/county_inflow/countyinflow1213.csv",
     "data/enriched/county_inflow/countyinflow1213_enriched.csv", "county", "1213"),
    ("data/original/county_inflow/countyinflow1314.csv",
     "data/enriched/county_inflow/countyinflow1314_enriched.csv", "county", "1314"),
    ("data/original/county_inflow/countyinflow1415.csv",
     "data/enriched/county_inflow/countyinflow1415_enriched.csv", "county", "1415"),
    ("data/original/county_inflow/countyinflow1516.csv",
     "data/enriched/county_inflow/countyinflow1516_enriched.csv", "county", "1516"),
    ("data/original/county_inflow/countyinflow1617.csv",
     "data/enriched/county_inflow/countyinflow1617_enriched.csv", "county", "1617"),
    ("data/original/county_inflow/countyinflow1718.csv",
     "data/enriched/county_inflow/countyinflow1718_enriched.csv", "county", "1718"),
    ("data/original/county_inflow/countyinflow1819.csv",
     "data/enriched/county_inflow/countyinflow1819_enriched.csv", "county", "1819"),
    ("data/original/county_inflow/countyinflow1920.csv",
     "data/enriched/county_inflow/countyinflow1920_enriched.csv", "county", "1920"),
    ("data/original/county_inflow/countyinflow2021.csv",
     "data/enriched/county_inflow/countyinflow2021_enriched.csv", "county", "2021"),
    ("data/original/county_inflow/countyinflow2122.csv",
     "data/enriched/county_inflow/countyinflow2122_enriched.csv", "county", "2122"),
    ("data/original/county_inflow/countyinflow2223.csv",
     "data/enriched/county_inflow/countyinflow2223_enriched.csv", "county", "2223"),
    # County outflow
    ("data/original/county_outflow/countyoutflow0910.csv",
     "data/enriched/county_outflow/countyoutflow0910_enriched.csv", "county", "0910"),
    ("data/original/county_outflow/countyoutflow1011.csv",
     "data/enriched/county_outflow/countyoutflow1011_enriched.csv", "county", "1011"),
    ("data/original/county_outflow/countyoutflow1112.csv",
     "data/enriched/county_outflow/countyoutflow1112_enriched.csv", "county", "1112"),
    ("data/original/county_outflow/countyoutflow1213.csv",
     "data/enriched/county_outflow/countyoutflow1213_enriched.csv", "county", "1213"),
    ("data/original/county_outflow/countyoutflow1314.csv",
     "data/enriched/county_outflow/countyoutflow1314_enriched.csv", "county", "1314"),
    ("data/original/county_outflow/countyoutflow1415.csv",
     "data/enriched/county_outflow/countyoutflow1415_enriched.csv", "county", "1415"),
    ("data/original/county_outflow/countyoutflow1516.csv",
     "data/enriched/county_outflow/countyoutflow1516_enriched.csv", "county", "1516"),
    ("data/original/county_outflow/countyoutflow1617.csv",
     "data/enriched/county_outflow/countyoutflow1617_enriched.csv", "county", "1617"),
    ("data/original/county_outflow/countyoutflow1718.csv",
     "data/enriched/county_outflow/countyoutflow1718_enriched.csv", "county", "1718"),
    ("data/original/county_outflow/countyoutflow1819.csv",
     "data/enriched/county_outflow/countyoutflow1819_enriched.csv", "county", "1819"),
    ("data/original/county_outflow/countyoutflow1920.csv",
     "data/enriched/county_outflow/countyoutflow1920_enriched.csv", "county", "1920"),
    ("data/original/county_outflow/countyoutflow2021.csv",
     "data/enriched/county_outflow/countyoutflow2021_enriched.csv", "county", "2021"),
    ("data/original/county_outflow/countyoutflow2122.csv",
     "data/enriched/county_outflow/countyoutflow2122_enriched.csv", "county", "2122"),
    ("data/original/county_outflow/countyoutflow2223.csv",
     "data/enriched/county_outflow/countyoutflow2223_enriched.csv", "county", "2223"),
]

# IRS pseudo-FIPS that carry no real state name — empties here are expected.
KNOWN_UNLABELLED_STATE_FIPS = {"58", "59"}

# Special aggregate state FIPS that MUST appear in every enriched file.
REQUIRED_SPECIAL_FIPS = {"96", "97", "98"}

# Connecticut state FIPS (2-digit zero-padded)
CT_FIPS = "09"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def count_rows(path: Path, encoding: str = "utf-8") -> int:
    """Return the number of data rows (excluding header) in a CSV."""
    with open(path, newline="", encoding=encoding) as fh:
        return sum(1 for _ in csv.DictReader(fh))


def _open_enriched(path: Path):
    """Return a csv.DictReader for an enriched file (always UTF-8)."""
    fh = open(path, newline="", encoding="utf-8")
    return fh, csv.DictReader(fh)


def _detect_encoding(path: Path) -> str:
    """Raw IRS files use latin-1; enriched files use utf-8."""
    return "latin-1"


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------
def check_row_count(
    orig_path: Path,
    enr_path: Path,
) -> tuple[bool, str]:
    orig_n = count_rows(orig_path, encoding="latin-1")
    enr_n  = count_rows(enr_path,  encoding="utf-8")
    if orig_n == enr_n:
        return True, f"row count {enr_n:,} matches original"
    return False, f"row count MISMATCH — original {orig_n:,}, enriched {enr_n:,}"


def check_fips_padding(
    enr_path: Path,
    kind: str,
) -> tuple[bool, str]:
    """Verify all state FIPS are 2-digit and county FIPS are 3-digit strings."""
    bad_state: list[tuple[str, str]] = []   # (col, value)
    bad_county: list[tuple[str, str]] = []

    state_cols  = ["y2_statefips", "y1_statefips"]
    county_cols = ["y2_countyfips", "y1_countyfips"] if kind == "county" else []

    with open(enr_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            for col in state_cols:
                v = row.get(col, "")
                if v and len(v) != 2:
                    bad_state.append((col, v))
            for col in county_cols:
                v = row.get(col, "")
                if v and len(v) != 3:
                    bad_county.append((col, v))

    msgs = []
    ok = True
    if bad_state:
        ok = False
        sample = bad_state[:5]
        msgs.append(f"state FIPS not 2-digit — {len(bad_state):,} occurrences, e.g. {sample}")
    if bad_county:
        ok = False
        sample = bad_county[:5]
        msgs.append(f"county FIPS not 3-digit — {len(bad_county):,} occurrences, e.g. {sample}")

    if ok:
        return True, "all FIPS codes are correctly zero-padded"
    return False, "; ".join(msgs)


def check_empty_values(
    enr_path: Path,
    kind: str,
) -> tuple[bool, str, str]:
    """
    Scan for empty values in key join columns.

    Returns (ok, error_msg, warn_msg).
    Known-unlabelled rows (FIPS 58/59) are reported as warnings, not errors.
    """
    if kind == "state":
        key_cols = ["y2_state", "y2_state_name", "y1_state", "y1_state_name"]
    else:
        key_cols = [
            "y2_state", "y2_state_name", "y2_county_name",
            "y1_state", "y1_state_name", "y1_county_name",
        ]

    errors:   dict[str, int] = {}   # col → count of unexpected empties
    known_sf: set[str] = set()      # unlabelled FIPS codes actually seen

    with open(enr_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            y1_sf = row.get("y1_statefips", "")
            y2_sf = row.get("y2_statefips", "")
            for col in key_cols:
                if not row[col].strip():
                    # Determine which side is empty
                    side_sf = y1_sf if col.startswith("y1") else y2_sf
                    if side_sf in KNOWN_UNLABELLED_STATE_FIPS:
                        known_sf.add(side_sf)
                    else:
                        errors[col] = errors.get(col, 0) + 1

    err_msg  = ""
    warn_msg = ""
    ok = True

    if errors:
        ok = False
        parts = [f"{col}: {n:,}" for col, n in sorted(errors.items())]
        err_msg = "unexpected empty values — " + ", ".join(parts)

    if known_sf:
        warn_msg = (
            f"known unlabelled IRS pseudo-FIPS {sorted(known_sf)} produce empty "
            f"state_name/state_postal fields (expected — these are aggregate rows)"
        )

    if ok:
        return True, "no unexpected empty values in key columns", warn_msg
    return False, err_msg, warn_msg


def check_special_fips(enr_path: Path) -> tuple[bool, str]:
    """Verify that FIPS 96, 97, 98 all appear at least once."""
    seen: set[str] = set()
    with open(enr_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            for col in ("y1_statefips", "y2_statefips"):
                v = row.get(col, "")
                if v in REQUIRED_SPECIAL_FIPS:
                    seen.add(v)
            if seen >= REQUIRED_SPECIAL_FIPS:
                break  # found all — no need to scan further

    missing = REQUIRED_SPECIAL_FIPS - seen
    if not missing:
        return True, f"special aggregate FIPS {sorted(REQUIRED_SPECIAL_FIPS)} all present"
    return False, f"missing special FIPS: {sorted(missing)}"


def check_connecticut(enr_path: Path) -> tuple[bool, str]:
    """
    Verify that all CT county rows resolve to a non-empty county name.

    Both 2021-22 and 2022-23 IRS county files use planning-region FIPS
    (09110-09190). This check confirms those codes resolve correctly.
    """
    ct_rows = 0
    empty_name = 0
    ct_fips_seen: set[str] = set()

    with open(enr_path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            for sf_col, name_col in [
                ("y2_statefips", "y2_county_name"),
                ("y1_statefips", "y1_county_name"),
            ]:
                if row.get(sf_col) == CT_FIPS:
                    cf = row.get(
                        "y2_countyfips" if sf_col == "y2_statefips" else "y1_countyfips", ""
                    )
                    ct_fips_seen.add(cf)
                    ct_rows += 1
                    if not row[name_col].strip():
                        empty_name += 1

    if ct_rows == 0:
        return True, "no CT rows found (skipped)"

    planning = {cf for cf in ct_fips_seen if cf.isdigit() and int(cf) >= 100}
    traditional = {cf for cf in ct_fips_seen if cf.isdigit() and 0 < int(cf) < 100}

    detail = (
        f"{ct_rows:,} CT rows — "
        f"planning-region FIPS {sorted(planning)}"
    )
    if traditional:
        detail += f", traditional county FIPS {sorted(traditional)}"

    if empty_name:
        return False, f"{empty_name:,} CT rows have empty county name — {detail}"
    return True, f"all CT county names resolved — {detail}"


# ---------------------------------------------------------------------------
# Per-file validation
# ---------------------------------------------------------------------------
def validate_file(
    orig: str,
    enr: str,
    kind: str,
    year_tag: str,
    quick: bool,
) -> bool:
    orig_path = Path(orig)
    enr_path  = Path(enr)

    print(f"\n{'─' * 70}")
    print(f"  {enr_path.name}  [{kind}, {year_tag}]")
    print(f"{'─' * 70}")

    # Check existence
    for p, label in [(orig_path, "original"), (enr_path, "enriched")]:
        if not p.exists():
            print(f"  ✗ MISSING {label} file: {p}")
            return False

    all_ok = True

    def report(ok: bool, msg: str, prefix: str = "") -> None:
        nonlocal all_ok
        icon = "✓" if ok else "✗"
        if not ok:
            all_ok = False
        print(f"  {icon} {prefix}{msg}")

    # 1. Row count
    ok, msg = check_row_count(orig_path, enr_path)
    report(ok, msg)

    if not quick:
        # 2. FIPS padding
        ok, msg = check_fips_padding(enr_path, kind)
        report(ok, msg)

        # 3. Empty values
        ok, err_msg, warn_msg = check_empty_values(enr_path, kind)
        report(ok, err_msg if not ok else err_msg)
        if warn_msg:
            print(f"  ⚠ {warn_msg}")

        # 4. Special FIPS codes
        ok, msg = check_special_fips(enr_path)
        report(ok, msg)

        # 5. Connecticut (county files only)
        if kind == "county":
            ok, msg = check_connecticut(enr_path)
            report(ok, msg)

    return all_ok


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    quick = "--quick" in sys.argv

    print("=" * 70)
    print("  IRS Migration Data — Validation Report (Milestone 1.4)")
    print("=" * 70)
    if quick:
        print("  Mode: quick (row-count only, no per-row scans)")

    total = 0
    passed = 0

    for orig, enr, kind, year_tag in FILE_PAIRS:
        total += 1
        ok = validate_file(orig, enr, kind, year_tag, quick)
        if ok:
            passed += 1

    print(f"\n{'=' * 70}")
    print(f"  Result: {passed}/{total} files passed all checks")
    if passed == total:
        print("  ✓ All validations passed.")
    else:
        print(f"  ✗ {total - passed} file(s) failed — see details above.")
    print("=" * 70)

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
