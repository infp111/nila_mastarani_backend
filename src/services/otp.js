import crypto from 'node:crypto';
import { query, one } from '../db.js';
import { hmac } from '../crypto.js';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SEC = 45;

export async function createOtp(email, purpose, pendingName = null) {
  const recent = await one(
    "SELECT created_at FROM otp_codes WHERE email = ? AND purpose = ? AND created_at > datetime('now', ?) ORDER BY id DESC LIMIT 1",
    [email, purpose, `-${RESEND_COOLDOWN_SEC} seconds`]
  );
  if (recent) {
    const err = new Error(`Please wait ${RESEND_COOLDOWN_SEC} seconds before requesting another code.`);
    err.status = 429;
    throw err;
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  // invalidate older codes
  await query('UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE email = ? AND purpose = ? AND consumed_at IS NULL', [email, purpose]);
  await query(
    "INSERT INTO otp_codes (email, purpose, code_hash, pending_name, expires_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
    [email, purpose, hmac(`${email}:${purpose}:${code}`), pendingName, `+${TTL_MIN} minutes`]
  );
  return code;
}

// Returns the otp row on success, throws on failure.
export async function verifyOtp(email, purpose, code) {
  const row = await one(
    'SELECT * FROM otp_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY id DESC LIMIT 1',
    [email, purpose]
  );
  const fail = (m) => { const e = new Error(m); e.status = 400; return e; };
  if (!row) throw fail('Code expired or not found. Please request a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw fail('Too many wrong attempts. Please request a new code.');
  const ok = crypto.timingSafeEqual(
    Buffer.from(row.code_hash), Buffer.from(hmac(`${email}:${purpose}:${String(code).trim()}`))
  );
  if (!ok) {
    await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw fail('Incorrect code.');
  }
  await query('UPDATE otp_codes SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
  return row;
}
