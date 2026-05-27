const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

const client = new Anthropic();

async function runAdvocateIntelligence() {
  console.log('[advocate-intel] Starting pattern analysis run');

  try {
    // Fetch advocate cases from the past 12 months
    const casesResult = await pool.query(
      `SELECT ac.id, ac.case_type, ac.institution_name, ac.institution_type,
              ac.location_label, ac.incident_date, ac.summary, ac.status,
              u.founding_member, u.verified
       FROM advocate_cases ac
       JOIN users u ON u.id = ac.user_id
       WHERE ac.created_at > NOW() - INTERVAL '12 months'
       ORDER BY ac.institution_name, ac.created_at`
    );

    // Fetch moral injury reports from past 12 months
    const morInjResult = await pool.query(
      `SELECT id, fr_role, institution_name, institution_type, created_at
       FROM moral_injury_reports
       WHERE created_at > NOW() - INTERVAL '12 months'
         AND institution_name IS NOT NULL`
    );

    const cases = casesResult.rows;
    const morInjReports = morInjResult.rows;

    if (cases.length === 0 && morInjReports.length === 0) {
      console.log('[advocate-intel] No cases to analyze');
      return;
    }

    // Group by institution — count weighted complaints (verified founding = 2x)
    const institutionMap = {};

    for (const c of cases) {
      const key = `${c.institution_name}||${c.institution_type}||${c.location_label || ''}`;
      if (!institutionMap[key]) {
        institutionMap[key] = {
          institution_name: c.institution_name,
          institution_type: c.institution_type,
          location_label:   c.location_label || '',
          cases: [],
          verified_count:   0,
          unverified_count: 0,
          weighted_count:   0,
          complaint_types:  new Set(),
        };
      }
      const entry = institutionMap[key];
      entry.cases.push(c);
      entry.complaint_types.add(c.case_type);
      if (c.founding_member || c.verified) {
        entry.verified_count++;
        entry.weighted_count += 2; // verified weighted 2x
      } else {
        entry.unverified_count++;
        entry.weighted_count += 1;
      }
    }

    // Also incorporate moral injury reports for institution patterns
    for (const r of morInjReports) {
      const key = `${r.institution_name}||${r.institution_type || 'hospital'}||`;
      if (!institutionMap[key]) {
        institutionMap[key] = {
          institution_name: r.institution_name,
          institution_type: r.institution_type || 'hospital',
          location_label:   '',
          cases: [],
          verified_count:   0,
          unverified_count: 0,
          weighted_count:   0,
          complaint_types:  new Set(),
        };
      }
      institutionMap[key].unverified_count++;
      institutionMap[key].weighted_count += 1;
      institutionMap[key].complaint_types.add('healthcare_worker_report');
    }

    // Threshold: weighted_count >= 3 within 12 months
    const flagged = Object.values(institutionMap).filter(e => e.weighted_count >= 3);

    if (flagged.length === 0) {
      console.log('[advocate-intel] No institutions meet threshold (weighted ≥ 3)');
      return;
    }

    console.log(`[advocate-intel] ${flagged.length} institution(s) meet threshold`);

    const now = new Date();
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

    for (const entry of flagged) {
      try {
        // Build context for AI (NO case summaries — only metadata to preserve privacy)
        const caseContext = entry.cases.map(c =>
          `Case type: ${c.case_type}, Status: ${c.status}, Date: ${c.incident_date || 'unspecified'}, Verified member: ${c.founding_member || c.verified ? 'yes' : 'no'}`
        ).join('\n');

        const prompt = `You are analyzing institutional complaint patterns for a community advocacy platform. You are NOT analyzing criminal cases — you are identifying patterns that warrant community awareness.

Institution: ${entry.institution_name}
Institution type: ${entry.institution_type}
Location: ${entry.location_label || 'Not specified'}
Total weighted complaint score: ${entry.weighted_count} (verified complaints count 2x)
Verified complaints: ${entry.verified_count}
Unverified complaints: ${entry.unverified_count}
Complaint types: ${[...entry.complaint_types].join(', ')}

Case metadata (no personal details):
${caseContext}

Write a 2-3 sentence pattern summary for the public Patterns page. This will be shown alongside the institution name and complaint counts. It should:
- Acknowledge the pattern without making specific legal accusations
- Note the complaint types and general time frame
- Be measured, factual, and community-focused

Also provide a confidence level: low, medium, or high. High = 2+ verified complaints from founding members. Medium = at least 1 verified + others. Low = all unverified.

Respond as JSON: {"summary": "...", "confidence": "low|medium|high"}`;

        const response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        });

        let summary = '';
        let confidence = 'low';
        try {
          const text = response.content[0].text;
          const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
          summary = parsed.summary || '';
          confidence = ['low','medium','high'].includes(parsed.confidence) ? parsed.confidence : 'low';
        } catch {
          summary = 'Pattern of complaints documented against this institution within the past 12 months.';
          confidence = entry.verified_count >= 2 ? 'high' : entry.verified_count >= 1 ? 'medium' : 'low';
        }

        // Check if a report already exists for this institution in this time window
        const existing = await pool.query(
          `SELECT id FROM advocate_pattern_reports
           WHERE institution_name = $1 AND institution_type = $2
             AND time_period_start > NOW() - INTERVAL '7 days'`,
          [entry.institution_name, entry.institution_type]
        );

        if (existing.rows[0]) {
          // Update existing report
          await pool.query(
            `UPDATE advocate_pattern_reports SET
               complaint_types     = $1,
               total_complaints    = $2,
               verified_complaints = $3,
               unverified_complaints = $4,
               time_period_end     = $5,
               ai_summary          = $6,
               ai_confidence       = $7,
               created_at          = NOW()
             WHERE id = $8`,
            [
              [...entry.complaint_types],
              entry.verified_count + entry.unverified_count,
              entry.verified_count,
              entry.unverified_count,
              now.toISOString().slice(0,10),
              summary,
              confidence,
              existing.rows[0].id,
            ]
          );
        } else {
          await pool.query(
            `INSERT INTO advocate_pattern_reports
               (institution_name, institution_type, location_label, complaint_types,
                total_complaints, verified_complaints, unverified_complaints,
                time_period_start, time_period_end, ai_summary, ai_confidence)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              entry.institution_name,
              entry.institution_type,
              entry.location_label || null,
              [...entry.complaint_types],
              entry.verified_count + entry.unverified_count,
              entry.verified_count,
              entry.unverified_count,
              twelveMonthsAgo.toISOString().slice(0,10),
              now.toISOString().slice(0,10),
              summary,
              confidence,
            ]
          );
        }

        console.log(`[advocate-intel] Processed pattern for: ${entry.institution_name}`);
      } catch (e) {
        console.error(`[advocate-intel] Error processing ${entry.institution_name}:`, e.message);
      }
    }

    console.log('[advocate-intel] Pattern analysis complete');
  } catch (e) {
    console.error('[advocate-intel] Fatal error:', e.message);
    throw e;
  }
}

module.exports = { runAdvocateIntelligence };
