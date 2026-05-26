const https = require('https');

// Read at call time, not module load time — avoids stale captures when PM2 passes
// a cached env snapshot that predates the .env update.
function getConfig() {
  return {
    apiKey:      process.env.BREVO_API_KEY || '',
    senderEmail: process.env.BREVO_SENDER_EMAIL || 'noreply@mycelium.unprecedentedtimes.org',
    senderName:  'Mycelium',
    baseUrl:     process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org',
  };
}

function sendEmail({ to, subject, html }) {
  const { apiKey, senderEmail, senderName } = getConfig();

  console.log(`[email] sendEmail called — to=${to} subject="${subject}"`);
  console.log(`[email] BREVO_API_KEY present: ${!!apiKey} length: ${apiKey.length}`);

  if (!apiKey) {
    console.log('[email] BREVO_API_KEY is empty — skipping Brevo send');
    return Promise.resolve();
  }

  const body = JSON.stringify({
    sender:      { name: senderName, email: senderEmail },
    to:          [{ email: to }],
    subject,
    htmlContent: html,
  });

  console.log(`[email] Sending via Brevo API — sender=${senderEmail} to=${to}`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers:  {
        'api-key':        apiKey,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        console.log(`[email] Brevo response status: ${res.statusCode}`);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('[email] Brevo send successful');
          resolve();
        } else {
          console.error(`[email] Brevo error ${res.statusCode}:`, data);
          reject(new Error(`Email send failed (${res.statusCode}): ${data}`));
        }
      });
    });
    req.on('error', err => {
      console.error('[email] https request error:', err.message);
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

function invitationEmail({ inviterName, inviteToken, personalNote, toEmail }) {
  const { baseUrl } = getConfig();
  const link = `${baseUrl}/invite/${inviteToken}`;
  console.log(`[email] invitationEmail — inviter=${inviterName} token=${inviteToken} to=${toEmail}`);

  const noteHtml = personalNote
    ? `<div style="margin:24px 0;padding:16px 20px;background:#eaf3e4;border-left:4px solid #2a5f0a;border-radius:6px;font-style:italic;color:#2a3a1a;">${personalNote}</div>`
    : '';

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#2a5f0a;padding:32px 40px;text-align:center;">
      <p style="color:#c8e6b0;font-size:13px;margin:0 0 8px;letter-spacing:.08em;text-transform:uppercase;">⬡ Mycelium</p>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">You've been invited</h1>
    </div>
    <div style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1710;margin:0 0 8px;">
        <strong>${inviterName}</strong> has invited you to join Mycelium — a community platform for mutual aid, needs, and offers in Huntsville, Alabama.
      </p>
      ${noteHtml}
      <div style="margin:28px 0;padding:20px;background:#faf8f4;border-radius:8px;border:1px solid #ddd6c8;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#6b6254;text-transform:uppercase;letter-spacing:.06em;">The Mycelium Covenant</p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1a1710;line-height:1.7;">
          <li>Show up with integrity — your word matters here</li>
          <li>Give more than you take</li>
          <li>Keep it family-friendly and safe for everyone</li>
          <li>Respect the humans behind every post</li>
          <li>Protect the network — report what feels wrong</li>
        </ul>
      </div>
      <div style="text-align:center;margin:32px 0 24px;">
        <a href="${link}" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">Accept Invitation</a>
      </div>
      <p style="font-size:12px;color:#6b6254;text-align:center;margin:0;">
        Or copy this link: <a href="${link}" style="color:#2a5f0a;">${link}</a><br>
        This invitation expires in 14 days.
      </p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({ to: toEmail, subject: `${inviterName} has invited you to join Mycelium`, html });
}

module.exports = { sendEmail, invitationEmail };
