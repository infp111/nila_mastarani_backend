// Learner engagement API: stats, onboarding/study plan, lesson practice XP, spaced-repetition review, leaderboard.
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { asyncH } from '../middleware/auth.js';
import {
  XP, ACHIEVEMENTS, settleStreak, awardXp, addReviewItems, answerReview, maybeReviewerBadge, localDate, getStats,
} from '../services/gamify.js';

const r = Router();
const need = (req, res, next) => (req.ownerKey ? next() : res.status(400).json({ error: 'Missing guest id' }));

async function nextLesson(ownerKey) {
  // Continue the course practised most recently; otherwise the first published lesson.
  const last = await one(
    `SELECT l.course_id FROM progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.owner_key = ?
     ORDER BY p.last_practised_at DESC LIMIT 1`, [ownerKey]
  );
  const pick = async (courseFilter, params) => one(
    `SELECT l.id, l.title, l.title_odia, c.title course_title, c.slug course_slug, c.icon
     FROM lessons l JOIN courses c ON c.id = l.course_id
     LEFT JOIN progress p ON p.lesson_id = l.id AND p.owner_key = ?
     WHERE l.is_published = 1 AND c.is_published = 1 AND (p.status IS NULL OR p.status <> 'completed') ${courseFilter}
     ORDER BY c.sort_order, c.id, l.sort_order, l.id LIMIT 1`, [ownerKey, ...params]
  );
  return (last && (await pick('AND l.course_id = ?', [last.course_id]))) || pick('', []);
}

r.get('/me/stats', need, asyncH(async (req, res) => {
  const s = await settleStreak(req.ownerKey);
  const today = localDate(s.timezone);
  const rows = await query(
    `SELECT day, SUM(xp) xp FROM xp_events WHERE owner_key = ? AND day >= date(?, '-6 days') GROUP BY day`, [req.ownerKey, today]
  );
  const map = Object.fromEntries(rows.map((x) => [String(x.day instanceof Date ? x.day.toISOString().slice(0, 10) : x.day).slice(0, 10), Number(x.xp)]));
  const week = [...Array(7)].map((_, i) => {
    const d = localDate(s.timezone, new Date(Date.now() - (6 - i) * 86400000));
    return { day: d, xp: map[d] || 0 };
  });
  const due = await one("SELECT COUNT(*) n FROM review_items WHERE owner_key = ? AND due_at <= CURRENT_TIMESTAMP", [req.ownerKey]);
  const total = await one('SELECT COUNT(*) n FROM review_items WHERE owner_key = ?', [req.ownerKey]);
  const got = await query('SELECT code, earned_at FROM achievements WHERE owner_key = ?', [req.ownerKey]);
  const gotMap = Object.fromEntries(got.map((g) => [g.code, g.earned_at]));
  const done = await one("SELECT COUNT(*) n FROM progress WHERE owner_key = ? AND status = 'completed'", [req.ownerKey]);
  res.json({
    stats: {
      xpTotal: s.xp_total, streak: s.streak_current, streakBest: s.streak_best, freezes: s.freezes,
      dailyGoal: s.daily_goal_xp, todayXp: map[today] || 0, activeToday: s.last_active_date === today,
      onboarded: Boolean(s.onboarded), motivation: s.motivation, selfLevel: s.self_level,
      reminderEnabled: Boolean(s.reminder_enabled), reminderTime: s.reminder_time, timezone: s.timezone,
      lessonsDone: done.n, streakLost: s.streakLost || 0, freezeUsed: s.freezeUsed || 0,
    },
    week,
    review: { due: due.n, total: total.n },
    achievements: ACHIEVEMENTS.map((a) => ({ ...a, earned: Boolean(gotMap[a.code]), earnedAt: gotMap[a.code] || null })),
    next: await nextLesson(req.ownerKey),
  });
}));

const prefsSchema = z.object({
  motivation: z.enum(['job', 'study', 'travel', 'confidence', 'daily']).optional(),
  selfLevel: z.enum(['new', 'some', 'good']).optional(),
  dailyGoal: z.number().int().min(5).max(200).optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().max(40).optional(),
  onboarded: z.boolean().optional(),
});

r.put('/me/preferences', need, asyncH(async (req, res) => {
  const b = prefsSchema.parse(req.body);
  await getStats(req.ownerKey);
  const cols = { motivation: 'motivation', selfLevel: 'self_level', dailyGoal: 'daily_goal_xp', reminderEnabled: 'reminder_enabled', reminderTime: 'reminder_time', timezone: 'timezone', onboarded: 'onboarded' };
  const sets = []; const vals = [];
  for (const [k, c] of Object.entries(cols)) if (b[k] !== undefined) { sets.push(`${c} = ?`); vals.push(typeof b[k] === 'boolean' ? Number(b[k]) : b[k]); }
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { return res.status(400).json({ error: 'Unknown timezone' }); } }
  if (sets.length) await query(`UPDATE learner_stats SET ${sets.join(', ')} WHERE owner_key = ?`, [...vals, req.ownerKey]);
  res.json({ ok: true });
}));

