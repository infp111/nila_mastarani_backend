import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { query, one } from '../db.js';
import { asyncH, signToken, requireUser } from '../middleware/auth.js';
import { createOtp, verifyOtp } from '../services/otp.js';
import { adoptGuestGamification } from '../services/gamify.js';
import { sendOtpMail } from '../services/mailer.js';

const r = Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
r.use(limiter);

const emailSchema = z.string().trim().toLowerCase().email().max(190);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// Merge guest progress into the user's account after sign-in
async function adoptGuest(userId, guestId) {
  if (!guestId || !/^[a-zA-Z0-9-]{8,48}$/.test(guestId)) return;
  const g = `g:${guestId}`, u = `u:${userId}`;
  await query(
    `INSERT INTO progress (owner_key, lesson_id, status, sessions, seconds_practised, last_practised_at)
     SELECT ?, lesson_id, status, sessions, seconds_practised, last_practised_at FROM progress WHERE owner_key = ?
     ON CONFLICT(owner_key, lesson_id) DO UPDATE SET
       sessions = progress.sessions + excluded.sessions,
       seconds_practised = progress.seconds_practised + excluded.seconds_practised,
       status = CASE WHEN excluded.status = 'completed' THEN 'completed' ELSE progress.status END`,
    [u, g]
  );
  await query('DELETE FROM progress WHERE owner_key = ?', [g]);
  await query('UPDATE voice_sessions SET owner_key = ? WHERE owner_key = ?', [u, g]);
  await adoptGuestGamification(u, g);
}

// Step 1 of sign-up: name + email -> OTP
r.post('/signup', asyncH(async (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(120), email: emailSchema }).parse(req.body);
  const existing = await one('SELECT id, email_verified FROM users WHERE email = ?', [body.email]);
  if (existing?.email_verified) return res.status(409).json({ error: 'This email is already registered. Please sign in.', code: 'EXISTS' });
  const code = await createOtp(body.email, 'signup', body.name);
  await sendOtpMail(body.email, body.name, code, 'signup');
  res.json({ ok: true, message: 'We sent a 6-digit code to your email.' });
}));

// Sign-in for existing users: email -> OTP (passwordless)
r.post('/login', asyncH(async (req, res) => {
  const { email } = z.object({ email: emailSchema }).parse(req.body);
  const u = await one('SELECT id, name, email_verified, is_active FROM users WHERE email = ?', [email]);
  if (!u || !u.email_verified) return res.status(404).json({ error: 'No account found with this email. Please sign up.', code: 'NOT_FOUND' });
  if (!u.is_active) return res.status(403).json({ error: 'This account is disabled.' });
  const code = await createOtp(email, 'login');
  await sendOtpMail(email, u.name, code, 'login');
  res.json({ ok: true, message: 'We sent a 6-digit code to your email.' });
}));

// Step 2: verify OTP -> JWT
r.post('/verify', asyncH(async (req, res) => {
  const body = z.object({
    email: emailSchema,
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    purpose: z.enum(['signup', 'login']),
    guestId: z.string().optional(),
  }).parse(req.body);
  const otp = await verifyOtp(body.email, body.purpose, body.code);

  let user = await one('SELECT * FROM users WHERE email = ?', [body.email]);
  if (body.purpose === 'signup') {
    if (!user) {
      const ins = await query('INSERT INTO users (name, email, email_verified) VALUES (?, ?, 1)', [otp.pending_name || body.email.split('@')[0], body.email]);
      user = await one('SELECT * FROM users WHERE id = ?', [ins.insertId]);
    } else {
      await query('UPDATE users SET email_verified = 1, name = COALESCE(?, name) WHERE id = ?', [otp.pending_name, user.id]);
      user = await one('SELECT * FROM users WHERE id = ?', [user.id]);
    }
  }
  if (!user) return res.status(404).json({ error: 'Account not found.' });
  await query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
  await adoptGuest(user.id, body.guestId);
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Admin password login
r.post('/admin-login', asyncH(async (req, res) => {
  const { email, password } = z.object({ email: emailSchema, password: z.string().min(1) }).parse(req.body);
  const u = await one("SELECT * FROM users WHERE email = ? AND role = 'admin' AND is_active = 1", [email]);
  if (!u || !u.password_hash || !(await bcrypt.compare(password, u.password_hash))) {
    return res.status(401).json({ error: 'Invalid admin email or password.' });
  }
  await query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [u.id]);
  res.json({ token: signToken(u), user: publicUser(u) });
}));

r.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

r.patch('/me', requireUser, asyncH(async (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(2).max(120) }).parse(req.body);
  await query('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  res.json({ user: { ...publicUser(req.user), name } });
}));

r.post('/change-password', requireUser, asyncH(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins use passwords.' });
  const { current, next } = z.object({ current: z.string(), next: z.string().min(8) }).parse(req.body);
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(current, u.password_hash || ''))) return res.status(400).json({ error: 'Current password is wrong.' });
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(next, 12), req.user.id]);
  res.json({ ok: true });
}));

export default r;
