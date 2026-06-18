"""
enrich_county_data.py — Milestone 1.3

Enriches any IRS county inflow or outflow CSV by adding missing county/state
info and writing a standardised output schema:

    y2_state, y2_state_name, y2_statefips, y2_countyfips, y2_county_name,
    y1_statefips, y1_countyfips, y1_state, y1_state_name, y1_county_name,
    n1, n2, AGI

Lookup source: county_fips.csv — a unified file produced by parse_fips.py that
combines rows from both Census geocode vintages:
  • All counties from all-geocodes-v2021.csv (covers 2021–22 IRS FIPS codes)
  • Connecticut planning-region rows from all-geocodes-v2025.csv appended
    (covers 2022–23 IRS FIPS codes for CT: 09110–09190)
  A single lookup therefore resolves county names for both 2021–22 and 2022–23
  IRS data without needing per-file FIPS selection.

Inflow files  (e.g. countyinflow2122.csv):
    y2 = destination county — only y2_statefips + y2_countyfips present;
    y2_state, y2_state_name, y2_county_name must be derived from the lookup.
    y1 = origin — raw file has y1_state (postal) and y1_countyname; only
    y1_state_name must be added from the lookup.

Outflow files (e.g. countyoutflow2122.csv):
    y1 = origin county — only y1_statefips + y1_countyfips present;
    y1_state, y1_state_name, y1_county_name must be derived from the lookup.
    y2 = destination — raw file has y2_state (postal) and y2_countyname;
    only y2_state_name must be added from the lookup.

Special aggregate FIPS codes used by IRS (not real geographies):
  State-level:  96 = US+Foreign total, 97 = US total, 98 = Foreign total,
                57 = Foreign
  County-level: 000 = state aggregate, 001 = same-state total,
                003 = different-state total
These receive canonical descriptive labels so no row is left blank.

Usage
-----
    python enrich_county_data.py <input_csv> <output_csv>   # single file
    python enrich_county_data.py                            # batch (all four)
"""

import csv
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
COUNTY_FIPS_CSV = Path("data/fips/county_fips.csv")

BATCH_FILES: list[tuple[str, str]] = [
    # Inflow
    ("data/original/county_inflow/countyinflow0809.csv",    "data/enriched/county_inflow/countyinflow0809_enriched.csv"),
    ("data/original/county_inflow/countyinflow0910.csv",    "data/enriched/county_inflow/countyinflow0910_enriched.csv"),
    ("data/original/county_inflow/countyinflow1011.csv",    "data/enriched/county_inflow/countyinflow1011_enriched.csv"),
    ("data/original/county_inflow/countyinflow1112.csv",    "data/enriched/county_inflow/countyinflow1112_enriched.csv"),
    ("data/original/county_inflow/countyinflow1213.csv",    "data/enriched/county_inflow/countyinflow1213_enriched.csv"),
    ("data/original/county_inflow/countyinflow1314.csv",    "data/enriched/county_inflow/countyinflow1314_enriched.csv"),
    ("data/original/county_inflow/countyinflow1415.csv",    "data/enriched/county_inflow/countyinflow1415_enriched.csv"),
    ("data/original/county_inflow/countyinflow1516.csv",    "data/enriched/county_inflow/countyinflow1516_enriched.csv"),
    ("data/original/county_inflow/countyinflow1617.csv",    "data/enriched/county_inflow/countyinflow1617_enriched.csv"),
    ("data/original/county_inflow/countyinflow1718.csv",    "data/enriched/county_inflow/countyinflow1718_enriched.csv"),
    ("data/original/county_inflow/countyinflow1819.csv",    "data/enriched/county_inflow/countyinflow1819_enriched.csv"),
    ("data/original/county_inflow/countyinflow1920.csv",    "data/enriched/county_inflow/countyinflow1920_enriched.csv"),
    ("data/original/county_inflow/countyinflow2021.csv",    "data/enriched/county_inflow/countyinflow2021_enriched.csv"),
    ("data/original/county_inflow/countyinflow2122.csv",    "data/enriched/county_inflow/countyinflow2122_enriched.csv"),
    ("data/original/county_inflow/countyinflow2223.csv",    "data/enriched/county_inflow/countyinflow2223_enriched.csv"),
    # Outflow
    ("data/original/county_outflow/countyoutflow0809.csv",  "data/enriched/county_outflow/countyoutflow0809_enriched.csv"),
    ("data/original/county_outflow/countyoutflow0910.csv",  "data/enriched/county_outflow/countyoutflow0910_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1011.csv",  "data/enriched/county_outflow/countyoutflow1011_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1112.csv",  "data/enriched/county_outflow/countyoutflow1112_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1213.csv",  "data/enriched/county_outflow/countyoutflow1213_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1314.csv",  "data/enriched/county_outflow/countyoutflow1314_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1415.csv",  "data/enriched/county_outflow/countyoutflow1415_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1516.csv",  "data/enriched/county_outflow/countyoutflow1516_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1617.csv",  "data/enriched/county_outflow/countyoutflow1617_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1718.csv",  "data/enriched/county_outflow/countyoutflow1718_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1819.csv",  "data/enriched/county_outflow/countyoutflow1819_enriched.csv"),
    ("data/original/county_outflow/countyoutflow1920.csv",  "data/enriched/county_outflow/countyoutflow1920_enriched.csv"),
    ("data/original/county_outflow/countyoutflow2021.csv",  "data/enriched/county_outflow/countyoutflow2021_enriched.csv"),
    ("data/original/county_outflow/countyoutflow2122.csv",  "data/enriched/county_outflow/countyoutflow2122_enriched.csv"),
    ("data/original/county_outflow/countyoutflow2223.csv",  "data/enriched/county_outflow/countyoutflow2223_enriched.csv"),
]

