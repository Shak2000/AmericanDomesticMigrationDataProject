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
- [x] A `<header>` with the project title and subtitle
- [x] A top control bar containing:
  - [x] Radio button pair: **State** / **County** (granularity toggle)
  - [x] Year slider (range input, min/max set dynamically from available years)
  - [x] Metric dropdown (all 22 metrics listed in SPECS.md)
- [x] A two-panel main layout:
  - [x] **Left panel (large):** map container `<div id="map">`
  - [x] **Right panel (narrow):** line graph container `<div id="linechart">` + its own secondary dropdown
    for flow-type selection (shown only when a primary region is selected but no secondary is selected)
- [x] A status/tooltip bar at the bottom of the map for hover feedback
- [x] Semantic HTML5 elements throughout; unique IDs on all interactive controls

### Milestone 2.2 — Design System (`styles.css`)

Implement a readable light-mode aesthetic:
- [x] Color palette: snowy white background (`#fffafa`), accent very light bluish-green (`#e2f2f0`), dark goldenrod highlights
  (`#b8860b`), soft black text (`#2a2f36`)
- [x] Typography: **Inter** from Google Fonts for all body text; a slightly heavier
  weight for headings
- [x] Clean card styling for control panels and the line graph panel
- [x] Smooth CSS transitions on all interactive elements (hover, select, slider thumb)
- [x] Fully responsive layout using CSS Grid (map + sidebar), collapsing gracefully on narrow viewports
- [x] Custom-styled range slider and radio buttons using CSS pseudo-elements
- [x] Color scale legend strip positioned at the bottom of the map panel

---

## Phase 3 — Core D3 Infrastructure (`script.js`)

**Goal:** Load data, wire up controls, and implement the shared state management layer before drawing
any visuals.

### Milestone 3.1 — Data Loading & Preprocessing

- [x] Use `d3.csv()` to load all enriched state and county files, keyed by `{level, year, direction}`.
  State files are loaded **eagerly** at startup (~200 KB each × 6 = fast).
  County files are loaded **lazily** the first time the user switches to county view (~7–8 MB each × 6 ≈ 45 MB total).
- [x] Parse all numeric columns (`n1`, `n2`, `AGI`) to numbers.
- [x] Build two in-memory lookup structures:
  - [x] **State flow map:** `stateFlows[year][direction][y1_fips][y2_fips]` → `{n1, n2, AGI}`
  - [x] **County flow map:** `countyFlows[year][direction][y1_key][y2_key]` → `{n1, n2, AGI}` where
    `key = statefips_countyfips`
- [x] Precompute "total" aggregates per region per year, extracted from IRS aggregate rows:
  - [x] `stateTotals[year][fips]` → `{ inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }`
  - [x] `countyTotals[year][key]` → `{ inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }`
  - [x] Inflow total = row where `y1_statefips = "96"` (US+Foreign aggregate)
  - [x] Outflow total = row where `y2_statefips = "96"`

### Milestone 3.2 — Derived Metric Computation

- [x] Implement `computeMetric(metricKey, { inflow, outflow, totalInflow, totalOutflow })` — a pure
  function that returns the correct value for the selected metric, or `null` when required data is
  missing or a denominator is zero.
- [x] `METRIC_META` registry maps every key to `{ label, direction, format }`.
- [x] `getMapValue(regionKey, year, metricKey, level, primaryRegion)` — high-level dispatcher that
  assembles the correct records (totals vs. pair flows) and calls `computeMetric`.
  - Default view (no selection): uses `stateTotals` / `nationalTotals` as denominator so share
    metrics show each region's fraction of **national** migration.
  - Primary-selected view: uses the specific origin→destination flow and the primary's totals as
    denominator, so share metrics show each region's fraction of the primary's total flow.
- [x] `formatMetricValue(value, metricKey)` — formatter (integer, currency $K, percent).
- [x] `getMetricLabel(metricKey)` — returns the human-readable label.
- [x] `computeNationalTotals()` — sums all state totals after state files load; result stored in
  `nationalTotals[year]`.
