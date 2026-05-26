const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');
const { sendEmail } = require('./email');

const SENSITIVE_LOCATIONS = [
  { name: 'Huntsville Hospital',           lat: 34.7361, lng: -86.5836 },
  { name: 'UAB Huntsville Hospital',        lat: 34.6894, lng: -86.5867 },
  { name: 'Crestwood Medical Center',       lat: 34.6978, lng: -86.5478 },
  { name: 'Lee High School',                lat: 34.6915, lng: -86.5825 },
  { name: 'Johnson High School',            lat: 34.7612, lng: -86.5551 },
  { name: 'Chapman Middle School',          lat: 34.7498, lng: -86.5668 },
  { name: 'Grissom High School',            lat: 34.7749, lng: -86.6399 },
  { name: 'Columbia High School',           lat: 34.8008, lng: -86.7187 },
  { name: 'Huntsville City Schools HQ',     lat: 34.7282, lng: -86.5957 },
  { name: 'Madison Academy',               lat: 34.7259, lng: -86.7481 },
  { name: 'Whitesburg Bridge',             lat: 34.7162, lng: -86.5627 },
  { name: 'US-72 Bridge (Tennessee River)', lat: 34.7380, lng: -86.5844 },
  { name: "Governor's Drive Bridge",        lat: 34.7072, lng: -86.5826 },
  { name: 'Ditto Landing / Tennessee River',lat: 34.6668, lng: -86.5622 },
  { name: 'Monte Sano State Park',          lat: 34.7431, lng: -86.5284 },
  { name: 'Redstone Arsenal boundary',      lat: 34.6795, lng: -86.6517 },
];