# Special state-level FIPS codes not present in county_fips.csv
SPECIAL_STATE_FIPS: dict[str, tuple[str, str]] = {
    "57": ("FR",    "Foreign"),
    "96": ("US+FO", "Total Migration-US and Foreign"),
    "97": ("US",    "Total Migration-US"),
    "98": ("FO",    "Total Migration-Foreign"),
}

# Special county-level aggregate codes (3-digit zero-padded)
SPECIAL_COUNTY_FIPS: dict[str, str] = {
    "000": "Total (State Aggregate)",
    "001": "Total (Same State)",
    "003": "Total (Different State)",
}

# Standardised output schema — identical for inflow and outflow
OUTPUT_FIELDS = [
    "y2_state", "y2_state_name", "y2_statefips", "y2_countyfips", "y2_county_name",
    "y1_statefips", "y1_countyfips", "y1_state", "y1_state_name", "y1_county_name",
    "n1", "n2", "AGI",
]


# ---------------------------------------------------------------------------
# FIPS lookup
# ---------------------------------------------------------------------------
def load_county_fips(
    path: Path = COUNTY_FIPS_CSV,
) -> tuple[
    dict[tuple[str, str], tuple[str, str, str]],  # county lookup
    dict[str, tuple[str, str]],                    # state-only lookup
]:
    """
    Load the unified county_fips.csv into two lookups.

    The file contains rows from both Census geocode vintages so a single load
    covers both 2021–22 and 2022–23 IRS county data, including Connecticut's
    traditional counties (FIPS 001–015) and planning regions (FIPS 110–190).

    Returns
    -------
    county_lookup : {(state_fips, county_fips) -> (postal, state_name, county_name)}
    state_lookup  : {state_fips -> (postal, state_name)}  (derived from county rows)
    """
    county_lookup: dict[tuple[str, str], tuple[str, str, str]] = {}
    state_lookup: dict[str, tuple[str, str]] = {}

    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            sf = row["state_fips"].strip().zfill(2)
            cf = row["county_fips"].strip().zfill(3)
            postal = row["state_postal"].strip()
            state_name = row["state_name"].strip()
            county_name = row["county_name"].strip()
            county_lookup[(sf, cf)] = (postal, state_name, county_name)
            if sf not in state_lookup:
                state_lookup[sf] = (postal, state_name)

    # Merge special state codes into state_lookup
    state_lookup.update(SPECIAL_STATE_FIPS)
    return county_lookup, state_lookup


