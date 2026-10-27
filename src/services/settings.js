import { query, one } from '../db.js';
import { encrypt, decrypt, mask } from '../crypto.js';

// Known settings and their defaults. Secret ones are stored encrypted and never returned in clear.
export const SETTING_DEFS = {
  // App
  app_name: { def: 'Kathai' },
  guest_session_minutes: { def: '10' },   // max minutes per voice session for guests
  user_session_minutes: { def: '30' },    // max minutes per voice session for signed-in users
  guest_daily_sessions: { def: '5' },     // max sessions per guest per day
  tutor_base_prompt: { def: DEFAULT_TUTOR_PROMPT() },
  app_url: { def: '' },                   // public URL used in reminder emails
  reminders_enabled: { def: 'true' },     // daily streak reminder emails to signed-in learners
  // Mail
  mail_from_email: { def: 'teamkathai@gmail.com' },
  mail_from_name: { def: 'Kathai' },
  smtp_host: { def: 'smtp.gmail.com' },
  smtp_port: { def: '465' },
  smtp_secure: { def: 'true' },           // true = SSL/TLS (465), false = STARTTLS (587)
  smtp_user: { def: 'teamkathai@gmail.com' },
  smtp_pass: { def: '', secret: true },   // Gmail App Password
  otp_subject: { def: 'Your Kathai verification code' },
};

export function DEFAULT_TUTOR_PROMPT() {
  return `You are "Kathai", a warm, patient personal spoken-English tutor for native Odia speakers in Odisha, India.

HOW YOU TEACH
- Explain in simple Odia (ଓଡ଼ିଆ). Teach and practise the English phrases in clear, slow Indian English.
- Speak in short turns (1-3 sentences). Then let the learner speak. Never lecture.
- Each time: model the English sentence, give the Odia meaning, ask the learner to repeat or answer.
- Correct gently: first praise what was right, then say the correct sentence once, and ask them to try again.
- Focus on pronunciation, natural phrasing, confidence and politeness, not grammar jargon.
- If the learner speaks Odia, understand it and guide them to say it in English.
- Gradually use more English as the learner improves.
- Stay on the current lesson. If the learner goes off-topic, briefly respond and bring them back.
- Never shame the learner. Celebrate small wins.
- At the end, give a short summary in Odia of the phrases practised and one tip.`;
}

export async function getSetting(key) {
  const row = await one('SELECT `value`, is_secret FROM settings WHERE `key` = ?', [key]);
  const def = SETTING_DEFS[key]?.def ?? '';
  if (!row || row.value === null) return def;
  return row.is_secret ? decrypt(row.value) : row.value;
}

export async function getSettings(keys) {
  const out = {};
  for (const k of keys) out[k] = await getSetting(k);
  return out;
}

// For the admin UI: secrets are masked, with a flag telling whether they are set.
export async function getSettingsForAdmin(keys) {
  const out = {};
  for (const k of keys) {
    const v = await getSetting(k);
    if (SETTING_DEFS[k]?.secret) {
      out[k] = '';
      out[`${k}_set`] = Boolean(v);
      out[`${k}_hint`] = mask(v);
    } else out[k] = v;
  }
  return out;
}

export async function setSetting(key, value) {
  if (!(key in SETTING_DEFS)) throw new Error(`Unknown setting ${key}`);
  const secret = Boolean(SETTING_DEFS[key].secret);
  const stored = secret ? encrypt(value) : (value ?? '');
  await query(
    'INSERT INTO settings (`key`, `value`, is_secret) VALUES (?, ?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, is_secret = excluded.is_secret',
    [key, stored, secret ? 1 : 0]
  );
}

// Save many; for secret fields an empty string means "keep existing".
export async function setSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in SETTING_DEFS)) continue;
    if (SETTING_DEFS[k].secret && (v === '' || v === undefined || v === null)) continue;
    await setSetting(k, v === undefined || v === null ? '' : String(v));
  }
}