async function runAnomalyDetection() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[anomaly] ANTHROPIC_API_KEY not set — skipping detection run');
    return;
  }

  console.log('[anomaly] Starting detection run…');

  let reports;
  try {
    const result = await pool.query(
      `SELECT id, dashboard_type, title, description, location_label,
              location_lat, location_lng, severity, report_type, created_at
       FROM watch_reports
       WHERE created_at > NOW() - INTERVAL '60 days'
       ORDER BY created_at DESC
       LIMIT 200`
    );
    reports = result.rows;
  } catch (e) {
    console.error('[anomaly] DB fetch failed:', e.message);
    return;
  }

  if (reports.length < 3) {
    console.log('[anomaly] Too few reports to analyze, skipping');
    return;
  }

  const client = new Anthropic({ apiKey });

  const prompt = `You are a community safety analyst for Huntsville, Alabama. Analyze these community watch reports and identify concerning patterns.

Look for:
1. LOCATION CLUSTERS: 3+ reports within roughly 0.5 miles of each other across any dashboards
2. SEVERITY ESCALATION: Same area with reports of increasing severity over time
3. CROSS_DASHBOARD: Infrastructure reports near health clusters; environmental reports near housing violations
4. TEMPORAL_PATTERN: Unusual spike (5+ reports) in any 7-day window
5. SENSITIVE_LOCATION: Any report within 0.5 miles of: ${SENSITIVE_LOCATIONS.map(l => l.name).join(', ')}

Reports (JSON):
${JSON.stringify(reports, null, 2)}

Return ONLY a valid JSON object. No explanation outside the JSON.
{
  "anomalies": [
    {
      "anomaly_type": "location_cluster|severity_escalation|cross_dashboard|temporal_pattern|sensitive_location",
      "description": "Plain-language description of the pattern and why it matters",
      "affected_report_ids": ["<uuid>"],
      "severity": "critical|serious|moderate|minor|monitoring",
      "dashboard_types": ["<dashboard>"],
      "location_label": "<area name or null>",
      "ai_confidence": "low|medium|high"
    }
  ]
}

Rules:
- Only include anomalies with at least 2 affected reports
- Severity "critical" = imminent threat to health/safety
- Severity "serious" = significant concern requiring prompt attention
- Be conservative: only flag real patterns, not coincidences
- ai_confidence "high" = clear data evidence; "medium" = plausible pattern; "low" = speculative
- Return {"anomalies": []} if no real patterns found`;

  let rawResponse;
  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    rawResponse = message.content[0]?.text || '';
    console.log('[anomaly] Claude responded:', rawResponse.slice(0, 200));
  } catch (e) {
    console.error('[anomaly] Claude API call failed:', e.message);
    return;
  }

  let parsed;
  try {
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[anomaly] Failed to parse Claude response:', e.message);
    return;
  }

  const newAnomalies = parsed.anomalies || [];
  console.log(`[anomaly] Claude identified ${newAnomalies.length} anomalies`);

  let savedCount = 0;
  for (const a of newAnomalies) {
    if (!a.anomaly_type || !a.description || !Array.isArray(a.affected_report_ids) || a.affected_report_ids.length < 2) continue;

    const validSeverities = ['critical','serious','moderate','minor','monitoring'];
    const validConfidences = ['low','medium','high'];
    if (!validSeverities.includes(a.severity)) a.severity = 'moderate';
    if (!validConfidences.includes(a.ai_confidence)) a.ai_confidence = 'low';

    // Deduplicate: skip if identical anomaly_type + same location_label exists in last 48h
    try {
      const existing = await pool.query(
        `SELECT id FROM watch_anomalies
         WHERE anomaly_type = $1
           AND location_label IS NOT DISTINCT FROM $2
           AND created_at > NOW() - INTERVAL '48 hours'
         LIMIT 1`,
        [a.anomaly_type, a.location_label || null]
      );
      if (existing.rows[0]) continue;
    } catch (e) {
      console.error('[anomaly] Dedup check failed:', e.message);
    }

    try {
      const validIds = a.affected_report_ids.filter(id =>
        typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
      );

      await pool.query(
        `INSERT INTO watch_anomalies
           (anomaly_type, description, affected_reports, severity, dashboard_types, location_label, ai_confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          a.anomaly_type,
          a.description,
          validIds,
          a.severity,
          Array.isArray(a.dashboard_types) ? a.dashboard_types : [],
          a.location_label || null,
          a.ai_confidence,
        ]
      );
      savedCount++;

      // Email admin for high confidence anomalies
      if (a.ai_confidence === 'high') {
        sendAdminAnomalyAlert(a).catch(e => console.error('[anomaly] alert email failed:', e.message));
      }
    } catch (e) {
      console.error('[anomaly] Failed to save anomaly:', e.message);
    }
  }

  console.log(`[anomaly] Run complete — saved ${savedCount} new anomalies`);
}

async function sendAdminAnomalyAlert(anomaly) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
  const severityColors = {
    critical: '#dc2626', serious: '#ea580c',
    moderate: '#ca8a04', minor: '#2563eb', monitoring: '#6b7280',
  };
  const color = severityColors[anomaly.severity] || '#6b7280';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#1a1710;padding:24px 32px;">
      <p style="color:#c8e6b0;font-size:12px;margin:0 0 6px;letter-spacing:.08em;text-transform:uppercase;">⬡ Mycelium Watch — AI Anomaly Alert</p>
      <h1 style="color:#fff;margin:0;font-size:18px;">High-Confidence Anomaly Detected</h1>
    </div>
    <div style="padding:28px 32px;">
      <div style="display:inline-block;padding:.25rem .75rem;border-radius:99px;background:${color}22;color:${color};font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border:1px solid ${color};margin-bottom:16px;">
        ${anomaly.severity} · ${anomaly.anomaly_type.replace('_',' ')}
      </div>
      <p style="font-size:15px;color:#1a1710;margin:0 0 16px;">${anomaly.description}</p>
      <table style="font-size:13px;color:#6b6254;border-collapse:collapse;width:100%;">
        ${anomaly.location_label ? `<tr><td style="padding:4px 0;font-weight:600;width:130px;">Location</td><td>${anomaly.location_label}</td></tr>` : ''}
        <tr><td style="padding:4px 0;font-weight:600;">Dashboards</td><td>${(anomaly.dashboard_types||[]).join(', ') || '—'}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">Reports involved</td><td>${anomaly.affected_report_ids?.length || 0}</td></tr>
        <tr><td style="padding:4px 0;font-weight:600;">AI Confidence</td><td>${anomaly.ai_confidence}</td></tr>
      </table>
      <div style="text-align:center;margin:24px 0 0;">
        <a href="${baseUrl}/watch" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:99px;font-size:14px;font-weight:700;">Review in Admin</a>
      </div>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({
    to: adminEmail,
    subject: `[Mycelium Watch] ${anomaly.severity.toUpperCase()} anomaly detected — ${anomaly.anomaly_type}`,
    html,
  });
}

module.exports = { runAnomalyDetection };