def resolve(
    raw_state_fips: str,
    raw_county_fips: str,
    county_lookup: dict[tuple[str, str], tuple[str, str, str]],
    state_lookup: dict[str, tuple[str, str]],
) -> tuple[str, str, str]:
    sf = raw_state_fips.strip().zfill(2)
    cf = raw_county_fips.strip().zfill(3)

    # 1. Special state aggregate codes (96, 97, 98, 57)
    if sf in SPECIAL_STATE_FIPS:
        postal, state_name = SPECIAL_STATE_FIPS[sf]
        county_label = SPECIAL_COUNTY_FIPS.get(cf, f"Aggregate (county {int(cf)})")
        return postal, state_name, county_label

    # 2. Real state, special state-wide aggregate (000)
    if cf == "000":
        postal, state_name = state_lookup.get(sf, ("", ""))
        return postal, state_name, SPECIAL_COUNTY_FIPS["000"]

    # 3. Normal lookup (001 and 003 now safely pass through)
    result = county_lookup.get((sf, cf))
    if result:
        return result

    return "", "", ""


# ---------------------------------------------------------------------------
# Direction detection
# ---------------------------------------------------------------------------
def detect_direction(fieldnames: list[str]) -> str:
    """
    Return 'inflow' or 'outflow' based on which columns are present.

    Inflow  → has y1_state / y1_countyname (origin info); missing y2 names.
    Outflow → has y2_state / y2_countyname (destination info); missing y1 names.
    """
    if "y1_state" in fieldnames and "y2_state" not in fieldnames:
        return "inflow"
    if "y2_state" in fieldnames and "y1_state" not in fieldnames:
        return "outflow"
    return "inflow" if fieldnames[0].startswith("y2") else "outflow"


