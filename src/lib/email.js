const nodemailer = require('nodemailer');

function createTransport() {
  return nodemailer.createTransport({
    host:   process.env.MAIL_HOST || 'smtp-relay.brevo.com',
    port:   parseInt(process.env.MAIL_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.MAIL_USER,
      pass: process.env.MAIL_PASS,
    },
  });
}

function sendEmail({ to, subject, html }) {
  const from    = process.env.MAIL_FROM || 'noreply@mycelium.unprecedentedtimes.org';
  const host    = process.env.MAIL_HOST;
  const user    = process.env.MAIL_USER;

  console.log(`[email] sendEmail — to=${to} subject="${subject}"`);
  console.log(`[email] MAIL_HOST=${host} MAIL_USER=${user} MAIL_FROM=${from}`);

  if (!user || !process.env.MAIL_PASS) {
    console.warn('[email] MAIL_USER or MAIL_PASS missing — skipping send');
    return Promise.resolve();
  }

  const transporter = createTransport();

  return transporter.sendMail({ from, to, subject, html })
    .then(info => {
      console.log('[email] sent OK — messageId:', info.messageId);
    })
    .catch(err => {
      console.error('[email] send failed:', err.message);
      throw err;
    });
}

function invitationEmail({ inviterName, inviteToken, personalNote, toEmail }) {
  const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
  const link    = `${baseUrl}/invite/${inviteToken}`;
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
      <p style="color:#c8e6b0;font-size:13px;margin:0 0 8px;letter-spacing:.08em;text-transform:uppercase;">&#x2B21; Mycelium</p>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">You've been invited</h1>
    </div>
    <div style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1710;margin:0 0 8px;">
        <strong>${inviterName}</strong> has invited you to join Mycelium &mdash; a community platform for mutual aid, needs, and offers in Huntsville, Alabama.
      </p>
      ${noteHtml}
      <div style="margin:28px 0;padding:20px;background:#faf8f4;border-radius:8px;border:1px solid #ddd6c8;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#6b6254;text-transform:uppercase;letter-spacing:.06em;">The Mycelium Covenant</p>
        <ul style="margin:0;padding-left:20px;font-size:14px;color:#1a1710;line-height:1.7;">
          <li>Show up with integrity &mdash; your word matters here</li>
          <li>Give more than you take</li>
          <li>Keep it family-friendly and safe for everyone</li>
          <li>Respect the humans behind every post</li>
          <li>Protect the network &mdash; report what feels wrong</li>
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

function welcomeBackEmail({ username, toEmail }) {
  const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
  console.log(`[email] welcomeBackEmail — username=${username} to=${toEmail}`);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#2a5f0a;padding:32px 40px;text-align:center;">
      <p style="color:#c8e6b0;font-size:13px;margin:0 0 8px;letter-spacing:.08em;text-transform:uppercase;">&#x2B21; Mycelium</p>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Welcome back</h1>
    </div>
    <div style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1710;margin:0 0 16px;">
        Welcome back, <strong>${username}</strong>. Your account has been restored.
      </p>
      <p style="font-size:14px;color:#6b6254;margin:0 0 28px;">
        Your posts and community history are intact. The chain grows.
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${baseUrl}" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">Go to Mycelium</a>
      </div>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({ to: toEmail, subject: 'Welcome back to Mycelium', html });
}

function emailChangeVerification({ username, newEmail, changeToken, toEmail }) {
  const baseUrl = process.env.APP_BASE_URL || 'https://mycelium.unprecedentedtimes.org';
  const link    = `${baseUrl}/verify-email?token=${changeToken}`;
  console.log(`[email] emailChangeVerification — username=${username} to=${toEmail}`);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f2ede4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #ddd6c8;">
    <div style="background:#2a5f0a;padding:32px 40px;text-align:center;">
      <p style="color:#c8e6b0;font-size:13px;margin:0 0 8px;letter-spacing:.08em;text-transform:uppercase;">&#x2B21; Mycelium</p>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:700;">Confirm your new email</h1>
    </div>
    <div style="padding:36px 40px;">
      <p style="font-size:16px;color:#1a1710;margin:0 0 16px;">
        Hi <strong>${username}</strong>, click the button below to confirm <strong>${newEmail}</strong> as your new Mycelium email address.
      </p>
      <p style="font-size:14px;color:#6b6254;margin:0 0 28px;">
        If you didn't request this change, you can safely ignore this email.
        This link expires in 24 hours.
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${link}" style="display:inline-block;background:#2a5f0a;color:#fff;text-decoration:none;padding:14px 36px;border-radius:99px;font-size:15px;font-weight:700;">Confirm New Email</a>
      </div>
      <p style="font-size:12px;color:#6b6254;text-align:center;margin:0;">
        Or copy: <a href="${link}" style="color:#2a5f0a;">${link}</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  return sendEmail({ to: toEmail, subject: 'Confirm your new Mycelium email address', html });
}

module.exports = { sendEmail, invitationEmail, welcomeBackEmail, emailChangeVerification };