// Finished the exercises part of a lesson (learn + practice). Speaking XP comes from /lessons/:id/complete.
r.post('/lessons/:id/practice', need, asyncH(async (req, res) => {
  const b = z.object({ correct: z.number().int().min(0).max(200), total: z.number().int().min(1).max(200) }).parse(req.body);
  const lesson = await one('SELECT id, key_phrases, vocabulary FROM lessons WHERE id = ? AND is_published = 1', [req.params.id]);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found' });
  await query(
    `INSERT INTO progress (owner_key, lesson_id, status) VALUES (?, ?, 'started')
     ON CONFLICT(owner_key, lesson_id) DO UPDATE SET last_practised_at = CURRENT_TIMESTAMP`, [req.ownerKey, lesson.id]
  );
  await addReviewItems(req.ownerKey, lesson);
  const perfect = b.correct >= b.total;
  const reward = await awardXp(req.ownerKey, perfect ? XP.practicePerfect : XP.practice, 'practice', { lessonId: lesson.id, perfect });
  res.json({ reward, accuracy: Math.round((Math.min(b.correct, b.total) / b.total) * 100) });
}));

// Due review items, plus a pool of other items to build multiple-choice distractors.
r.get('/review', need, asyncH(async (req, res) => {
  const limit = Math.min(20, Number(req.query.limit) || 12);
  let items = await query(
    `SELECT id, kind, en, odia, box FROM review_items WHERE owner_key = ? AND due_at <= CURRENT_TIMESTAMP ORDER BY due_at LIMIT ${limit}`, [req.ownerKey]
  );
  let early = false;
  if (!items.length && req.query.any) {
    // "Practise anyway": weakest items first even if not due
    items = await query(
      `SELECT id, kind, en, odia, box FROM review_items WHERE owner_key = ? ORDER BY box, wrong_count DESC, RANDOM() LIMIT ${limit}`, [req.ownerKey]
    );
    early = true;
  }
  const pool = await query(`SELECT en, odia, kind FROM review_items WHERE owner_key = ? ORDER BY RANDOM() LIMIT 40`, [req.ownerKey]);
  res.json({ items, pool, early });
}));

r.post('/review/:id/answer', need, asyncH(async (req, res) => {
  const { correct } = z.object({ correct: z.boolean() }).parse(req.body);
  const out = await answerReview(req.ownerKey, req.params.id, correct);
  if (!out) return res.status(404).json({ error: 'Not found' });
  res.json(out);
}));

r.post('/review/finish', need, asyncH(async (req, res) => {
  const { correct } = z.object({ correct: z.number().int().min(0).max(20) }).parse(req.body);
  const reward = await awardXp(req.ownerKey, correct * XP.reviewPerItem + 2, 'review');
  reward.achievements.push(...(await maybeReviewerBadge(req.ownerKey)));
  res.json({ reward });
}));

// Weekly leaderboard (Monday-Sunday, IST). Signed-in learners only appear; guests see it with a sign-up prompt.
r.get('/leaderboard', asyncH(async (req, res) => {
  const today = localDate('Asia/Kolkata');
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(Date.parse(`${today}T00:00:00Z`) - dow * 86400000).toISOString().slice(0, 10);
  const rows = await query(
    `SELECT e.owner_key, SUM(e.xp) xp, u.name, s.streak_current streak
     FROM xp_events e JOIN users u ON e.owner_key = ('u:' || u.id) AND u.is_active = 1
     LEFT JOIN learner_stats s ON s.owner_key = e.owner_key
     WHERE e.day >= ? GROUP BY e.owner_key, u.name, s.streak_current ORDER BY xp DESC LIMIT 30`, [monday]
  );
  const board = rows.map((x, i) => ({ rank: i + 1, name: x.name.split(' ')[0], xp: Number(x.xp), streak: x.streak || 0, me: x.owner_key === req.ownerKey }));
  let me = board.find((b) => b.me) || null;
  if (!me && req.ownerKey) {
    const m = await one('SELECT COALESCE(SUM(xp),0) xp FROM xp_events WHERE owner_key = ? AND day >= ?', [req.ownerKey, monday]);
    me = { rank: null, xp: Number(m.xp), me: true };
  }
  const end = new Date(Date.parse(`${monday}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
  res.json({ weekStart: monday, weekEnd: end, board, me, signedIn: Boolean(req.user) });
}));

export default r;
