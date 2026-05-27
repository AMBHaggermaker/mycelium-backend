const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const LAND_INTEL_PROMPT = `You are a land development intelligence analyst for Huntsville, Alabama and Madison County. Analyze community reports to identify land development patterns that may affect residents, particularly displacement risks and corporate land acquisition activity.

Community reports (last 90 days):
{REPORTS}

Based on these community reports and your knowledge of Huntsville/Madison County development patterns, generate land development intelligence reports. Look for:

1. DISPLACEMENT_RISK — housing code violations + civic rezoning in the same area suggest displacement pressure
2. LLC_ACQUISITION_PATTERN — clustering of housing issues suggesting bulk corporate buying
3. ZONING_CHANGE_REQUEST — civic reports mentioning rezoning near residential areas
4. ANNEXATION_ACTIVITY — civic reports about annexation filings
5. BULK_PURCHASE_PATTERN — area has 3+ housing reports of different types suggesting multiple buyers
6. AGRICULTURAL_CONVERSION — rural area reports suggesting farmland development pressure
7. PROPERTY_TRANSFER_CLUSTER — multiple housing/civic reports in same small area within 60 days

Huntsville context:
- Historically vulnerable neighborhoods: Lincoln Mill, Five Points, North Huntsville, Lowe Mill corridor
- Active growth corridors: Cummings Research Park, Highway 72 west, Airport Road SE, I-565 corridor
- Redstone Arsenal expansion drives displacement north and west

Return ONLY valid JSON:
{
  "reports": [
    {
      "report_type": "displacement_risk|llc_acquisition_pattern|zoning_change_request|annexation_activity|bulk_purchase_pattern|agricultural_conversion|property_transfer_cluster",
      "title": "Brief title under 70 chars",
      "summary": "1-2 sentences: what the pattern is and why it matters for residents",
      "affected_areas": ["neighborhood or street name"],
      "data_sources": ["Community watch reports", "Madison County public records context"],
      "ai_confidence": "low|medium|high"
    }
  ]
}

Rules:
- Only include patterns with genuine evidence from the community data
- high = clear evidence in reports; medium = plausible inference; low = speculative
- Maximum 5 reports
- Return {"reports": []} if no meaningful patterns found`;

async function runLandIntelligence() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[land-intel] ANTHROPIC_API_KEY not set — skipping');
    return;
  }

  console.log('[land-intel] Starting land intelligence run…');

  let communityReports;
  try {
    const result = await pool.query(
      `SELECT id, dashboard_type, title, description, location_label,
              severity, report_type, created_at
       FROM watch_reports
       WHERE dashboard_type IN ('housing','civic','environment','health','land_development')
         AND created_at > NOW() - INTERVAL '90 days'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    communityReports = result.rows;
  } catch (e) {
    console.error('[land-intel] DB fetch failed:', e.message);
    return;
  }

  if (communityReports.length < 2) {
    console.log('[land-intel] Too few reports to analyze, skipping');
    return;
  }

  const client = new Anthropic({ apiKey });
  const prompt = LAND_INTEL_PROMPT.replace('{REPORTS}', JSON.stringify(communityReports, null, 2));

  let rawResponse;
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
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
          r.data_sources || ['Community watch reports analysis'],
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
      console.error('[land-intel] Cross-dashboard correlation error:', e.message)
    );
  }
}

async function crossDashboardCorrelation(landReports) {
  const displacementTypes = ['displacement_risk', 'llc_acquisition_pattern', 'bulk_purchase_pattern', 'property_transfer_cluster'];

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

    const affectedIds = housingResult.rows.map(row => row.id);
    const typeLabel = r.report_type.replace(/_/g, ' ');

    await pool.query(
      `INSERT INTO watch_anomalies
         (anomaly_type, description, affected_reports, severity, dashboard_types, location_label, ai_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        'cross_dashboard',
        `Land development intelligence detected ${typeLabel} activity in ${area}. ${housingResult.rows.length} housing/health community reports in the same area suggest potential displacement pressure — residents may be experiencing impacts before formal development begins.`,
        affectedIds,
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
