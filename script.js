/**
 * script.js — U.S. Migration Explorer
 *
 * Phase 3 — Core D3 Infrastructure
 *
 * Milestone 3.1: Data Loading & Preprocessing
 *   - Loads all 12 enriched CSV files (state + county, inflow + outflow, 3 years)
 *   - Parses numeric columns (n1, n2, AGI) to numbers
 *   - Builds stateFlows / countyFlows lookup maps
 *   - Precomputes per-region totals from IRS aggregate rows (y1/y2 FIPS = "96")
 *
 * Milestone 3.2: Derived Metric Computation
 *   - METRIC_META: registry of all 22 metrics (label, unit, direction, format)
 *   - computeMetric(metricKey, records): pure function → number | null
 *   - getMapValue(regionKey, year, metricKey, level, primaryRegion): dispatcher
 *   - formatMetricValue(value, metricKey): display formatter
 *   - computeNationalTotals(): sums stateTotals across all states (share denominator)
 *
 * Milestone 3.3: Application State & Event Wiring  [→ appState + render()]
 */

'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 1 — CONSTANTS & MANIFEST
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Available year-range tags.
 * The slider positions 0/1/2 map to these keys in the flow maps.
 */
const YEARS = ['2021', '2122', '2223'];

/** Human-readable labels for each year tag. */
const YEAR_LABELS = {
    '2021': '2020–21',
    '2122': '2021–22',
    '2223': '2022–23',
};

/** IRS aggregate FIPS — total U.S.+Foreign migration. */
const FIPS_TOTAL = '96';  // US + Foreign total
const FIPS_TOTAL_US = '97';  // US only
const FIPS_TOTAL_FOREIGN = '98';  // Foreign only

/**
 * State-level FIPS codes that represent IRS aggregate rows, not real geographies.
 * Rows with these FIPS codes are excluded from map rendering but included in
 * the flow map so that metric computations can access them.
 */
const SPECIAL_STATE_FIPS = new Set(['57', '58', '59', '96', '97', '98']);

/**
 * County-level codes used by the IRS for aggregate rows.
 * When combined with a real state FIPS, these are aggregate, not real counties.
 * When combined with a special state FIPS (96/97/98/57) they are also aggregate.
 */
const SPECIAL_COUNTY_FIPS = new Set(['000', '001', '003']);

/**
 * File manifest.
 * Each entry describes one enriched CSV and its logical key triple.
 * State files are loaded eagerly on startup (small, ~200 KB each).
 * County files are loaded lazily the first time the user switches to county
 * view (large, ~7–8 MB each × 6 files ≈ 45 MB total).
 */
const DATA_FILES = [
    // ── State inflow ──────────────────────────────────────────────────────────
    {
        level: 'state', year: '2021', direction: 'inflow',
        path: 'data/enriched/state_inflow/stateinflow2021_enriched.csv'
    },
    {
        level: 'state', year: '2122', direction: 'inflow',
        path: 'data/enriched/state_inflow/stateinflow2122_enriched.csv'
    },
    {
        level: 'state', year: '2223', direction: 'inflow',
        path: 'data/enriched/state_inflow/stateinflow2223_enriched.csv'
    },
    // ── State outflow ─────────────────────────────────────────────────────────
    {
        level: 'state', year: '2021', direction: 'outflow',
        path: 'data/enriched/state_outflow/stateoutflow2021_enriched.csv'
    },
    {
        level: 'state', year: '2122', direction: 'outflow',
        path: 'data/enriched/state_outflow/stateoutflow2122_enriched.csv'
    },
    {
        level: 'state', year: '2223', direction: 'outflow',
        path: 'data/enriched/state_outflow/stateoutflow2223_enriched.csv'
    },
    // ── County inflow ─────────────────────────────────────────────────────────
    {
        level: 'county', year: '2021', direction: 'inflow',
        path: 'data/enriched/county_inflow/countyinflow2021_enriched.csv'
    },
    {
        level: 'county', year: '2122', direction: 'inflow',
        path: 'data/enriched/county_inflow/countyinflow2122_enriched.csv'
    },
    {
        level: 'county', year: '2223', direction: 'inflow',
        path: 'data/enriched/county_inflow/countyinflow2223_enriched.csv'
    },
    // ── County outflow ────────────────────────────────────────────────────────
    {
        level: 'county', year: '2021', direction: 'outflow',
        path: 'data/enriched/county_outflow/countyoutflow2021_enriched.csv'
    },
    {
        level: 'county', year: '2122', direction: 'outflow',
        path: 'data/enriched/county_outflow/countyoutflow2122_enriched.csv'
    },
    {
        level: 'county', year: '2223', direction: 'outflow',
        path: 'data/enriched/county_outflow/countyoutflow2223_enriched.csv'
    },
];

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 2 — IN-MEMORY DATA STORES
═══════════════════════════════════════════════════════════════════════════ */

/**
 * stateFlows[year][direction][y1_fips][y2_fips] → { n1, n2, AGI }
 *
 * Stores EVERY row from the state-level enriched files, including IRS
 * aggregate rows (y1/y2 FIPS ∈ SPECIAL_STATE_FIPS). Keyed by the raw
 * 2-digit zero-padded FIPS strings from the enriched files.
 *
 * Inflow files:  y2 = destination state, y1 = origin (or aggregate code)
 * Outflow files: y1 = origin state, y2 = destination (or aggregate code)
 */
const stateFlows = {};

/**
 * countyFlows[year][direction][y1Key][y2Key] → { n1, n2, AGI }
 *
 * Key format: `${statefips}_${countyfips}` (e.g. "01_073" for Jefferson Co., AL).
 * Includes aggregate rows so metric computations can look up IRS totals.
 *
 * Inflow files:  y2Key = destination county, y1Key = origin (or aggregate)
 * Outflow files: y1Key = origin county, y2Key = destination (or aggregate)
 */
const countyFlows = {};

/**
 * stateTotals[year][statefips] → { inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }
 *
 * Extracted from IRS aggregate rows:
 *   Inflow total  = inflow row where y1_statefips = "96" (US+Foreign total)
 *   Outflow total = outflow row where y2_statefips = "96"
 * Only populated for real state FIPS (01–56, 72).
 */
const stateTotals = {};

/**
 * countyTotals[year][key] → { inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }
 *
 * Extracted from IRS aggregate rows:
 *   Inflow total  = row where y1_statefips="96" AND y1_countyfips="000"
 *   Outflow total = row where y2_statefips="96" AND y2_countyfips="000"
 */
const countyTotals = {};

/**
 * stateMeta[statefips] → { postal, name }
 * Built incrementally as state files are processed.
 */
