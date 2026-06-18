"""
enrich_state_data.py — Milestone 1.2

Enriches any IRS state inflow or outflow CSV by adding missing state info and
writing a standardised output schema:

    y2_state, y2_state_name, y2_statefips,
    y1_statefips, y1_state, y1_state_name,
    n1, n2, AGI

Lookup source: state_fips.csv — produced by parse_fips.py from the Census
all-geocodes-v2021.csv. State FIPS codes are identical across vintages, so a
single file covers all year-ranges (2021–22 and 2022–23).

Inflow files  (e.g. stateinflow2122.csv):
    y2 = destination state — only y2_statefips present; y2_state and
    y2_state_name must be derived from the FIPS lookup.

Outflow files (e.g. stateoutflow2122.csv):
    y1 = origin state — only y1_statefips present; y1_state and
    y1_state_name must be derived from the FIPS lookup.

Both sides are always re-derived from the lookup so the output is clean and
consistent regardless of the raw IRS labelling.

Usage
-----
    python enrich_state_data.py <input_csv> <output_csv>   # single file
    python enrich_state_data.py                            # batch (all four)
"""

import csv
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
STATE_FIPS_CSV = Path("data/fips/state_fips.csv")

BATCH_FILES: list[tuple[str, str]] = [
    # Inflow
    ("data/original/state_inflow/stateinflow1011.csv",    "data/enriched/state_inflow/stateinflow1011_enriched.csv"),
    ("data/original/state_inflow/stateinflow1112.csv",    "data/enriched/state_inflow/stateinflow1112_enriched.csv"),
    ("data/original/state_inflow/stateinflow1213.csv",    "data/enriched/state_inflow/stateinflow1213_enriched.csv"),
    ("data/original/state_inflow/stateinflow1314.csv",    "data/enriched/state_inflow/stateinflow1314_enriched.csv"),
    ("data/original/state_inflow/stateinflow1415.csv",    "data/enriched/state_inflow/stateinflow1415_enriched.csv"),
    ("data/original/state_inflow/stateinflow1516.csv",    "data/enriched/state_inflow/stateinflow1516_enriched.csv"),
    ("data/original/state_inflow/stateinflow1617.csv",    "data/enriched/state_inflow/stateinflow1617_enriched.csv"),
    ("data/original/state_inflow/stateinflow1718.csv",    "data/enriched/state_inflow/stateinflow1718_enriched.csv"),
    ("data/original/state_inflow/stateinflow1819.csv",    "data/enriched/state_inflow/stateinflow1819_enriched.csv"),
    ("data/original/state_inflow/stateinflow1920.csv",    "data/enriched/state_inflow/stateinflow1920_enriched.csv"),
    ("data/original/state_inflow/stateinflow2021.csv",    "data/enriched/state_inflow/stateinflow2021_enriched.csv"),
    ("data/original/state_inflow/stateinflow2122.csv",    "data/enriched/state_inflow/stateinflow2122_enriched.csv"),
    ("data/original/state_inflow/stateinflow2223.csv",    "data/enriched/state_inflow/stateinflow2223_enriched.csv"),
    # Outflow
    ("data/original/state_outflow/stateoutflow1011.csv",  "data/enriched/state_outflow/stateoutflow1011_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1112.csv",  "data/enriched/state_outflow/stateoutflow1112_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1213.csv",  "data/enriched/state_outflow/stateoutflow1213_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1314.csv",  "data/enriched/state_outflow/stateoutflow1314_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1415.csv",  "data/enriched/state_outflow/stateoutflow1415_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1516.csv",  "data/enriched/state_outflow/stateoutflow1516_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1617.csv",  "data/enriched/state_outflow/stateoutflow1617_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1718.csv",  "data/enriched/state_outflow/stateoutflow1718_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1819.csv",  "data/enriched/state_outflow/stateoutflow1819_enriched.csv"),
    ("data/original/state_outflow/stateoutflow1920.csv",  "data/enriched/state_outflow/stateoutflow1920_enriched.csv"),
    ("data/original/state_outflow/stateoutflow2021.csv",  "data/enriched/state_outflow/stateoutflow2021_enriched.csv"),
    ("data/original/state_outflow/stateoutflow2122.csv",  "data/enriched/state_outflow/stateoutflow2122_enriched.csv"),
    ("data/original/state_outflow/stateoutflow2223.csv",  "data/enriched/state_outflow/stateoutflow2223_enriched.csv"),
]

# Special FIPS codes not present in state_fips.csv
SPECIAL_FIPS: dict[str, tuple[str, str]] = {
    "57": ("FR",    "Foreign"),
    "96": ("US+FO", "Total Migration-US and Foreign"),
    "97": ("US",    "Total Migration-US"),
    "98": ("FO",    "Total Migration-Foreign"),
}

# Standardised output schema — identical for inflow and outflow
OUTPUT_FIELDS = [
    "y2_state", "y2_state_name", "y2_statefips",
    "y1_statefips", "y1_state", "y1_state_name",
    "n1", "n2", "AGI",
]


