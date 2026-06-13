# IRS Migration Data Visualization — Implementation Plan

## Project Overview

Build an interactive, browser-based data visualization using D3.js that lets users explore IRS SOI
migration data at both the state and county level. Users will be able to select regions on a choropleth
map, examine pairwise migration flows, and trace trends across all available years via a line graph.

---

## Data Inventory

| File | Rows (approx.) | Description |
|---|---|---|
| `stateinflow2122.csv` | 2,856 | State-to-state inflow, 2021–22 |
| `stateinflow2223.csv` | 2,856 | State-to-state inflow, 2022–23 |
| `stateoutflow2122.csv` | 2,856 | State-to-state outflow, 2021–22 |
| `stateoutflow2223.csv` | 2,856 | State-to-state outflow, 2022–23 |
| `countyinflow2122.csv` | ~90,500 | County-to-county inflow, 2021–22 |
| `countyinflow2223.csv` | ~92,000 | County-to-county inflow, 2022–23 |
| `countyoutflow2122.csv` | ~90,400 | County-to-county outflow, 2021–22 |
| `countyoutflow2223.csv` | ~93,000 | County-to-county outflow, 2022–23 |
| `all-geocodes-v2021.csv` | ~38,000 | U.S. Census geocode lookup (pre-2022 county definitions) |
| `all-geocodes-v2025.csv` | ~38,000 | U.S. Census geocode lookup (2022+ definitions, incl. CT planning regions) |

**Key data notes:**
- `y1` = receiving geography (inflow files) / origin geography (outflow files)
- `y2` = sending geography (inflow files) / destination geography (outflow files)
- `n1` = households, `n2` = individuals, `AGI` = adjusted gross income (thousands of dollars)
- Special `y1_statefips` codes: `96` = US+Foreign total, `97` = US total, `98` = Foreign total
- County files use an additional `y1_countyfips` / `y2_countyfips` column
- **Connecticut geography change (2022):** The U.S. Census replaced Connecticut's 8 traditional
  counties with 9 planning regions. Both the 2021–22 and 2022–23 IRS county files use the
  planning-region FIPS codes (09110–09190). `all-geocodes-v2021.csv` has only the traditional
  counties; `all-geocodes-v2025.csv` adds the 9 planning regions. The unified `county_fips.csv`
  includes both sets so all IRS rows can be resolved.

---

## Phase 1 — Data Preparation (Python)

**Goal:** Produce clean, enriched CSV files ready for ingestion by the front-end.

### Milestone 1.1 — Parse FIPS Lookups (`parse_fips.py`)

Rewrite `parse_fips.py` to read **both** Census geocode CSVs and produce **two unified** CSV files:

- [x] `state_fips.csv` — columns: `fips_code`, `state_name`, `state_postal`
  (states are identical between both vintages; 2021 rows are used)
- [x] `county_fips.csv` — columns: `state_fips`, `county_fips`, `county_name`, `state_name`, `state_postal`
  Contains **all** counties from `all-geocodes-v2021.csv` **plus** the Connecticut planning-region
  rows from `all-geocodes-v2025.csv`. This means the single file covers both the 2021–22 IRS files
  (which reference Connecticut's traditional county FIPS) and the 2022–23 files (which reference
  planning-region FIPS), with no ambiguity because the old and new CT codes are disjoint.

Implementation notes:
- [x] Filter the geocode CSVs by Summary Level: `040` → state rows; `050` → county/planning-region rows.
- [x] Derive `state_postal` from a hard-coded name → abbreviation dictionary (all 50 states + DC).
- [x] For county rows, carry forward the state context from the `040` row with the matching `State FIPS Code`.
- [x] Merge step: start with all 2021 county rows, then append only the Connecticut rows from 2025
  (FIPS 09110–09190, 9 planning regions). Deduplicate on `(state_fips, county_fips)` so 2021 wins
  on any overlap.
- [x] Sanity-check: warn if any state rows have no postal code; confirm both old and new CT
  geographies are present in `county_fips.csv`.

**Output:** `state_fips.csv`, `county_fips.csv`

---

### Milestone 1.2 — Enrich State CSV Files (`enrich_state_data.py`)

General-purpose Python script that accepts any state inflow **or** outflow CSV and joins it
with `state_fips.csv` to add:

- [x] `y2_state_postal` — postal abbreviation of the receiving/destination state (`y2_statefips`)
- [x] `y2_state_name` — full name of the receiving/destination state

The script should be callable as:
```
python enrich_state_data.py <input_csv> <output_csv>
```

Batch-produce the four enriched files:
- [x] `stateinflow2122_enriched.csv`
- [x] `stateinflow2223_enriched.csv`
- [x] `stateoutflow2122_enriched.csv`
- [x] `stateoutflow2223_enriched.csv`

---