- [x] All 22 metrics covered:

| Group | Metrics |
|---|---|
| Population | inflow, outflow, net, inflow share, outflow share, net share |
| Households | inflow, outflow, net, inflow share, outflow share, net share |
| AGI | inflow, outflow, net, inflow share, outflow share, net share |
| Average AGI | avg individual in, avg household in, avg individual out, avg household out |

### Milestone 3.3 — Application State & Event Wiring

- [x] Central `appState` object maintained at module scope:
  ```js
  {
    level:           'state' | 'county',
    yearIndex:       0 | 1 | 2,          // maps to YEARS[yearIndex]
    metric:          String,              // one of the 22 METRIC_META keys
    primaryRegion:   String | null,       // FIPS key of clicked region
    secondaryRegion: String | null,       // FIPS key of second clicked region
    flowType:        String               // line-chart flow-type dropdown value
  }
  ```
- [x] All five controls wired to `appState` + `render()`:
  - Granularity radio → sets `appState.level`, clears selections, triggers lazy county load
  - Year slider → sets `appState.yearIndex`, updates label text and filled-track CSS
  - Metric dropdown → sets `appState.metric`
  - Flow-type dropdown (sidebar) → sets `appState.flowType`, calls `renderChart()` only
  - Clear-selection button → nulls both region keys, updates sidebar
- [x] `render()` always calls `updateSelectionUI()` then `renderMap()` then `renderChart()`,
  guaranteeing the sidebar stays in sync on every state transition.
- [x] `initUI()` — syncs all HTML controls **from** `appState` on first load, ensuring a
  consistent initial display even if `appState` defaults are changed programmatically.
- [x] `updateSelectionUI()` — drives the selection-summary panel and flow-type dropdown
  visibility; builds display labels from `stateMeta` / `countyMeta`.
- [x] `setLoadingState(loading, msg)` — injects/hides the golden spinner overlay over `#map`
  during lazy county-data loading.

---

## Phase 4 — Choropleth Map

**Goal:** Render the interactive D3 choropleth map with region selection.

### Milestone 4.1 — GeoJSON Integration

- [x] Fetch U.S. state TopoJSON from `us-atlas@3` CDN → `states-10m.json`
  - `loadGeoData('state')` fetches eagerly on first `renderMap()` call; result is cached.
- [x] Fetch county-level TopoJSON from `us-atlas@3` CDN → `counties-10m.json`
  - `loadGeoData('county')` fetches lazily on first county-mode render; result is cached.
  - Both loads show the spinner overlay so the user always gets feedback.
- [x] `topojson.feature()` converts each TopoJSON object to a GeoJSON FeatureCollection.
  - `.fipsKey` is attached to every feature: `"01"` for states, `"01_073"` for counties —
    matching the keys used in `stateTotals` and `countyTotals`.
- [x] Three border meshes built via `topojson.mesh()`:
  - `stateMesh`  — internal state boundaries (adjacent pairs only)
  - `countyMesh` — internal county boundaries (county mode only)
  - `nationMesh` — outer U.S. boundary
- [x] `d3.geoAlbersUsa().fitExtent()` projection recalculated on every render to fit the
  current container dimensions (supports responsive resize via `ResizeObserver`).
- [x] `setupMapSvg()` creates the SVG + two `<g>` layers (base fills, border meshes) on
  first call; updates the `viewBox` on subsequent calls.
- [x] `renderMap()` draws:
  - Base layer: one `<path class="region">` per feature with placeholder fill `--accent-bg`
    (M4.2 will apply the D3 colour scale over this).
  - Border layer: county mesh (county mode), state mesh, nation outline.
- [x] Render-generation counter guards against stale paints during rapid state changes.
- [x] `ResizeObserver` on `#map` container triggers `renderMap()` on window resize.
- [x] `topojson-client@3` CDN script added to `index.html` (before `script.js`).

### Milestone 4.2 — Choropleth Rendering

