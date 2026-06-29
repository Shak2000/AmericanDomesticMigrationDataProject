/**
 * script.js — U.S. Migration Explorer
 *
 * Phase 3 — Core D3 Infrastructure
 *
 * Milestone 3.1: Data Loading & Preprocessing
 * - Loads all 12 enriched CSV files (state + county, inflow + outflow, 3 years)
 * - Parses numeric columns (n1, n2, AGI) to numbers
 * - Builds stateFlows / countyFlows lookup maps
 * - Precomputes per-region totals from IRS aggregate rows (y1/y2 FIPS = "96")
 *
 * Milestone 3.2: Derived Metric Computation
 * - METRIC_META: registry of all 22+ metrics (label, unit, direction, format)
 * - computeMetric(metricKey, records): pure function → number | null
 * - getMapValue(regionKey, year, metricKey, level, primaryRegion): dispatcher
 * - formatMetricValue(value, metricKey): display formatter
 * - computeNationalTotals(): sums stateTotals across all states (share denominator)
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
const YEARS = [
    '0809', '0910', '1011', '1112', '1213', '1314', '1415',
    '1516', '1617', '1718', '1819', '1920', '2021', '2122', '2223'
];

/** Human-readable labels for each year tag. */
const YEAR_LABELS = {
    '0809': '2008–2009', '0910': '2009–2010', '1011': '2010–2011', '1112': '2011–2012', '1213': '2012–2013',
    '1314': '2013–2014', '1415': '2014–2015', '1516': '2015–2016', '1617': '2016–2017', '1718': '2017–2018',
    '1819': '2018–2019', '1920': '2019–2020', '2021': '2020–2021', '2122': '2021–2022', '2223': '2022–2023'
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
const SPECIAL_COUNTY_FIPS = new Set(['000']);

/**
 * File manifest.
 * Each entry describes one enriched CSV and its logical key triple.
 * State files are loaded eagerly on startup (small, ~200 KB each).
 * County files are loaded lazily the first time the user switches to county
 * view (large, ~7–8 MB each × 6 files ≈ 45 MB total).
 */
const DATA_FILES = [];

for (const year of YEARS) {
    // ── State files ─────────────────────────────────────────────────────────
    DATA_FILES.push({
        level: 'state', year: year, direction: 'inflow',
        path: `data/enriched/state_inflow/stateinflow${year}_enriched.csv`
    });
    DATA_FILES.push({
        level: 'state', year: year, direction: 'outflow',
        path: `data/enriched/state_outflow/stateoutflow${year}_enriched.csv`
    });

    // ── County files ────────────────────────────────────────────────────────
    DATA_FILES.push({
        level: 'county', year: year, direction: 'inflow',
        path: `data/enriched/county_inflow/countyinflow${year}_enriched.csv`
    });
    DATA_FILES.push({
        level: 'county', year: year, direction: 'outflow',
        path: `data/enriched/county_outflow/countyoutflow${year}_enriched.csv`
    });
}

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
 * Inflow total  = inflow row where y1_statefips = "96" (US+Foreign total)
 * Outflow total = outflow row where y2_statefips = "96"
 * Only populated for real state FIPS (01–56, 72).
 */
const stateTotals = {};

/**
 * countyTotals[year][key] → { inflow: {n1,n2,AGI}, outflow: {n1,n2,AGI} }
 *
 * Extracted from IRS aggregate rows:
 * Inflow total  = row where y1_statefips="96" AND y1_countyfips="000"
 * Outflow total = row where y2_statefips="96" AND y2_countyfips="000"
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
    return isRealStateFips(sf) && !SPECIAL_COUNTY_FIPS.has(cf) && !cf.startsWith('AGG');
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
 */
function processStateRows(rows, year, direction) {
    if (!stateFlows[year]) stateFlows[year] = {};
    if (!stateFlows[year][direction]) stateFlows[year][direction] = {};
    if (!stateTotals[year]) stateTotals[year] = {};

    const dirMap = stateFlows[year][direction];

    for (const row of rows) {
        const y1 = row.y1_statefips;
        const y2 = row.y2_statefips;
        const rec = { n1: parseNum(row.n1), n2: parseNum(row.n2), AGI: parseNum(row.AGI) };

        if (!dirMap[y1]) dirMap[y1] = {};
        dirMap[y1][y2] = rec;

        if (isRealStateFips(y2)) stateMeta[y2] = { postal: row.y2_state, name: row.y2_state_name };
        if (isRealStateFips(y1)) stateMeta[y1] = { postal: row.y1_state, name: row.y1_state_name };

        // Support fallback naming in case scripts output differently
        const y1Name = row.y1_state_name || row.y1_statename || row.y1_name || '';
        const y2Name = row.y2_state_name || row.y2_statename || row.y2_name || '';
        const isNonMigrant = y1Name.includes('Non-migrants') || y2Name.includes('Non-migrants');
        const isSameState1 = y1Name.includes('Total Migration-Same State');
        const isSameState2 = y2Name.includes('Total Migration-Same State');

        if (direction === 'inflow') {
            let refFips = null;
            let isTotal = false;

            // Agnostic check: Find which side is the real state and which has the aggregate string
            if (isRealStateFips(y2) && y1Name.includes('Total Migration-US and Foreign')) {
                refFips = y2;
                isTotal = true;
            } else if (isRealStateFips(y1) && y2Name.includes('Total Migration-US and Foreign')) {
                refFips = y1;
                isTotal = true;
            } else if (isRealStateFips(y2) && (isNonMigrant || isSameState1)) {
                refFips = y2;
            } else if (isRealStateFips(y1) && (isNonMigrant || isSameState2)) {
                refFips = y1;
            }

            if (refFips) {
                if (!stateTotals[year][refFips]) stateTotals[year][refFips] = {};

                // base_inflow: Includes everything (Non-migrants, Same State, Total Migration) for share denominators
                if (!stateTotals[year][refFips].base_inflow) stateTotals[year][refFips].base_inflow = { n1: 0, n2: 0, AGI: 0 };
                stateTotals[year][refFips].base_inflow.n1 += rec.n1;
                stateTotals[year][refFips].base_inflow.n2 += rec.n2;
                stateTotals[year][refFips].base_inflow.AGI += rec.AGI;

                // inflow: Purely migration from US/Foreign
                if (isTotal) {
                    if (!stateTotals[year][refFips].inflow) stateTotals[year][refFips].inflow = { n1: 0, n2: 0, AGI: 0 };
                    stateTotals[year][refFips].inflow.n1 += rec.n1;
                    stateTotals[year][refFips].inflow.n2 += rec.n2;
                    stateTotals[year][refFips].inflow.AGI += rec.AGI;
                }
            }
        }

        if (direction === 'outflow') {
            let refFips = null;
            let isTotal = false;

            if (isRealStateFips(y1) && y2Name.includes('Total Migration-US and Foreign')) {
                refFips = y1;
                isTotal = true;
            } else if (isRealStateFips(y2) && y1Name.includes('Total Migration-US and Foreign')) {
                refFips = y2;
                isTotal = true;
            } else if (isRealStateFips(y1) && (isNonMigrant || isSameState2)) {
                refFips = y1;
            } else if (isRealStateFips(y2) && (isNonMigrant || isSameState1)) {
                refFips = y2;
            }

            if (refFips) {
                if (!stateTotals[year][refFips]) stateTotals[year][refFips] = {};

                if (!stateTotals[year][refFips].base_outflow) stateTotals[year][refFips].base_outflow = { n1: 0, n2: 0, AGI: 0 };
                stateTotals[year][refFips].base_outflow.n1 += rec.n1;
                stateTotals[year][refFips].base_outflow.n2 += rec.n2;
                stateTotals[year][refFips].base_outflow.AGI += rec.AGI;

                if (isTotal) {
                    if (!stateTotals[year][refFips].outflow) stateTotals[year][refFips].outflow = { n1: 0, n2: 0, AGI: 0 };
                    stateTotals[year][refFips].outflow.n1 += rec.n1;
                    stateTotals[year][refFips].outflow.n2 += rec.n2;
                    stateTotals[year][refFips].outflow.AGI += rec.AGI;
                }
            }
        }
    }
}

/**
 * Process one batch of rows from a county enriched CSV.
 * Populates countyFlows, countyTotals, and countyMeta.
 */
function processCountyRows(rows, year, direction) {
    if (!countyFlows[year]) countyFlows[year] = {};
    if (!countyFlows[year][direction]) countyFlows[year][direction] = {};
    if (!countyTotals[year]) countyTotals[year] = {};

    const dirMap = countyFlows[year][direction];

    for (const row of rows) {
        const y1sf = row.y1_statefips, y1cf = row.y1_countyfips;
        const y2sf = row.y2_statefips, y2cf = row.y2_countyfips;
        const y1Key = `${y1sf}_${y1cf}`, y2Key = `${y2sf}_${y2cf}`;
        const rec = { n1: parseNum(row.n1), n2: parseNum(row.n2), AGI: parseNum(row.AGI) };

        if (!dirMap[y1Key]) dirMap[y1Key] = {};
        dirMap[y1Key][y2Key] = rec;

        if (isRealCounty(y2sf, y2cf)) countyMeta[y2Key] = { statefips: y2sf, countyfips: y2cf, countyName: row.y2_county_name, stateName: row.y2_state_name, statePostal: row.y2_state };
        if (isRealCounty(y1sf, y1cf)) countyMeta[y1Key] = { statefips: y1sf, countyfips: y1cf, countyName: row.y1_county_name, stateName: row.y1_state_name, statePostal: row.y1_state };

        // Robust FIPS-based checks instead of fragile string matching
        const isNonMigrant = (y1sf === y2sf && y1cf === y2cf);

        if (direction === 'inflow') {
            let refKey = null;
            let isTotal = false;

            if (isRealCounty(y2sf, y2cf) && y1sf === '96') {
                refKey = y2Key;
                isTotal = true;
            } else if (isRealCounty(y1sf, y1cf) && y2sf === '96') {
                refKey = y1Key;
                isTotal = true;
            } else if (isRealCounty(y1sf, y1cf) && isNonMigrant) {
                refKey = y1Key;
            } else if (isRealCounty(y2sf, y2cf) && isNonMigrant) {
                refKey = y2Key;
            }

            if (refKey) {
                if (!countyTotals[year][refKey]) countyTotals[year][refKey] = {};

                if (!countyTotals[year][refKey].base_inflow) countyTotals[year][refKey].base_inflow = { n1: 0, n2: 0, AGI: 0 };
                countyTotals[year][refKey].base_inflow.n1 += rec.n1;
                countyTotals[year][refKey].base_inflow.n2 += rec.n2;
                countyTotals[year][refKey].base_inflow.AGI += rec.AGI;

                if (isTotal) {
                    if (!countyTotals[year][refKey].inflow) countyTotals[year][refKey].inflow = { n1: 0, n2: 0, AGI: 0 };
                    countyTotals[year][refKey].inflow.n1 += rec.n1;
                    countyTotals[year][refKey].inflow.n2 += rec.n2;
                    countyTotals[year][refKey].inflow.AGI += rec.AGI;
                }
            }
        }

        if (direction === 'outflow') {
            let refKey = null;
            let isTotal = false;

            if (isRealCounty(y1sf, y1cf) && y2sf === '96') {
                refKey = y1Key;
                isTotal = true;
            } else if (isRealCounty(y2sf, y2cf) && y1sf === '96') {
                refKey = y2Key;
                isTotal = true;
            } else if (isRealCounty(y1sf, y1cf) && isNonMigrant) {
                refKey = y1Key;
            } else if (isRealCounty(y2sf, y2cf) && isNonMigrant) {
                refKey = y2Key;
            }

            if (refKey) {
                if (!countyTotals[year][refKey]) countyTotals[year][refKey] = {};

                if (!countyTotals[year][refKey].base_outflow) countyTotals[year][refKey].base_outflow = { n1: 0, n2: 0, AGI: 0 };
                countyTotals[year][refKey].base_outflow.n1 += rec.n1;
                countyTotals[year][refKey].base_outflow.n2 += rec.n2;
                countyTotals[year][refKey].base_outflow.AGI += rec.AGI;

                if (isTotal) {
                    if (!countyTotals[year][refKey].outflow) countyTotals[year][refKey].outflow = { n1: 0, n2: 0, AGI: 0 };
                    countyTotals[year][refKey].outflow.n1 += rec.n1;
                    countyTotals[year][refKey].outflow.n2 += rec.n2;
                    countyTotals[year][refKey].outflow.AGI += rec.AGI;
                }
            }
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
   SECTION 6 — DERIVED METRIC COMPUTATION  (Milestone 3.2 & 9.2)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Metadata registry for all metrics.
 *
 * Fields:
 * label     — human-readable name (matches index.html <option> text)
 * direction — which flow direction(s) the metric reads:
 * 'inflow'  → only uses inflow record
 * 'outflow' → only uses outflow record
 * 'both'    → uses both (net metrics) or neither (avg AGI)
 * format    — how to display the value:
 * 'integer'  → round to whole number, add comma separator
 * 'currency' → round to whole number, thousands of $, add comma
 * 'percent'  → multiply by 100, show as X.X %
 * 'decimal'  → display with 2 decimal places
 *
 * AGI values in the raw data are in thousands of dollars.
 * Avg AGI metrics therefore produce values in thousands of $/person.
 */
const METRIC_META = {
    // ── Population ──────────────────────────────────────────────────────────
    pop_inflow: { label: 'Population inflow', direction: 'inflow', format: 'integer' },
    pop_outflow: { label: 'Population outflow', direction: 'outflow', format: 'integer' },
    pop_net_inflow: { label: 'Net population inflow', direction: 'both', format: 'integer' },
    pop_net_outflow: { label: 'Net population outflow', direction: 'both', format: 'integer' },
    pop_inflow_share: { label: 'Population inflow as share of population', direction: 'inflow', format: 'percent' },
    pop_outflow_share: { label: 'Population outflow as share of population', direction: 'outflow', format: 'percent' },
    pop_net_inflow_share: { label: 'Net population inflow as share of population', direction: 'both', format: 'percent' },
    pop_net_outflow_share: { label: 'Net population outflow as share of population', direction: 'both', format: 'percent' },
    pop_inflow_total_share: { label: 'Share of total population inflow', direction: 'inflow', format: 'percent' },
    pop_outflow_total_share: { label: 'Share of total population outflow', direction: 'outflow', format: 'percent' },

    // ── Households ──────────────────────────────────────────────────────────
    hh_inflow: { label: 'Household inflow', direction: 'inflow', format: 'integer' },
    hh_outflow: { label: 'Household outflow', direction: 'outflow', format: 'integer' },
    hh_net_inflow: { label: 'Net household inflow', direction: 'both', format: 'integer' },
    hh_net_outflow: { label: 'Net household outflow', direction: 'both', format: 'integer' },
    hh_inflow_share: { label: 'Household inflow as share of households', direction: 'inflow', format: 'percent' },
    hh_outflow_share: { label: 'Household outflow as share of households', direction: 'outflow', format: 'percent' },
    hh_net_inflow_share: { label: 'Net household inflow as share of households', direction: 'both', format: 'percent' },
    hh_net_outflow_share: { label: 'Net household outflow as share of households', direction: 'both', format: 'percent' },
    hh_inflow_total_share: { label: 'Share of total household inflow', direction: 'inflow', format: 'percent' },
    hh_outflow_total_share: { label: 'Share of total household outflow', direction: 'outflow', format: 'percent' },

    // ── AGI ─────────────────────────────────────────────────────────────────
    agi_inflow: { label: 'AGI inflow', direction: 'inflow', format: 'currency' },
    agi_outflow: { label: 'AGI outflow', direction: 'outflow', format: 'currency' },
    agi_net_inflow: { label: 'Net AGI inflow', direction: 'both', format: 'currency' },
    agi_net_outflow: { label: 'Net AGI outflow', direction: 'both', format: 'currency' },
    agi_inflow_share: { label: 'AGI inflow as share of AGI', direction: 'inflow', format: 'percent' },
    agi_outflow_share: { label: 'AGI outflow as share of AGI', direction: 'outflow', format: 'percent' },
    agi_net_inflow_share: { label: 'Net AGI inflow as share of AGI', direction: 'both', format: 'percent' },
    agi_net_outflow_share: { label: 'Net AGI outflow as share of AGI', direction: 'both', format: 'percent' },
    agi_inflow_total_share: { label: 'Share of total AGI inflow', direction: 'inflow', format: 'percent' },
    agi_outflow_total_share: { label: 'Share of total AGI outflow', direction: 'outflow', format: 'percent' },

    // ── Inbound / Outbound Rates ─────────────────────────────────────────────
    pop_inbound_rate: { label: 'Population inbound rate', direction: 'both', format: 'percent' },
    pop_outbound_rate: { label: 'Population outbound rate', direction: 'both', format: 'percent' },
    hh_inbound_rate: { label: 'Household inbound rate', direction: 'both', format: 'percent' },
    hh_outbound_rate: { label: 'Household outbound rate', direction: 'both', format: 'percent' },
    agi_inbound_rate: { label: 'AGI inbound rate', direction: 'both', format: 'percent' },
    agi_outbound_rate: { label: 'AGI outbound rate', direction: 'both', format: 'percent' },

    // ── Average AGI ─────────────────────────────────────────────────────────
    avg_agi_in_individual: { label: 'Avg AGI of individual moving in', direction: 'inflow', format: 'currency' },
    avg_agi_in_household: { label: 'Avg AGI of household moving in', direction: 'inflow', format: 'currency' },
    avg_agi_out_individual: { label: 'Avg AGI of individual moving out', direction: 'outflow', format: 'currency' },
    avg_agi_out_household: { label: 'Avg AGI of household moving out', direction: 'outflow', format: 'currency' },

    // ── Ratio of Average AGIs ────────────────────────────────────────────────
    agi_ratio_in_out_individual: { label: 'Avg AGI ratio, in- to out-mover individual', direction: 'both', format: 'decimal' },
    agi_ratio_in_out_household: { label: 'Avg AGI ratio, in- to out-mover household', direction: 'both', format: 'decimal' },
    agi_ratio_out_in_individual: { label: 'Avg AGI ratio, out- to in-mover individual', direction: 'both', format: 'decimal' },
    agi_ratio_out_in_household: { label: 'Avg AGI ratio, out- to in-mover household', direction: 'both', format: 'decimal' },
};

/* ── Two-dropdown metric selection ──────────────────────────────────────────
 * Instead of one large dropdown, the UI uses a Category selector (Population /
 * Households / AGI) paired with a Statistic selector whose options depend on
 * the chosen category.  AGI has extra stats (avg AGI metrics) that the other
 * categories lack.
 *
 * STAT_OPTIONS lists the common statistics available in ALL categories.
 * AGI_EXTRA_STATS lists additional statistics available only when AGI is selected.
 */

const STAT_OPTIONS = [
    { suffix: 'inflow', label: 'Inflow', pairLabel: 'Inflow (B → A)', desc: 'The number of people, households, or dollars (AGI) moving into a region during a given tax year.' },
    { suffix: 'outflow', label: 'Outflow', pairLabel: 'Outflow (A → B)', desc: 'The number of people, households, or dollars (AGI) moving out of a region during a given tax year.' },
    { suffix: 'net_inflow', label: 'Net inflow', pairLabel: 'Net inflow (B → A)', desc: 'The difference between inflow and outflow. Net inflow = inflow − outflow (positive means the region gained).' },
    { suffix: 'net_outflow', label: 'Net outflow', pairLabel: 'Net outflow (A → B)', desc: 'The difference between inflow and outflow. Net outflow = outflow − inflow (positive means the region lost).' },
    { suffix: 'inflow_share', label: 'Inflow rate', pairLabel: 'Inflow rate (B → A)', desc: "A region's inflow expressed as a percentage of the region's total population, number of households, or AGI." },
    { suffix: 'outflow_share', label: 'Outflow rate', pairLabel: 'Outflow rate (A → B)', desc: "A region's outflow expressed as a percentage of the region's total population, number of households, or AGI." },
    { suffix: 'net_inflow_share', label: 'Net inflow rate', pairLabel: 'Net inflow rate (B → A)', desc: "A region's net inflow expressed as a percentage of the region's total population, number of households, or AGI." },
    { suffix: 'net_outflow_share', label: 'Net outflow rate', pairLabel: 'Net outflow rate (A → B)', desc: "A region's net outflow expressed as a percentage of the region's total population, number of households, or AGI." },
    { suffix: 'inflow_total_share', label: 'Inflow share', pairLabel: 'Inflow share (B → A)', desc: "When unselected, the region's share of the total national inflow of people, households, or dollars (AGI). When selected, the region's share of the primary region's total inflow." },
    { suffix: 'outflow_total_share', label: 'Outflow share', pairLabel: 'Outflow share (A → B)', desc: "When unselected, the region's share of the total national outflow of people, households, or dollars (AGI). When selected, the region's share of the primary region's total outflow." },
    { suffix: 'inbound_rate', label: 'Inbound rate', pairLabel: 'Inbound rate', desc: 'The proportion of total migration volume that is inbound. Calculated as inflow ÷ (inflow + outflow). A rate above 50% indicates the region attracts more migrants than it loses.' },
    { suffix: 'outbound_rate', label: 'Outbound rate', pairLabel: 'Outbound rate', desc: 'The proportion of total migration volume that is outbound. Calculated as outflow ÷ (inflow + outflow). Equal to 1 − inbound rate.' },
];

/* ── Split dropdown options (Base stats) ─────────────────────────────────── */
const STAT_BASE_OPTIONS = [
    { base: 'total', label: 'Total', pairLabel: 'Total', desc: 'The total number of people, households, or dollars (AGI) moving.' },
    { base: 'net', label: 'Net', pairLabel: 'Net', desc: 'The difference between inflow and outflow.' },
    { base: 'rate', label: 'Rate (relative to population)', pairLabel: 'Rate', desc: "The migration expressed as a percentage of the region's total population, households, or AGI." },
    { base: 'net_rate', label: 'Net rate (relative to population)', pairLabel: 'Net rate', desc: "The net migration expressed as a percentage of the region's total population, households, or AGI." },
    { base: 'share', label: 'Share of total migration', pairLabel: 'Share', desc: "The region's share of the total national or primary region's migration flow." },
    { base: 'volume_share', label: 'Share of combined in/out volume', pairLabel: 'Volume share', desc: 'The proportion of total migration volume (inflow + outflow) that is in this direction.' }
];

const AGI_EXTRA_BASE_STATS = [
    { base: 'avg_individual', label: 'Average AGI per individual', pairLabel: 'Average AGI per individual', desc: 'The average AGI of each individual moving.' },
    { base: 'avg_household', label: 'Average AGI per household', pairLabel: 'Average AGI per household', desc: 'The average AGI of each household moving.' },
    { base: 'ratio_individual', label: 'Ratio of avg AGI per individual', pairLabel: 'Ratio of avg AGI per individual', desc: 'The ratio of average AGI between in-movers and out-movers.' },
    { base: 'ratio_household', label: 'Ratio of avg AGI per household', pairLabel: 'Ratio of avg AGI per household', desc: 'The ratio of average AGI between in-movers and out-movers.' }
];

const AGI_EXTRA_STATS = [
    { suffix: 'avg_agi_in_individual', label: 'Avg AGI of individual moving in', pairLabel: 'Avg AGI of individual moving in (B → A)', desc: 'The average Adjusted Gross Income (AGI) of each individual moving into a region.' },
    { suffix: 'avg_agi_in_household', label: 'Avg AGI of household moving in', pairLabel: 'Avg AGI of household moving in (B → A)', desc: 'The average Adjusted Gross Income (AGI) of each household moving into a region.' },
    { suffix: 'avg_agi_out_individual', label: 'Avg AGI of individual moving out', pairLabel: 'Avg AGI of individual moving out (A → B)', desc: 'The average Adjusted Gross Income (AGI) of each individual moving out of a region.' },
    { suffix: 'avg_agi_out_household', label: 'Avg AGI of household moving out', pairLabel: 'Avg AGI of household moving out (A → B)', desc: 'The average Adjusted Gross Income (AGI) of each household moving out of a region.' },
    { suffix: 'agi_ratio_in_out_individual', label: 'Avg AGI ratio, in- to out-mover individual', pairLabel: 'Avg AGI ratio, in- to out-mover individual', desc: 'The ratio of the average AGI per individual moving in to the average AGI per individual moving out. A ratio above 1.0 means in-movers have higher average incomes than out-movers.' },
    { suffix: 'agi_ratio_in_out_household', label: 'Avg AGI ratio, in- to out-mover household', pairLabel: 'Avg AGI ratio, in- to out-mover household', desc: 'The ratio of the average AGI per household moving in to the average AGI per household moving out. A ratio above 1.0 means in-movers have higher average incomes than out-movers.' },
    { suffix: 'agi_ratio_out_in_individual', label: 'Avg AGI ratio, out- to in-mover individual', pairLabel: 'Avg AGI ratio, out- to in-mover individual', desc: 'The ratio of the average AGI per individual moving out to the average AGI per individual moving in. A ratio above 1.0 means out-movers have higher average incomes than in-movers.' },
    { suffix: 'agi_ratio_out_in_household', label: 'Avg AGI ratio, out- to in-mover household', pairLabel: 'Avg AGI ratio, out- to in-mover household', desc: 'The ratio of the average AGI per household moving out to the average AGI per household moving in. A ratio above 1.0 means out-movers have higher average incomes than in-movers.' },
];

function getMetricDescription(metricKey) {
    const suffix = extractStatSuffix(metricKey);
    const category = extractMetricCategory(metricKey);
    const allStats = [...STAT_OPTIONS, ...AGI_EXTRA_STATS];
    const stat = allStats.find(s => s.suffix === suffix);
    let desc = stat && stat.desc ? stat.desc : '';

    if (category === 'pop') {
        desc = desc.replace('people, households, or dollars (AGI)', 'people');
        desc = desc.replace("population, number of households, or AGI", "population");
    } else if (category === 'hh') {
        desc = desc.replace('people, households, or dollars (AGI)', 'households');
        desc = desc.replace("population, number of households, or AGI", "number of households");
    } else if (category === 'agi') {
        desc = desc.replace('people, households, or dollars (AGI)', 'dollars (AGI)');
        desc = desc.replace("population, number of households, or AGI", "AGI");
    }

    return desc;
}

function updateStatisticDescription(elementId, metricKey) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = getMetricDescription(metricKey);
    }
}

/**
 * Build the full METRIC_META key from category, direction, and baseStat.
 */
function buildMetricKey(category, direction, baseStat) {
    const isOut = (direction === 'out');

    // AGI Extras
    if (baseStat === 'avg_individual') return isOut ? 'avg_agi_out_individual' : 'avg_agi_in_individual';
    if (baseStat === 'avg_household') return isOut ? 'avg_agi_out_household' : 'avg_agi_in_household';
    if (baseStat === 'ratio_individual') return isOut ? 'agi_ratio_out_in_individual' : 'agi_ratio_in_out_individual';
    if (baseStat === 'ratio_household') return isOut ? 'agi_ratio_out_in_household' : 'agi_ratio_in_out_household';

    // Standard Stats
    let suffix = '';
    if (baseStat === 'total') suffix = isOut ? 'outflow' : 'inflow';
    if (baseStat === 'net') suffix = isOut ? 'net_outflow' : 'net_inflow';
    if (baseStat === 'rate') suffix = isOut ? 'outflow_share' : 'inflow_share';
    if (baseStat === 'net_rate') suffix = isOut ? 'net_outflow_share' : 'net_inflow_share';
    if (baseStat === 'share') suffix = isOut ? 'outflow_total_share' : 'inflow_total_share';
    if (baseStat === 'volume_share') suffix = isOut ? 'outbound_rate' : 'inbound_rate';

    return `${category}_${suffix}`;
}

/**
 * Extract category, direction, and baseStat from a full metric key.
 */
function parseMetricKey(metricKey) {
    let category = 'pop';
    if (metricKey.startsWith('agi_') || metricKey.startsWith('avg_agi_') || metricKey.startsWith('agi_ratio_')) category = 'agi';
    else if (metricKey.startsWith('hh_')) category = 'hh';

    let suffix = metricKey;
    for (const p of ['pop_', 'hh_', 'agi_']) {
        if (metricKey.startsWith(p)) {
            suffix = metricKey.slice(p.length);
            break;
        }
    }

    let direction = 'in';
    if (metricKey.includes('outbound_rate') || metricKey.includes('outflow') || metricKey.includes('avg_agi_out') || metricKey.includes('agi_ratio_out_in')) {
        direction = 'out';
    }

    let baseStat = 'total';
    if (metricKey.includes('net_inflow_share') || metricKey.includes('net_outflow_share')) baseStat = 'net_rate';
    else if (metricKey.includes('inflow_share') || metricKey.includes('outflow_share')) baseStat = 'rate';
    else if (metricKey.includes('total_share')) baseStat = 'share';
    else if (metricKey.includes('inbound_rate') || metricKey.includes('outbound_rate')) baseStat = 'volume_share';
    else if (metricKey.includes('net_inflow') || metricKey.includes('net_outflow')) baseStat = 'net';
    else if (metricKey.includes('inflow') || metricKey.includes('outflow')) baseStat = 'total';
    else if (metricKey.includes('avg_agi_in_individual') || metricKey.includes('avg_agi_out_individual')) baseStat = 'avg_individual';
    else if (metricKey.includes('avg_agi_in_household') || metricKey.includes('avg_agi_out_household')) baseStat = 'avg_household';
    else if (metricKey.includes('agi_ratio_in_out_individual') || metricKey.includes('agi_ratio_out_in_individual')) baseStat = 'ratio_individual';
    else if (metricKey.includes('agi_ratio_in_out_household') || metricKey.includes('agi_ratio_out_in_household')) baseStat = 'ratio_household';

    return { category, direction, baseStat };
}

/**
 * Extract the stat suffix from a full metric key.
 * Returns the suffix that, combined with a category, reproduces the key.
 */
function extractStatSuffix(metricKey) {
    if (metricKey.startsWith('avg_agi_') || metricKey.startsWith('agi_ratio_')) return metricKey;
    for (const p of ['pop_', 'hh_', 'agi_']) {
        if (metricKey.startsWith(p)) return metricKey.slice(p.length);
    }
    return metricKey;
}

/**
 * Extract the category prefix from a full metric key.
 */
function extractMetricCategory(metricKey) {
    if (metricKey.startsWith('avg_agi_') || metricKey.startsWith('agi_ratio_')) return 'agi';
    if (metricKey.startsWith('pop_')) return 'pop';
    if (metricKey.startsWith('hh_')) return 'hh';
    if (metricKey.startsWith('agi_')) return 'agi';
    return 'pop';
}

/**
 * Populate a stat <select> with base options appropriate for the given category.
 * Tries to preserve the currently-selected baseStat when the category changes.
 * Returns the selected baseStat.
 */
function populateStatSelect(selectEl, category, isPairMode = false, preferredBaseStat = null) {
    if (!selectEl) return '';

    const currentBaseStat = preferredBaseStat ?? selectEl.value;
    selectEl.innerHTML = '';

    // Common stats
    for (const stat of STAT_BASE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = stat.base;
        opt.textContent = isPairMode ? stat.pairLabel : stat.label;
        selectEl.appendChild(opt);
    }

    // AGI-only extras
    if (category === 'agi') {
        for (const stat of AGI_EXTRA_BASE_STATS) {
            const opt = document.createElement('option');
            opt.value = stat.base;
            opt.textContent = isPairMode ? stat.pairLabel : stat.label;
            selectEl.appendChild(opt);
        }
    }

    // Try to preserve selection
    const hasTarget = Array.from(selectEl.options).some(o => o.value === currentBaseStat);
    selectEl.value = hasTarget ? currentBaseStat : selectEl.options[0]?.value || '';

    return selectEl.value;
}

/**
 * computeMetric(metricKey, records) → number | null
 *
 * Pure function. Given the relevant flow records for a region (or a pair of
 * regions), returns the numeric value for the selected metric, or null if the
 * required data is missing / the denominator is zero.
 *
 * @param {string} metricKey
 * @param {Object} records
 * @param {FlowRecord|null} records.inflow
 * The inflow record to use. In the default map view this is the region's
 * total inflow (FIPS-96 row). When a primary region P is selected, this is
 * the flow from region R into P: stateFlows[year]['inflow'][R][P].
 * @param {FlowRecord|null} records.outflow
 * The outflow record. In the default map view this is the region's total
 * outflow. When a primary P is selected, this is the flow from P to R:
 * stateFlows[year]['outflow'][P][R].
 * @param {FlowRecord|null} records.totalInflow
 * Denominator for inflow share metrics.
 * Default view: nationalTotals[year].inflow  (so share = state's fraction
 * of all national migration → meaningful choropleth comparison).
 * Primary-selected view: stateTotals[year][P].inflow  (so share = fraction
 * of P's total inflow that came from R).
 * @param {FlowRecord|null} records.totalOutflow
 * Denominator for outflow share metrics (same logic as totalInflow).
 *
 * FlowRecord = { n1: number, n2: number, AGI: number }
 * n1  = households
 * n2  = individuals
 * AGI = adjusted gross income (thousands of dollars)
 */
function computeMetric(metricKey, { inflow, outflow, baseOutflow, totalInflow, totalOutflow }, isRelative = false, level = appState.level) {
    // ── Milestone 5.2: Check for missing data in county level ──
    if (level === 'county') {
        const meta = METRIC_META[metricKey];
        if (meta) {
            if (meta.direction === 'inflow' && !inflow) return null;
            if (meta.direction === 'outflow' && !outflow) return null;
            if (meta.direction === 'both' && (!inflow || !outflow)) return null;
        }
    }

    const i = inflow ?? { n1: 0, n2: 0, AGI: 0 };
    const o = outflow ?? { n1: 0, n2: 0, AGI: 0 };
    const bo = baseOutflow ?? { n1: 0, n2: 0, AGI: 0 };
    const ti = totalInflow ?? i;
    const to = totalOutflow ?? o;

    // Explicit net calculations replacing the former isRelative flip
    const netInflowN2 = i.n2 - o.n2;
    const netOutflowN2 = o.n2 - i.n2;

    const netInflowN1 = i.n1 - o.n1;
    const netOutflowN1 = o.n1 - i.n1;

    const netInflowAGI = i.AGI - o.AGI;
    const netOutflowAGI = o.AGI - i.AGI;

    switch (metricKey) {
        // ── Population ──────────────────────────────────────────────────────────
        case 'pop_inflow': return i.n2;
        case 'pop_outflow': return o.n2;
        case 'pop_net_inflow': return netInflowN2;
        case 'pop_net_outflow': return netOutflowN2;
        case 'pop_inflow_share': return bo.n2 > 0 ? i.n2 / bo.n2 : null;
        case 'pop_outflow_share': return bo.n2 > 0 ? o.n2 / bo.n2 : null;
        case 'pop_net_inflow_share': return bo.n2 > 0 ? netInflowN2 / bo.n2 : null;
        case 'pop_net_outflow_share': return bo.n2 > 0 ? netOutflowN2 / bo.n2 : null;
        case 'pop_inflow_total_share': return ti.n2 > 0 ? i.n2 / ti.n2 : null;
        case 'pop_outflow_total_share': return to.n2 > 0 ? o.n2 / to.n2 : null;

        // ── Households ──────────────────────────────────────────────────────────
        case 'hh_inflow': return i.n1;
        case 'hh_outflow': return o.n1;
        case 'hh_net_inflow': return netInflowN1;
        case 'hh_net_outflow': return netOutflowN1;
        case 'hh_inflow_share': return bo.n1 > 0 ? i.n1 / bo.n1 : null;
        case 'hh_outflow_share': return bo.n1 > 0 ? o.n1 / bo.n1 : null;
        case 'hh_net_inflow_share': return bo.n1 > 0 ? netInflowN1 / bo.n1 : null;
        case 'hh_net_outflow_share': return bo.n1 > 0 ? netOutflowN1 / bo.n1 : null;
        case 'hh_inflow_total_share': return ti.n1 > 0 ? i.n1 / ti.n1 : null;
        case 'hh_outflow_total_share': return to.n1 > 0 ? o.n1 / to.n1 : null;

        // ── AGI ─────────────────────────────────────────────────────────────────
        case 'agi_inflow': return i.AGI;
        case 'agi_outflow': return o.AGI;
        case 'agi_net_inflow': return netInflowAGI;
        case 'agi_net_outflow': return netOutflowAGI;
        case 'agi_inflow_share': return bo.AGI > 0 ? i.AGI / bo.AGI : null;
        case 'agi_outflow_share': return bo.AGI > 0 ? o.AGI / bo.AGI : null;
        case 'agi_net_inflow_share': return bo.AGI > 0 ? netInflowAGI / bo.AGI : null;
        case 'agi_net_outflow_share': return bo.AGI > 0 ? netOutflowAGI / bo.AGI : null;
        case 'agi_inflow_total_share': return ti.AGI > 0 ? i.AGI / ti.AGI : null;
        case 'agi_outflow_total_share': return to.AGI > 0 ? o.AGI / to.AGI : null;

        // ── Inbound / Outbound Rates ─────────────────────────────────────────────
        case 'pop_inbound_rate': { const sum = i.n2 + o.n2; return sum > 0 ? i.n2 / sum : null; }
        case 'pop_outbound_rate': { const sum = i.n2 + o.n2; return sum > 0 ? o.n2 / sum : null; }
        case 'hh_inbound_rate': { const sum = i.n1 + o.n1; return sum > 0 ? i.n1 / sum : null; }
        case 'hh_outbound_rate': { const sum = i.n1 + o.n1; return sum > 0 ? o.n1 / sum : null; }
        case 'agi_inbound_rate': { const sum = i.AGI + o.AGI; return sum > 0 ? i.AGI / sum : null; }
        case 'agi_outbound_rate': { const sum = i.AGI + o.AGI; return sum > 0 ? o.AGI / sum : null; }

        // ── Average AGI ─────────────────────────────────────────────────────────
        case 'avg_agi_in_individual': return i.n2 > 0 ? i.AGI / i.n2 : null;
        case 'avg_agi_in_household': return i.n1 > 0 ? i.AGI / i.n1 : null;
        case 'avg_agi_out_individual': return o.n2 > 0 ? o.AGI / o.n2 : null;
        case 'avg_agi_out_household': return o.n1 > 0 ? o.AGI / o.n1 : null;

        // ── Ratio of Average AGIs ───────────────────────────────────────────────
        case 'agi_ratio_in_out_individual': {
            const avgIn = i.n2 > 0 ? i.AGI / i.n2 : 0;
            const avgOut = o.n2 > 0 ? o.AGI / o.n2 : 0;
            return avgOut > 0 ? avgIn / avgOut : null;
        }
        case 'agi_ratio_in_out_household': {
            const avgIn = i.n1 > 0 ? i.AGI / i.n1 : 0;
            const avgOut = o.n1 > 0 ? o.AGI / o.n1 : 0;
            return avgOut > 0 ? avgIn / avgOut : null;
        }
        case 'agi_ratio_out_in_individual': {
            const avgIn = i.n2 > 0 ? i.AGI / i.n2 : 0;
            const avgOut = o.n2 > 0 ? o.AGI / o.n2 : 0;
            return avgIn > 0 ? avgOut / avgIn : null;
        }
        case 'agi_ratio_out_in_household': {
            const avgIn = i.n1 > 0 ? i.AGI / i.n1 : 0;
            const avgOut = o.n1 > 0 ? o.AGI / o.n1 : 0;
            return avgIn > 0 ? avgOut / avgIn : null;
        }

        default:
            console.warn(`computeMetric: unknown metric key "${metricKey}"`);
            return null;
    }
}

/**
 * getMapValue(regionKey, year, metricKey, level, primaryRegion)
 * → number | null
 *
 * High-level dispatcher: assembles the correct inflow/outflow/total records
 * for the given display context, then delegates to computeMetric().
 *
 * Two modes:
 *
 * A) Default view (primaryRegion = null)
 * Each region is coloured by its own total flow metric.
 * Share denominators = nationalTotals[year] so values represent each
 * region's fraction of national migration.
 *
 * B) Primary-selected view (primaryRegion is set)
 * Each region R is coloured by the flow between R and primaryRegion P.
 * Inflow  = flow from R into  P  (stateFlows[year].inflow[R][P])
 * Outflow = flow from P into  R  (stateFlows[year].outflow[P][R])
 * Share denominators = P's own totals (stateTotals[year][P])
 * so share values = "fraction of P's total flow accounted for by R".
 *
 * @param {string}      regionKey     - state FIPS or "sf_cf" county key
 * @param {string}      year          - e.g. "2122"
 * @param {string}      metricKey     - one of the 22+ keys in METRIC_META
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
        const t = stateTotals[year]?.[fips];
        const nt = nationalTotals[year];
        return computeMetric(metricKey, {
            inflow: t?.inflow ?? null,
            outflow: t?.outflow ?? null,
            baseInflow: t?.base_outflow ?? null,
            baseOutflow: t?.base_outflow ?? null,
            totalInflow: nt?.inflow ?? null,
            totalOutflow: nt?.outflow ?? null,
        }, false, 'state'); // Explicitly pass 'state'
    } else {
        const inflow = getStateFlow(year, 'inflow', fips, primaryFips);
        const outflow = getStateFlow(year, 'outflow', primaryFips, fips);
        const pt = stateTotals[year]?.[primaryFips];
        return computeMetric(metricKey, {
            inflow,
            outflow,
            baseInflow: pt?.base_outflow ?? null,
            baseOutflow: pt?.base_outflow ?? null,
            totalInflow: pt?.inflow ?? null,
            totalOutflow: pt?.outflow ?? null,
        }, true, 'state'); // Explicitly pass 'state'
    }
}

function _getCountyMapValue(countyKey, year, metricKey, primaryCountyKey) {
    if (!primaryCountyKey) {
        const t = countyTotals[year]?.[countyKey];
        const nt = nationalTotals[year];
        return computeMetric(metricKey, {
            inflow: t?.inflow ?? null,
            outflow: t?.outflow ?? null,
            baseInflow: t?.base_outflow ?? null,
            baseOutflow: t?.base_outflow ?? null,
            totalInflow: nt?.inflow ?? null,
            totalOutflow: nt?.outflow ?? null,
        }, false, 'county'); // Explicitly pass 'county'
    } else {
        const inflow = getCountyFlow(year, 'inflow', countyKey, primaryCountyKey);
        const outflow = getCountyFlow(year, 'outflow', primaryCountyKey, countyKey);
        const pt = countyTotals[year]?.[primaryCountyKey];
        return computeMetric(metricKey, {
            inflow,
            outflow,
            baseInflow: pt?.base_outflow ?? null,
            baseOutflow: pt?.base_outflow ?? null,
            totalInflow: pt?.inflow ?? null,
            totalOutflow: pt?.outflow ?? null,
        }, true, 'county'); // Explicitly pass 'county'
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
            return `${(value * 100).toFixed(2)}%`;
        case 'currency':
            // Value is in thousands of dollars. Replace K with ,000
            if (Math.round(value) === 0) return '$0';
            const formattedVal = Math.abs(Math.round(value)).toLocaleString('en-US');
            return value < 0 ? `-$${formattedVal},000` : `$${formattedVal},000`;
        case 'decimal':
            // E.g. for ratios
            return value.toFixed(2);
        case 'integer':
        default:
            // Possibly negative (net metrics); include sign for clarity.
            return Math.round(value).toLocaleString('en-US');
    }
}

/**
 * formatAxisValue(value, metricKey) → string
 * Specifically for chart Y-axes to format large currency values in M or B.
 */
function formatAxisValue(value, metricKey) {
    if (value === null || !Number.isFinite(value)) return '—';
    const meta = METRIC_META[metricKey];
    if (!meta) return String(value);

    if (meta.format === 'currency') {
        if (value === 0) return '$0';
        const actualDollars = value * 1000;
        const absDollars = Math.abs(actualDollars);
        const sign = value < 0 ? '-' : '';

        if (absDollars >= 1000000000) {
            return `${sign}$${(absDollars / 1000000000).toFixed(1).replace(/\.0$/, '')}B`;
        } else if (absDollars >= 1000000) {
            return `${sign}$${(absDollars / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
        } else {
            return `${sign}$${Math.round(absDollars).toLocaleString('en-US')}`;
        }
    }
    return formatMetricValue(value, metricKey);
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
    level: 'state',
    yearIndex: 14,
    metricCategory: 'pop',
    metric: 'pop_inflow',
    primaryRegion: null,
    secondaryRegion: null,

    zoomLevel: 1,
    panX: 0, // Horizontal pan
    panY: 0, // Vertical pan
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
 * geoCache['state']  → { features, stateMesh, nationMesh }
 * geoCache['county'] → { features, stateMesh, countyMesh, nationMesh }
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
 * State  fipsKey = zero-padded 2-char state FIPS, e.g. "01"
 * County fipsKey = "${sf}_${cf}", e.g. "01_073" for Jefferson Co., AL
 *
 * Also builds three border meshes for the border layer:
 * stateMesh  — internal state boundaries (adjacent pairs only)
 * countyMesh — internal county boundaries (county mode only)
 * nationMesh — outer U.S. boundary
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
 * 1. Update the map status text for the current selection.
 * 2. Re-draw the choropleth map with the current metric values.
 */
function render() {
    updateMapStatusText();
    renderMap();           // async, fire-and-forget
}

/**
 * renderMap()
 *
 * Async. Loads geo data on first call (cached thereafter), sizes the SVG to
 * the current container, builds an AlbersUSA projection, and paints:
 * • Base layer   — one <path> per geographic region, filled by metric value
 * • Border layer — county mesh (county mode), state mesh, nation outline
 *
 * A render-generation counter ensures only the most-recent invocation's result
 * is actually painted.
 */
async function renderMap() {
    updateStatisticDescription('map-statistic-description', appState.metric);
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
    const validValues = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (const f of features) {
        // Ignore primary region for bounds calculation so self-flow doesn't skew distributions
        if (appState.primaryRegion && f.fipsKey === appState.primaryRegion) {
            valueTuples.push([f, null]);
            continue;
        }

        const val = getMapValue(f.fipsKey, year, appState.metric, appState.level, appState.primaryRegion);
        valueTuples.push([f, val]);
        if (val !== null && Number.isFinite(val)) {
            validValues.push(val);
            if (val < minVal) minVal = val;
            if (val > maxVal) maxVal = val;
        }
    }

    // ── Build D3 Color Scale ─────────────────────────────────────────────────────
    let colorScale;
    let legendGradientCss = '';
    let tickValues = [];

    if (validValues.length === 0) {
        // Fallback if absolutely no data exists for current filters
        minVal = 0;
        maxVal = 0;
        colorScale = () => 'var(--accent-bg)';
        legendGradientCss = 'var(--accent-bg)';
        tickValues = [];
    } else {
        // Use diverging scale only for metrics that can actually go negative (net metrics).
        // Rate metrics have direction='both' but are always 0–1, so they get a sequential scale.
        const isDivergingMetric = metricMeta.direction === 'both' && appState.metric.includes('net');
        if (isDivergingMetric) {
            // Diverging scale: Split the data to ensure 0 remains the true center of the legend.
            const negVals = validValues.filter(v => v < 0);
            const posVals = validValues.filter(v => v >= 0);

            // d3.scaleQuantile with a range of length N yields N-1 thresholds.
            // We need 10 boundaries total for 11 diverging colors. We allocate 5 
            // thresholds to the negative side and 5 to the positive side.
            const negQuantiles = negVals.length > 0
                ? d3.scaleQuantile().domain(negVals).range(new Array(6)).quantiles()
                : [-5, -4, -3, -2, -0.1]; // Fallback if no negative flow exists

            const posQuantiles = posVals.length > 0
                ? d3.scaleQuantile().domain(posVals).range(new Array(6)).quantiles()
                : [0.1, 2, 3, 4, 5];      // Fallback if no positive flow exists

            const thresholds = [...negQuantiles, ...posQuantiles];
            const divColors = d3.schemeRdYlGn[11];

            colorScale = d3.scaleThreshold()
                .domain(thresholds)
                .range(divColors);

            // Generate a hard-stepped gradient for the legend
            legendGradientCss = 'linear-gradient(to right, ' + divColors.map((c, i) => `${c} ${(i / 11) * 100}%, ${c} ${((i + 1) / 11) * 100}%`).join(', ') + ')';

            // Include actual min and max for the outer edges of the tick bar
            tickValues = [minVal, ...thresholds, maxVal];

        } else {
            // Sequential scale: direct quantile calculation over all data
            const seqColors = d3.quantize(d3.interpolatePuBu, 11);

            const qScale = d3.scaleQuantile()
                .domain(validValues)
                .range(seqColors);

            // Automatically yields exactly 10 thresholds for the 11 sequential colors
            const thresholds = qScale.quantiles();

            colorScale = d3.scaleThreshold()
                .domain(thresholds)
                .range(seqColors);

            // Generate a hard-stepped gradient for the legend
            legendGradientCss = 'linear-gradient(to right, ' + seqColors.map((c, i) => `${c} ${(i / 11) * 100}%, ${c} ${((i + 1) / 11) * 100}%`).join(', ') + ')';
            tickValues = [minVal, ...thresholds, maxVal];
        }
    }

    // ── Update Legend UI ─────────────────────────────────────────────────────────
    const legendEl = document.getElementById('map-legend');
    if (validValues.length > 0) {
        legendEl.style.visibility = 'visible'; // Restore visibility

        const gradientEl = document.getElementById('legend-gradient');
        if (gradientEl) {
            gradientEl.style.background = legendGradientCss;
            // Expand the bar vertically and enforce its presence
            gradientEl.style.height = '16px';
            gradientEl.style.minHeight = '16px';
            gradientEl.style.width = '100%';
            gradientEl.style.borderRadius = '4px';
            gradientEl.style.display = 'block';
            gradientEl.style.flexShrink = '0';
        }

        // Hide standard min/max text elements as we will display all boundaries dynamically
        const oldMin = document.getElementById('legend-min');
        const oldMax = document.getElementById('legend-max');
        if (oldMin) oldMin.style.display = 'none';
        if (oldMax) oldMax.style.display = 'none';

        // Create or refresh the tick container below the gradient
        let tickContainer = document.getElementById('legend-ticks');
        if (!tickContainer) {
            tickContainer = document.createElement('div');
            tickContainer.id = 'legend-ticks';
            tickContainer.style.position = 'relative';

            if (gradientEl) {
                gradientEl.parentNode.insertBefore(tickContainer, gradientEl.nextSibling);
            } else {
                legendEl.appendChild(tickContainer);
            }
        }

        // Adjust styling for horizontal numbers
        tickContainer.style.height = '24px';
        tickContainer.style.marginTop = '6px';
        tickContainer.style.width = '100%';
        tickContainer.style.flexShrink = '0';

        tickContainer.innerHTML = '';
        tickValues.forEach((val, i) => {
            const tick = document.createElement('span');
            tick.textContent = formatMetricValue(val, appState.metric);
            tick.style.position = 'absolute';
            tick.style.left = `${(i / 11) * 100}%`;

            // Keep numbers horizontal. Shift the first and last ones inward 
            // so they don't get cut off by the edges of the screen.
            if (i === 0) {
                tick.style.transform = 'translateX(0)';
            } else if (i === tickValues.length - 1) {
                tick.style.transform = 'translateX(-100%)';
            } else {
                tick.style.transform = 'translateX(-50%)';
            }

            tick.style.fontSize = '0.7rem';
            tick.style.whiteSpace = 'nowrap';
            tickContainer.appendChild(tick);
        });

        // Stretch the legend full width and ensure it steals vertical space from the map
        legendEl.style.display = 'flex';
        legendEl.style.flexDirection = 'column';
        legendEl.style.width = '100%';
        legendEl.style.boxSizing = 'border-box';
        legendEl.style.paddingBottom = '10px';
        legendEl.style.flexShrink = '0';
    } else {
        // Keep the physical space reserved so the map layout doesn't jump, 
        // but hide its visual contents because there is no data.
        legendEl.style.display = 'flex';
        legendEl.style.flexDirection = 'column';
        legendEl.style.width = '100%';
        legendEl.style.boxSizing = 'border-box';
        legendEl.style.paddingBottom = '10px';
        legendEl.style.flexShrink = '0';

        legendEl.style.visibility = 'hidden';
    }

    // ── Projection & Zoom: AlbersUSA fitted to container ──────────────────────────────
    const margin = 18;
    mapProjection = d3.geoAlbersUsa().fitExtent(
        [[margin, margin], [width - margin, height - margin]],
        geo.features
    );

    // Apply zoom transformation to projection
    const baseScale = mapProjection.scale();
    const baseTranslate = mapProjection.translate();
    const zoomFactor = appState.zoomLevel;

    // We want to zoom towards the center of the viewport
    const centerX = width / 2;
    const centerY = height / 2;

    // Calculate panning offsets. 
    // We invert the sign so "Right" slider moves the camera right (map moves left).
    // Multiply by zoomFactor to keep panning speed feeling consistent while zoomed in.
    const panTranslateX = -(appState.panX / 100) * (width / 2) * zoomFactor;
    const panTranslateY = -(appState.panY / 100) * (height / 2) * zoomFactor;

    mapProjection
        .scale(baseScale * zoomFactor)
        .translate([
            centerX + (baseTranslate[0] - centerX) * zoomFactor + panTranslateX,
            centerY + (baseTranslate[1] - centerY) * zoomFactor + panTranslateY
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
                    if (d[0].fipsKey === appState.primaryRegion) return '#9ca3af'; // Darker gray for selected region
                    const val = d[1];
                    if (val === null || !Number.isFinite(val)) {
                        // Milestone 5.2: Light gray for missing county data, background color for missing state data
                        return appState.level === 'county' ? '#e5e7eb' : 'var(--bg)';
                    }
                    return colorScale(val);
                }),
            update => update
                .attr('d', d => mapPath(d[0])) // Update path for zooming
                .attr('fill', d => {
                    if (d[0].fipsKey === appState.primaryRegion) return '#9ca3af';
                    const val = d[1];
                    if (val === null || !Number.isFinite(val)) {
                        return appState.level === 'county' ? '#e5e7eb' : 'var(--bg)';
                    }
                    return colorScale(val);
                })
        )
        .attr('cursor', 'pointer')
        .attr('stroke', d => {
            if (d[0].fipsKey === appState.primaryRegion) return '#000';
            if (d[0].fipsKey === appState.secondaryRegion) return '#444';
            return 'none';
        })
        .attr('stroke-width', d => {
            if (d[0].fipsKey === appState.primaryRegion) return 2.5 * zoomFactor;
            if (d[0].fipsKey === appState.secondaryRegion) return 2 * zoomFactor;
            return 0;
        })
        .attr('stroke-dasharray', d => {
            if (d[0].fipsKey === appState.secondaryRegion) return `${4 * zoomFactor},${2 * zoomFactor}`;
            return 'none';
        })
        .on('mouseenter', function (event, d) {
            // Apply slight opacity dimming on hover
            d3.select(this).attr('fill-opacity', 0.8);

            // Bring hovered region to the top so its border isn't overlapped by neighbors
            d3.select(this).raise();

            // Initialise or select the global tooltip element
            let tooltip = d3.select('#map-tooltip');
            if (tooltip.empty()) {
                tooltip = d3.select('body').append('div')
                    .attr('id', 'map-tooltip')
                    .style('position', 'absolute')
                    .style('display', 'none')
                    .style('pointer-events', 'none')
                    .style('background', 'rgba(255, 255, 255, 0.95)')
                    .style('border', '1px solid #ccc')
                    .style('padding', '8px 12px')
                    .style('border-radius', '6px')
                    .style('box-shadow', '0 4px 6px rgba(0,0,0,0.1)')
                    .style('font-size', '0.85rem')
                    .style('color', '#333')
                    .style('z-index', '1000');
            }
            tooltip.style('display', 'block');
        })
        .on('mousemove', function (event, d) {
            const fips = d[0].fipsKey;

            // Resolve geographic display name based on level
            let name = fips;
            if (appState.level === 'state') {
                name = stateMeta[fips]?.name || fips;
            } else {
                const cm = countyMeta[fips];
                name = cm ? `${cm.countyName}, ${cm.statePostal}` : fips;
            }

            // Do not show a numerical statistic for the primary selection
            if (fips === appState.primaryRegion) {
                d3.select('#map-tooltip')
                    .html(`<strong>${name}</strong><br/><span style="color: #666;">Selected Region</span>`)
                    .style('left', (event.pageX + 15) + 'px')
                    .style('top', (event.pageY + 15) + 'px');
                return;
            }

            const val = d[1];

            // Milestone 5.2 update: Explicitly label missing data in the tooltip
            let metricStr;
            if (val === null || !Number.isFinite(val)) {
                metricStr = '<em style="color: #999;">No data available</em>';
            } else {
                metricStr = formatMetricValue(val, appState.metric);
            }

            let labelStr = getMetricLabel(appState.metric);

            // If a primary region is selected, clarify the directional relationship
            if (appState.primaryRegion) {
                let primaryName = appState.primaryRegion;
                if (appState.level === 'state') {
                    primaryName = stateMeta[appState.primaryRegion]?.name || appState.primaryRegion;
                } else {
                    const cm = countyMeta[appState.primaryRegion];
                    primaryName = cm ? `${cm.countyName}, ${cm.statePostal}` : appState.primaryRegion;
                }

                // Explicitly check the metric key to handle "net_inflow" and "net_outflow" correctly
                if (appState.metric.includes('outflow') || appState.metric.includes('_out_')) {
                    labelStr += ` from ${primaryName}`;
                } else if (appState.metric.includes('inflow') || appState.metric.includes('_in_')) {
                    labelStr += ` to ${primaryName}`;
                }
            }

            // Populate and position the tooltip
            d3.select('#map-tooltip')
                .html(`<strong>${name}</strong><br/><span style="color: #666;">${labelStr}:</span> ${metricStr}`)
                .style('left', (event.pageX + 15) + 'px')
                .style('top', (event.pageY + 15) + 'px');
        })
        .on('mouseleave', function (event, d) {
            d3.select(this).attr('fill-opacity', 1);
            d3.select('#map-tooltip').style('display', 'none');

            // Re-raise selected regions so they stay on top of the previously hovered item
            mapLayerBase.selectAll('path.region')
                .filter(data => data[0].fipsKey === appState.primaryRegion || data[0].fipsKey === appState.secondaryRegion)
                .raise();
        })
        .on('click', function (event, d) {
            const fips = d[0].fipsKey;

            // State machine for click interactions (Restricted to single selection for now)
            if (appState.primaryRegion === fips) {
                appState.primaryRegion = null; // Clicked Primary -> Deselect all
            } else {
                appState.primaryRegion = fips; // Clicked another -> Swap Primary
            }

            appState.secondaryRegion = null;

            // Force-hide tooltip to avoid ghosting before re-render occurs
            d3.select('#map-tooltip').style('display', 'none');

            render(); // Trigger recomputation
        });

    // Raise selected regions so their border strokes aren't overlapped by neighboring regions
    mapLayerBase.selectAll('path.region')
        .filter(d => d[0].fipsKey === appState.primaryRegion || d[0].fipsKey === appState.secondaryRegion)
        .raise();

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

    // Keep all meshes on top of the base layer (especially over highlighted borders)
    mapLayerBorder.raise();

    console.debug(`[Map] geo rendered (gen=${gen}, level=${appState.level}, zoom=${zoomFactor})`);
}



/* ════════════════════════════════════════════════════════════════════════════
   SECTION 8.5 — PHASE 6: INDIVIDUAL REGION TREND CHART  (Milestone 6.1)
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Isolated state for the individual-region trend chart.
 * Kept separate from appState so the chart has its own region / metric
 * selection and does not interfere with the map's primary/secondary selection.
 */
const indChartState = {
    // Array of exactly 12 slots. Each is either null or { key, level, label }
    regions: [
        { key: '06', level: 'state', label: 'California' },
        { key: '48', level: 'state', label: 'Texas' },
        ...new Array(10).fill(null)
    ],
    metricCategory: 'pop',
    metric: 'pop_inflow',
    stagedKey: null,
    stagedLevel: null,
    stagedLabel: null
};

// D3 color scale for up to 12 lines
const indChartColors = d3.scaleOrdinal(d3.schemePaired);

/** D3 handles retained between renders so we can update-in-place. */
let indChartSvg = null;        // the root <svg> selection
let indChartInner = null;      // the <g> shifted by margins
let indChartXScale = null;
let indChartYScale = null;
// Wider left margin gives breathing room between y-axis label and tick numbers
let indChartMargin = { top: 24, right: 32, bottom: 64, left: 100 };

/** Flat entry list used by the combobox — rebuilt on data load. */
let indComboboxEntries = [];   // [{ key, label, level }]
let indComboboxOpen = false;
let indComboboxHighlightIdx = -1;

/* ── Combobox data ───────────────────────────────────────────────────────────
 * Builds the flat entry list for the region combobox.
 * States are always first; counties follow if data is loaded.
 * Call this once on init and again after county data loads.
 */
function buildIndComboboxEntries() {
    // States — only include entries that have a real name (not just a raw FIPS code).
    // Entries where meta.name is blank or equals the raw FIPS slip through when the
    // IRS file had no matching name row (e.g. FIPS "00" national total).
    const stateEntries = Object.entries(stateMeta)
        .filter(([fips, meta]) => {
            const name = meta.name || meta.postal || '';
            return name.length > 0 && name !== fips;
        })
        .map(([fips, meta]) => ({ key: fips, label: meta.name || meta.postal, level: 'state' }))
        .sort((a, b) => a.label.localeCompare(b.label));

    // Counties — only include entries that have a real countyName string.
    // Entries with blank/missing names appear as raw keys like "02_261" (dissolved
    // Census areas) and should be excluded from the dropdown.
    const countyEntries = countyDataLoaded
        ? Object.entries(countyMeta)
            .filter(([, meta]) => meta.countyName && meta.countyName.trim().length > 0)
            .map(([key, meta]) => ({
                key,
                label: `${meta.countyName}, ${meta.statePostal || meta.stateName || ''}`.trim().replace(/,$/, ''),
                level: 'county',
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
        : [];

    indComboboxEntries = [...stateEntries, ...countyEntries];
}

/* ── Combobox DOM helpers ───────────────────────────────────────────────── */

function _appendRegionOption(listbox, entry, showLevelBadge) {
    const opt = document.createElement('div');
    // Check against stagedKey since regionKey is no longer used for the combobox
    const isActive = entry.key === indChartState.stagedKey;
    opt.className = 'region-option' + (isActive ? ' region-option--active' : '');
    opt.textContent = showLevelBadge ? `${entry.label}\u2002(${entry.level})` : entry.label;
    opt.dataset.key = entry.key;
    opt.dataset.level = entry.level;
    opt.dataset.label = entry.label;
    opt.setAttribute('role', 'option');
    opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
    listbox.appendChild(opt);
}

function _renderIndComboboxListbox(filterText) {
    const listbox = document.getElementById('ind-region-listbox');
    if (!listbox) return;

    const lower = (filterText || '').toLowerCase().trim();
    indComboboxHighlightIdx = -1;

    // Filter out nulls before extracting plotted keys
    const plottedKeys = new Set(
        indChartState.regions.filter(r => r !== null).map(r => r.key)
    );

    const filtered = indComboboxEntries.filter(e => {
        // Exclude if already plotted
        if (plottedKeys.has(e.key)) return false;
        // Exclude if it doesn't match the search filter
        if (lower && !e.label.toLowerCase().includes(lower)) return false;
        return true;
    });

    listbox.innerHTML = '';

    if (filtered.length === 0) {
        const msg = document.createElement('div');
        msg.className = 'region-option region-option--no-results';
        msg.textContent = 'No results found';
        listbox.appendChild(msg);
        return;
    }

    if (lower) {
        // Flat filtered list — no level badge, just the region name
        filtered.forEach(e => _appendRegionOption(listbox, e, false));
    } else {
        // Structured list: selected first, then States, then Counties
        const selectedEntry = indChartState.stagedKey
            ? indComboboxEntries.find(e => e.key === indChartState.stagedKey)
            : null;

        const states = filtered.filter(e => e.level === 'state' && e.key !== selectedEntry?.key);
        const counties = filtered.filter(e => e.level === 'county' && e.key !== selectedEntry?.key);

        if (selectedEntry && !plottedKeys.has(selectedEntry.key)) {
            const grp = document.createElement('div');
            grp.className = 'region-group-label';
            grp.textContent = 'Selected';
            listbox.appendChild(grp);
            _appendRegionOption(listbox, selectedEntry, false);
        }

        if (states.length) {
            const grp = document.createElement('div');
            grp.className = 'region-group-label';
            grp.textContent = 'States';
            listbox.appendChild(grp);
            states.forEach(e => _appendRegionOption(listbox, e, false));
        }

        if (counties.length) {
            const grp = document.createElement('div');
            grp.className = 'region-group-label';
            grp.textContent = 'Counties';
            listbox.appendChild(grp);
            counties.forEach(e => _appendRegionOption(listbox, e, false));
        }

        // Loading indicator shown while background county fetch is still in flight
        if (!countyDataLoaded) {
            const hint = document.createElement('div');
            hint.className = 'region-option region-option--no-results';
            hint.textContent = 'Loading county data…';
            listbox.appendChild(hint);
        }
    }
}

function _openIndCombobox() {
    const listbox = document.getElementById('ind-region-listbox');
    const input = document.getElementById('ind-region-input');
    if (!listbox || !input || indComboboxOpen) return;
    listbox.removeAttribute('hidden');
    input.setAttribute('aria-expanded', 'true');
    indComboboxOpen = true;
    _renderIndComboboxListbox(input.value);
    // Scroll selected item into view
    const active = listbox.querySelector('.region-option--active');
    if (active) active.scrollIntoView({ block: 'nearest' });
}

function _closeIndCombobox(validateInput = false) {
    const listbox = document.getElementById('ind-region-listbox');
    const input = document.getElementById('ind-region-input');
    if (!listbox || !input) return;

    if (validateInput && indComboboxOpen) {
        const currentText = input.value.trim();
        const lower = currentText.toLowerCase();
        const selKey = indChartState.stagedKey;

        if (currentText === '') {
            // User erased the text box, clear the selection
            if (selKey !== null) {
                indChartState.stagedKey = null;
                indChartState.stagedLevel = null;
                indChartState.stagedLabel = null;
                const addBtn = document.getElementById('ind-add-btn');
                if (addBtn) addBtn.disabled = true;
            }
        } else {
            // User typed text but didn't click. See if it matches exactly
            const match = indComboboxEntries.find(e => e.label.toLowerCase() === lower);
            if (match) {
                // Ensure it is not already plotted/added
                const isAlreadyAdded = indChartState.regions.some(r => r !== null && r.key === match.key);
                const activeCount = indChartState.regions.filter(r => r !== null).length;
                const isValid = !isAlreadyAdded && activeCount < 12;

                if (isValid) {
                    if (match.key !== selKey) {
                        indChartState.stagedKey = match.key;
                        indChartState.stagedLevel = match.level;
                        indChartState.stagedLabel = match.label;
                        const addBtn = document.getElementById('ind-add-btn');
                        if (addBtn) addBtn.disabled = false;
                    }
                } else {
                    // Matches but is excluded or we reached the limit
                    indChartState.stagedKey = null;
                    indChartState.stagedLevel = null;
                    indChartState.stagedLabel = null;
                    const addBtn = document.getElementById('ind-add-btn');
                    if (addBtn) addBtn.disabled = true;
                }
            } else {
                // Typed gibberish, clear selection
                indChartState.stagedKey = null;
                indChartState.stagedLevel = null;
                indChartState.stagedLabel = null;
                const addBtn = document.getElementById('ind-add-btn');
                if (addBtn) addBtn.disabled = true;
            }
        }
    }

    listbox.setAttribute('hidden', '');
    input.setAttribute('aria-expanded', 'false');
    indComboboxOpen = false;
    indComboboxHighlightIdx = -1;

    // Restore input to the staged name
    input.value = indChartState.stagedLabel || '';
}

function _updateIndRegionInputState() {
    const input = document.getElementById('ind-region-input');
    if (!input) return;

    // Only count slots that have a region in them
    const activeCount = indChartState.regions.filter(r => r !== null).length;

    if (activeCount >= 12) {
        input.disabled = true;
        input.placeholder = "Maximum of 12 regions reached";
        if (typeof _closeIndCombobox === 'function') _closeIndCombobox();
    } else {
        input.disabled = false;
        input.placeholder = "Search states and counties…";
    }
}

function _selectIndComboboxEntry(key, level, label) {
    indChartState.stagedKey = key || null;
    indChartState.stagedLevel = level || null;
    indChartState.stagedLabel = label || null;

    const input = document.getElementById('ind-region-input');
    const addBtn = document.getElementById('ind-add-btn');

    if (input) input.value = key ? label : '';

    // Enable "Add" if a valid new region is selected and we haven't hit 12
    if (addBtn) {
        // Ensure r is not null before checking r.key
        const isAlreadyAdded = indChartState.regions.some(r => r !== null && r.key === key);

        // Filter out nulls when checking the length
        const activeCount = indChartState.regions.filter(r => r !== null).length;

        addBtn.disabled = !key || isAlreadyAdded || activeCount >= 12;
    }

    if (typeof _closeIndCombobox === 'function') _closeIndCombobox();
}

function renderIndRegionBubbles() {
    const container = document.getElementById('ind-selected-regions');
    if (!container) return;

    container.innerHTML = '';

    // 1. Extract active regions and attach their original slot index
    const activeRegions = indChartState.regions
        .map((region, i) => region ? { ...region, slotIndex: i } : null)
        .filter(r => r !== null);

    // 2. Sort the list: States first, then Counties, then alphabetically
    activeRegions.sort((a, b) => {
        if (a.level === 'state' && b.level === 'county') return -1;
        if (a.level === 'county' && b.level === 'state') return 1;
        return a.label.localeCompare(b.label);
    });

    // 3. Render the sorted bubbles
    activeRegions.forEach((region) => {
        const i = region.slotIndex; // Use original index for color and removal logic

        const bubble = document.createElement('div');
        bubble.className = 'region-bubble';
        bubble.style.borderColor = indChartColors(i);
        bubble.style.backgroundColor = `${indChartColors(i)}15`;

        const label = document.createElement('span');
        label.textContent = region.label;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'bubble-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.setAttribute('aria-label', `Remove ${region.label}`);

        removeBtn.addEventListener('click', () => {
            // Nullify the specific slot in the original array
            indChartState.regions[i] = null;

            // Re-evaluate Add button state
            const addBtn = document.getElementById('ind-add-btn');
            if (addBtn && indChartState.stagedKey) {
                const isAlreadyAdded = indChartState.regions.some(r => r !== null && r.key === indChartState.stagedKey);
                const activeCount = indChartState.regions.filter(r => r !== null).length;
                addBtn.disabled = isAlreadyAdded || activeCount >= 12;
            }

            if (typeof _updateIndRegionInputState === 'function') {
                _updateIndRegionInputState();
            }

            renderIndRegionBubbles();
            renderIndividualChart();
        });

        bubble.appendChild(label);
        bubble.appendChild(removeBtn);
        container.appendChild(bubble);
    });
}

function _updateComboboxHighlight(options) {
    options.forEach((opt, i) => {
        if (i === indComboboxHighlightIdx) {
            opt.classList.add('region-option--highlighted');
            opt.scrollIntoView({ block: 'nearest' });
        } else {
            opt.classList.remove('region-option--highlighted');
        }
    });
}

/**
 * One-time setup of combobox event listeners.
 * Call after the DOM is ready and initial data has loaded.
 */
function initIndividualCombobox() {
    const input = document.getElementById('ind-region-input');
    const listbox = document.getElementById('ind-region-listbox');
    const combobox = document.getElementById('ind-region-combobox');
    if (!input || !listbox || !combobox) return;

    buildIndComboboxEntries();

    // Restore display value if a region was pre-selected
    if (indChartState.regionKey) {
        const entry = indComboboxEntries.find(e => e.key === indChartState.regionKey);
        if (entry) input.value = entry.label;
    }

    // Open on focus
    input.addEventListener('focus', () => _openIndCombobox());

    // Filter while typing
    input.addEventListener('input', () => {
        if (!indComboboxOpen) _openIndCombobox();
        _renderIndComboboxListbox(input.value);
    });

    // Keyboard navigation
    input.addEventListener('keydown', e => {
        if (!indComboboxOpen && e.key !== 'Tab') _openIndCombobox();
        const options = Array.from(listbox.querySelectorAll('.region-option:not(.region-option--no-results)'));
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            indComboboxHighlightIdx = Math.min(indComboboxHighlightIdx + 1, options.length - 1);
            _updateComboboxHighlight(options);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            indComboboxHighlightIdx = Math.max(indComboboxHighlightIdx - 1, 0);
            _updateComboboxHighlight(options);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const highlighted = options[indComboboxHighlightIdx];
            if (highlighted) {
                _selectIndComboboxEntry(highlighted.dataset.key, highlighted.dataset.level, highlighted.dataset.label);
            } else {
                _closeIndCombobox(true);
            }
        } else if (e.key === 'Escape') {
            _closeIndCombobox();
        }
    });

    // Select on click
    listbox.addEventListener('mousedown', e => {
        const opt = e.target.closest('.region-option');
        if (!opt || opt.classList.contains('region-option--no-results')) return;
        e.preventDefault(); // prevent blur-before-select race
        _selectIndComboboxEntry(opt.dataset.key, opt.dataset.level, opt.dataset.label);
    });

    // Close on blur (delayed so mousedown on listbox can fire first)
    input.addEventListener('blur', () => setTimeout(() => _closeIndCombobox(true), 150));

    // Click outside closes
    document.addEventListener('click', e => {
        if (!combobox.contains(e.target)) _closeIndCombobox(true);
    });
}

/**
 * Create (first call) or resize (subsequent calls) the D3 SVG inside
 * #chart-individual-svg-container, and establish / update scales and axes.
 *
 * Returns { width, height } — the inner drawing area dimensions.
 */
function setupIndividualChart() {
    const container = document.getElementById('chart-individual-svg-container');
    if (!container) return { width: 0, height: 0 };

    const m = indChartMargin;
    const totalW = container.clientWidth || 800;
    const totalH = container.clientHeight || 340;
    const width = totalW - m.left - m.right;
    const height = totalH - m.top - m.bottom;

    if (!indChartSvg) {
        // ── First call: create the SVG skeleton ───────────────────────────────
        indChartSvg = d3.select(container)
            .append('svg')
            .attr('role', 'img')
            .attr('aria-label', 'Individual region migration trend');

        indChartInner = indChartSvg.append('g')
            .attr('class', 'ind-chart-inner');

        // Grid lines group (behind everything)
        indChartInner.append('g').attr('class', 'ind-chart-grid ind-chart-grid-y');

        // Axes groups
        indChartInner.append('g').attr('class', 'ind-chart-axis ind-chart-axis-x');
        indChartInner.append('g').attr('class', 'ind-chart-axis ind-chart-axis-y');

        // Y-axis label (rotated, positioned absolutely via transform)
        indChartSvg.append('text')
            .attr('class', 'ind-chart-y-label')
            .attr('text-anchor', 'middle');

        // Line path (drawn on top of grid)
        indChartInner.append('path').attr('class', 'ind-chart-line');

        // Dot group (circles drawn last so they sit on top of the line)
        indChartInner.append('g').attr('class', 'ind-chart-dots');

        // Zero-line (for net/diverging metrics)
        indChartInner.append('line').attr('class', 'ind-chart-zero-line');
    }

    // ── Every call: update viewBox and translate margin group ─────────────────
    indChartSvg
        .attr('width', totalW)
        .attr('height', totalH)
        .attr('viewBox', `0 0 ${totalW} ${totalH}`);

    indChartInner.attr('transform', `translate(${m.left},${m.top})`);

    // ── Scales ────────────────────────────────────────────────────────────────
    indChartXScale = d3.scalePoint()
        .domain(YEARS)
        .range([0, width])
        .padding(0.1);

    // yScale domain will be set by renderIndividualChart() once we have data.
    indChartYScale = d3.scaleLinear().range([height, 0]);

    // ── X-axis ────────────────────────────────────────────────────────────────
    indChartInner.select('.ind-chart-axis-x')
        .attr('transform', `translate(0,${height})`)
        .call(
            d3.axisBottom(indChartXScale)
                .tickFormat(t => YEAR_LABELS[t] ?? t)
        )
        .selectAll('text')
        .attr('transform', 'rotate(-40)')
        .attr('text-anchor', 'end')
        .attr('dx', '-0.4em')
        .attr('dy', '0.15em');

    // ── Y-axis label position ─────────────────────────────────────────────────
    // Fixed at x=12 (near left edge) so there is always clear horizontal space
    // between the label and the y-axis tick numbers (which extend left from x=m.left).
    indChartSvg.select('.ind-chart-y-label')
        .attr('transform', `translate(28, ${m.top + height / 2}) rotate(-90)`);


    return { width, height };
}

/**
 * Main render function for the individual chart.
 *
 * Shows the placeholder when no region is chosen.
 * When a region is chosen, builds the data series and paints/updates:
 * - D3 scales with correct domains
 * - Y-axis ticks + grid lines
 * - The line path
 * - Circle markers with hover tooltips
 * - A horizontal zero-line for net/diverging metrics
 * - The Y-axis label text
 */
function renderIndividualChart() {
    updateStatisticDescription('ind-statistic-description', indChartState.metric);
    const placeholder = document.getElementById('chart-individual-placeholder');
    const svgContainer = document.getElementById('chart-individual-svg-container');
    if (!placeholder || !svgContainer) return;

    // ── 1. Extract active regions and remember their slot index ───────────────
    const activeRegions = indChartState.regions
        .map((r, i) => r ? { ...r, slotIndex: i } : null)
        .filter(r => r !== null);

    if (activeRegions.length === 0) {
        placeholder.removeAttribute('hidden');
        svgContainer.setAttribute('hidden', '');
        return;
    }

    placeholder.setAttribute('hidden', '');
    svgContainer.removeAttribute('hidden');

    const { width, height } = setupIndividualChart();
    if (width <= 0 || height <= 0) return;

    const metricKey = indChartState.metric;

    // ── 3. Build Data Series for ALL regions ──────────────────────────────────
    const allSeries = activeRegions.map((region) => {
        const seriesData = YEARS.map(year => {
            let value = null;
            if (region.level === 'state') {
                value = _getStateMapValue(region.key, year, metricKey);
            } else if (region.level === 'county') {
                value = _getCountyMapValue(region.key, year, metricKey);
            }
            return { year, label: YEAR_LABELS[year] ?? year, value };
        });

        return {
            regionKey: region.key,
            regionLabel: region.label,
            color: indChartColors(region.slotIndex), // FIXED COLOR BY SLOT
            data: seriesData
        };
    });

    // Flatten all valid values to find the global Y domain
    const defined = d => d.value !== null && Number.isFinite(d.value);
    const validVals = allSeries.flatMap(s => s.data.filter(defined).map(d => d.value));

    // ── 4. Dynamic Y Scale ────────────────────────────────────────────────────
    let [yMin, yMax] = validVals.length > 0 ? [d3.min(validVals), d3.max(validVals)] : [0, 1];

    const range = yMax - yMin;
    const pad = range === 0 ? (Math.abs(yMax) * 0.05 || 1) : range * 0.1;
    const isDiverging = METRIC_META[metricKey]?.direction === 'both' && metricKey.includes('net');

    if (isDiverging) {
        yMin = yMin - pad;
        yMax = yMax + pad;
    } else {
        yMin = Math.max(0, yMin - pad);
        yMax = yMax + pad;
    }

    indChartYScale.domain([yMin, yMax]).nice();

    // ── 5. Axes & Grid ────────────────────────────────────────────────────────
    indChartInner.select('.ind-chart-axis-y')
        .call(d3.axisLeft(indChartYScale).ticks(6).tickFormat(v => formatAxisValue(v, metricKey)));

    indChartInner.select('.ind-chart-grid-y')
        .call(d3.axisLeft(indChartYScale).ticks(6).tickSize(-width).tickFormat(''))
        .select('.domain').remove();

    const zeroY = indChartYScale(0);
    const showZero = isDiverging && zeroY >= 0 && zeroY <= height;

    indChartInner.select('.ind-chart-zero-line')
        .attr('x1', 0).attr('x2', width)
        .attr('y1', zeroY).attr('y2', zeroY)
        .attr('stroke', showZero ? 'rgba(0,0,0,0.25)' : 'none')
        .attr('stroke-width', 1).attr('stroke-dasharray', '4 3');

    // ── 6. Line Paths ─────────────────────────────────────────────────────────
    const lineGen = d3.line()
        .defined(defined)
        .x(d => indChartXScale(d.year))
        .y(d => indChartYScale(d.value))
        .curve(d3.curveMonotoneX);

    // Because there are multiple lines, bind data to a group of paths rather than a single path
    // Remove the old single path first if it exists
    indChartInner.select('path.ind-chart-line').remove();

    // Create a container for multi-lines if it doesn't exist
    let lineGroup = indChartInner.select('.ind-chart-lines-group');
    if (lineGroup.empty()) {
        // Insert it right before the dots group
        lineGroup = indChartInner.insert('g', '.ind-chart-dots').attr('class', 'ind-chart-lines-group');
    }

    lineGroup.selectAll('path.multi-line')
        .data(allSeries, d => d.regionKey)
        .join('path')
        .attr('class', 'multi-line')
        .attr('fill', 'none')
        .attr('stroke', d => d.color)
        .attr('stroke-width', 2.5)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('d', d => lineGen(d.data));

    // ── 7. Circle Markers & Tooltip ───────────────────────────────────────────
    let tooltip = d3.select('body').select('#chart-tooltip');
    if (tooltip.empty()) tooltip = d3.select('body').append('div').attr('id', 'chart-tooltip');

    // Create a group for each region's dots
    const dotsGroups = indChartInner.select('.ind-chart-dots')
        .selectAll('g.region-dots')
        .data(allSeries, d => d.regionKey)
        .join('g')
        .attr('class', 'region-dots');

    dotsGroups.selectAll('circle')
        .data(d => d.data.map(point => ({ ...point, regionLabel: d.regionLabel, color: d.color })))
        .join(
            enter => enter.append('circle')
                .attr('r', 4)
                .attr('cx', d => indChartXScale(d.year))
                .attr('cy', d => defined(d) ? indChartYScale(d.value) : 0)
                .attr('fill', 'var(--surface)')
                .attr('stroke', d => d.color)
                .attr('stroke-width', 2)
                .style('cursor', 'pointer')
                .style('display', d => defined(d) ? null : 'none'),
            update => update
                .attr('cx', d => indChartXScale(d.year))
                .attr('cy', d => defined(d) ? indChartYScale(d.value) : 0)
                .attr('stroke', d => d.color)
                .style('display', d => defined(d) ? null : 'none')
        )
        .on('mouseenter', function (event, d) {
            // Bring hovered line's dots to front
            d3.select(this.parentNode).raise();
            d3.select(this).attr('r', 6);

            const valStr = formatMetricValue(d.value, metricKey);
            tooltip.style('display', 'block').html(`
                <strong>${d.label}</strong><br/>
                <span style="color: #666;">Region:</span> 
                <span style="color: ${d.color}; font-weight: bold;">${d.regionLabel}</span><br/>
                <span style="color: #666;">${getMetricLabel(metricKey)}:</span> ${valStr}
            `);
        })
        .on('mousemove', function (event) {
            const tipNode = tooltip.node();
            const tipW = tipNode ? tipNode.offsetWidth : 180;
            const rightOverflow = event.pageX + 14 + tipW > window.innerWidth - 16;
            tooltip
                .style('left', rightOverflow ? (event.pageX - tipW - 14) + 'px' : (event.pageX + 14) + 'px')
                .style('top', (event.pageY - 10) + 'px');
        })
        .on('mouseleave', function () {
            d3.select(this).attr('r', 4);
            tooltip.style('display', 'none');
        });
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 8.6 — PHASE 7: PAIRWISE REGION TREND CHART  (Milestones 7.1/7.2)
═══════════════════════════════════════════════════════════════════════════ */

const pairChartState = {
    // Array of exactly 12 slots. Each is either null or an object with regionA and regionB
    pairs: [
        {
            regionA: { key: '06', level: 'state', label: 'California' },
            regionB: { key: '48', level: 'state', label: 'Texas' }
        },
        {
            regionA: { key: '48', level: 'state', label: 'Texas' },
            regionB: { key: '06', level: 'state', label: 'California' }
        },
        ...new Array(10).fill(null)
    ],
    metricCategory: 'pop',
    metric: 'pop_outflow',

    // Temporarily hold the selections before "Add" is clicked
    stagedAKey: null,
    stagedALevel: null,
    stagedALabel: null,

    stagedBKey: null,
    stagedBLevel: null,
    stagedBLabel: null
};

// D3 color scale for up to 12 lines (reused from individual chart)
const pairChartColors = d3.scaleOrdinal(d3.schemePaired);

function _updatePairInputStates() {
    const inputA = document.getElementById('pair-region-a-input');
    const inputB = document.getElementById('pair-region-b-input');
    const addBtn = document.getElementById('pair-add-btn');
    if (!inputA || !inputB) return;

    const activeCount = pairChartState.pairs.filter(p => p !== null).length;

    if (activeCount >= 12) {
        inputA.disabled = true;
        inputB.disabled = true;
        inputA.placeholder = "Max 12 pairs reached";
        inputB.placeholder = "Max 12 pairs reached";
    } else {
        inputA.disabled = false;
        inputB.disabled = false;
        inputA.placeholder = "Search states and counties…";
        inputB.placeholder = "Search states and counties…";
    }

    // Evaluate Add button
    if (addBtn) {
        const hasA = !!pairChartState.stagedAKey;
        const hasB = !!pairChartState.stagedBKey;
        const isDuplicate = pairChartState.pairs.some(p =>
            p !== null &&
            p.regionA.key === pairChartState.stagedAKey &&
            p.regionB.key === pairChartState.stagedBKey
        );
        addBtn.disabled = !hasA || !hasB || isDuplicate || activeCount >= 12;
    }
}

function renderPairRegionBubbles() {
    const container = document.getElementById('pair-selected-regions');
    if (!container) return;

    container.innerHTML = '';

    const activePairs = pairChartState.pairs
        .map((pair, i) => pair ? { ...pair, slotIndex: i } : null)
        .filter(p => p !== null);

    activePairs.forEach((pair) => {
        const i = pair.slotIndex;

        const bubble = document.createElement('div');
        bubble.className = 'region-bubble';
        bubble.style.borderColor = pairChartColors(i);
        bubble.style.backgroundColor = `${pairChartColors(i)}15`;

        const label = document.createElement('span');
        label.innerHTML = `${pair.regionA.label} &leftrightarrow; ${pair.regionB.label}`;

        const removeBtn = document.createElement('button');
        removeBtn.className = 'bubble-remove-btn';
        removeBtn.innerHTML = '×';
        removeBtn.setAttribute('aria-label', `Remove pair`);

        removeBtn.addEventListener('click', () => {
            pairChartState.pairs[i] = null;
            _updatePairInputStates();
            renderPairRegionBubbles();
            renderPairChart();
        });

        bubble.appendChild(label);
        bubble.appendChild(removeBtn);
        container.appendChild(bubble);
    });
}

let pairChartSvg = null;
let pairChartInner = null;
let pairChartXScale = null;
let pairChartYScale = null;
let pairChartMargin = { top: 24, right: 32, bottom: 64, left: 100 };

function setupPairChart() {
    const container = document.getElementById('chart-pair-svg-container');
    if (!container) return { width: 0, height: 0 };

    const m = pairChartMargin;
    const totalW = container.clientWidth || 800;
    const totalH = container.clientHeight || 340;
    const width = totalW - m.left - m.right;
    const height = totalH - m.top - m.bottom;

    if (!pairChartSvg) {
        pairChartSvg = d3.select(container).append('svg')
            .attr('role', 'img').attr('aria-label', 'Pairwise migration trend');

        pairChartInner = pairChartSvg.append('g').attr('class', 'pair-chart-inner');

        pairChartInner.append('g').attr('class', 'ind-chart-grid ind-chart-grid-y');
        pairChartInner.append('g').attr('class', 'ind-chart-axis ind-chart-axis-x');
        pairChartInner.append('g').attr('class', 'ind-chart-axis ind-chart-axis-y');

        pairChartSvg.append('text')
            .attr('class', 'ind-chart-y-label pair-chart-y-label')
            .attr('text-anchor', 'middle');

        // Pre-append elements so we don't have to lazily create them in render
        pairChartInner.append('line').attr('class', 'ind-chart-zero-line');
        pairChartInner.append('path').attr('class', 'pair-chart-line');
        pairChartInner.append('g').attr('class', 'pair-chart-dots');
    }

    pairChartSvg.attr('width', totalW).attr('height', totalH).attr('viewBox', `0 0 ${totalW} ${totalH}`);
    pairChartInner.attr('transform', `translate(${m.left},${m.top})`);

    pairChartXScale = d3.scalePoint().domain(YEARS).range([0, width]).padding(0.1);
    pairChartYScale = d3.scaleLinear().range([height, 0]);

    pairChartInner.select('.ind-chart-axis-x')
        .attr('transform', `translate(0,${height})`)
        .call(d3.axisBottom(pairChartXScale).tickFormat(t => YEAR_LABELS[t] ?? t))
        .selectAll('text').attr('transform', 'rotate(-40)').attr('text-anchor', 'end').attr('dx', '-0.4em').attr('dy', '0.15em');

    pairChartSvg.select('.pair-chart-y-label').attr('transform', `translate(28, ${m.top + height / 2}) rotate(-90)`).text(getMetricLabel(pairChartState.metric));

    return { width, height };
}

function renderPairChart() {
    updateStatisticDescription('pair-statistic-description', pairChartState.metric);
    const placeholder = document.getElementById('chart-pair-placeholder');
    const svgContainer = document.getElementById('chart-pair-svg-container');
    if (!placeholder || !svgContainer) return;

    const activePairs = pairChartState.pairs
        .map((p, i) => p ? { ...p, slotIndex: i } : null)
        .filter(p => p !== null);

    // ── 1. Check if ANY pair is selected ─────────────────────────────────
    if (activePairs.length === 0) {
        placeholder.removeAttribute('hidden');
        svgContainer.setAttribute('hidden', '');
        const p = placeholder.querySelector('p');
        if (p) {
            p.innerHTML = "Select two states or counties above and click 'Add' to view the migration flows between them over time.";
        }
        return;
    }

    placeholder.setAttribute('hidden', '');
    svgContainer.removeAttribute('hidden');

    const { width, height } = setupPairChart();
    if (width <= 0 || height <= 0) return;

    const metricKey = pairChartState.metric;

    // ── 3. Build Data Series ──────────────────────────────────────────────────
    const allSeries = activePairs.map((pair) => {
        const seriesData = YEARS.map(year => {
            let value = null;
            if (pair.regionA.level === 'state') {
                value = _getStateMapValue(pair.regionB.key, year, metricKey, pair.regionA.key);
            } else {
                value = _getCountyMapValue(pair.regionB.key, year, metricKey, pair.regionA.key);
            }
            return { year, label: YEAR_LABELS[year] ?? year, value };
        });

        return {
            pairKey: `${pair.regionA.key}_${pair.regionB.key}`,
            regionALabel: pair.regionA.label,
            regionBLabel: pair.regionB.label,
            color: pairChartColors(pair.slotIndex),
            data: seriesData
        };
    });

    const defined = d => d.value !== null && Number.isFinite(d.value);
    const validVals = allSeries.flatMap(s => s.data.filter(defined).map(d => d.value));

    // ── 4. Dynamic Y Scale ────────────────────────────────────────────────────
    let [yMin, yMax] = validVals.length > 0 ? [d3.min(validVals), d3.max(validVals)] : [0, 1];
    const range = yMax - yMin;
    const pad = range === 0 ? (Math.abs(yMax) * 0.05 || 1) : range * 0.1;
    const isDiverging = METRIC_META[metricKey]?.direction === 'both' && metricKey.includes('net');

    if (isDiverging) {
        yMin = yMin - pad;
        yMax = yMax + pad;
    } else {
        yMin = Math.max(0, yMin - pad);
        yMax = yMax + pad;
    }

    pairChartYScale.domain([yMin, yMax]).nice();

    // ── 5. Axes & Grid ────────────────────────────────────────────────────────
    pairChartInner.select('.ind-chart-axis-y').call(d3.axisLeft(pairChartYScale).ticks(6).tickFormat(v => formatAxisValue(v, metricKey)));
    pairChartInner.select('.ind-chart-grid-y').call(d3.axisLeft(pairChartYScale).ticks(6).tickSize(-width).tickFormat('')).select('.domain').remove();

    const zeroY = pairChartYScale(0);
    const showZero = isDiverging && zeroY >= 0 && zeroY <= height;
    pairChartInner.select('.ind-chart-zero-line')
        .attr('x1', 0).attr('x2', width).attr('y1', zeroY).attr('y2', zeroY)
        .attr('stroke', showZero ? 'rgba(0,0,0,0.25)' : 'none')
        .attr('stroke-width', 1).attr('stroke-dasharray', '4 3');

    // ── 6. Line Paths ──────────────────────────────────────────────────────────
    const lineGen = d3.line().defined(defined).x(d => pairChartXScale(d.year)).y(d => pairChartYScale(d.value)).curve(d3.curveMonotoneX);

    pairChartInner.select('path.pair-chart-line').remove();

    let lineGroup = pairChartInner.select('.pair-chart-lines-group');
    if (lineGroup.empty()) lineGroup = pairChartInner.insert('g', '.pair-chart-dots').attr('class', 'pair-chart-lines-group');

    lineGroup.selectAll('path.multi-line')
        .data(allSeries, d => d.pairKey)
        .join('path')
        .attr('class', 'multi-line')
        .attr('fill', 'none')
        .attr('stroke', d => d.color)
        .attr('stroke-width', 2.5)
        .attr('stroke-linejoin', 'round')
        .attr('stroke-linecap', 'round')
        .attr('d', d => lineGen(d.data));

    // ── 7. Circle Markers & Tooltip ───────────────────────────────────────────
    let tooltip = d3.select('body').select('#chart-tooltip');

    // Ensure the tooltip exists even if the user hasn't hovered the map yet
    if (tooltip.empty()) {
        tooltip = d3.select('body').append('div').attr('id', 'chart-tooltip');
    }

    const dotsGroups = pairChartInner.select('.pair-chart-dots')
        .selectAll('g.pair-dots')
        .data(allSeries, d => d.pairKey)
        .join('g')
        .attr('class', 'pair-dots');

    dotsGroups.selectAll('circle')
        .data(d => d.data.map(point => ({ ...point, regionALabel: d.regionALabel, regionBLabel: d.regionBLabel, color: d.color })))
        .join(
            enter => enter.append('circle')
                .attr('r', 4)
                .attr('cx', d => pairChartXScale(d.year))
                .attr('cy', d => defined(d) ? pairChartYScale(d.value) : 0)
                .attr('fill', 'var(--surface)')
                .attr('stroke', d => d.color)
                .attr('stroke-width', 2)
                .style('cursor', 'pointer')
                .style('display', d => defined(d) ? null : 'none'),
            update => update
                .attr('cx', d => pairChartXScale(d.year))
                .attr('cy', d => defined(d) ? pairChartYScale(d.value) : 0)
                .attr('stroke', d => d.color)
                .style('display', d => defined(d) ? null : 'none')
        )
        // Add a thick, invisible border so the user's mouse doesn't have to be pixel-perfect
        .style('stroke', 'transparent')
        .style('stroke-width', '10px')
        .on('mouseenter', function (event, d) {
            d3.select(this.parentNode).raise();

            // Expand the visible circle, but keep the invisible hit-area large
            d3.select(this).attr('r', 6).style('stroke-width', '10px');

            const valStr = formatMetricValue(d.value, metricKey);
            tooltip.style('display', 'block')
                .html(`<strong>${d.label}</strong><br/>
                       <span style="color: #666;">Region A:</span> <span style="color: ${d.color}; font-weight: bold;">${d.regionALabel}</span><br/>
                       <span style="color: #666;">Region B:</span> <span style="color: ${d.color}; font-weight: bold;">${d.regionBLabel}</span><br/>
                       <span style="color: #666;">${getMetricLabel(metricKey)}:</span> ${valStr}`);
        })
        .on('mousemove', function (event) {
            const tipNode = tooltip.node();
            const tipW = tipNode ? tipNode.offsetWidth : 180;
            const rightOverflow = event.pageX + 14 + tipW > window.innerWidth - 16;
            tooltip.style('left', rightOverflow ? (event.pageX - tipW - 14) + 'px' : (event.pageX + 14) + 'px')
                .style('top', (event.pageY - 10) + 'px');
        })
        .on('mouseleave', function () {
            // Restore visual size and hit-area
            d3.select(this).attr('r', 4).style('stroke-width', '10px');
            tooltip.style('display', 'none');
        });

    // Clean up the inner visual ring inside the large transparent hit area
    dotsGroups.selectAll('circle.inner-ring')
        .data(d => d.data.map(point => ({ ...point, color: d.color })))
        .join('circle')
        .attr('class', 'inner-ring')
        .attr('r', 4)
        .attr('cx', d => pairChartXScale(d.year))
        .attr('cy', d => defined(d) ? pairChartYScale(d.value) : 0)
        .attr('fill', 'var(--surface)')
        .attr('stroke', d => d.color)
        .attr('stroke-width', 2)
        .style('pointer-events', 'none') // Ensure the invisible hit area gets the mouse events
        .style('display', d => defined(d) ? null : 'none');
}

/** Helper to generate region comboboxes cleanly */
function bindGenericCombobox(prefix, getSelectedKey, onSelect, getAllowedLevel, getExcludedKey) {
    let isOpen = false;
    let highlightIdx = -1;

    const input = document.getElementById(`${prefix}-input`);
    const listbox = document.getElementById(`${prefix}-listbox`);
    const combobox = document.getElementById(`${prefix}-combobox`);
    if (!input || !listbox || !combobox) return;

    function appendOption(entry, showBadge) {
        const opt = document.createElement('div');
        const isActive = entry.key === getSelectedKey();
        opt.className = 'region-option' + (isActive ? ' region-option--active' : '');
        opt.textContent = showBadge ? `${entry.label}\u2002(${entry.level})` : entry.label;
        opt.dataset.key = entry.key;
        opt.dataset.level = entry.level;
        opt.dataset.label = entry.label;
        opt.setAttribute('role', 'option');
        opt.setAttribute('aria-selected', isActive ? 'true' : 'false');
        listbox.appendChild(opt);
    }

    function renderList(filterText) {
        const lower = (filterText || '').toLowerCase().trim();
        highlightIdx = -1;

        const allowedLevel = getAllowedLevel ? getAllowedLevel() : null;
        let availableEntries = indComboboxEntries;

        if (allowedLevel) {
            availableEntries = availableEntries.filter(e => e.level === allowedLevel);
        }

        const excludedKeys = getExcludedKey ? getExcludedKey() : null;
        if (excludedKeys) {
            if (Array.isArray(excludedKeys)) {
                const excludeSet = new Set(excludedKeys);
                availableEntries = availableEntries.filter(e => !excludeSet.has(e.key));
            } else {
                availableEntries = availableEntries.filter(e => e.key !== excludedKeys);
            }
        }

        const filtered = lower ? availableEntries.filter(e => e.label.toLowerCase().includes(lower)) : availableEntries;

        listbox.innerHTML = '';
        if (filtered.length === 0) {
            listbox.innerHTML = '<div class="region-option region-option--no-results">No results found</div>';
            return;
        }

        if (lower) {
            filtered.forEach(e => appendOption(e, false));
        } else {
            const selKey = getSelectedKey();
            const selectedEntry = selKey ? availableEntries.find(e => e.key === selKey) : null;
            const states = filtered.filter(e => e.level === 'state' && e.key !== selKey);
            const counties = filtered.filter(e => e.level === 'county' && e.key !== selKey);

            if (selectedEntry) {
                listbox.insertAdjacentHTML('beforeend', '<div class="region-group-label">Selected</div>');
                appendOption(selectedEntry, false);
            }
            if (states.length) {
                listbox.insertAdjacentHTML('beforeend', '<div class="region-group-label">States</div>');
                states.forEach(e => appendOption(e, false));
            }
            if (counties.length) {
                listbox.insertAdjacentHTML('beforeend', '<div class="region-group-label">Counties</div>');
                counties.forEach(e => appendOption(e, false));
            }
            if (!countyDataLoaded && (!allowedLevel || allowedLevel === 'county')) {
                listbox.insertAdjacentHTML('beforeend', '<div class="region-option region-option--no-results">Loading county data…</div>');
            }
        }
    }

    function openBox() {
        if (isOpen) return;
        listbox.removeAttribute('hidden');
        input.setAttribute('aria-expanded', 'true');
        isOpen = true;
        renderList(input.value);
    }

    // Accept a validation flag to check what the user typed before closing
    function closeBox(validateInput = false) {
        if (validateInput && isOpen) {
            const currentText = input.value.trim();
            const lower = currentText.toLowerCase();
            const selKey = getSelectedKey();

            if (currentText === '') {
                // User erased the text box, clear the selection
                if (selKey !== null) onSelect(null, null, null);
            } else {
                // User typed text but didn't click. See if it matches exactly
                const match = indComboboxEntries.find(e => e.label.toLowerCase() === lower);
                if (match) {
                    let isValid = true;
                    const allowedLevel = getAllowedLevel ? getAllowedLevel() : null;
                    if (allowedLevel && match.level !== allowedLevel) isValid = false;

                    const excludedKeys = getExcludedKey ? getExcludedKey() : null;
                    if (excludedKeys) {
                        if (Array.isArray(excludedKeys) && excludedKeys.includes(match.key)) isValid = false;
                        else if (match.key === excludedKeys) isValid = false;
                    }

                    if (isValid) {
                        if (match.key !== selKey) onSelect(match.key, match.level, match.label);
                    } else {
                        onSelect(null, null, null); // Matches but is excluded
                    }
                } else {
                    onSelect(null, null, null); // Typed gibberish, clear selection
                }
            }
        }

        listbox.setAttribute('hidden', '');
        input.setAttribute('aria-expanded', 'false');
        isOpen = false;
        highlightIdx = -1;

        // Restore input value to whatever the firmly confirmed state is
        const confirmedKey = getSelectedKey();
        const confirmedEntry = confirmedKey ? indComboboxEntries.find(e => e.key === confirmedKey) : null;
        input.value = confirmedEntry ? confirmedEntry.label : '';
    }

    input.addEventListener('focus', openBox);
    input.addEventListener('input', () => {
        if (!isOpen) openBox();
        renderList(input.value);
    });

    input.addEventListener('keydown', e => {
        if (!isOpen && e.key !== 'Tab') openBox();
        const options = Array.from(listbox.querySelectorAll('.region-option:not(.region-option--no-results)'));

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            highlightIdx = e.key === 'ArrowDown' ? Math.min(highlightIdx + 1, options.length - 1) : Math.max(highlightIdx - 1, 0);
            options.forEach((opt, i) => {
                if (i === highlightIdx) {
                    opt.classList.add('region-option--highlighted');
                    opt.scrollIntoView({ block: 'nearest' });
                } else {
                    opt.classList.remove('region-option--highlighted');
                }
            });
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const h = options[highlightIdx];
            if (h) {
                onSelect(h.dataset.key, h.dataset.level, h.dataset.label);
                closeBox(false); // Validated by click/enter
            } else {
                closeBox(true); // Attempt to validate what they typed
            }
        } else if (e.key === 'Escape') {
            closeBox(false); // Cancel out, do not validate
        }
    });

    listbox.addEventListener('mousedown', e => {
        const opt = e.target.closest('.region-option');
        if (!opt || opt.classList.contains('region-option--no-results')) return;
        e.preventDefault(); // Prevents input blur
        onSelect(opt.dataset.key, opt.dataset.level, opt.dataset.label);
        closeBox(false); // Explicit selection made, no typing validation needed
    });

    // Fire validation instantly on blur so other UI elements (like the Add button) see it immediately
    input.addEventListener('blur', () => closeBox(true));

    document.addEventListener('click', e => {
        if (!combobox.contains(e.target)) closeBox(true);
    });
}

function initPairComboboxes() {
    bindGenericCombobox(
        'pair-region-a',
        () => pairChartState.stagedAKey,
        (key, level, label) => {
            pairChartState.stagedAKey = key || null;
            pairChartState.stagedALevel = level || null;
            pairChartState.stagedALabel = label || null;
            const inputA = document.getElementById('pair-region-a-input');
            if (inputA) inputA.value = key ? label : '';
            if (typeof _updatePairInputStates === 'function') _updatePairInputStates();
        },
        () => pairChartState.stagedBLevel,
        () => {
            const excludes = [];
            if (pairChartState.stagedBKey) {
                // 1. A cannot be the exact same region as B
                excludes.push(pairChartState.stagedBKey);

                // 2. Exclude any region that ALREADY forms a direct (A → B) pair with stagedBKey
                pairChartState.pairs.forEach(p => {
                    if (p !== null && p.regionB.key === pairChartState.stagedBKey) {
                        excludes.push(p.regionA.key);
                    }
                });
            }
            return excludes;
        }
    );

    bindGenericCombobox(
        'pair-region-b',
        () => pairChartState.stagedBKey,
        (key, level, label) => {
            pairChartState.stagedBKey = key || null;
            pairChartState.stagedBLevel = level || null;
            pairChartState.stagedBLabel = label || null;
            const inputB = document.getElementById('pair-region-b-input');
            if (inputB) inputB.value = key ? label : '';
            if (typeof _updatePairInputStates === 'function') _updatePairInputStates();
        },
        () => pairChartState.stagedALevel,
        () => {
            const excludes = [];
            if (pairChartState.stagedAKey) {
                // 1. B cannot be the exact same region as A
                excludes.push(pairChartState.stagedAKey);

                // 2. Exclude any region that ALREADY forms a direct (A → B) pair with stagedAKey
                pairChartState.pairs.forEach(p => {
                    if (p !== null && p.regionA.key === pairChartState.stagedAKey) {
                        excludes.push(p.regionB.key);
                    }
                });
            }
            return excludes;
        }
    );
}

/* ════════════════════════════════════════════════════════════════════════════
   SECTION 9 — CONTROL WIRING  (Milestone 3.3)
═══════════════════════════════════════════════════════════════════════════ */

function wireControls() {
    // ── Granularity radio buttons ─────────────────────────────────────────────
    document.querySelectorAll('input[name="granularity"]').forEach(radio => {
        radio.addEventListener('change', () => {
            appState.level = radio.value;
            appState.primaryRegion = null;
            appState.secondaryRegion = null;
            updateMapStatusText();
            // County data is loaded eagerly at startup — no lazy load needed here.
            render();
        });
    });

    // ── Year slider ───────────────────────────────────────────────────────────
    const slider = document.getElementById('year-slider');
    const yearLabel = document.getElementById('year-display');

    if (slider) {
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
    }

    // ── Helper to bind three dropdowns ────────────────────────────────────────
    function bindDropdowns(catSelId, dirSelId, statSelId, isPairMode, stateObj, renderFn) {
        const catSel = document.getElementById(catSelId);
        const dirSel = document.getElementById(dirSelId);
        const statSel = document.getElementById(statSelId);
        if (!catSel || !dirSel || !statSel) return;

        function updateState() {
            stateObj.metric = buildMetricKey(catSel.value, dirSel.value, statSel.value);
            if (stateObj.metricCategory !== undefined) {
                stateObj.metricCategory = catSel.value;
            }
            renderFn();
        }

        catSel.addEventListener('change', () => {
            populateStatSelect(statSel, catSel.value, isPairMode, statSel.value);
            updateState();
        });

        dirSel.addEventListener('change', updateState);
        statSel.addEventListener('change', updateState);
    }

    // ── Map: Category + Direction + Statistic selects ─────────────────────────
    bindDropdowns('metric-category-select', 'metric-direction-select', 'metric-stat-select', false, appState, render);



    // ── Zoom slider ───────────────────────────────────────────────────────────
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomLabel = document.getElementById('zoom-display');

    if (zoomSlider) {
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

    // ── Pan X slider ──────────────────────────────────────────────────────────
    const panXSlider = document.getElementById('pan-x-slider');
    const panXLabel = document.getElementById('pan-x-display');

    if (panXSlider) {
        panXSlider.addEventListener('input', () => {
            appState.panX = +panXSlider.value;
            panXLabel.textContent = `${appState.panX > 0 ? '+' : ''}${appState.panX}`;

            const min = +panXSlider.min;
            const max = +panXSlider.max;
            const pct = ((appState.panX - min) / (max - min)) * 100;
            panXSlider.style.setProperty('--pan-x-pct', `${pct}`);

            renderMap(); // Only need to re-render map
        });
    }

    // ── Pan Y slider ──────────────────────────────────────────────────────────
    const panYSlider = document.getElementById('pan-y-slider');
    const panYLabel = document.getElementById('pan-y-display');

    if (panYSlider) {
        panYSlider.addEventListener('input', () => {
            appState.panY = +panYSlider.value;
            panYLabel.textContent = `${appState.panY > 0 ? '+' : ''}${appState.panY}`;

            const min = +panYSlider.min;
            const max = +panYSlider.max;
            const pct = ((appState.panY - min) / (max - min)) * 100;
            panYSlider.style.setProperty('--pan-y-pct', `${pct}`);

            renderMap(); // Only need to re-render map
        });
    }

    // ── Individual chart: Category + Direction + Statistic selects ────────────
    bindDropdowns('ind-metric-category-select', 'ind-metric-direction-select', 'ind-metric-stat-select', false, indChartState, renderIndividualChart);

    // ── Individual chart: ADD button ─────────────────────────────────────────
    const indAddBtn = document.getElementById('ind-add-btn');
    if (indAddBtn) {
        indAddBtn.addEventListener('click', () => {
            const activeCount = indChartState.regions.filter(r => r !== null).length;
            if (indChartState.stagedKey && activeCount < 12) {
                // Ensure it's not already in the array
                if (!indChartState.regions.some(r => r !== null && r.key === indChartState.stagedKey)) {
                    // Find first empty slot
                    const emptyIdx = indChartState.regions.findIndex(r => r === null);
                    if (emptyIdx !== -1) {
                        indChartState.regions[emptyIdx] = {
                            key: indChartState.stagedKey,
                            level: indChartState.stagedLevel,
                            label: indChartState.stagedLabel
                        };
                    }
                }

                // Clear the input and staged values
                indChartState.stagedKey = null;
                indChartState.stagedLevel = null;
                indChartState.stagedLabel = null;

                const input = document.getElementById('ind-region-input');
                if (input) input.value = '';

                indAddBtn.disabled = true;

                if (typeof _updateIndRegionInputState === 'function') _updateIndRegionInputState();
                renderIndRegionBubbles();
                renderIndividualChart();
            }
        });
    }

    // ── Individual chart: CLEAR button ───────────────────────────────────────
    const indClearBtn = document.getElementById('ind-clear-btn');
    if (indClearBtn) {
        indClearBtn.addEventListener('click', () => {
            // Empty the regions array by filling with 12 nulls
            indChartState.regions = new Array(12).fill(null);

            // Clear staged input
            indChartState.stagedKey = null;
            indChartState.stagedLevel = null;
            indChartState.stagedLabel = null;

            const input = document.getElementById('ind-region-input');
            if (input) input.value = '';

            if (indAddBtn) indAddBtn.disabled = true;

            if (typeof _closeIndCombobox === 'function') _closeIndCombobox();

            if (typeof _updateIndRegionInputState === 'function') _updateIndRegionInputState();
            renderIndRegionBubbles();
            renderIndividualChart();
        });
    }

    // ── Navigation arrows ─────────────────────────────────────────────────────
    const scrollUpMapBtn = document.getElementById('scroll-up-map-btn');
    if (scrollUpMapBtn) {
        scrollUpMapBtn.addEventListener('click', () => {
            document.getElementById('page-toc').scrollIntoView({ behavior: 'instant' });
        });
    }
    const scrollDownBtn = document.getElementById('scroll-down-btn');
    if (scrollDownBtn) {
        scrollDownBtn.addEventListener('click', () => {
            // Instantly jump to the individual chart section
            document.getElementById('chart-individual').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollUpBtn = document.getElementById('scroll-up-btn');
    if (scrollUpBtn) {
        scrollUpBtn.addEventListener('click', () => {
            // Instantly jump back to the top of the map interface
            document.getElementById('page-map').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollDownIndBtn = document.getElementById('scroll-down-ind-btn');
    if (scrollDownIndBtn) {
        scrollDownIndBtn.addEventListener('click', () => {
            document.getElementById('chart-pair').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollUpPairBtn = document.getElementById('scroll-up-pair-btn');
    if (scrollUpPairBtn) {
        scrollUpPairBtn.addEventListener('click', () => {
            document.getElementById('chart-individual').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollDownPairBtn = document.getElementById('scroll-down-pair-btn');
    if (scrollDownPairBtn) {
        scrollDownPairBtn.addEventListener('click', () => {
            document.getElementById('page-guide').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollUpGuideBtn = document.getElementById('scroll-up-guide-btn');
    if (scrollUpGuideBtn) {
        scrollUpGuideBtn.addEventListener('click', () => {
            document.getElementById('chart-pair').scrollIntoView({ behavior: 'instant' });
        });
    }

    const scrollDownTocBtn = document.getElementById('scroll-down-toc-btn');
    if (scrollDownTocBtn) {
        scrollDownTocBtn.addEventListener('click', () => {
            document.getElementById('page-map').scrollIntoView({ behavior: 'instant' });
        });
    }

    // ── Table of Contents link click handlers ─────────────────────────────────
    document.querySelectorAll('.toc-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const target = link.dataset.target;
            const el = document.getElementById(target);
            if (el) el.scrollIntoView({ behavior: 'instant' });
        });
    });

    // ── Pairwise chart: Category + Direction + Statistic selects ──────────────
    bindDropdowns('pair-metric-category-select', 'pair-metric-direction-select', 'pair-metric-stat-select', true, pairChartState, renderPairChart);

    // ── Pairwise chart: ADD button ─────────────────────────────────────────
    const pairAddBtn = document.getElementById('pair-add-btn');
    if (pairAddBtn) {
        pairAddBtn.addEventListener('click', () => {
            const activeCount = pairChartState.pairs.filter(p => p !== null).length;
            if (pairChartState.stagedAKey && pairChartState.stagedBKey && activeCount < 12) {

                // Ensure duplicate isn't added
                const isDuplicate = pairChartState.pairs.some(p =>
                    p !== null &&
                    p.regionA.key === pairChartState.stagedAKey &&
                    p.regionB.key === pairChartState.stagedBKey
                );

                if (!isDuplicate) {
                    const emptyIdx = pairChartState.pairs.findIndex(p => p === null);
                    if (emptyIdx !== -1) {
                        pairChartState.pairs[emptyIdx] = {
                            regionA: { key: pairChartState.stagedAKey, level: pairChartState.stagedALevel, label: pairChartState.stagedALabel },
                            regionB: { key: pairChartState.stagedBKey, level: pairChartState.stagedBLevel, label: pairChartState.stagedBLabel }
                        };
                    }
                }

                // Clear staged inputs
                pairChartState.stagedAKey = null;
                pairChartState.stagedALevel = null;
                pairChartState.stagedALabel = null;
                pairChartState.stagedBKey = null;
                pairChartState.stagedBLevel = null;
                pairChartState.stagedBLabel = null;

                const inputA = document.getElementById('pair-region-a-input');
                const inputB = document.getElementById('pair-region-b-input');
                if (inputA) inputA.value = '';
                if (inputB) inputB.value = '';

                if (typeof _updatePairInputStates === 'function') _updatePairInputStates();
                renderPairRegionBubbles();
                renderPairChart();
            }
        });
    }

    // ── Pairwise chart: CLEAR button ───────────────────────────────────────
    const pairClearBtn = document.getElementById('pair-clear-btn');
    if (pairClearBtn) {
        pairClearBtn.addEventListener('click', () => {
            // Empty the array by filling with 12 nulls
            pairChartState.pairs = new Array(12).fill(null);

            // Clear staged inputs
            pairChartState.stagedAKey = null;
            pairChartState.stagedALevel = null;
            pairChartState.stagedALabel = null;
            pairChartState.stagedBKey = null;
            pairChartState.stagedBLevel = null;
            pairChartState.stagedBLabel = null;

            const inputA = document.getElementById('pair-region-a-input');
            const inputB = document.getElementById('pair-region-b-input');
            if (inputA) inputA.value = '';
            if (inputB) inputB.value = '';

            if (typeof _updatePairInputStates === 'function') _updatePairInputStates();
            renderPairRegionBubbles();
            renderPairChart();
        });
    }
}

/**
 * Helper to initialize the three dropdowns from a full metric key.
 */
function initDropdowns(metricKey, catSelId, dirSelId, statSelId, isPairMode) {
    const catSel = document.getElementById(catSelId);
    const dirSel = document.getElementById(dirSelId);
    const statSel = document.getElementById(statSelId);
    if (!metricKey || !catSel || !dirSel || !statSel) return;

    const { category, direction, baseStat } = parseMetricKey(metricKey);
    catSel.value = category;
    dirSel.value = direction;
    populateStatSelect(statSel, category, isPairMode, baseStat);
}

/**
 * initUI()
 *
 * Synchronises every HTML control with the current appState values.
 * Called once after data loads so that the initial display is consistent
 * regardless of any defaults set in the appState object at the top of the file.
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
    if (slider && yearLabel) {
        slider.value = appState.yearIndex;
        const tag = currentYear();
        yearLabel.textContent = YEAR_LABELS[tag];
        const pct = (appState.yearIndex / (YEARS.length - 1)) * 100;
        slider.style.setProperty('--slider-pct', `${pct}%`);
        slider.setAttribute('aria-valuenow', appState.yearIndex);
        slider.setAttribute('aria-valuetext', YEAR_LABELS[tag]);
    }

    // ── Map: sync category + direction + stat selects ─────────────────────────
    initDropdowns(appState.metric, 'metric-category-select', 'metric-direction-select', 'metric-stat-select', false);

    // ── Zoom slider ───────────────────────────────────────────────────────────
    const zoomSlider = document.getElementById('zoom-slider');
    const zoomLabel = document.getElementById('zoom-display');
    if (zoomSlider && zoomLabel) {
        zoomSlider.value = appState.zoomLevel;
        zoomLabel.textContent = `${appState.zoomLevel}×`;
        const zoomMin = +zoomSlider.min;
        const zoomMax = +zoomSlider.max;
        const zoomPct = ((appState.zoomLevel - zoomMin) / (zoomMax - zoomMin)) * 100;
        zoomSlider.style.setProperty('--zoom-pct', `${zoomPct}%`);
    }

    // ── Pan sliders ───────────────────────────────────────────────────────────
    const panXSlider = document.getElementById('pan-x-slider');
    const panXLabel = document.getElementById('pan-x-display');
    if (panXSlider && panXLabel) {
        panXSlider.value = appState.panX;
        panXLabel.textContent = `${appState.panX > 0 ? '+' : ''}${appState.panX}`;
        const min = +panXSlider.min;
        const max = +panXSlider.max;
        panXSlider.style.setProperty('--pan-x-pct', `${((appState.panX - min) / (max - min)) * 100}`);
    }

    const panYSlider = document.getElementById('pan-y-slider');
    const panYLabel = document.getElementById('pan-y-display');
    if (panYSlider && panYLabel) {
        panYSlider.value = appState.panY;
        panYLabel.textContent = `${appState.panY > 0 ? '+' : ''}${appState.panY}`;
        const min = +panYSlider.min;
        const max = +panYSlider.max;
        panYSlider.style.setProperty('--pan-y-pct', `${((appState.panY - min) / (max - min)) * 100}`);
    }

    // ── Map status text ───────────────────────────────────────────────────────
    updateMapStatusText();

    // ── Individual chart: sync category + direction + stat selects ────────────
    initDropdowns(indChartState.metric, 'ind-metric-category-select', 'ind-metric-direction-select', 'ind-metric-stat-select', false);
    initIndividualCombobox(); // builds entries, wires all combobox events
    renderIndRegionBubbles();
    renderIndividualChart();

    // ── Pairwise chart: sync category + direction + stat selects ──────────────
    initDropdowns(pairChartState.metric, 'pair-metric-category-select', 'pair-metric-direction-select', 'pair-metric-stat-select', true);
    initPairComboboxes();
    renderPairRegionBubbles();
    renderPairChart();
}

/**
 * Update the map status text based on the current selection.
 */
function updateMapStatusText() {
    const statusText = document.getElementById('map-status-text');
    if (!statusText) return;

    if (!appState.primaryRegion) {
        statusText.textContent = 'Hover over a state, county, or county equivalent to see details';
        return;
    }

    // Build display labels
    let pLabel = appState.primaryRegion;
    let sLabel = '';

    if (appState.level === 'state') {
        const pm = stateMeta[appState.primaryRegion];
        if (pm) pLabel = `${pm.name} (${pm.postal})`;
        if (appState.secondaryRegion) {
            const sm = stateMeta[appState.secondaryRegion];
            if (sm) sLabel = ` → ${sm.name} (${sm.postal})`;
        }
    } else {
        const pm = countyMeta[appState.primaryRegion];
        if (pm) pLabel = `${pm.countyName}, ${pm.statePostal}`;
        if (appState.secondaryRegion) {
            const sm = countyMeta[appState.secondaryRegion];
            if (sm) sLabel = ` → ${sm.countyName}, ${sm.statePostal}`;
        }
    }

    statusText.textContent = `Selected: ${pLabel}${sLabel}`;
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

    // Begin loading county data eagerly in the background.
    // This runs in parallel with the first map render so the UI stays responsive.
    // When it completes, rebuild the combobox entries so counties become selectable.
    loadCountyData().then(() => {
        buildIndComboboxEntries();
        // If the combobox is currently open, refresh the listbox immediately
        if (indComboboxOpen) _renderIndComboboxListbox(
            document.getElementById('ind-region-input')?.value ?? ''
        );
        console.log('[App] County combobox entries built:', indComboboxEntries.filter(e => e.level === 'county').length.toLocaleString());
    }).catch(err => {
        console.error('[App] County background load failed:', err);
    });

    // Re-render map whenever the container is resized (e.g. window resize)
    const resizeObserver = new ResizeObserver(() => { if (mapSvg) renderMap(); });
    resizeObserver.observe(document.getElementById('map'));

    // Re-scaffold and re-render the individual chart when its container resizes
    const indChartContainer = document.getElementById('chart-individual-svg-container');
    if (indChartContainer) {
        const chartResizeObserver = new ResizeObserver(() => {
            // Reset the SVG handle so setupIndividualChart() recreates it at the new size
            if (indChartSvg) {
                indChartSvg.remove();
                indChartSvg = null;
                indChartInner = null;
            }
            renderIndividualChart();
        });
        chartResizeObserver.observe(indChartContainer);
    }

    // Re-scaffold and re-render the pair chart when its container resizes
    const pairChartContainer = document.getElementById('chart-pair-svg-container');
    if (pairChartContainer) {
        const pairResizeObserver = new ResizeObserver(() => {
            if (pairChartSvg) {
                pairChartSvg.remove();
                pairChartSvg = null;
                pairChartInner = null;
            }
            renderPairChart();
        });
        pairResizeObserver.observe(pairChartContainer);
    }

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
        formatMetricValue, formatAxisValue, getMetricLabel,
        // Section 7.5 — Geo integration
        loadGeoData, setupMapSvg,
        geoCache,
        get mapProjection() { return mapProjection; },
        get mapPath() { return mapPath; },
        get mapLayerBase() { return mapLayerBase; },
        get mapLayerBorder() { return mapLayerBorder; },
        // Section 9 — UI helpers
        initUI, wireControls, updateMapStatusText, setLoadingState,
        // Loaders
        loadCountyData,
        // Render
        render,
    };
});