### Milestone 1.3 — Enrich County CSV Files (`enrich_county_data.py`)

General-purpose Python script that accepts any county inflow **or** outflow CSV and joins it
with the unified `county_fips.csv` (which contains both pre-2022 CT county codes and 2022+
CT planning-region codes) to add:

- [x] `y2_state_postal` — postal abbreviation for the `y2` state
- [x] `y2_state_name` — full name of the `y2` state
- [x] `y2_county_name` — county or planning-region name for the `y2` geography (joined on
  `y2_statefips` + `y2_countyfips`)

The script should be callable as:
```
python enrich_county_data.py <input_csv> <output_csv>
```

Batch-produce the four enriched files:
- [x] `countyinflow2122_enriched.csv`
- [x] `countyinflow2223_enriched.csv`
- [x] `countyoutflow2122_enriched.csv`
- [x] `countyoutflow2223_enriched.csv`

---

### Milestone 1.4 — Data Validation

After generating all enriched files, run `scripts/validate_data.py` which checks:
- [x] No unexpected empty values in key join columns (`state_postal`, `state_name`, `county_name`).
  IRS pseudo-FIPS 58 (same-state aggregate) and 59 (different-state aggregate) produce intentionally
  empty labels; these are reported as known warnings, not errors.
- [x] Row counts in every enriched file exactly match its raw original
- [x] Special aggregate FIPS codes (96, 97, 98) are present in every enriched file
- [x] All state FIPS are 2-digit zero-padded strings; all county FIPS are 3-digit zero-padded strings
- [x] Connecticut county rows all resolve to a non-empty county/planning-region name.
  Confirmed by validation: 2020–21 IRS files use traditional county FIPS (001–015);
  2021–22 and 2022–23 IRS files use planning-region FIPS (110–190). Both resolve correctly
  against the unified `county_fips.csv`.

**Deliverables for Phase 1:**
```
scripts/validate_data.py
data/fips/state_fips.csv
data/fips/county_fips.csv
data/enriched/state_inflow/stateinflow2021_enriched.csv
data/enriched/state_inflow/stateinflow2122_enriched.csv
data/enriched/state_inflow/stateinflow2223_enriched.csv
data/enriched/state_outflow/stateoutflow2021_enriched.csv
data/enriched/state_outflow/stateoutflow2122_enriched.csv
data/enriched/state_outflow/stateoutflow2223_enriched.csv
data/enriched/county_inflow/countyinflow2021_enriched.csv
data/enriched/county_inflow/countyinflow2122_enriched.csv
data/enriched/county_inflow/countyinflow2223_enriched.csv
data/enriched/county_outflow/countyoutflow2021_enriched.csv
data/enriched/county_outflow/countyoutflow2122_enriched.csv
data/enriched/county_outflow/countyoutflow2223_enriched.csv
```

---

## Phase 2 — Project Scaffold & Design System

**Goal:** Set up the HTML/CSS/JS project skeleton with a polished visual design before any D3 logic.

### Milestone 2.1 — HTML Structure (`index.html`)

Create `index.html` containing:
- [ ] A `<header>` with the project title and subtitle
- [ ] A top control bar containing:
  - [ ] Radio button pair: **State** / **County** (granularity toggle)
  - [ ] Year slider (range input, min/max set dynamically from available years)
  - [ ] Metric dropdown (all 22 metrics listed in SPECS.md)
- [ ] A two-panel main layout:
  - [ ] **Left panel (large):** map container `<div id="map">`
  - [ ] **Right panel (narrow):** line graph container `<div id="linechart">` + its own secondary dropdown
    for flow-type selection (shown only when a primary region is selected but no secondary is selected)
- [ ] A status/tooltip bar at the bottom of the map for hover feedback
- [ ] Semantic HTML5 elements throughout; unique IDs on all interactive controls

### Milestone 2.2 — Design System (`styles.css`)

Implement a readable light-mode aesthetic:
- [ ] Color palette: snowy white background (`#fffafa`), accent very light bluish-green (`#e2f2f0`), dark goldenrod highlights
  (`#b8860b`), soft black text (`#2a2f36`)
- [ ] Typography: **Inter** (or **Outfit**) from Google Fonts for all body text; a slightly heavier
  weight for headings
- [ ] Clean card styling for control panels and the line graph panel
- [ ] Smooth CSS transitions on all interactive elements (hover, select, slider thumb)
- [ ] Fully responsive layout using CSS Grid (map + sidebar), collapsing gracefully on narrow viewports
- [ ] Custom-styled range slider and radio buttons using CSS pseudo-elements
- [ ] Color scale legend strip positioned at the bottom of the map panel

---

## Phase 3 — Core D3 Infrastructure (`script.js`)

**Goal:** Load data, wire up controls, and implement the shared state management layer before drawing
any visuals.

