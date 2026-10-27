import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one } from '../db.js';

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.appSecret, { expiresIn: config.jwtExpiresIn });
}

export async function userFromToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.appSecret);
    const u = await one('SELECT id, name, email, role, is_active FROM users WHERE id = ?', [p.sub]);
    return u && u.is_active ? u : null;
  } catch {
    return null;
  }
}

const GUEST_RE = /^[a-zA-Z0-9-]{8,48}$/;

// Attaches req.user (or null) and req.ownerKey ("u:<id>" or "g:<guestId>") for every request.
export async function identify(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  req.user = await userFromToken(token);
  const guest = String(req.headers['x-guest-id'] || '');
  req.guestId = GUEST_RE.test(guest) ? guest : null;
  req.ownerKey = req.user ? `u:${req.user.id}` : req.guestId ? `g:${req.guestId}` : null;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });
  next();
}

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