- [x] Bind the current year's metric values to each geographic region.
- [x] Compute a sequential color scale (`d3.scaleSequential`) using a curated diverging palette:
  - [x] **Net metrics:** diverging scale (negative = red-orange, zero = neutral gray, positive = green)
  - [x] **Inflow/outflow only metrics:** sequential scale (light → accent teal)
- [x] Render region `<path>` elements; fill by computed metric value.
- [x] Render a gradient color legend at the bottom of the map.

### Milestone 4.3 — Selection Logic

- [x] **Click to select primary region:** clicking a region with no primary selected makes it the
  primary; clicking again deselects. Clicking a different region when one is already selected sets
  the new one as secondary (or replaces the primary if none is secondary).
- [x] **Visual feedback:** primary region highlighted with gold stroke + slight scale-up; secondary with
  teal stroke; all others dimmed proportionally to their flow with the primary.
- [x] **No selection mode:** map shows total inbound or outbound flow per region (based on metric type).
- [x] **Primary selected mode:** map shows the flow between the primary region and every other region.

### Milestone 4.4 — Tooltips & Hover State

- [x] On `mouseover`: display a tooltip showing region name + current metric value (formatted with
  `d3.format`). Use a floating `<div>` tooltip that follows the cursor.
- [x] On `mouseout`: hide tooltip.
- [x] Smooth `transition().duration(200)` on fill changes during hover.

---

## Phase 5 – Data Expansion

### Milestone 5.1 – Extend Data Back to 2011-12

- [x] Collect IRS data on migration dating as far back as 2011-12
- [x] Expand the Python data enrichment files in data/original/ and data/enriched to process this data, too
- [x] Expand the YEAR_LABELS and YEARS constants in script.js to include the additional years

### Milestone 5.2 – Make Sure Counties with Missing Data for a Certain Year Are Not Enabled

- [x] If the level is set to county and, for a particular year and metric, the county is missing data, then instead of setting that county to 0, the county should be colored a light gray (lighter than the gray of a selected county) and not be enabled in the first place.
- [x] If the level is set to county, a county is selected, and for a particular year and metric, there is another county for which there is no data with the selected county, then that other county should be colored a light gray and not be enabled in the first place.
- [x] Please make sure that the top two bullet points apply to a "net" statistic when the inflow or outflow data (or both) are missing for a county.

---

## Phase 6 — Line Graph: Individual Region Trend

**Goal:** Render a standalone time-series line chart **below the map** showing how any single
map-level statistic has changed over time for one chosen state or county. This chart is visually
and structurally separate from the choropleth map; it has its own region selector and is not
driven by the map's click selection.

### Milestone 6.1 — HTML Structure & Chart Scaffold

- [x] Add a `<section id="chart-individual">` block beneath the `<main>` map layout in `index.html`.
- [x] Inside it, place:
  - [x] A chart title / heading (e.g. *"Migration Trend — Individual Region"*).
  - [x] A controls row containing:
    - [x] A **region selector**: a searchable `<select>` (or auto-complete text input) populated from
      `stateMeta` (state mode) or `countyMeta` (county mode) listing all available regions by name.
      Switches automatically when the Level radio changes.
    - [x] A **metric selector**: a `<select>` identical in options to the map's metric dropdown
      (all 22 metrics from `METRIC_META`). Defaults to whatever the map's current metric is.
    - [x] A **"clear" button** that resets the region selection back to the no-selection state.
  - [x] A `<div id="chart-individual-svg-container">` where D3 injects the SVG.
  - [x] A `<div id="chart-individual-placeholder">` with a centered message shown when no region
    is selected.
- [x] Create the D3 SVG with conventional margins (top, right, bottom, left) for axes and labels.
- [x] Define:
  - [x] `xScale`: `d3.scalePoint` (or `d3.scaleLinear`) over `YEARS` (all 15 available year-range tags,
    `'0809'` through `'2223'`). Domain displayed as human-readable labels from `YEAR_LABELS`.
  - [x] `yScale`: `d3.scaleLinear` over `[0, maxValue]` (or `[minValue, maxValue]` for net/diverging
    metrics). Recalculated on every data change.