const stateMeta = {};

/**
 * countyMeta[key] → { statefips, countyfips, countyName, stateName, statePostal }
 * key = `${statefips}_${countyfips}`
 * Built incrementally as county files are processed.
 */
const countyMeta = {};

/**
 * nationalTotals[year] → { inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }
 *
 * Sum of all real-state stateTotals for a given year.
 * Used as the denominator for share metrics in the default (no-selection) map view
 * so that each state's value = "fraction of national migration flow".
 * Populated by computeNationalTotals() after all state files are loaded.
 */
const nationalTotals = {};

/** Tracks whether county files have been loaded yet. */
let countyDataLoaded = false;
let countyDataLoading = null; // Promise, set while loading is in progress

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 3 — UTILITY FUNCTIONS
═══════════════════════════════════════════════════════════════════════════ */

/** Parse a CSV string to a number; returns 0 for blank/NaN values. */
function parseNum(s) {
    const n = +s;
    return Number.isFinite(n) ? n : 0;
}

/**
 * Return true if the given 2-digit state FIPS is a real U.S. geography
 * (not an IRS aggregate code like 96/97/98/57/58/59).
 */
function isRealStateFips(fips) {
    return !SPECIAL_STATE_FIPS.has(fips);
}

/**
 * Return true if a (stateFips, countyFips) pair represents a real county,
 * i.e. neither the state FIPS nor the county FIPS is an IRS aggregate code.
 */
function isRealCounty(sf, cf) {
    return isRealStateFips(sf) && !SPECIAL_COUNTY_FIPS.has(cf);
}

/**
 * Return the flow record { n1, n2, AGI } for a state-level origin→destination
 * pair from the appropriate flow map, or null if not found.
 *
 * @param {string} year      - e.g. "2122"
 * @param {string} direction - "inflow" | "outflow"
 * @param {string} y1        - 2-digit origin state FIPS
 * @param {string} y2        - 2-digit destination state FIPS
 */
function getStateFlow(year, direction, y1, y2) {
    return stateFlows[year]?.[direction]?.[y1]?.[y2] ?? null;
}

/**
 * Return the flow record for a county-level origin→destination pair, or null.
 * Keys are `${statefips}_${countyfips}`.
 */
function getCountyFlow(year, direction, y1Key, y2Key) {
    return countyFlows[year]?.[direction]?.[y1Key]?.[y2Key] ?? null;
}

/**
 * Return the precomputed total { inflow: {...}, outflow: {...} } for a state
 * across all years, or just one direction. Returns null if not found.
 */
function getStateTotals(year, statefips) {
    return stateTotals[year]?.[statefips] ?? null;
}

