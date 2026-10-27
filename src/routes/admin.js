import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, one } from '../db.js';
import { asyncH, requireAdmin } from '../middleware/auth.js';
import { encrypt, decrypt, mask } from '../crypto.js';
import { getSettingsForAdmin, setSettings, SETTING_DEFS } from '../services/settings.js';
import { sendMail, verifyMailSettings } from '../services/mailer.js';
import { PROVIDERS, testEngine } from '../voice/providers/index.js';

const r = Router();
r.use(requireAdmin);

const bool = z.union([z.boolean(), z.number(), z.string()]).transform((v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0));
const parseJson = (v, d = []) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 120) || `course-${Date.now()}`;

// ---------- Dashboard ----------
r.get('/stats', asyncH(async (_req, res) => {
  const [u, c, l, s, g] = await Promise.all([
    one("SELECT COUNT(*) n FROM users WHERE role = 'user'"),
    one('SELECT COUNT(*) n FROM courses'),
    one('SELECT COUNT(*) n FROM lessons'),
    one('SELECT COUNT(*) n, COALESCE(SUM(seconds),0) secs FROM voice_sessions'),
    one("SELECT COUNT(DISTINCT owner_key) n FROM voice_sessions WHERE owner_key LIKE 'g:%'"),
  ]);
  const recent = await query(
    `SELECT v.id, v.owner_key, v.started_at, v.seconds, v.end_reason, l.title lesson, e.name engine, u.name user_name
     FROM voice_sessions v LEFT JOIN lessons l ON l.id = v.lesson_id LEFT JOIN llm_engines e ON e.id = v.engine_id
     LEFT JOIN users u ON v.owner_key = ('u:' || u.id) ORDER BY v.id DESC LIMIT 15`
  );
  const [dau, wau, streaks, xpw] = await Promise.all([
    one("SELECT COUNT(DISTINCT owner_key) n FROM xp_events WHERE day >= date('now')"),
    one("SELECT COUNT(DISTINCT owner_key) n FROM xp_events WHERE day >= date('now', '-6 days')"),
    one('SELECT COUNT(*) n, COALESCE(MAX(streak_current),0) best FROM learner_stats WHERE streak_current >= 3'),
    one("SELECT COALESCE(SUM(xp),0) n FROM xp_events WHERE day >= date('now', '-6 days')"),
  ]);
  res.json({ users: u.n, courses: c.n, lessons: l.n, sessions: s.n, minutes: Math.round(s.secs / 60), guests: g.n, recent,
    engagement: { dau: dau.n, wau: wau.n, streaks3: streaks.n, bestStreak: streaks.best, xpWeek: Number(xpw.n) } });
}));

r.get('/sessions/:id', asyncH(async (req, res) => {
  const s = await one('SELECT * FROM voice_sessions WHERE id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.transcript = parseJson(s.transcript);
  res.json({ session: s });
}));

// ---------- Courses ----------
const courseSchema = z.object({
  title: z.string().trim().min(2).max(160),
  title_odia: z.string().trim().max(200).optional().nullable(),
  slug: z.string().trim().max(140).optional().nullable(),
  description: z.string().optional().nullable(),
  category: z.string().trim().min(1).max(60).default('general'),
  level: z.enum(['beginner', 'intermediate', 'advanced']).default('beginner'),
  icon: z.string().max(16).optional().nullable(),
  engine_id: z.coerce.number().int().positive().optional().nullable().or(z.literal('').transform(() => null)),
  course_instructions: z.string().optional().nullable(),
  sort_order: z.coerce.number().int().default(0),
  is_published: bool.default(0),
});

r.get('/courses', asyncH(async (_req, res) => {
  const courses = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id) AS lesson_count
     FROM courses c ORDER BY c.sort_order, c.id`
  );
  const categories = (await query('SELECT DISTINCT category FROM courses ORDER BY category')).map((x) => x.category);
  res.json({ courses, categories });
}));

r.get('/courses/:id', asyncH(async (req, res) => {
  const course = await one('SELECT * FROM courses WHERE id = ?', [req.params.id]);
  if (!course) return res.status(404).json({ error: 'Not found' });
  const lessons = await query('SELECT * FROM lessons WHERE course_id = ? ORDER BY sort_order, id', [course.id]);
  lessons.forEach((l) => { l.key_phrases = parseJson(l.key_phrases); l.vocabulary = parseJson(l.vocabulary); });
  res.json({ course, lessons });
}));

r.post('/courses', asyncH(async (req, res) => {
  const c = courseSchema.parse(req.body);
  let slug = slugify(c.slug || c.title);
  if (await one('SELECT id FROM courses WHERE slug = ?', [slug])) slug = `${slug}-${Date.now().toString(36)}`;
  const ins = await query(
    `INSERT INTO courses (slug, title, title_odia, description, category, level, icon, engine_id, course_instructions, sort_order, is_published)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [slug, c.title, c.title_odia || null, c.description || null, c.category, c.level, c.icon || null, c.engine_id || null, c.course_instructions || null, c.sort_order, c.is_published]
  );
  res.json({ course: await one('SELECT * FROM courses WHERE id = ?', [ins.insertId]) });
}));

