import { Router } from 'express';
import { query, one } from '../db.js';
import { asyncH } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { awardXp, addReviewItems, XP } from '../services/gamify.js';

const r = Router();

const parseJson = (v) => { if (!v) return []; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return []; } };

r.get('/config', asyncH(async (_req, res) => {
  const s = await getSettings(['app_name', 'guest_session_minutes', 'user_session_minutes']);
  res.json({ appName: s.app_name, guestSessionMinutes: Number(s.guest_session_minutes), userSessionMinutes: Number(s.user_session_minutes) });
}));

// Published courses (+ lesson count and the caller's progress)
r.get('/courses', asyncH(async (req, res) => {
  const courses = await query(
    `SELECT c.id, c.slug, c.title, c.title_odia, c.description, c.category, c.level, c.icon,
            (SELECT COUNT(*) FROM lessons l WHERE l.course_id = c.id AND l.is_published = 1) AS lesson_count
     FROM courses c WHERE c.is_published = 1 ORDER BY c.sort_order, c.id`
  );
  if (req.ownerKey) {
    const done = await query(
      `SELECT l.course_id, COUNT(*) AS n FROM progress p JOIN lessons l ON l.id = p.lesson_id
       WHERE p.owner_key = ? AND p.status = 'completed' GROUP BY l.course_id`, [req.ownerKey]
    );
    const map = Object.fromEntries(done.map((d) => [d.course_id, d.n]));
    courses.forEach((c) => { c.completed = map[c.id] || 0; });
  }
  res.json({ courses });
}));

r.get('/courses/:slug', asyncH(async (req, res) => {
  const course = await one(
    'SELECT id, slug, title, title_odia, description, category, level, icon FROM courses WHERE slug = ? AND is_published = 1', [req.params.slug]
  );
  if (!course) return res.status(404).json({ error: 'Course not found' });
  const lessons = await query(
    `SELECT l.id, l.title, l.title_odia, l.objective, l.duration_min, p.status, p.sessions
     FROM lessons l LEFT JOIN progress p ON p.lesson_id = l.id AND p.owner_key = ?
     WHERE l.course_id = ? AND l.is_published = 1 ORDER BY l.sort_order, l.id`,
    [req.ownerKey || '', course.id]
  );
  res.json({ course, lessons });
}));

r.get('/lessons/:id', asyncH(async (req, res) => {
  const l = await one(
    `SELECT l.id, l.course_id, l.title, l.title_odia, l.objective, l.key_phrases, l.vocabulary, l.roleplay_scenario, l.duration_min,
            c.slug AS course_slug, c.title AS course_title
     FROM lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = ? AND l.is_published = 1 AND c.is_published = 1`, [req.params.id]
  );
  if (!l) return res.status(404).json({ error: 'Lesson not found' });
  l.key_phrases = parseJson(l.key_phrases);
  l.vocabulary = parseJson(l.vocabulary);
  const siblings = await query('SELECT id FROM lessons WHERE course_id = ? AND is_published = 1 ORDER BY sort_order, id', [l.course_id]);
  const idx = siblings.findIndex((s) => s.id === l.id);
  l.next_lesson_id = siblings[idx + 1]?.id || null;
  const p = req.ownerKey ? await one('SELECT status, sessions, seconds_practised FROM progress WHERE owner_key = ? AND lesson_id = ?', [req.ownerKey, l.id]) : null;
  res.json({ lesson: l, progress: p });
}));

r.post('/lessons/:id/complete', asyncH(async (req, res) => {
  if (!req.ownerKey) return res.status(400).json({ error: 'Missing guest id' });
  const lesson = await one('SELECT id, key_phrases, vocabulary FROM lessons WHERE id = ?', [req.params.id]);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  const prev = await one('SELECT status FROM progress WHERE owner_key = ? AND lesson_id = ?', [req.ownerKey, lesson.id]);
  await query(
    `INSERT INTO progress (owner_key, lesson_id, status) VALUES (?, ?, 'completed')
     ON CONFLICT(owner_key, lesson_id) DO UPDATE SET status = 'completed', last_practised_at = CURRENT_TIMESTAMP`, [req.ownerKey, lesson.id]
  );
  await addReviewItems(req.ownerKey, lesson);
  // Speaking XP: base + 1 per minute spoken on this lesson today (capped). Half XP when repeating a completed lesson.
  const t = await one(
    "SELECT COALESCE(SUM(seconds),0) secs FROM voice_sessions WHERE owner_key = ? AND lesson_id = ? AND started_at >= datetime('now', '-1 day')",
    [req.ownerKey, lesson.id]
  );
  let xp = XP.speakingBase + Math.min(10, Math.floor(Number(t.secs) / 60) * XP.speakingPerMinute);
  if (prev?.status === 'completed') xp = Math.ceil(xp / 2);
  const reward = await awardXp(req.ownerKey, xp, 'speaking', { lessonId: lesson.id });
  res.json({ ok: true, reward });
}));

r.get('/me/history', asyncH(async (req, res) => {
  if (!req.ownerKey) return res.json({ sessions: [] });
  const sessions = await query(
    `SELECT v.id, v.started_at, v.seconds, l.title AS lesson_title, l.id AS lesson_id
     FROM voice_sessions v LEFT JOIN lessons l ON l.id = v.lesson_id
     WHERE v.owner_key = ? ORDER BY v.id DESC LIMIT 30`, [req.ownerKey]
  );
  const totals = await one("SELECT COUNT(*) AS lessons_done FROM progress WHERE owner_key = ? AND status = 'completed'", [req.ownerKey]);
  const time = await one('SELECT COALESCE(SUM(seconds),0) AS secs FROM voice_sessions WHERE owner_key = ?', [req.ownerKey]);
  res.json({ sessions, lessonsDone: totals.lessons_done, minutesPractised: Math.round(time.secs / 60) });
}));

export default r;