# ---------------------------------------------------------------------------
# FIPS lookup
# ---------------------------------------------------------------------------
def load_state_fips(path: Path = STATE_FIPS_CSV) -> dict[str, tuple[str, str]]:
    """Load state_fips.csv + special codes → {fips: (postal, name)}."""
    lookup: dict[str, tuple[str, str]] = {}
    with open(path, newline="", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            fips = row["fips_code"].strip().zfill(2)
            lookup[fips] = (row["state_postal"].strip(), row["state_name"].strip())
    lookup.update(SPECIAL_FIPS)
    return lookup


def get_state_info(raw_fips: str, lookup: dict[str, tuple[str, str]]) -> tuple[str, str]:
    """Return (postal, name) for a state FIPS code (padded or un-padded)."""
    return lookup.get(raw_fips.strip().zfill(2), ("", ""))


# ---------------------------------------------------------------------------
# Direction detection
# ---------------------------------------------------------------------------
def detect_direction(fieldnames: list[str]) -> str:
    """
    Return 'inflow' or 'outflow' by inspecting which state columns are present.

    Inflow  → raw file has y1_state / y1_state_name (origin info already there)
              but is missing y2_state / y2_state_name for the destination.
    Outflow → raw file has y2_state / y2_state_name (destination info already there)
              but is missing y1_state / y1_state_name for the origin.
    """
    has_y1_state = "y1_state" in fieldnames
    has_y2_state = "y2_state" in fieldnames
    if has_y1_state and not has_y2_state:
        return "inflow"
    if has_y2_state and not has_y1_state:
        return "outflow"
    # Fallback: first column convention (inflow: y2_statefips first)
    return "inflow" if fieldnames[0].startswith("y2") else "outflow"


# ---------------------------------------------------------------------------
# Core enrichment
# ---------------------------------------------------------------------------
def enrich(
    input_path: str | Path,
    output_path: str | Path,
    lookup: dict[str, tuple[str, str]],
) -> int:
    """
    Read *input_path*, produce the standardised 9-column output in *output_path*.
    Returns the number of data rows written.
    """
    input_path = Path(input_path)
    output_path = Path(output_path)
    missing: set[tuple[str, str]] = set()
    rows_written = 0

    with (
        open(input_path, newline="", encoding="utf-8") as fh_in,
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
            # Zero-pad to canonical 2-digit width so the writer always
            # outputs a string like "01" rather than the raw integer "1".
            y2_sf = row["y2_statefips"].strip().zfill(2)
            y1_sf = row["y1_statefips"].strip().zfill(2)

            # Derive both sides from lookup (clean, consistent values)
            y2_state, y2_state_name = get_state_info(y2_sf, lookup)
            y1_state, y1_state_name = get_state_info(y1_sf, lookup)

            # Fallback to raw file values only for the side that already had data
            # (guards against lookup gaps for edge-case FIPS codes)
            if not y2_state and direction == "outflow":
                y2_state = row.get("y2_state", "")
                y2_state_name = row.get("y2_state_name", "")
            if not y1_state and direction == "inflow":
                y1_state = row.get("y1_state", "")
                y1_state_name = row.get("y1_state_name", "")

            # If the raw data contained "Non-migrants", "Total Migration-Same State", 
            # or "Total Migration-US and Foreign", ensure it is NOT overwritten by the lookup.
            if direction == "inflow":
                raw_y1_name = row.get("y1_state_name", "")
                if any(sub in raw_y1_name for sub in ["Non-migrants", "Total Migration-Same State", "Total Migration-US and Foreign"]):
                    y1_state_name = raw_y1_name
            elif direction == "outflow":
                raw_y2_name = row.get("y2_state_name", "")
                if any(sub in raw_y2_name for sub in ["Non-migrants", "Total Migration-Same State", "Total Migration-US and Foreign"]):
                    y2_state_name = raw_y2_name

            writer.writerow({
                "y2_state":      y2_state,
                "y2_state_name": y2_state_name,
                "y2_statefips":  y2_sf,
                "y1_statefips":  y1_sf,
                "y1_state":      y1_state,
                "y1_state_name": y1_state_name,
                "n1":            row["n1"],
                "n2":            row["n2"],
                "AGI":           row.get("AGI", row.get("agi", "")),
            })
            rows_written += 1

    if missing:
        sample = sorted(missing)[:10]
        print(f"    WARNING: unresolved FIPS codes: {sample}")

    return rows_written


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main() -> None:
    if len(sys.argv) == 3:
        # ── Single-file mode ──────────────────────────────────────────────
        if not STATE_FIPS_CSV.exists():
            sys.exit(f"ERROR: {STATE_FIPS_CSV} not found. Run parse_fips.py first.")
        lookup = load_state_fips()
        n = enrich(sys.argv[1], sys.argv[2], lookup)
        print(f"  Wrote {n:,} rows → {sys.argv[2]}")

    elif len(sys.argv) == 1:
        # ── Batch mode ────────────────────────────────────────────────────
        if not STATE_FIPS_CSV.exists():
            sys.exit(f"ERROR: {STATE_FIPS_CSV} not found. Run parse_fips.py first.")
        lookup = load_state_fips()
        print(f"Loaded {len(lookup)} FIPS entries (including special codes)\n")

        for src, dst in BATCH_FILES:
            if not Path(src).exists():
                print(f"  SKIP: {src} not found")
                continue
            n = enrich(src, dst, lookup)
            print(f"    → {n:,} rows written ✓\n")

        print("Done.")

    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