### Milestone 3.1 — Data Loading & Preprocessing

- [ ] Use `d3.csv()` to load all enriched state and county files, keyed by `{level, year, direction}`.
- [ ] Parse all numeric columns (`n1`, `n2`, `AGI`) to numbers.
- [ ] Build two in-memory lookup structures:
  - [ ] **State flow map:** `stateFlows[year][direction][y1_fips][y2_fips]` → `{n1, n2, AGI}`
  - [ ] **County flow map:** `countyFlows[year][direction][y1_key][y2_key]` → `{n1, n2, AGI}` where
    `key = statefips_countyfips`
- [ ] Precompute "total" aggregates (summing across all origins/destinations) per region per year.

### Milestone 3.2 — Derived Metric Computation

- [ ] Implement a `computeMetric(flowRecord, metricKey)` function that returns the correct value for the
selected metric given a raw flow record. Metrics requiring a denominator (e.g., "as a share of
population") should use the region's total (code `96`) row as the denominator. Cover all 22 metrics
from SPECS.md:

| Group | Metrics |
|---|---|
| Population | inflow, outflow, net, inflow share, outflow share, net share |
| Households | inflow, outflow, net, inflow share, outflow share, net share |
| AGI | inflow, outflow, net, inflow share, outflow share, net share |
| Average AGI | avg individual in, avg household in, avg individual out, avg household out |

### Milestone 3.3 — Application State & Event Wiring

- [ ] Maintain a central `appState` object:
```js
{
  level: 'state' | 'county',
  year: Number,
  metric: String,
  primaryRegion: String | null,   // FIPS key
  secondaryRegion: String | null, // FIPS key
  flowType: String                // for line chart secondary dropdown
}
```

- [ ] Wire all controls to update `appState` and call a `render()` function that re-renders both the map
and the line chart based on current state.

---

## Phase 4 — Choropleth Map

**Goal:** Render the interactive D3 choropleth map with region selection.

### Milestone 4.1 — GeoJSON Integration

- [ ] Fetch U.S. state TopoJSON from the `topojson-us` CDN (`us-10m.json`).
- [ ] For county mode, fetch the county-level TopoJSON (also from CDN).
- [ ] Use `topojson.feature()` to convert to GeoJSON; project with `d3.geoAlbersUsa()`.

### Milestone 4.2 — Choropleth Rendering

- [ ] Bind the current year's metric values to each geographic region.
- [ ] Compute a sequential color scale (`d3.scaleSequential`) using a curated diverging palette:
  - [ ] **Net metrics:** diverging scale (negative = red-orange, zero = neutral gray, positive = green)
  - [ ] **Inflow/outflow only metrics:** sequential scale (light → accent teal)
- [ ] Render region `<path>` elements; fill by computed metric value.
- [ ] Render a gradient color legend at the bottom of the map.

### Milestone 4.3 — Selection Logic

- [ ] **Click to select primary region:** clicking a region with no primary selected makes it the
  primary; clicking again deselects. Clicking a different region when one is already selected sets
  the new one as secondary (or replaces the primary if none is secondary).
- [ ] **Visual feedback:** primary region highlighted with gold stroke + slight scale-up; secondary with
  teal stroke; all others dimmed proportionally to their flow with the primary.
- [ ] **No selection mode:** map shows total inbound or outbound flow per region (based on metric type).
- [ ] **Primary selected mode:** map shows the flow between the primary region and every other region.

### Milestone 4.4 — Tooltips & Hover State

- [ ] On `mouseover`: display a tooltip showing region name + current metric value (formatted with
  `d3.format`). Use a floating `<div>` tooltip that follows the cursor.
- [ ] On `mouseout`: hide tooltip.
- [ ] Smooth `transition().duration(200)` on fill changes during hover.

---

## Phase 5 — Line Graph

**Goal:** Render the supplementary time-series line chart on the right panel.

### Milestone 5.1 — Chart Scaffold

- [ ] Create an SVG inside `#linechart` with margins for axes and labels.
- [ ] Define `x` scale as `d3.scaleLinear` over available years; `y` scale as `d3.scaleLinear` over
  value range.
- [ ] Render axes with `d3.axisBottom` and `d3.axisLeft`.

### Milestone 5.2 — No-Selection State

- [ ] When `primaryRegion === null`, overlay a centered placeholder message: *"Select a region on the
  map to see trends over time."*

### Milestone 5.3 — Primary Only State (Aggregate Trend)

- [ ] Show the secondary flow-type dropdown (Total flow, Total U.S. flow, Total foreign flow, Total
  same-state flow, Total different-state flow [county only], Total non-movers).
- [ ] Plot a single line representing the selected flow type for the primary region across all years.
- [ ] Animate the line using `stroke-dasharray` / `stroke-dashoffset` on initial render.
- [ ] Add circular data-point markers at each year; on hover, show a tooltip with the exact value.

### Milestone 5.4 — Primary + Secondary State (Pairwise Trend)

- [ ] Hide the flow-type dropdown.
- [ ] Plot the migration flow between the primary and secondary region across all years.
- [ ] Label the line with the secondary region name at the endpoint.
- [ ] Smoothly transition the line when either selection changes.

---

## Phase 6 — Polish, Accessibility & Validation

**Goal:** Final pass for quality, performance, and usability.

### Milestone 6.1 — Micro-Animations & UX Polish

- [ ] Animated map load: regions fade in with a staggered `delay` on first render.
- [ ] Line chart path draws itself in on appearance.
- [ ] Slider year indicator updates a visible numeric label in real time.
- [ ] Metric dropdown uses a custom-styled `<select>` grouped by metric category.

### Milestone 6.2 — Accessibility

- [ ] All interactive elements have `aria-label` attributes.
- [ ] Color scales are supplemented with pattern fills (optional hatching) for colorblind accessibility.
- [ ] Keyboard navigation: Tab order through controls → map (arrow keys to move selection) → line chart.

### Milestone 6.3 — Performance

- [ ] County-level data (~90k rows × 4 files) is the main bottleneck. Strategies:
  - [ ] Load county data lazily (only when the user switches to County mode).
  - [ ] Precompute and cache aggregated totals per county on load.
  - [ ] Throttle slider `input` events with `d3.timer` / `requestAnimationFrame`.

### Milestone 6.4 — Final Validation Checklist

- [ ] All 22 metrics render correctly for both state and county modes
- [ ] Selection states (none / primary / primary+secondary) all work as specified
- [ ] Line chart shows correct data in all three display modes
- [ ] Year slider transitions the map smoothly between available years
- [ ] State ↔ County toggle clears selection and re-renders correctly
- [ ] No console errors in Chrome/Firefox/Safari
- [ ] Responsive layout works at 1280px, 1440px, and 1920px widths

---

## Deliverable Summary

```
IRSMigrationDataProject/
├── scripts/
│   ├── parse_fips.py                           # Phase 1.1
│   ├── enrich_state_data.py                    # Phase 1.2
│   ├── enrich_county_data.py                   # Phase 1.3
│   └── validate_data.py                        # Phase 1.4
├── data/
│   ├── fips/
│   │   ├── all-geocodes-v2021.csv              # Census source (pre-2022 county definitions)
│   │   ├── all-geocodes-v2025.csv              # Census source (2022+ CT planning regions)
│   │   ├── state_fips.csv                      # output of parse_fips.py
│   │   └── county_fips.csv                     # output of parse_fips.py (unified: old CT + new CT)
│   ├── original/
│   │   ├── state_inflow/
│   │   │   ├── stateinflow2021.csv
│   │   │   ├── stateinflow2122.csv
│   │   │   └── stateinflow2223.csv
│   │   ├── state_outflow/
│   │   │   ├── stateoutflow2021.csv
│   │   │   ├── stateoutflow2122.csv
│   │   │   └── stateoutflow2223.csv
│   │   ├── county_inflow/
│   │   │   ├── countyinflow2021.csv
│   │   │   ├── countyinflow2122.csv
│   │   │   └── countyinflow2223.csv
│   │   └── county_outflow/
│   │       ├── countyoutflow2021.csv
│   │       ├── countyoutflow2122.csv
│   │       └── countyoutflow2223.csv
│   └── enriched/
│       ├── state_inflow/
│       │   ├── stateinflow2021_enriched.csv    # output of enrich_state_data.py
│       │   ├── stateinflow2122_enriched.csv
│       │   └── stateinflow2223_enriched.csv
│       ├── state_outflow/
│       │   ├── stateoutflow2021_enriched.csv   # output of enrich_state_data.py
│       │   ├── stateoutflow2122_enriched.csv
│       │   └── stateoutflow2223_enriched.csv
│       ├── county_inflow/
│       │   ├── countyinflow2021_enriched.csv   # output of enrich_county_data.py
│       │   ├── countyinflow2122_enriched.csv
│       │   └── countyinflow2223_enriched.csv
│       └── county_outflow/
│           ├── countyoutflow2021_enriched.csv  # output of enrich_county_data.py
│           ├── countyoutflow2122_enriched.csv
│           └── countyoutflow2223_enriched.csv
├── index.html                                  # Phase 2.1
├── styles.css                                  # Phase 2.2
└── script.js                                   # Phases 3–5
```

---

## Execution Order

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5  →  Phase 6
(Data)      (Scaffold)  (D3 Core)   (Map)       (Chart)     (Polish)
```

Phases 2 and 3 can be developed in parallel once Phase 1 is complete. Phases 4 and 5 depend on
Phase 3 being complete.