- [x] Render bottom axis (`d3.axisBottom`) with year labels rotated 45° if they overlap.
- [x] Render left axis (`d3.axisLeft`) with formatted tick values using `formatMetricValue`.
- [x] Add a y-axis label showing the metric name from `getMetricLabel(metricKey)`.

### Milestone 6.2 — No-Selection State

- [x] When no region is chosen, `#chart-individual-placeholder` is visible and the SVG is hidden.
- [x] Placeholder text: *"Select a state or county above to view its migration trend over time."*
- [x] The placeholder should share the same card style as the rest of the sidebar.

### Milestone 6.3 — Single-Region Trend Rendering

- [x] When a region is selected, hide the placeholder and show the SVG.
- [x] For each year in `YEARS`, call `getMapValue(regionKey, year, metricKey, level, null)` to
  get the metric value in default (no-primary-selection) mode, so the trend reflects total flows,
  not flows relative to a selected primary.
- [x] Plot a single `<path>` line using `d3.line()` connecting all (year, value) data points.
  - [x] Skip years with `null` values (data not available for that year); use `defined()` so the line
    renders as a broken segment rather than connecting across gaps.
  - [x] Style the line with the accent color (`--accent`) and a stroke width of 2px.
- [x] For each non-null data point render a `<circle>` marker (radius 4px).
  - [x] On hover over a circle: show a floating tooltip with the year label and formatted value.
  - [x] On hover, the circle expands slightly (radius 6px) with a smooth transition.
