# U.S. Migration Explorer

An interactive choropleth visualization of U.S. domestic migration patterns using
[IRS Statistics of Income (SOI)](https://www.irs.gov/statistics/soi-tax-stats-migration-data)
tax data from 2020 to 2023. Explore population, household, and income flows at the
**state** and **county** level through a D3.js-powered map and time-series chart.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Project Structure](#project-structure)
3. [Data Preparation](#data-preparation)
  - [Step 1 — Place raw source files](#step-1--place-raw-source-files)
  - [Step 2 — Parse FIPS lookups](#step-2--parse-fips-lookups)
  - [Step 3 — Enrich migration CSVs](#step-3--enrich-migration-csvs)
  - [Step 4 — Validate enriched files](#step-4--validate-enriched-files)
4. [Running the Visualization](#running-the-visualization)
5. [Data Notes](#data-notes)
6. [Metrics Reference](#metrics-reference)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Python** | 3.10 or later | Only the standard library is used — no `pip install` required |
| **A modern web browser** | Chrome, Firefox, Safari, or Edge | D3.js v7 is loaded from a CDN |
| **A local HTTP server** | Any (see below) | Required to load CSV files via `fetch()` — opening `index.html` directly with `file://` will be blocked by CORS |

---

## Project Structure

```
IRSMigrationDataProject/
├── index.html                          # Visualization entry point
├── styles.css                          # Design system (Milestone 2.2)
├── script.js                           # D3 logic (Phases 3–5)
│
├── scripts/
│   ├── parse_fips.py                   # Step 2: build FIPS lookup CSVs
│   ├── enrich_state_data.py            # Step 3a: enrich state migration files
│   ├── enrich_county_data.py           # Step 3b: enrich county migration files
│   └── validate_data.py                # Step 4: validate all enriched outputs
│
└── data/
    ├── fips/
    │   ├── all-geocodes-v2021.csv      # Census geocode source (pre-2022 definitions)
    │   ├── all-geocodes-v2025.csv      # Census geocode source (2022+ CT planning regions)
    │   ├── state_fips.csv              # Generated — do not edit manually
    │   └── county_fips.csv             # Generated — do not edit manually
    │
    ├── original/
    │   ├── state_inflow/               # stateinflow2021.csv, 2122.csv, 2223.csv
    │   ├── state_outflow/              # stateoutflow2021.csv, 2122.csv, 2223.csv
    │   ├── county_inflow/              # countyinflow2021.csv, 2122.csv, 2223.csv
    │   └── county_outflow/             # countyoutflow2021.csv, 2122.csv, 2223.csv
    │
    └── enriched/
        ├── state_inflow/               # stateinflow*_enriched.csv  — generated
        ├── state_outflow/              # stateoutflow*_enriched.csv — generated
        ├── county_inflow/              # countyinflow*_enriched.csv — generated
        └── county_outflow/             # countyoutflow*_enriched.csv — generated
```

---

## Data Preparation

All scripts must be run **from the project root** (the directory containing `index.html`).

### Step 1 — Place raw source files

Download the following files and place them in the directories shown:

#### IRS SOI migration data → `data/original/`

Download from [IRS SOI Migration Data](https://www.irs.gov/statistics/soi-tax-stats-migration-data).

| File | Destination |
|---|---|
| `stateinflow2021.csv` | `data/original/state_inflow/` |
| `stateinflow2122.csv` | `data/original/state_inflow/` |
| `stateinflow2223.csv` | `data/original/state_inflow/` |
| `stateoutflow2021.csv` | `data/original/state_outflow/` |
| `stateoutflow2122.csv` | `data/original/state_outflow/` |
| `stateoutflow2223.csv` | `data/original/state_outflow/` |
| `countyinflow2021.csv` | `data/original/county_inflow/` |
| `countyinflow2122.csv` | `data/original/county_inflow/` |
| `countyinflow2223.csv` | `data/original/county_inflow/` |
| `countyoutflow2021.csv` | `data/original/county_outflow/` |
| `countyoutflow2122.csv` | `data/original/county_outflow/` |
| `countyoutflow2223.csv` | `data/original/county_outflow/` |

#### U.S. Census geocode files → `data/fips/`

Download from [Census Gazetteer / Geocodes](https://www.census.gov/geographies/reference-files/time-series/geo/gazetteer-files.html)
(or the Census FTP archive):

| File | Destination | Notes |
|---|---|---|
| `all-geocodes-v2021.csv` | `data/fips/` | Pre-2022 county definitions |
| `all-geocodes-v2025.csv` | `data/fips/` | Includes CT planning regions |

#### Note on the Data Preparation Script

It is possible to prepare the data in just one command:

```bash
python scripts/enrich_data.py
```

However, steps 2, 3, and 4 explain the role of the individual commands executed in the aforementioned one-command script.

### Step 2 — Parse FIPS lookups

```bash
python scripts/parse_fips.py
```

**What it does:** Reads both Census geocode CSVs and writes two unified lookup files:

- `data/fips/state_fips.csv` — `fips_code`, `state_name`, `state_postal`
- `data/fips/county_fips.csv` — `state_fips`, `county_fips`, `county_name`, `state_name`, `state_postal`
  (combines all pre-2022 counties **plus** Connecticut's 9 planning regions from the 2025 vintage)

**Expected output:**
```
Parsing data/fips/all-geocodes-v2021.csv …
  52 state entries, 3,221 county entries
...
  Wrote 52 rows → data/fips/state_fips.csv
  Wrote 3,230 rows → data/fips/county_fips.csv
✓ Both pre-2022 and 2022+ CT geographies are present
```

> **Note:** You will see a warning that Puerto Rico (FIPS 72) has no postal code. This is expected — Puerto Rico is not included in the IRS migration data.

### Step 3 — Enrich migration CSVs

Run the two enrichment scripts in either order:

```bash
python scripts/enrich_state_data.py
python scripts/enrich_county_data.py
```

Each script reads the raw IRS files from `data/original/` and writes enriched versions to
`data/enriched/`, adding the missing state name, state postal code, and county name columns
derived from the FIPS lookup files.

**Enriched state schema:**
```
y2_state, y2_state_name, y2_statefips,
y1_statefips, y1_state, y1_state_name,
n1, n2, AGI
```

**Enriched county schema:**
```
y2_state, y2_state_name, y2_statefips, y2_countyfips, y2_county_name,
y1_statefips, y1_countyfips, y1_state, y1_state_name, y1_county_name,
n1, n2, AGI
```

> All FIPS codes in the enriched files are **zero-padded strings** (2 digits for state, 3 for county),
> not integers.

### Step 4 — Validate enriched files

```bash
python scripts/validate_data.py
```

Checks all 12 enriched files against five criteria and prints a pass/fail report:

1. Row counts match raw originals
2. No unexpected empty values in key columns
3. Special aggregate FIPS codes (96, 97, 98) are present
4. All FIPS codes are correctly zero-padded
5. All Connecticut county rows resolve to a non-empty name

A clean run ends with:
```
Result: 12/12 files passed all checks
✓ All validations passed.
```

For a faster row-count-only check:
```bash
python scripts/validate_data.py --quick
```

---

## Running the Visualization

Because `script.js` loads data via `fetch()`, you need a local HTTP server — opening
`index.html` directly with `file://` will fail due to browser CORS restrictions.

**Option A — Python (no extra install):**
```bash
python -m http.server 8080
```
Then open [http://localhost:8080](http://localhost:8080) in your browser.

**Option B — Node.js `serve` (if Node is installed):**
```bash
npx serve .
```

**Option C — VS Code Live Server extension:**
Right-click `index.html` → *Open with Live Server*.

---

## Data Notes

| Column | Meaning |
|---|---|
| `y1` | Receiving geography (inflow files) / origin geography (outflow files) |
| `y2` | Sending geography (inflow files) / destination geography (outflow files) |
| `n1` | Number of households |
| `n2` | Number of individuals |
| `AGI` | Adjusted gross income (thousands of dollars) |

**Special aggregate FIPS codes** used by the IRS (not real geographies):

| State FIPS | Meaning |
|---|---|
| `96` | Total migration — U.S. and Foreign |
| `97` | Total migration — U.S. only |
| `98` | Total migration — Foreign only |
| `57` | Foreign |
| `58` | Same-state aggregate (no label; pass-through from raw file) |
| `59` | Different-state aggregate (no label; pass-through from raw file) |

**Connecticut geography change:** Starting with the 2021–22 IRS files, Connecticut's
8 traditional counties were replaced by 9 planning regions in the Census FIPS system.
The unified `county_fips.csv` includes both sets of geographies so all year-ranges
resolve correctly without any per-file handling.

---

## Metrics Reference

The visualization supports all 22 metrics from SPECS.md:

| Group | Metrics |
|---|---|
| **Population** | Inflow · Outflow · Net · Inflow share · Outflow share · Net share |
| **Households** | Inflow · Outflow · Net · Inflow share · Outflow share · Net share |
| **AGI** | Inflow · Outflow · Net · Inflow share · Outflow share · Net share |
| **Average AGI** | Avg per individual moving in · Avg per household moving in · Avg per individual moving out · Avg per household moving out |

"Share" metrics express a region's flow as a fraction of its **total** flow (IRS aggregate code `96`).
