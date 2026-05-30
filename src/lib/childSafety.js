/**
 * Child Safety Protection Layer
 *
 * Layer 1: File hash checking against known CSAM signatures (PhotoDNA-style)
 * Layer 2: AI pattern detection for grooming / child exploitation language
 *
 * EXEMPT routes (Advocate and Legislature): AI text scanning only.
 * Hash checking applies to ALL image uploads with NO exceptions.
 *
 * NCMEC CyberTipline API integration: pending API key setup.
 * See NCMEC_API_KEY in .env. Manual submission process documented below.
 */

const crypto   = require('crypto');
const pool     = require('../db');
const { sendEmail } = require('./email');
const Anthropic = require('@anthropic-ai/sdk');

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || 'aliciambh82@protonmail.com';
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const anthropic      = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;

// ── Local known-hash list ────────────────────────────────────────────────────
// Format: SHA-256 hex strings. Populated from NCMEC or other trusted sources.
// Update this list by adding hashes from verified CSAM databases.
// When NCMEC_API_KEY is configured, replace this with a live API lookup.
const KNOWN_CSAM_HASHES = new Set([
  // Placeholder — replace with actual hashes from NCMEC hash-sharing program
  // https://www.missingkids.org/gethelpnow/cybertipline
]);

/**
 * Compute SHA-256 hash of a file buffer and check against known CSAM hashes.
 * Returns { matched: boolean, hash: string }
 */
function checkFileHash(buffer) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return { matched: KNOWN_CSAM_HASHES.has(hash), hash };
}

/**
 * Handle a confirmed CSAM hash match.
 * Logs to DB, sends admin email alert, returns the report record.
 */
async function handleCsamMatch({ userId, fileHash, ipAddress, route }) {
  console.error(`[CSAM] Hash match detected — user=${userId} hash=${fileHash} ip=${ipAddress} route=${route}`);

  let report;
  try {
    const r = await pool.query(
      `INSERT INTO csam_reports (user_id, file_hash, ip_address, action_taken, route)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId || null, fileHash, ipAddress || null, 'file_deleted_upload_blocked', route || null]
    );
    report = r.rows[0];
  } catch (e) {
    console.error('[CSAM] Failed to insert csam_report:', e.message);
  }

  // Alert admin immediately
  try {
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: '🚨 CSAM HASH MATCH DETECTED — Immediate Action Required',
      html: `
        <h2 style="color:#c00">CSAM Hash Match — Upload Blocked</h2>
        <p>A file upload matched a known CSAM hash signature and was immediately deleted.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0"><strong>Report ID:</strong></td><td>${report?.id || 'see DB'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>User ID:</strong></td><td>${userId || 'anonymous'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>File Hash:</strong></td><td style="font-family:monospace">${fileHash}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>IP Address:</strong></td><td>${ipAddress || 'unknown'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Route:</strong></td><td>${route || 'unknown'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Time:</strong></td><td>${new Date().toISOString()}</td></tr>
        </table>
        <hr>
        <p><strong>Required actions:</strong></p>
        <ol>
          <li>Review the csam_reports table in the database</li>
          <li>Submit a CyberTipline report to NCMEC at https://www.missingkids.org/gethelpnow/cybertipline</li>
          <li>Consider account suspension for the user</li>
        </ol>
        <p style="color:#666;font-size:12px">This is an automated alert from Mycelium platform child safety systems.</p>
      `,
    });
  } catch (e) {
    console.error('[CSAM] Admin email failed:', e.message);
  }

  return report;
}

/**
 * Run CSAM hash check on an uploaded file buffer.
 * Call this BEFORE any file storage.
 * Returns { safe: boolean } — if safe is false, delete the file and block the upload.
 */
async function checkUploadedFile({ buffer, userId, ipAddress, route }) {
  const { matched, hash } = checkFileHash(buffer);
  if (!matched) return { safe: true, hash };

  await handleCsamMatch({ userId, fileHash: hash, ipAddress, route });
  return { safe: false, hash };
}

// ── AI content scanning ──────────────────────────────────────────────────────

const SCAN_PROMPT = `You are a child safety content moderator. Analyze the following user-generated content for:
1. Grooming language patterns (building trust/secrecy with a minor, requesting contact info)
2. Content that sexualizes minors in any way
3. Suspicious adult-to-minor contact patterns
4. Requests for a minor's location, school, schedule, or identifying information
5. Offers of gifts, money, or special attention targeting apparent minors

Respond with JSON only. Format:
{
  "flagged": boolean,
  "reason": "brief reason if flagged, null if not",
  "confidence": "high|medium|low",
  "category": "grooming|sexualization|contact_pattern|location_request|enticement|none"
}

Be conservative — flag anything that raises genuine concern. False positives are reviewed by a human moderator.`;

/**
 * Scan text content for child safety violations using Claude AI.
 * Returns { flagged, reason, confidence, category }
 */
async function scanContent(text) {
  if (!anthropic || !text?.trim()) return { flagged: false };
  if (text.length < 10) return { flagged: false };

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [
        { role: 'user', content: `${SCAN_PROMPT}\n\nContent to analyze:\n${text.slice(0, 3000)}` },
      ],
    });
    const raw = msg.content[0]?.text?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/^```json\n?|```$/g, '').trim());
    return parsed;
  } catch (e) {
    console.error('[childSafety] AI scan error:', e.message);
    return { flagged: false };
  }
}

/**
 * Flag content in the safety_flags table and alert admin.
 */
async function recordSafetyFlag({ contentType, contentId, userId, reason, detail, confidence }) {
  console.warn(`[childSafety] Safety flag — type=${contentType} id=${contentId} reason=${reason}`);

  let flag;
  try {
    const r = await pool.query(
      `INSERT INTO safety_flags (content_type, content_id, user_id, flag_reason, flag_detail, ai_confidence)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [contentType, String(contentId), userId || null, reason, detail || null, confidence || null]
    );
    flag = r.rows[0];
  } catch (e) {
    console.error('[childSafety] Failed to insert safety_flag:', e.message);
    return;
  }

  try {
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: '⚠️ Child Safety Flag — Content Review Required',
      html: `
        <h2 style="color:#c60">Child Safety Flag — Pending Review</h2>
        <p>AI content scanning has flagged content for child safety review.</p>
        <table style="border-collapse:collapse;font-size:14px">
          <tr><td style="padding:4px 12px 4px 0"><strong>Flag ID:</strong></td><td>${flag?.id || 'see DB'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Content Type:</strong></td><td>${contentType}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Content ID:</strong></td><td>${contentId}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>User ID:</strong></td><td>${userId || 'unknown'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Reason:</strong></td><td>${reason}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Confidence:</strong></td><td>${confidence || 'unknown'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Detail:</strong></td><td>${detail || 'none'}</td></tr>
          <tr><td style="padding:4px 12px 4px 0"><strong>Time:</strong></td><td>${new Date().toISOString()}</td></tr>
        </table>
        <p>Review in the admin panel under <strong>Child Safety</strong> tab.</p>
      `,
    });
  } catch (e) {
    console.error('[childSafety] Admin email failed:', e.message);
  }

  return flag;
}

/**
 * Scan text and record a flag if needed.
 * contentType: 'post' | 'message' | 'profile'
 */
async function scanAndFlag({ text, contentType, contentId, userId }) {
  const result = await scanContent(text);
  if (!result?.flagged) return;

  await recordSafetyFlag({
    contentType,
    contentId,
    userId,
    reason: result.category || 'child_safety_concern',
    detail: result.reason,
    confidence: result.confidence,
  });
}

module.exports = { checkUploadedFile, scanAndFlag, recordSafetyFlag };
