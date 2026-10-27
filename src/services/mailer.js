import nodemailer from 'nodemailer';
import { getSettings } from './settings.js';

const MAIL_KEYS = ['mail_from_email', 'mail_from_name', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'app_name', 'otp_subject'];

async function transport(overrides = {}) {
  const s = { ...(await getSettings(MAIL_KEYS)), ...overrides };
  if (!s.smtp_host || !s.smtp_user || !s.smtp_pass) {
    throw new Error('Mail is not configured. Set SMTP host, user and app password in Admin > Mail settings.');
  }
  const t = nodemailer.createTransport({
    host: s.smtp_host,
    port: Number(s.smtp_port || 465),
    secure: String(s.smtp_secure) === 'true',
    auth: { user: s.smtp_user, pass: s.smtp_pass },
  });
  return { t, s };
}

export async function sendMail({ to, subject, text, html }, overrides) {
  const { t, s } = await transport(overrides);
  return t.sendMail({
    from: `"${s.mail_from_name || s.app_name}" <${s.mail_from_email || s.smtp_user}>`,
    to, subject, text, html,
  });
}

export async function verifyMailSettings(overrides) {
  const { t } = await transport(overrides);
  await t.verify();
  return true;
}

export async function sendOtpMail(to, name, code, purpose) {
  const s = await getSettings(['app_name', 'otp_subject']);
  const app = s.app_name || 'Kathai';
  const action = purpose === 'signup' ? 'confirm your sign-up' : 'sign in';
  const text = `Namaskar ${name || ''},\n\nYour ${app} code to ${action} is: ${code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.\n\n— Team ${app}`;
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
    <h2 style="color:#e8590c;margin:0 0 8px">${app}</h2>
    <p>ନମସ୍କାର ${escapeHtml(name || '')},</p>
    <p>Your code to ${action}:</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:16px 0">${code}</p>
    <p style="color:#666;font-size:13px">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
  </div>`;
  return sendMail({ to, subject: s.otp_subject || `Your ${app} code`, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
