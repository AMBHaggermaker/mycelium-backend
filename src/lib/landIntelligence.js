const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

// ── EPA ECHO API (proper REST API, not scraping) ──────────────────────────────
async function fetchECHOFacilities() {
  try {
    const params = new URLSearchParams({
      output:      'JSON',
      p_st:        'AL',
      p_county:    'MADISON',
      p_per_page:  '20',
      p_act:       'Y',   // active facilities only
      p_qiv:       '5',   // at least one inspection/violation in 5 years
    });
    const url = `https://echodata.epa.gov/echo/facility_search.json?${params}`;
    const res = await fetch(url, {
      signal:  AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const facilities = data?.Results?.Facilities || [];
    return facilities.slice(0, 20).map(f => ({
      name:     f.FacilityName,
      city:     f.City,
      address:  f.LocationAddress,
      programs: f.ProgramSystemAcronyms,
      status:   f.CurrentVioStatus,
    }));
  } catch (e) {
    console.log('[land-intel] EPA ECHO unavailable (non-fatal):', e.message);
    return null;
  }
}

// ── Main analysis loop ────────────────────────────────────────────────────────
async function runLandIntelligence() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[land-intel] ANTHROPIC_API_KEY not set — skipping');
    return;
  }

  console.log('[land-intel] Starting land intelligence run…');

  // 1. Fetch community-submitted land records (primary source)
  let landRecords;
  try {
    const result = await pool.query(
      `SELECT lr.*, u.username AS submitted_by_username
       FROM land_records lr
       JOIN users u ON u.id = lr.submitted_by
       WHERE lr.created_at > NOW() - INTERVAL '180 days'
       ORDER BY lr.created_at DESC
       LIMIT 100`
    );
    landRecords = result.rows;
  } catch (e) {
    console.error('[land-intel] Failed to fetch land records:', e.message);
    return;
  }

  // 2. Fetch community watch reports (context)
  let communityReports;
  try {
    const result = await pool.query(
      `SELECT id, dashboard_type, title, description, location_label,
              severity, report_type, created_at
       FROM watch_reports
       WHERE dashboard_type IN ('housing','civic','health','environment','land_development')
         AND created_at > NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC
       LIMIT 80`
    );
    communityReports = result.rows;
  } catch (e) {
    console.error('[land-intel] Failed to fetch community reports:', e.message);
    communityReports = [];
  }

  // 3. EPA ECHO facilities (best-effort environmental context)
  const echoFacilities = await fetchECHOFacilities();

  // Require at least some submitted land records to proceed
  if (landRecords.length === 0 && communityReports.length < 3) {
    console.log('[land-intel] Insufficient data — skipping analysis');
    return;
  }

  const client = new Anthropic({ apiKey });

  const echoSection = echoFacilities
    ? `EPA ECHO — Active environmental facilities in Madison County (${echoFacilities.length} flagged):\n${JSON.stringify(echoFacilities, null, 2)}`
    : 'EPA ECHO data unavailable for this run.';

  const prompt = `You are a land development intelligence analyst for Huntsville, Alabama and Madison County. You are analyzing community-submitted public records and watch reports to identify patterns that may harm residents.

DATA SOURCES
============

1. COMMUNITY-SUBMITTED LAND RECORDS (primary — human-verified public records):
${landRecords.length > 0 ? JSON.stringify(landRecords, null, 2) : '(no records submitted yet)'}

2. COMMUNITY WATCH REPORTS — housing, civic, health, environment (context):
${JSON.stringify(communityReports, null, 2)}

3. ${echoSection}

ANALYSIS INSTRUCTIONS
====================
Look for these patterns in the submitted land records and watch reports:

1. LLC_ACQUISITION_PATTERN — same buyer (especially LLC/Holdings/Capital/Properties/Ventures) appears in 2+ property transfer records
2. BULK_PURCHASE_PATTERN — same buyer acquires 3+ properties within 90 days in the same area
3. DISPLACEMENT_RISK — zoning changes (R→I or R→C) OR annexation filings in areas that ALSO have housing violation watch reports nearby
4. ANNEXATION_ACTIVITY — annexation filings, especially near neighborhoods with housing complaints
5. ZONING_CHANGE_REQUEST — rezoning requests near residential areas, especially if watch reports exist nearby
6. PROPERTY_TRANSFER_CLUSTER — multiple property transfers within a small geographic area in a short timeframe
7. PLANNING_DECISION_IMPACT — planning commission approvals for projects in areas with multiple watch reports

ALERT FLAGS (always mention explicitly in description if triggered):
- Buyer is an LLC or corporate entity (flag the entity name)
- Same buyer in 3+ transactions within 90 days in same area (bulk purchase threshold)
- Annexation filing affects area with existing housing violation/displacement watch reports
- Zoning change from residential to commercial/industrial near housing complaint clusters

Return ONLY valid JSON — no explanation outside the JSON:
{
  "reports": [
    {
      "report_type": "llc_acquisition_pattern|bulk_purchase_pattern|displacement_risk|annexation_activity|zoning_change_request|property_transfer_cluster|planning_decision_impact",
      "title": "Concise title under 80 chars",
      "summary": "2-3 sentences: what the pattern is, why it matters for residents, which entity is involved if known",
      "affected_areas": ["neighborhood or street"],
      "data_sources": ["Community-submitted land records", "Community watch reports", "EPA ECHO"],
      "ai_confidence": "low|medium|high",
      "flags": {
        "llc_buyer": true|false,
        "bulk_purchase_threshold": true|false,
        "annexation_near_housing_reports": true|false
      }
    }
  ]
}

Rules:
- Only include reports with actual evidence from the submitted data
- high confidence = clear evidence in submitted records; medium = pattern inferred from watch reports; low = speculative
- Max 6 reports per run
- If buyer name ends in LLC, Holdings, Properties, Capital, Ventures, Partners — set llc_buyer: true
- Return {"reports": []} if no meaningful patterns found`;

  let rawResponse;
  try {
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    });
    rawResponse = message.content[0]?.text || '';
    console.log('[land-intel] Claude responded:', rawResponse.slice(0, 200));
  } catch (e) {
    console.error('[land-intel] Claude API call failed:', e.message);
    return;
  }

  let parsed;
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[land-intel] Failed to parse response:', e.message);
    return;
  }

  const reports = parsed.reports || [];
  console.log(`[land-intel] Claude generated ${reports.length} reports`);

  const validConfidences = ['low', 'medium', 'high'];
  let savedCount = 0;

  for (const r of reports) {
    if (!r.report_type || !r.title || !r.summary) continue;
    if (!validConfidences.includes(r.ai_confidence)) r.ai_confidence = 'low';

    const firstArea = (r.affected_areas || [])[0] || null;
    try {
      const existing = await pool.query(
        `SELECT id FROM land_development_reports
         WHERE report_type = $1
           AND ($2 IS NULL OR affected_areas[1] ILIKE $3)
           AND created_at > NOW() - INTERVAL '6 hours'
         LIMIT 1`,
        [r.report_type, firstArea, firstArea ? `%${firstArea}%` : '%']
      );
      if (existing.rows[0]) continue;
    } catch (e) {
      console.error('[land-intel] Dedup check failed:', e.message);
    }

    try {
      await pool.query(
        `INSERT INTO land_development_reports
           (report_type, title, summary, affected_areas, data_sources, ai_confidence, raw_analysis)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          r.report_type,
          r.title.slice(0, 255),
          r.summary,
          r.affected_areas || [],
          r.data_sources || ['Community-submitted land records'],
          r.ai_confidence,
          JSON.stringify(r),
        ]
      );
      savedCount++;
    } catch (e) {
      console.error('[land-intel] Failed to save report:', e.message);
    }
  }

  console.log(`[land-intel] Run complete — saved ${savedCount} new reports`);

  if (savedCount > 0) {
    await crossDashboardCorrelation(reports).catch(e =>
      console.error('[land-intel] Cross-dashboard error:', e.message)
    );
  }
}

async function crossDashboardCorrelation(landReports) {
  const displacementTypes = [
    'displacement_risk', 'llc_acquisition_pattern',
    'bulk_purchase_pattern', 'property_transfer_cluster',
  ];

  for (const r of landReports) {
    if (!displacementTypes.includes(r.report_type)) continue;
    const area = (r.affected_areas || [])[0];
    if (!area) continue;

    const areaKey = area.split(',')[0].trim();
    if (areaKey.length < 4) continue;

    const housingResult = await pool.query(
      `SELECT id FROM watch_reports
       WHERE dashboard_type IN ('housing','health')
         AND location_label ILIKE $1
         AND created_at > NOW() - INTERVAL '90 days'
       LIMIT 5`,
      [`%${areaKey}%`]
    );
    if (housingResult.rows.length < 2) continue;

    const dupeCheck = await pool.query(
      `SELECT id FROM watch_anomalies
       WHERE anomaly_type = 'cross_dashboard'
         AND location_label ILIKE $1
         AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [`%${areaKey}%`]
    );
    if (dupeCheck.rows[0]) continue;

    const typeLabel = r.report_type.replace(/_/g, ' ');
    await pool.query(
      `INSERT INTO watch_anomalies
         (anomaly_type, description, affected_reports, severity,
          dashboard_types, location_label, ai_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'cross_dashboard',
        `Land development intelligence detected ${typeLabel} activity in ${area}. ${housingResult.rows.length} housing/health community reports in the same area suggest potential displacement pressure — residents may be experiencing impacts before formal development begins.`,
        housingResult.rows.map(row => row.id),
        'serious',
        ['housing', 'land_development'],
        area,
        r.ai_confidence,
      ]
    );
    console.log(`[land-intel] Created cross-dashboard anomaly for ${area}`);
  }
}

module.exports = { runLandIntelligence };