# ---------------------------------------------------------------------------
# Core enrichment
# ---------------------------------------------------------------------------
def enrich(
    input_path: str | Path,
    output_path: str | Path,
    county_lookup: dict[tuple[str, str], tuple[str, str, str]],
    state_lookup: dict[str, tuple[str, str]],
) -> int:
    """
    Read *input_path*, enrich it using the unified county_fips.csv lookup, and
    write the standardised 13-column output to *output_path*.

    The same lookup resolves both 2021–22 rows (which use pre-2022 county FIPS)
    and 2022–23 rows (which use CT planning-region FIPS 110–190), because
    county_fips.csv contains both sets of geographies.

    Returns the number of data rows written.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    missing: set[tuple[str, str, str]] = set()
    rows_written = 0

    with (
        open(input_path, newline="", encoding="latin-1") as fh_in,
        open(output_path, "w", newline="", encoding="utf-8") as fh_out,
    ):
        reader = csv.DictReader(fh_in)
        if not reader.fieldnames:
            raise ValueError(f"Empty or header-less file: {input_path}")

        direction = detect_direction(list(reader.fieldnames))
        print(f"  [{direction}] {input_path.name}")

        writer = csv.DictWriter(fh_out, fieldnames=OUTPUT_FIELDS)
        writer.writeheader()

        for row in reader:
            # Zero-pad FIPS codes to their canonical widths as strings so all
            # downstream uses (lookup, missing-set, CSV output) are consistent.
            y2_sf = row["y2_statefips"].strip().zfill(2)
            y2_cf = row["y2_countyfips"].strip().zfill(3)
            y1_sf = row["y1_statefips"].strip().zfill(2)
            y1_cf = row["y1_countyfips"].strip().zfill(3)

            if direction == "inflow":
                # y2 (destination) is missing — derive from lookup
                y2_state, y2_state_name, y2_county_name = resolve(
                    y2_sf, y2_cf, county_lookup, state_lookup
                )
                y1_state = row.get("y1_state", "")
                y1_raw_county = row.get("y1_countyname", "")
                
                # --- TRUNCATION-SAFE FIX ---
                # Shortened to "Total Migration" to catch truncated IRS county strings
                if any(sub in y1_raw_county for sub in ["Non-migrants", "Total Migration"]):
                    y1_county_name = y1_raw_county
                    _, y1_state_name = state_lookup.get(y1_sf, (y1_state, ""))
                    if not y1_state_name:
                        y1_state_name = row.get("y1_state_name", "")
                else:
                    _, _, y1_county_name_full = resolve(y1_sf, y1_cf, county_lookup, state_lookup)
                    y1_county_name = y1_county_name_full if y1_county_name_full else y1_raw_county
                    _, y1_state_name = state_lookup.get(y1_sf, (y1_state, ""))
                    if not y1_state_name:
                        y1_state_name = row.get("y1_state_name", "")

            else:  # outflow
                # y1 (origin) is missing — derive from lookup
                y1_state, y1_state_name, y1_county_name = resolve(
                    y1_sf, y1_cf, county_lookup, state_lookup
                )
                y2_state = row.get("y2_state", "")
                y2_raw_county = row.get("y2_countyname", "")
                
                # --- TRUNCATION-SAFE FIX ---
                # Shortened to "Total Migration" to catch truncated IRS county strings
                if any(sub in y2_raw_county for sub in ["Non-migrants", "Total Migration"]):
                    y2_county_name = y2_raw_county
                    _, y2_state_name = state_lookup.get(y2_sf, (y2_state, ""))
                    if not y2_state_name:
                        y2_state_name = row.get("y2_state_name", "")
                else:
                    _, _, y2_county_name_full = resolve(y2_sf, y2_cf, county_lookup, state_lookup)
                    y2_county_name = y2_county_name_full if y2_county_name_full else y2_raw_county
                    _, y2_state_name = state_lookup.get(y2_sf, (y2_state, ""))
                    if not y2_state_name:
                        y2_state_name = row.get("y2_state_name", "")

            # Track unresolved codes (already padded)
            if not y2_state:
                missing.add(("y2", y2_sf, y2_cf))
            if not y1_state:
                missing.add(("y1", y1_sf, y1_cf))

            writer.writerow({
                "y2_state":       y2_state,
                "y2_state_name":  y2_state_name,
                "y2_statefips":   y2_sf,
                "y2_countyfips":  y2_cf,
                "y2_county_name": y2_county_name,
                "y1_statefips":   y1_sf,
                "y1_countyfips":  y1_cf,
                "y1_state":       y1_state,
                "y1_state_name":  y1_state_name,
                "y1_county_name": y1_county_name,
                "n1":             row["n1"],
                "n2":             row["n2"],
                "AGI":            row.get("AGI", row.get("agi", "")),
            })
            rows_written += 1

    if missing:
        sample = sorted(missing)[:10]
        print(f"    WARNING: unresolved (state, county) FIPS pairs: {sample}")

    return rows_written


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    if len(sys.argv) == 3:
        # ── Single-file mode ──────────────────────────────────────────────
        if not COUNTY_FIPS_CSV.exists():
            sys.exit(
                f"ERROR: {COUNTY_FIPS_CSV} not found. Run parse_fips.py first.\n"
                "  parse_fips.py produces a unified lookup covering both pre-2022\n"
                "  county definitions and 2022+ CT planning regions."
            )
        county_lookup, state_lookup = load_county_fips()
        n = enrich(sys.argv[1], sys.argv[2], county_lookup, state_lookup)
        print(f"  Wrote {n:,} rows → {sys.argv[2]}")

    elif len(sys.argv) == 1:
        # ── Batch mode ────────────────────────────────────────────────────
        if not COUNTY_FIPS_CSV.exists():
            sys.exit(
                f"ERROR: {COUNTY_FIPS_CSV} not found. Run parse_fips.py first.\n"
                "  parse_fips.py produces a unified lookup covering both pre-2022\n"
                "  county definitions and 2022+ CT planning regions."
            )
        county_lookup, state_lookup = load_county_fips()
        print(
            f"Loaded {len(county_lookup):,} county FIPS entries "
            f"(unified: pre-2022 counties + CT planning regions)\n"
        )

        for src, dst in BATCH_FILES:
            if not Path(src).exists():
                print(f"  SKIP: {src} not found")
                continue
            n = enrich(src, dst, county_lookup, state_lookup)
            print(f"    → {n:,} rows written ✓\n")

        print("Done.")

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