r.put('/courses/:id', asyncH(async (req, res) => {
  const c = courseSchema.parse(req.body);
  const slug = slugify(c.slug || c.title);
  const clash = await one('SELECT id FROM courses WHERE slug = ? AND id <> ?', [slug, req.params.id]);
  if (clash) return res.status(409).json({ error: 'Another course already uses this URL slug.' });
  await query(
    `UPDATE courses SET slug=?, title=?, title_odia=?, description=?, category=?, level=?, icon=?, engine_id=?, course_instructions=?, sort_order=?, is_published=? WHERE id=?`,
    [slug, c.title, c.title_odia || null, c.description || null, c.category, c.level, c.icon || null, c.engine_id || null, c.course_instructions || null, c.sort_order, c.is_published, req.params.id]
  );
  res.json({ course: await one('SELECT * FROM courses WHERE id = ?', [req.params.id]) });
}));

r.delete('/courses/:id', asyncH(async (req, res) => {
  await query('DELETE FROM courses WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

r.post('/courses/reorder', asyncH(async (req, res) => {
  const ids = z.array(z.coerce.number().int()).parse(req.body.ids);
  for (let i = 0; i < ids.length; i++) await query('UPDATE courses SET sort_order = ? WHERE id = ?', [i, ids[i]]);
  res.json({ ok: true });
}));

// ---------- Lessons ----------
const phrase = z.object({ en: z.string().default(''), or: z.string().default(''), note: z.string().optional() });
const lessonSchema = z.object({
  title: z.string().trim().min(2).max(160),
  title_odia: z.string().max(200).optional().nullable(),
  objective: z.string().optional().nullable(),
  key_phrases: z.array(phrase).default([]),
  vocabulary: z.array(phrase).default([]),
  roleplay_scenario: z.string().optional().nullable(),
  tutor_instructions: z.string().optional().nullable(),
  duration_min: z.coerce.number().int().min(1).max(120).default(10),
  sort_order: z.coerce.number().int().optional(),
  is_published: bool.default(1),
});

const cleanPhrases = (arr) => arr.filter((p) => p.en.trim() || p.or.trim());

r.post('/courses/:id/lessons', asyncH(async (req, res) => {
  const l = lessonSchema.parse(req.body);
  const max = await one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM lessons WHERE course_id = ?', [req.params.id]);
  const ins = await query(
    `INSERT INTO lessons (course_id, title, title_odia, objective, key_phrases, vocabulary, roleplay_scenario, tutor_instructions, duration_min, sort_order, is_published)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [req.params.id, l.title, l.title_odia || null, l.objective || null, JSON.stringify(cleanPhrases(l.key_phrases)),
     JSON.stringify(cleanPhrases(l.vocabulary)), l.roleplay_scenario || null, l.tutor_instructions || null, l.duration_min, l.sort_order ?? max.n, l.is_published]
  );
  res.json({ id: ins.insertId });
}));

r.put('/lessons/:id', asyncH(async (req, res) => {
  const l = lessonSchema.parse(req.body);
  await query(
    `UPDATE lessons SET title=?, title_odia=?, objective=?, key_phrases=?, vocabulary=?, roleplay_scenario=?, tutor_instructions=?, duration_min=?, is_published=?
     ${l.sort_order !== undefined ? ', sort_order=' + Number(l.sort_order) : ''} WHERE id=?`,
    [l.title, l.title_odia || null, l.objective || null, JSON.stringify(cleanPhrases(l.key_phrases)), JSON.stringify(cleanPhrases(l.vocabulary)),
     l.roleplay_scenario || null, l.tutor_instructions || null, l.duration_min, l.is_published, req.params.id]
  );
  res.json({ ok: true });
}));

r.delete('/lessons/:id', asyncH(async (req, res) => {
  await query('DELETE FROM lessons WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

r.post('/courses/:id/lessons/reorder', asyncH(async (req, res) => {
  const ids = z.array(z.coerce.number().int()).parse(req.body.ids);
  for (let i = 0; i < ids.length; i++) await query('UPDATE lessons SET sort_order = ? WHERE id = ? AND course_id = ?', [i, ids[i], req.params.id]);
  res.json({ ok: true });
}));

// ---------- AI engines ----------
const engineOut = (e) => {
  const key = decrypt(e.api_key_enc);
  const { api_key_enc, ...rest } = e;
  return { ...rest, extra_config: parseJson(e.extra_config, {}), api_key_set: Boolean(key), api_key_hint: mask(key) };
};

const engineSchema = z.object({
  name: z.string().trim().min(2).max(120),
  provider: z.string().refine((p) => p in PROVIDERS, 'Unknown provider'),
  model: z.string().trim().min(1).max(160),
  voice: z.string().max(80).optional().nullable(),
  language_code: z.string().max(20).optional().nullable(),
  api_key: z.string().optional(),               // empty = keep existing
  base_url: z.string().max(255).optional().nullable(),
  temperature: z.coerce.number().min(0).max(2).default(0.7),
  extra_config: z.union([z.record(z.any()), z.string()]).optional().nullable(),
  is_active: bool.default(1),
});

const normExtra = (x) => {
  if (!x) return null;
  if (typeof x === 'string') { if (!x.trim()) return null; JSON.parse(x); return x; } // validate
  return JSON.stringify(x);
};

r.get('/engines', asyncH(async (_req, res) => {
  const rows = await query('SELECT * FROM llm_engines ORDER BY is_default DESC, id');
  const providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, models: p.models, voices: p.voices, docs: p.docs }]));
  res.json({ engines: rows.map(engineOut), providers });
}));

r.post('/engines', asyncH(async (req, res) => {
  const e = engineSchema.parse(req.body);
  const ins = await query(
    `INSERT INTO llm_engines (name, provider, model, voice, language_code, api_key_enc, base_url, temperature, extra_config, is_active)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [e.name, e.provider, e.model, e.voice || null, e.language_code || null, encrypt(e.api_key || ''), e.base_url || null, e.temperature, normExtra(e.extra_config), e.is_active]
  );
  const hasDefault = await one('SELECT id FROM llm_engines WHERE is_default = 1');
  if (!hasDefault) await query('UPDATE llm_engines SET is_default = 1 WHERE id = ?', [ins.insertId]);
  res.json({ engine: engineOut(await one('SELECT * FROM llm_engines WHERE id = ?', [ins.insertId])) });
}));

r.put('/engines/:id', asyncH(async (req, res) => {
  const e = engineSchema.parse(req.body);
  const sets = ['name=?', 'provider=?', 'model=?', 'voice=?', 'language_code=?', 'base_url=?', 'temperature=?', 'extra_config=?', 'is_active=?'];
  const vals = [e.name, e.provider, e.model, e.voice || null, e.language_code || null, e.base_url || null, e.temperature, normExtra(e.extra_config), e.is_active];
  if (e.api_key) { sets.push('api_key_enc=?'); vals.push(encrypt(e.api_key)); }
  await query(`UPDATE llm_engines SET ${sets.join(', ')} WHERE id = ?`, [...vals, req.params.id]);
  res.json({ engine: engineOut(await one('SELECT * FROM llm_engines WHERE id = ?', [req.params.id])) });
}));

r.post('/engines/:id/default', asyncH(async (req, res) => {
  const e = await one('SELECT id FROM llm_engines WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Not found' });
  await query('UPDATE llm_engines SET is_default = (id = ?), is_active = CASE WHEN id = ? THEN 1 ELSE is_active END', [e.id, e.id]);
  res.json({ ok: true });
}));

r.delete('/engines/:id', asyncH(async (req, res) => {
  const e = await one('SELECT is_default FROM llm_engines WHERE id = ?', [req.params.id]);
  if (e?.is_default) return res.status(400).json({ error: 'Set another engine as default before deleting this one.' });
  await query('DELETE FROM llm_engines WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

r.post('/engines/:id/test', asyncH(async (req, res) => {
  const e = await one('SELECT * FROM llm_engines WHERE id = ?', [req.params.id]);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const result = await testEngine({ ...e, api_key: decrypt(e.api_key_enc), extra_config: parseJson(e.extra_config, {}) });
  res.json(result);
}));

// ---------- Settings (tutor + app) ----------
const APP_KEYS = ['app_name', 'app_url', 'reminders_enabled', 'tutor_base_prompt', 'guest_session_minutes', 'user_session_minutes', 'guest_daily_sessions'];
const MAIL_KEYS = ['mail_from_email', 'mail_from_name', 'smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_pass', 'otp_subject'];

r.get('/settings/app', asyncH(async (_req, res) => res.json(await getSettingsForAdmin(APP_KEYS))));
r.put('/settings/app', asyncH(async (req, res) => {
  const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => APP_KEYS.includes(k)));
  if (body.tutor_base_prompt === '') body.tutor_base_prompt = SETTING_DEFS.tutor_base_prompt.def;
  await setSettings(body);
  res.json(await getSettingsForAdmin(APP_KEYS));
}));

r.get('/settings/mail', asyncH(async (_req, res) => res.json(await getSettingsForAdmin(MAIL_KEYS))));
r.put('/settings/mail', asyncH(async (req, res) => {
  const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => MAIL_KEYS.includes(k)));
  if (body.smtp_pass) body.smtp_pass = String(body.smtp_pass).replace(/\s+/g, ''); // Gmail app passwords are shown with spaces
  await setSettings(body);
  res.json(await getSettingsForAdmin(MAIL_KEYS));
}));

r.post('/settings/mail/test', asyncH(async (req, res) => {
  const { to } = z.object({ to: z.string().email() }).parse(req.body);
  try {
    await verifyMailSettings();
    await sendMail({ to, subject: 'Kathai test email ✔', text: 'Your Kathai mail settings work. ଧନ୍ୟବାଦ!' });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (e) {
    res.status(400).json({ error: `Mail failed: ${e.message}` });
  }
}));

// ---------- Users ----------
r.get('/users', asyncH(async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const users = await query(
    `SELECT u.id, u.name, u.email, u.role, u.email_verified, u.is_active, u.created_at, u.last_login_at,
       (SELECT COUNT(*) FROM progress p WHERE p.owner_key = ('u:' || u.id) AND p.status = 'completed') AS lessons_done,
       (SELECT COALESCE(SUM(seconds),0) FROM voice_sessions v WHERE v.owner_key = ('u:' || u.id)) AS seconds
     FROM users u WHERE u.name LIKE ? OR u.email LIKE ? ORDER BY u.id DESC LIMIT 200`, [q, q]
  );
  res.json({ users });
}));

r.patch('/users/:id', asyncH(async (req, res) => {
  const b = z.object({ is_active: bool.optional(), role: z.enum(['user', 'admin']).optional(), password: z.string().min(8).optional() }).parse(req.body);
  if (Number(req.params.id) === req.user.id && (b.is_active === 0 || b.role === 'user')) {
    return res.status(400).json({ error: "You can't disable or demote yourself." });
  }
  if (b.is_active !== undefined) await query('UPDATE users SET is_active = ? WHERE id = ?', [b.is_active, req.params.id]);
  if (b.role) await query('UPDATE users SET role = ? WHERE id = ?', [b.role, req.params.id]);
  if (b.password) await query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(b.password, 12), req.params.id]);
  res.json({ ok: true });
}));

export default r;