- [x] Re-render automatically whenever the **Level** radio changes (clearing region selection if
  the previously selected region doesn't exist in the new level).

---

## Phase 7 — Line Graph: Pairwise Migration Flows

**Goal:** Render a second standalone time-series line chart **below the individual chart** showing
how migration has flowed **between two specific regions** over time. The user independently
selects both a "Region A" and a "Region B"; the chart then plots inflow and outflow lines between
them across all available years.

### Milestone 7.1 — HTML Structure & Chart Scaffold

- [ ] Add a `<section id="chart-pair">` block beneath `#chart-individual` in `index.html`.
- [ ] Inside it, place:
  - [ ] A chart title / heading (e.g. *"Migration Trend — Between Two Regions"*).
  - [ ] A controls row containing:
    - [ ] **Region A selector**: searchable `<select>` (same style as 6.1's region selector).
      Labeled *"Region A"* or *"From / To"*.
    - [ ] **Region B selector**: searchable `<select>` (same style). Labeled *"Region B"*.
    - [ ] A **quantity selector**: a small `<select>` with three options:
      - *Individuals* (uses `n2` field)
      - *Households* (uses `n1` field)
      - *AGI ($K)* (uses `AGI` field)
    - [ ] A **"clear" button** that resets both region selections.
  - [ ] A `<div id="chart-pair-svg-container">` for the D3 SVG.
  - [ ] A `<div id="chart-pair-placeholder">` for the no-selection message.
- [ ] Create the D3 SVG with the same margin convention as the individual chart.
- [ ] Define:
  - [ ] `xScale`: same as 6.1 — `d3.scalePoint` over `YEARS`.
  - [ ] `yScale`: `d3.scaleLinear` whose domain covers both the A→B and B→A series simultaneously
    so both lines share a common y-axis.
- [ ] Render bottom and left axes with the same formatting conventions as Phase 6.
- [ ] Add a y-axis label reflecting the chosen quantity (e.g. *"Individuals"* or *"AGI ($K)"*).

### Milestone 7.2 — No-Selection / Partial-Selection State

- [ ] When **either** Region A or Region B is unset, `#chart-pair-placeholder` is visible and
  the SVG is hidden.
- [ ] Placeholder text: *"Select two states or counties above to view the migration flows between
  them over time."*
- [ ] If only one region is selected, the placeholder can additionally show:
  *"Now select a second region to complete the comparison."*

### Milestone 7.3 — Two-Region Flow Rendering

- [ ] When both regions are selected, hide the placeholder and show the SVG.
- [ ] For each year in `YEARS`, look up:
  - [ ] **A→B inflow**: `getStateFlow(year, 'inflow', regionA, regionB)` (or county equivalent) —
    the number of people/households/AGI that moved **from A into B**.
  - [ ] **B→A inflow**: `getStateFlow(year, 'inflow', regionB, regionA)` — people moving **from B
    into A**.
- [ ] Plot **two lines** on the same axes:
  - [ ] Line 1 (solid, accent color): A → B flow for the selected quantity across all years.
  - [ ] Line 2 (dashed, complementary color): B → A flow for the selected quantity across all years.
- [ ] Add a **legend** inside or below the SVG identifying which line is which, using the region
  display names (e.g. *"California → Texas"* and *"Texas → California"*).
- [ ] For each data point on both lines, render a `<circle>` marker with the same hover tooltip
  behaviour as Phase 6 (year label + formatted quantity value).
- [ ] Handle `null` values with the same broken-line and hollow-marker convention as Phase 6.
- [ ] Apply the same draw animation as Phase 6 on initial render; transition smoothly when either
  region or the quantity selector changes.
- [ ] If Region A and Region B are the same, display an error message inside the chart area:
  *"Region A and Region B must be different."* and suppress the lines.

### Milestone 7.4 — Data Availability Handling

- [ ] If the pairwise flow between the two regions is zero or null for all years (e.g. very small
  counties with suppressed data), display: *"Insufficient data to plot flows between these two
  regions."*
- [ ] Years with suppressed/null data are rendered as hollow markers (same convention as Phase 6).

---

## Phase 8 – Further Data Extensions

### Milestone 8.1 – Extend Data Back to 1990-91 for States and 1991-92 for Counties

- [ ] Collect IRS data on migration dating as far back as 1990-91 for states and 1991-92 for counties
- [ ] Expand the Python data enrichment files in data/original/ and data/enriched to process this data, too
- [ ] Note that the format of this data may be slightly different from the data from 2011-12 onwards, so the Python programs may need to be modified to handle this
- [ ] Expand the YEAR_LABELS and YEARS constants in script.js to include the additional years

---

## Phase 9 — Polish, Accessibility & Validation

**Goal:** Final pass for quality, performance, and usability.

### Milestone 9.1 — Micro-Animations & UX Polish

- [ ] Animated map load: regions fade in with a staggered `delay` on first render.
- [ ] Line chart path draws itself in on appearance.
- [ ] Slider year indicator updates a visible numeric label in real time.
- [ ] Metric dropdown uses a custom-styled `<select>` grouped by metric category.

### Milestone 9.2 — Accessibility

- [ ] All interactive elements have `aria-label` attributes.
- [ ] Color scales are supplemented with pattern fills (optional hatching) for colorblind accessibility.
- [ ] Keyboard navigation: Tab order through controls → map (arrow keys to move selection) → line chart.

### Milestone 9.3 — Performance

- [ ] County-level data (~90k rows × 4 files) is the main bottleneck. Strategies:
  - [ ] Load county data lazily (only when the user switches to County mode).
  - [ ] Precompute and cache aggregated totals per county on load.
  - [ ] Throttle slider `input` events with `d3.timer` / `requestAnimationFrame`.

### Milestone 9.4 — Final Validation Checklist

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
└── script.js                                   # Phases 3–7
```

---

## Execution Order

```
Phase 1  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5  →  Phase 6    →  Phase 7  →  Phase 8  →  Phase 9
(Data)      (Scaffold)  (D3 Core)   (Map)       (Data)      (Individual)  (Pair)      (More Data) (Polish)
```

Phases 2 and 3 can be developed in parallel once Phase 1 is complete. Phases 5, 6, and 7 depend on
Phase 3 being complete.