/** Return the precomputed county totals for a given year and key. */
function getCountyTotals(year, key) {
    return countyTotals[year]?.[key] ?? null;
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 4 — PER-FILE PROCESSORS
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Process one batch of rows from a state enriched CSV.
 * Populates stateFlows, stateTotals, and stateMeta.
 *
 * Schema (columns):
 *   y2_state, y2_state_name, y2_statefips,
 *   y1_statefips, y1_state, y1_state_name,
 *   n1, n2, AGI
 */
function processStateRows(rows, year, direction) {
    // Ensure nested containers exist
    if (!stateFlows[year]) stateFlows[year] = {};
    if (!stateFlows[year][direction]) stateFlows[year][direction] = {};
    if (!stateTotals[year]) stateTotals[year] = {};

    const dirMap = stateFlows[year][direction];

    for (const row of rows) {
        const y1 = row.y1_statefips;
        const y2 = row.y2_statefips;

        const rec = {
            n1: parseNum(row.n1),
            n2: parseNum(row.n2),
            AGI: parseNum(row.AGI),
        };

        // ── Flow map entry ────────────────────────────────────────────────────
        if (!dirMap[y1]) dirMap[y1] = {};
        dirMap[y1][y2] = rec;

        // ── State metadata (collect from real geography rows) ─────────────────
        if (isRealStateFips(y2)) {
            stateMeta[y2] = { postal: row.y2_state, name: row.y2_state_name };
        }
        if (isRealStateFips(y1)) {
            stateMeta[y1] = { postal: row.y1_state, name: row.y1_state_name };
        }

        // ── Totals: IRS aggregate rows ────────────────────────────────────────
        // Inflow  file: the row where y1 = FIPS_TOTAL gives the total inflow to y2.
        // Outflow file: the row where y2 = FIPS_TOTAL gives the total outflow from y1.
        if (direction === 'inflow' && y1 === FIPS_TOTAL && isRealStateFips(y2)) {
            if (!stateTotals[year][y2]) stateTotals[year][y2] = {};
            stateTotals[year][y2].inflow = rec;
        }
        if (direction === 'outflow' && y2 === FIPS_TOTAL && isRealStateFips(y1)) {
            if (!stateTotals[year][y1]) stateTotals[year][y1] = {};
            stateTotals[year][y1].outflow = rec;
        }
    }
}

/**
 * Process one batch of rows from a county enriched CSV.
 * Populates countyFlows, countyTotals, and countyMeta.
 *
 * Schema (columns):
 *   y2_state, y2_state_name, y2_statefips, y2_countyfips, y2_county_name,
 *   y1_statefips, y1_countyfips, y1_state, y1_state_name, y1_county_name,
 *   n1, n2, AGI
 */
function processCountyRows(rows, year, direction) {
    if (!countyFlows[year]) countyFlows[year] = {};
    if (!countyFlows[year][direction]) countyFlows[year][direction] = {};
    if (!countyTotals[year]) countyTotals[year] = {};

    const dirMap = countyFlows[year][direction];

    for (const row of rows) {
        const y1sf = row.y1_statefips;
        const y1cf = row.y1_countyfips;
        const y2sf = row.y2_statefips;
        const y2cf = row.y2_countyfips;
        const y1Key = `${y1sf}_${y1cf}`;
        const y2Key = `${y2sf}_${y2cf}`;

        const rec = {
            n1: parseNum(row.n1),
            n2: parseNum(row.n2),
            AGI: parseNum(row.AGI),
        };

        // ── Flow map entry ────────────────────────────────────────────────────
        if (!dirMap[y1Key]) dirMap[y1Key] = {};
        dirMap[y1Key][y2Key] = rec;

        // ── County metadata (real geographies only) ───────────────────────────
        if (isRealCounty(y2sf, y2cf)) {
            countyMeta[y2Key] = {
                statefips: y2sf,
                countyfips: y2cf,
                countyName: row.y2_county_name,
                stateName: row.y2_state_name,
                statePostal: row.y2_state,
            };
        }
        if (isRealCounty(y1sf, y1cf)) {
            countyMeta[y1Key] = {
                statefips: y1sf,
                countyfips: y1cf,
                countyName: row.y1_county_name,
                stateName: row.y1_state_name,
                statePostal: row.y1_state,
            };
        }

        // ── Totals: IRS aggregate rows ────────────────────────────────────────
        // Inflow  file: y1_statefips="96" AND y1_countyfips="000" → total inflow to y2 county.
        // Outflow file: y2_statefips="96" AND y2_countyfips="000" → total outflow from y1 county.
        if (direction === 'inflow'
            && y1sf === FIPS_TOTAL && y1cf === '000'
            && isRealCounty(y2sf, y2cf)) {
            if (!countyTotals[year][y2Key]) countyTotals[year][y2Key] = {};
            countyTotals[year][y2Key].inflow = rec;
        }
        if (direction === 'outflow'
            && y2sf === FIPS_TOTAL && y2cf === '000'
            && isRealCounty(y1sf, y1cf)) {
            if (!countyTotals[year][y1Key]) countyTotals[year][y1Key] = {};
            countyTotals[year][y1Key].outflow = rec;
        }
    }
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 5 — FILE LOADING
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Load a single enriched CSV file and process its rows.
 * Returns a Promise that resolves with the row count.
 */
function loadFile({ level, year, direction, path }) {
    return d3.csv(path).then(rows => {
        if (level === 'state') {
            processStateRows(rows, year, direction);
        } else {
            processCountyRows(rows, year, direction);
        }
        console.debug(`  ✓ [${level}/${year}/${direction}] ${rows.length.toLocaleString()} rows`);
        return rows.length;
    });
}

/**
 * Load all state-level CSV files (eagerly, at startup).
 * Returns a Promise that resolves when all 6 state files are loaded.
 */
function loadStateData() {
    const stateFiles = DATA_FILES.filter(f => f.level === 'state');
    console.log('[Data] Loading state files …');
    return Promise.all(stateFiles.map(loadFile)).then(counts => {
        const total = counts.reduce((a, b) => a + b, 0);
        console.log(`[Data] State data ready — ${total.toLocaleString()} total rows`);
    });
}

/**
 * Load all county-level CSV files (lazily, on first use of county view).
 * Subsequent calls return the same Promise so loading happens only once.
 * Returns a Promise.
 */
function loadCountyData() {
    if (countyDataLoaded) return Promise.resolve();
    if (countyDataLoading) return countyDataLoading;

    const countyFiles = DATA_FILES.filter(f => f.level === 'county');
    console.log('[Data] Loading county files (this may take a moment) …');

    countyDataLoading = Promise.all(countyFiles.map(loadFile)).then(counts => {
        const total = counts.reduce((a, b) => a + b, 0);
        countyDataLoaded = true;
        console.log(`[Data] County data ready — ${total.toLocaleString()} total rows`);
        console.log(`[Data] County metadata entries: ${Object.keys(countyMeta).length.toLocaleString()}`);
    });

    return countyDataLoading;
}

/**
 * Compute and cache national (all-state) inflow/outflow totals for each year.
 * Call this once after all state data is loaded.
 * Result is stored in nationalTotals[year].
 */
function computeNationalTotals() {
    for (const year of YEARS) {
        const inf = { n1: 0, n2: 0, AGI: 0 };
        const out = { n1: 0, n2: 0, AGI: 0 };
        for (const fips of Object.keys(stateTotals[year] ?? {})) {
            const t = stateTotals[year][fips];
            if (t.inflow) { inf.n1 += t.inflow.n1; inf.n2 += t.inflow.n2; inf.AGI += t.inflow.AGI; }
            if (t.outflow) { out.n1 += t.outflow.n1; out.n2 += t.outflow.n2; out.AGI += t.outflow.AGI; }
        }
        nationalTotals[year] = { inflow: inf, outflow: out };
    }
    console.debug('[Data] National totals computed for', YEARS.length, 'years.');
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 6 — DERIVED METRIC COMPUTATION  (Milestone 3.2)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Metadata registry for all 22 metrics.
 *
 * Fields:
 *   label     — human-readable name (matches index.html <option> text)
 *   direction — which flow direction(s) the metric reads:
 *                 'inflow'  → only uses inflow record
 *                 'outflow' → only uses outflow record
 *                 'both'    → uses both (net metrics) or neither (avg AGI)
 *   format    — how to display the value:
 *                 'integer'  → round to whole number, add comma separator
 *                 'currency' → round to whole number, thousands of $, add comma
 *                 'percent'  → multiply by 100, show as X.X %
 *
 * AGI values in the raw data are in thousands of dollars.
 * Avg AGI metrics therefore produce values in thousands of $/person.
 */
const METRIC_META = {
    // ── Population ──────────────────────────────────────────────────────────
    pop_inflow: { label: 'Population inflow', direction: 'inflow', format: 'integer' },
    pop_outflow: { label: 'Population outflow', direction: 'outflow', format: 'integer' },
    pop_net: { label: 'Net population flow', direction: 'both', format: 'integer' },
    pop_inflow_share: { label: 'Population inflow as share of total', direction: 'inflow', format: 'percent' },
    pop_outflow_share: { label: 'Population outflow as share of total', direction: 'outflow', format: 'percent' },
    pop_net_share: { label: 'Net population flow as share of total', direction: 'both', format: 'percent' },

    // ── Households ──────────────────────────────────────────────────────────
    hh_inflow: { label: 'Household inflow', direction: 'inflow', format: 'integer' },
    hh_outflow: { label: 'Household outflow', direction: 'outflow', format: 'integer' },
    hh_net: { label: 'Net household flow', direction: 'both', format: 'integer' },
    hh_inflow_share: { label: 'Household inflow as share of total', direction: 'inflow', format: 'percent' },
    hh_outflow_share: { label: 'Household outflow as share of total', direction: 'outflow', format: 'percent' },
    hh_net_share: { label: 'Net household flow as share of total', direction: 'both', format: 'percent' },

    // ── AGI ─────────────────────────────────────────────────────────────────
    agi_inflow: { label: 'AGI inflow ($K)', direction: 'inflow', format: 'currency' },
    agi_outflow: { label: 'AGI outflow ($K)', direction: 'outflow', format: 'currency' },
    agi_net: { label: 'Net AGI flow ($K)', direction: 'both', format: 'currency' },
    agi_inflow_share: { label: 'AGI inflow as share of total', direction: 'inflow', format: 'percent' },
    agi_outflow_share: { label: 'AGI outflow as share of total', direction: 'outflow', format: 'percent' },
    agi_net_share: { label: 'Net AGI flow as share of total', direction: 'both', format: 'percent' },

    // ── Average AGI ─────────────────────────────────────────────────────────
    avg_agi_in_individual: { label: 'Avg AGI per individual moving in ($K)', direction: 'inflow', format: 'currency' },
    avg_agi_in_household: { label: 'Avg AGI per household moving in ($K)', direction: 'inflow', format: 'currency' },
    avg_agi_out_individual: { label: 'Avg AGI per individual moving out ($K)', direction: 'outflow', format: 'currency' },
    avg_agi_out_household: { label: 'Avg AGI per household moving out ($K)', direction: 'outflow', format: 'currency' },
};

/**
 * computeMetric(metricKey, records) → number | null
 *
 * Pure function. Given the relevant flow records for a region (or a pair of
 * regions), returns the numeric value for the selected metric, or null if the
 * required data is missing / the denominator is zero.
 *
 * @param {string} metricKey
 * @param {Object} records
 *   @param {FlowRecord|null} records.inflow
 *     The inflow record to use. In the default map view this is the region's
 *     total inflow (FIPS-96 row). When a primary region P is selected, this is
 *     the flow from region R into P: stateFlows[year]['inflow'][R][P].
 *   @param {FlowRecord|null} records.outflow
 *     The outflow record. In the default map view this is the region's total
 *     outflow. When a primary P is selected, this is the flow from P to R:
 *     stateFlows[year]['outflow'][P][R].
 *   @param {FlowRecord|null} records.totalInflow
 *     Denominator for inflow share metrics.
 *     Default view: nationalTotals[year].inflow  (so share = state's fraction
 *       of all national migration → meaningful choropleth comparison).
 *     Primary-selected view: stateTotals[year][P].inflow  (so share = fraction
 *       of P's total inflow that came from R).
 *   @param {FlowRecord|null} records.totalOutflow
 *     Denominator for outflow share metrics (same logic as totalInflow).
 *
 * FlowRecord = { n1: number, n2: number, AGI: number }
 *   n1  = households
 *   n2  = individuals
 *   AGI = adjusted gross income (thousands of dollars)
 */
function computeMetric(metricKey, { inflow, outflow, totalInflow, totalOutflow }) {
    // Provide zero-filled fallbacks so arithmetic never throws on null.
    const i = inflow ?? { n1: 0, n2: 0, AGI: 0 };
    const o = outflow ?? { n1: 0, n2: 0, AGI: 0 };
    const ti = totalInflow ?? i;   // fallback: self (gives share = 1)
    const to = totalOutflow ?? o;

    switch (metricKey) {

        // ── Population ──────────────────────────────────────────────────────────
        case 'pop_inflow': return i.n2;
        case 'pop_outflow': return o.n2;
        case 'pop_net': return i.n2 - o.n2;
        case 'pop_inflow_share': return ti.n2 > 0 ? i.n2 / ti.n2 : null;
        case 'pop_outflow_share': return to.n2 > 0 ? o.n2 / to.n2 : null;
        case 'pop_net_share': {
            const denom = Math.max(ti.n2, to.n2);
            return denom > 0 ? (i.n2 - o.n2) / denom : null;
        }

        // ── Households ──────────────────────────────────────────────────────────
        case 'hh_inflow': return i.n1;
        case 'hh_outflow': return o.n1;
        case 'hh_net': return i.n1 - o.n1;
        case 'hh_inflow_share': return ti.n1 > 0 ? i.n1 / ti.n1 : null;
        case 'hh_outflow_share': return to.n1 > 0 ? o.n1 / to.n1 : null;
        case 'hh_net_share': {
            const denom = Math.max(ti.n1, to.n1);
            return denom > 0 ? (i.n1 - o.n1) / denom : null;
        }

        // ── AGI ─────────────────────────────────────────────────────────────────
        case 'agi_inflow': return i.AGI;
        case 'agi_outflow': return o.AGI;
        case 'agi_net': return i.AGI - o.AGI;
        case 'agi_inflow_share': return ti.AGI > 0 ? i.AGI / ti.AGI : null;
        case 'agi_outflow_share': return to.AGI > 0 ? o.AGI / to.AGI : null;
        case 'agi_net_share': {
            const denom = Math.max(ti.AGI, to.AGI);
            return denom > 0 ? (i.AGI - o.AGI) / denom : null;
        }

        // ── Average AGI (AGI in $K per migrant) ─────────────────────────────────
        // n2 = individuals, n1 = households
        case 'avg_agi_in_individual': return i.n2 > 0 ? i.AGI / i.n2 : null;
        case 'avg_agi_in_household': return i.n1 > 0 ? i.AGI / i.n1 : null;
        case 'avg_agi_out_individual': return o.n2 > 0 ? o.AGI / o.n2 : null;
        case 'avg_agi_out_household': return o.n1 > 0 ? o.AGI / o.n1 : null;

        default:
            console.warn(`computeMetric: unknown metric key "${metricKey}"`);
            return null;
    }
}

/**
 * getMapValue(regionKey, year, metricKey, level, primaryRegion)
 *   → number | null
 *
 * High-level dispatcher: assembles the correct inflow/outflow/total records
 * for the given display context, then delegates to computeMetric().
 *
 * Two modes:
 *
 * A) Default view (primaryRegion = null)
 *    Each region is coloured by its own total flow metric.
 *    Share denominators = nationalTotals[year] so values represent each
 *    region's fraction of national migration.
 *
 * B) Primary-selected view (primaryRegion is set)
 *    Each region R is coloured by the flow between R and primaryRegion P.
 *    Inflow  = flow from R into  P  (stateFlows[year].inflow[R][P])
 *    Outflow = flow from P into  R  (stateFlows[year].outflow[P][R])
 *    Share denominators = P's own totals (stateTotals[year][P])
 *    so share values = "fraction of P's total flow accounted for by R".
 *
 * @param {string}      regionKey     - state FIPS or "sf_cf" county key
 * @param {string}      year          - e.g. "2122"
 * @param {string}      metricKey     - one of the 22 keys in METRIC_META
 * @param {string}      level         - "state" | "county"
 * @param {string|null} primaryRegion - FIPS key, or null for default view
 */
function getMapValue(regionKey, year, metricKey, level, primaryRegion) {
    if (level === 'state') {
        return _getStateMapValue(regionKey, year, metricKey, primaryRegion);
    } else {
        return _getCountyMapValue(regionKey, year, metricKey, primaryRegion);
    }
}

function _getStateMapValue(fips, year, metricKey, primaryFips) {
    if (!primaryFips) {
        // ── Mode A: default view ───────────────────────────────────────────────
        const t = stateTotals[year]?.[fips];
        const nat = nationalTotals[year];
        return computeMetric(metricKey, {
            inflow: t?.inflow ?? null,
            outflow: t?.outflow ?? null,
            totalInflow: nat?.inflow ?? null,
            totalOutflow: nat?.outflow ?? null,
        });
    } else {
        // ── Mode B: primary-selected view ─────────────────────────────────────
        // inflow  = people who moved FROM fips INTO primaryFips
        const inflow = getStateFlow(year, 'inflow', fips, primaryFips);
        // outflow = people who moved FROM primaryFips INTO fips
        const outflow = getStateFlow(year, 'outflow', primaryFips, fips);
        const pt = stateTotals[year]?.[primaryFips];
        return computeMetric(metricKey, {
            inflow,
            outflow,
            totalInflow: pt?.inflow ?? null,
            totalOutflow: pt?.outflow ?? null,
        });
    }
}

function _getCountyMapValue(key, year, metricKey, primaryKey) {
    if (!primaryKey) {
        // ── Mode A: default view ───────────────────────────────────────────────
        // National county totals are not precomputed (45 MB county data may not
        // be loaded yet). Use the county's own total as both value and denominator;
        // share metrics will be relative to the county's own total migration.
        const t = countyTotals[year]?.[key];
        return computeMetric(metricKey, {
            inflow: t?.inflow ?? null,
            outflow: t?.outflow ?? null,
            totalInflow: t?.inflow ?? null,
            totalOutflow: t?.outflow ?? null,
        });
    } else {
        // ── Mode B: primary-selected view ─────────────────────────────────────
        const inflow = getCountyFlow(year, 'inflow', key, primaryKey);
        const outflow = getCountyFlow(year, 'outflow', primaryKey, key);
        const pt = countyTotals[year]?.[primaryKey];
        return computeMetric(metricKey, {
            inflow,
            outflow,
            totalInflow: pt?.inflow ?? null,
            totalOutflow: pt?.outflow ?? null,
        });
    }
}

/**
 * formatMetricValue(value, metricKey) → string
 *
 * Format a numeric metric value for display in tooltips and the status bar.
 * Returns "—" for null / NaN / Infinity values.
 */
function formatMetricValue(value, metricKey) {
    if (value === null || !Number.isFinite(value)) return '—';
    const meta = METRIC_META[metricKey];
    if (!meta) return String(value);

    switch (meta.format) {
        case 'percent':
            // Value is a fraction (0–1); display as percentage with 2 decimal places.
            return `${(value * 100).toFixed(2)} %`;
        case 'currency':
            // Value is in thousands of dollars.
            return `$${Math.round(value).toLocaleString('en-US')}K`;
        case 'integer':
        default:
            // Possibly negative (net metrics); include sign for clarity.
            return Math.round(value).toLocaleString('en-US');
    }
}

/**
 * getMetricLabel(metricKey) → string
 * Returns the human-readable label for a metric key.
 */
function getMetricLabel(metricKey) {
    return METRIC_META[metricKey]?.label ?? metricKey;
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 7 — APPLICATION STATE  (Milestone 3.3)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Central application state object.
 * All UI controls read from and write to this object; render() reads it.
 */
const appState = {
    level: 'state',   // 'state' | 'county'
    yearIndex: 2,          // 0 → YEARS[0] ('2021'), 1 → '2122', 2 → '2223'
    metric: 'pop_inflow', // metric key (see computeMetric)
    primaryRegion: null,       // FIPS key of the selected primary region, or null
    secondaryRegion: null,       // FIPS key of the secondary region, or null
    flowType: 'total',    // line-chart flow-type dropdown value
    zoomLevel: 1, // '1' to '5'
};

/** Convenience: return the current year tag string. */
function currentYear() {
    return YEARS[appState.yearIndex];
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 7.5 — GEO INTEGRATION  (Milestone 4.1)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * TopoJSON → GeoJSON cache.
 *   geoCache['state']  → { features, stateMesh, nationMesh }
 *   geoCache['county'] → { features, stateMesh, countyMesh, nationMesh }
 *
 * Populated lazily. State geo is fetched on first renderMap() call;
 * county geo is fetched the first time the user switches to county view.
 */
const geoCache = {};

/**
 * Active D3 map rendering references.
 * Created once in setupMapSvg(); reused by Milestones 4.2 and 4.3.
 */
let mapSvg = null;  // d3 selection wrapping the <svg>
let mapLayerBase = null;  // <g> holding region <path> fills (below borders)
let mapLayerBorder = null;  // <g> holding border mesh <path>s (above fills)
let mapProjection = null;  // current d3.geoAlbersUsa() instance
let mapPath = null;  // current d3.geoPath() generator
let mapRenderGen = 0;     // monotonically increasing; prevents stale renders

/**
 * loadGeoData(level) → Promise<GeoData>
 *
 * Fetches the us-atlas TopoJSON for the given level from jsDelivr CDN.
 * Result is cached so only one network request is ever made per level.
 *
 * Attaches a .fipsKey to every GeoJSON feature matching the keys used in
 * stateFlows / countyFlows / stateTotals / countyTotals:
 *   State  fipsKey = zero-padded 2-char state FIPS, e.g. "01"
 *   County fipsKey = "${sf}_${cf}", e.g. "01_073" for Jefferson Co., AL
 *
 * Also builds three border meshes for the border layer:
 *   stateMesh  — internal state boundaries (adjacent pairs only)
 *   countyMesh — internal county boundaries (county mode only)
 *   nationMesh — outer U.S. boundary
 */
async function loadGeoData(level) {
    if (geoCache[level]) return geoCache[level];

    const url = level === 'state'
        ? 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json'
        : 'https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json';

    console.log(`[Geo] Fetching ${level} TopoJSON from CDN…`);
    let topo;
    try {
        topo = await d3.json(url);
    } catch (err) {
        throw new Error(`[Geo] CDN fetch failed for ${level}: ${err.message}`);
    }

    // ── Convert to GeoJSON ──────────────────────────────────────────────────────────────
    const featureKey = level === 'state' ? 'states' : 'counties';
    const geoJson = topojson.feature(topo, topo.objects[featureKey]);

    // Attach .fipsKey for O(1) metric lookup in renderMap (M4.2)
    geoJson.features.forEach(f => {
        const padLen = level === 'state' ? 2 : 5;
        const raw = String(f.id).padStart(padLen, '0');
        f.fipsKey = level === 'state'
            ? raw
            : `${raw.slice(0, 2)}_${raw.slice(2)}`;
    });

    // ── Build border meshes ─────────────────────────────────────────────────────────
    const stateMesh = topojson.mesh(topo, topo.objects.states, (a, b) => a !== b);
    const nationMesh = topojson.mesh(topo, topo.objects.nation);

    const result = { features: geoJson, stateMesh, nationMesh };
    if (level === 'county') {
        result.countyMesh = topojson.mesh(
            topo, topo.objects.counties, (a, b) => a !== b
        );
    }

    geoCache[level] = result;
    console.log(
        `[Geo] ${level} geo ready — `,
        `${geoJson.features.length.toLocaleString()} features`
    );
    return result;
}

/**
 * setupMapSvg() → { width, height } | null
 *
 * Creates the map <svg> and its two layer <g> elements the first time it is
 * called, then keeps the viewBox in sync with the container on every call.
 * Returns null if the container has zero dimensions (layout not yet settled).
 */
function setupMapSvg() {
    const container = document.getElementById('map');
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width === 0 || height === 0) return null;

    if (!mapSvg) {
        mapSvg = d3.select('#map')
            .append('svg')
            .attr('role', 'presentation')
            .attr('aria-hidden', 'true')
            .style('position', 'absolute')
            .style('inset', '0')
            .style('width', '100%')
            .style('height', '100%');

        // Stacking order: fills first, then borders on top
        mapLayerBase = mapSvg.append('g').attr('class', 'layer-base');
        mapLayerBorder = mapSvg.append('g').attr('class', 'layer-borders');
    }

    mapSvg.attr('viewBox', `0 0 ${width} ${height}`);
    return { width, height };
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 8 — RENDER  (Milestones 3.3/4/5)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Master render function — called whenever appState changes.
 *
 * Responsibilities:
 *   1. Keep the selection sidebar (summary, flow-type control) in sync.
 *   2. Re-draw the choropleth map with the current metric values.
 *   3. Re-draw the line chart for the selected region(s).
 *
 * renderMap() is async (geo data may need fetching) but render() does not
 * await it — it fires-and-forgets. The render-generation counter inside
 * renderMap() discards stale results if a newer call has already started.
 */
function render() {
    updateSelectionUI();   // always keep sidebar in sync
    renderMap();           // async, fire-and-forget
    renderChart();
}

/**
 * renderMap() — Milestone 4.1 & 4.2
 *
 * Async. Loads geo data on first call (cached thereafter), sizes the SVG to
 * the current container, builds an AlbersUSA projection, and paints:
 *   • Base layer   — one <path> per geographic region, filled by metric value
 *   • Border layer — county mesh (county mode), state mesh, nation outline
 *
 * A render-generation counter ensures only the most-recent invocation's result
 * is actually painted.
 */
async function renderMap() {
    const gen = ++mapRenderGen;

    // ── Size the SVG ─────────────────────────────────────────────────────────────
    const dim = setupMapSvg();
    if (!dim) return;
    const { width, height } = dim;

    // ── Load geographic data (CDN, cached after first call) ────────────────────
    const firstLoad = !geoCache[appState.level];
    if (firstLoad) setLoadingState(true, 'Loading map boundaries…');

    let geo;
    try {
        geo = await loadGeoData(appState.level);
    } catch (err) {
        console.error(err.message);
        if (firstLoad) setLoadingState(false);
        return;
    }
    if (firstLoad) setLoadingState(false);
    if (gen !== mapRenderGen) return;  // stale — a newer render is already pending

    // ── Pre-calculate values & determine scale bounds ────────────────────────────
    const features = geo.features.features;
    const year = currentYear();
    const metricMeta = METRIC_META[appState.metric];

    // Array to hold [feature, numeric_value] tuples so we don't recalculate
    const valueTuples = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (const f of features) {
        const val = getMapValue(f.fipsKey, year, appState.metric, appState.level, appState.primaryRegion);
        valueTuples.push([f, val]);
        if (val !== null && Number.isFinite(val)) {
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
        }
    }

    // ── Build D3 Color Scale ─────────────────────────────────────────────────────
    let colorScale;
    let legendGradientCss = '';

    if (minVal === Infinity) {
        // Fallback if absolutely no data exists for current filters
        minVal = 0;
        maxVal = 0;
        colorScale = () => 'var(--accent-bg)';
        legendGradientCss = 'var(--accent-bg)';
    } else {
        if (metricMeta.direction === 'both') {
            // Diverging scale for net metrics (Negative = red/orange, 0 = neutral, Positive = green/teal)
            // Ensure the scale is visually balanced around zero by taking the max absolute bound.
            const absMax = Math.max(Math.abs(minVal), Math.abs(maxVal));
            // Avoid divide-by-zero if absMax is 0
            const domainMax = absMax > 0 ? absMax : 1;

            // Use 11 discrete parts of the RdYlGn scheme
            const divColors = d3.schemeRdYlGn[11];

            colorScale = d3.scaleQuantize()
                .domain([-domainMax, domainMax])
                .range(divColors);

            // Update bounds for legend display to reflect the balanced domain
            minVal = -domainMax;
            maxVal = domainMax;

            // Generate a hard-stepped gradient for the legend
            legendGradientCss = 'linear-gradient(to right, ' + divColors.map((c, i) => `${c} ${(i / 11) * 100}%, ${c} ${((i + 1) / 11) * 100}%`).join(', ') + ')';

        } else {
            // Sequential scale for inflow/outflow/avg
            // Domain from 0 (or min if > 0) to max
            const domainMin = minVal < 0 ? minVal : 0;
            const domainMax = maxVal > domainMin ? maxVal : domainMin + 1;

            // d3.schemePuBu only defines discrete arrays up to 9 items.
            // We quantize the continuous interpolator to get exactly 11 distinct colors.
            const seqColors = d3.quantize(d3.interpolatePuBu, 11);

            colorScale = d3.scaleQuantize()
                .domain([domainMin, domainMax])
                .range(seqColors);

            // Update bounds for legend display
            minVal = domainMin;
            maxVal = domainMax;

            // Generate a hard-stepped gradient for the legend
            legendGradientCss = 'linear-gradient(to right, ' + seqColors.map((c, i) => `${c} ${(i / 11) * 100}%, ${c} ${((i + 1) / 11) * 100}%`).join(', ') + ')';
        }
    }

    // ── Update Legend UI ─────────────────────────────────────────────────────────
    const legendEl = document.getElementById('map-legend');
    if (minVal !== Infinity) {
        document.getElementById('legend-min').textContent = formatMetricValue(minVal, appState.metric);
        document.getElementById('legend-max').textContent = formatMetricValue(maxVal, appState.metric);
        document.getElementById('legend-gradient').style.background = legendGradientCss;
        legendEl.style.display = 'flex';
    } else {
        legendEl.style.display = 'none';
    }

    // ── Projection & Zoom: AlbersUSA fitted to container ──────────────────────────────
    const margin = 18;
    mapProjection = d3.geoAlbersUsa().fitExtent(
        [[margin, margin], [width - margin, height - margin]],
        geo.features
    );

    // Apply zoom transformation to projection
    // AlbersUsa composite projection doesn't support .scale() * multiplier directly
    // Instead we calculate the base scale and translate, then apply the zoom transform.
    const baseScale = mapProjection.scale();
    const baseTranslate = mapProjection.translate();

    const zoomFactor = appState.zoomLevel;

    // We want to zoom towards the center of the viewport
    const centerX = width / 2;
    const centerY = height / 2;

    mapProjection
        .scale(baseScale * zoomFactor)
        .translate([
            centerX + (baseTranslate[0] - centerX) * zoomFactor,
            centerY + (baseTranslate[1] - centerY) * zoomFactor
        ]);

    mapPath = d3.geoPath(mapProjection);

    // ── Base layer: one <path> per geographic region ──────────────────────────
    mapLayerBase
        .selectAll('path.region')
        .data(valueTuples, d => d[0].fipsKey)
        .join(
            enter => enter.append('path')
                .attr('class', 'region')
                // Set initial D for smooth transition on first draw (optional)
                .attr('d', d => mapPath(d[0]))
                .attr('fill', d => {
                    const val = d[1];
                    return (val === null || !Number.isFinite(val)) ? 'var(--bg)' : colorScale(val);
                }),
            update => update
                .attr('d', d => mapPath(d[0])) // Update path for zooming
                .attr('fill', d => {
                    const val = d[1];
                    return (val === null || !Number.isFinite(val)) ? 'var(--bg)' : colorScale(val);
                })
        );

    // ── Border layer ────────────────────────────────────────────────────────────
    // County internal borders (only in county mode)
    mapLayerBorder
        .selectAll('path.county-mesh')
        .data(appState.level === 'county' && geo.countyMesh ? [geo.countyMesh] : [])
        .join('path')
        .attr('class', 'county-mesh')
        .attr('d', mapPath)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(0,0,0,0.12)')
        .attr('stroke-width', 0.25 * zoomFactor); // Scale border width slightly

    // State internal borders
    mapLayerBorder
        .selectAll('path.state-mesh')
        .data([geo.stateMesh])
        .join('path')
        .attr('class', 'state-mesh')
        .attr('d', mapPath)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(80,80,80,0.40)')
        .attr('stroke-width', (appState.level === 'state' ? 0.8 : 1.2) * zoomFactor);

    // Nation outer boundary
    mapLayerBorder
        .selectAll('path.nation-mesh')
        .data([geo.nationMesh])
        .join('path')
        .attr('class', 'nation-mesh')
        .attr('d', mapPath)
        .attr('fill', 'none')
        .attr('stroke', 'rgba(60,60,60,0.55)')
        .attr('stroke-width', 1.5 * zoomFactor);

    console.debug(`[Map] geo rendered (gen=${gen}, level=${appState.level}, zoom=${zoomFactor})`);
}

function renderChart() {
    // TODO: Milestone 5 — line chart
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 9 — CONTROL WIRING  (Milestone 3.3)
═══════════════════════════════════════════════════════════════════════════ */

function wireControls() {
    // ── Granularity radio buttons ─────────────────────────────────────────────
    document.querySelectorAll('input[name="granularity"]').forEach(radio => {
        radio.addEventListener('change', async () => {
            appState.level = radio.value;
            appState.primaryRegion = null;
            appState.secondaryRegion = null;
            updateSelectionUI();

            if (appState.level === 'county' && !countyDataLoaded) {
                setLoadingState(true, 'Loading county data…');
                try {
                    await loadCountyData();
                } finally {
                    setLoadingState(false);
                }
            }
            render();
        });
    });

    // ── Year slider ───────────────────────────────────────────────────────────
    const slider = document.getElementById('year-slider');
    const yearLabel = document.getElementById('year-display');

    slider.addEventListener('input', () => {
        appState.yearIndex = +slider.value;
        const tag = currentYear();
        yearLabel.textContent = YEAR_LABELS[tag];
        // Update filled-track CSS custom property
        const pct = (appState.yearIndex / (YEARS.length - 1)) * 100;
        slider.style.setProperty('--slider-pct', `${pct}%`);
        slider.setAttribute('aria-valuenow', appState.yearIndex);
        slider.setAttribute('aria-valuetext', YEAR_LABELS[tag]);
        render();
    });

    // Initialise filled-track percentage on load
    slider.style.setProperty('--slider-pct', '0%');

    // ── Metric select ─────────────────────────────────────────────────────────
    document.getElementById('metric-select').addEventListener('change', e => {
        appState.metric = e.target.value;
        render();
    });

    // ── Flow-type select (sidebar) ────────────────────────────────────────────
    document.getElementById('flow-type-select').addEventListener('change', e => {
        appState.flowType = e.target.value;
        renderChart();
    });

    // ── Clear-selection button ────────────────────────────────────────────────
    document.getElementById('clear-selection-btn').addEventListener('click', () => {
        appState.primaryRegion = null;
        appState.secondaryRegion = null;
        updateSelectionUI();
        render();
    });

    // ── Zoom slider ───────────────────────────────────────────────────────────
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomLabel = document.getElementById('zoom-display');

    zoomSlider.addEventListener('input', () => {
        appState.zoomLevel = +zoomSlider.value;
        zoomLabel.textContent = `${appState.zoomLevel}×`;

        // Update filled-track CSS custom property for zoom slider
        const min = +zoomSlider.min;
        const max = +zoomSlider.max;
        const pct = ((appState.zoomLevel - min) / (max - min)) * 100;
        zoomSlider.style.setProperty('--zoom-pct', `${pct}%`);
        zoomSlider.setAttribute('aria-valuenow', appState.zoomLevel);
        zoomSlider.setAttribute('aria-valuetext', `${appState.zoomLevel}×`);

        renderMap(); // Only need to re-render map, not chart
    });
}

/**
 * initUI()
 *
 * Synchronises every HTML control with the current appState values.
 * Called once after data loads so that the initial display is consistent
 * regardless of any defaults set in the appState object at the top of the file.
 *
 * Also useful if appState is mutated programmatically (e.g. deep-linking via
 * URL hash) before DOMContentLoaded fires.
 */
function initUI() {
    // ── Granularity radio ─────────────────────────────────────────────────────
    const radio = document.querySelector(
        `input[name="granularity"][value="${appState.level}"]`
    );
    if (radio) radio.checked = true;

    // ── Year slider ───────────────────────────────────────────────────────────
    const slider = document.getElementById('year-slider');
    const yearLabel = document.getElementById('year-display');
    slider.value = appState.yearIndex;
    const tag = currentYear();
    yearLabel.textContent = YEAR_LABELS[tag];
    const pct = (appState.yearIndex / (YEARS.length - 1)) * 100;
    slider.style.setProperty('--slider-pct', `${pct}%`);
    slider.setAttribute('aria-valuenow', appState.yearIndex);
    slider.setAttribute('aria-valuetext', YEAR_LABELS[tag]);

    // ── Metric select ─────────────────────────────────────────────────────────
    const metricEl = document.getElementById('metric-select');
    metricEl.value = appState.metric;

    // ── Flow-type select ─────────────────────────────────────────────────────
    const ftEl = document.getElementById('flow-type-select');
    ftEl.value = appState.flowType;

    // ── Zoom slider ───────────────────────────────────────────────────────────
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomLabel = document.getElementById('zoom-display');
    zoomSlider.value = appState.zoomLevel;
    zoomLabel.textContent = `${appState.zoomLevel}×`;
    const zoomMin = +zoomSlider.min;
    const zoomMax = +zoomSlider.max;
    const zoomPct = ((appState.zoomLevel - zoomMin) / (zoomMax - zoomMin)) * 100;
    zoomSlider.style.setProperty('--zoom-pct', `${zoomPct}%`);

    // ── Selection sidebar ─────────────────────────────────────────────────────
    updateSelectionUI();
}

/**
 * Show/hide the selection-summary panel and flow-type dropdown based on
 * whether primary/secondary regions are active.
 */
function updateSelectionUI() {
    const summary = document.getElementById('selection-summary');
    const ftControl = document.getElementById('flow-type-control');
    const primaryLbl = document.getElementById('primary-label');
    const secondaryLbl = document.getElementById('secondary-label');
    const statusText = document.getElementById('map-status-text');

    if (!appState.primaryRegion) {
        summary.hidden = true;
        ftControl.hidden = true;
        statusText.textContent = 'Hover over a state, county, or county equivalent to see details';
        return;
    }

    // Build display labels
    let pLabel = appState.primaryRegion;
    let sLabel = appState.secondaryRegion ?? '';

    if (appState.level === 'state') {
        const pm = stateMeta[appState.primaryRegion];
        if (pm) pLabel = `${pm.name} (${pm.postal})`;
        if (appState.secondaryRegion) {
            const sm = stateMeta[appState.secondaryRegion];
            if (sm) sLabel = `→ ${sm.name} (${sm.postal})`;
        }
    } else {
        const pm = countyMeta[appState.primaryRegion];
        if (pm) pLabel = `${pm.countyName}, ${pm.statePostal}`;
        if (appState.secondaryRegion) {
            const sm = countyMeta[appState.secondaryRegion];
            if (sm) sLabel = `→ ${sm.countyName}, ${sm.statePostal}`;
        }
    }

    primaryLbl.textContent = pLabel;
    secondaryLbl.textContent = sLabel;
    secondaryLbl.hidden = !appState.secondaryRegion;

    summary.hidden = false;
    // Show flow-type dropdown only when primary is set but secondary is not
    ftControl.hidden = !!appState.secondaryRegion;
}

/** Show or hide a loading overlay on the map. */
function setLoadingState(loading, message = '') {
    let overlay = document.getElementById('loading-overlay');
    if (loading) {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'loading-overlay';
            overlay.setAttribute('role', 'status');
            overlay.setAttribute('aria-live', 'polite');
            overlay.innerHTML = `<div class="loading-spinner"></div><p class="loading-msg"></p>`;
            document.getElementById('map').appendChild(overlay);
        }
        overlay.querySelector('.loading-msg').textContent = message;
        overlay.hidden = false;
    } else if (overlay) {
        overlay.hidden = true;
    }
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 10 — ENTRY POINT
═══════════════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', async () => {
    console.log('[App] Initialising U.S. Migration Explorer …');

    // Wire all UI controls before data arrives so the page feels interactive
    wireControls();

    // Load state data eagerly; county data loads lazily on first use
    setLoadingState(true, 'Loading migration data…');
    try {
        await loadStateData();
        computeNationalTotals();
        console.log('[App] State data ready. Rendering initial map …');
        console.log('[App] State metadata:', Object.keys(stateMeta).length, 'entries');
        console.log('[App] State totals sample (AL/2122):',
            stateTotals['2122']?.['01'] ?? '—');
        console.log('[App] National totals sample (2122 inflow n2):',
            nationalTotals['2122']?.inflow?.n2?.toLocaleString() ?? '—');
    } catch (err) {
        console.error('[App] Failed to load state data:', err);
    } finally {
        setLoadingState(false);
    }

    // Sync all HTML controls from appState, then do the first render.
    initUI();
    render();

    // Re-render map whenever the container is resized (e.g. window resize)
    const resizeObserver = new ResizeObserver(() => { if (mapSvg) renderMap(); });
    resizeObserver.observe(document.getElementById('map'));

    // Expose data stores and API for debugging and for future milestones
    window._migration = {
        // Data stores
        stateFlows, countyFlows,
        stateTotals, countyTotals,
        nationalTotals,
        stateMeta, countyMeta,
        // Constants
        appState, YEARS, YEAR_LABELS,
        FIPS_TOTAL, SPECIAL_STATE_FIPS, SPECIAL_COUNTY_FIPS,
        METRIC_META,
        // Section 3 — Utilities
        getStateFlow, getCountyFlow,
        getStateTotals, getCountyTotals,
        isRealStateFips, isRealCounty,
        // Section 6 — Metric computation
        computeMetric, getMapValue,
        formatMetricValue, getMetricLabel,
        // Section 7.5 — Geo integration
        loadGeoData, setupMapSvg,
        geoCache,
        get mapProjection() { return mapProjection; },
        get mapPath() { return mapPath; },
        get mapLayerBase() { return mapLayerBase; },
        get mapLayerBorder() { return mapLayerBorder; },
        // Section 9 — UI helpers
        initUI, wireControls, updateSelectionUI, setLoadingState,
        // Loaders
        loadCountyData,
        // Render
        render,
    };
});
