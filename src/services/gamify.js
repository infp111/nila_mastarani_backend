// Gamification + habit engine: XP, daily goal, streaks with freezes, achievements, spaced repetition.
// Ideas borrowed from Duolingo (XP, streaks, freezes, leagues), Babbel (review manager, SRS) and Busuu (study plan, goals).
import { query, one } from '../db.js';

export const XP = {
  practicePerfect: 15,   // finish lesson exercises with no mistakes
  practice: 10,          // finish lesson exercises
  speakingBase: 10,      // finish an AI conversation
  speakingPerMinute: 1,  // +1 XP per minute spoken (max 10)
  reviewPerItem: 1,      // spaced-repetition answers
  goalBonus: 5,          // reaching the daily goal
};

// Leitner intervals in days for boxes 1..5
const BOX_DAYS = [0, 1, 3, 7, 16, 35];

export const ACHIEVEMENTS = [
  { code: 'first_lesson', icon: '🌱', title: 'First steps', desc: 'Finish your first lesson' },
  { code: 'first_talk', icon: '🎙️', title: 'Brave voice', desc: 'Finish your first AI conversation' },
  { code: 'streak_3', icon: '🔥', title: 'On fire', desc: 'Reach a 3-day streak' },
  { code: 'streak_7', icon: '📅', title: 'One week strong', desc: 'Reach a 7-day streak' },
  { code: 'streak_30', icon: '🏆', title: 'Habit master', desc: 'Reach a 30-day streak' },
  { code: 'xp_100', icon: '⭐', title: 'Rising star', desc: 'Earn 100 XP' },
  { code: 'xp_1000', icon: '🌟', title: 'Superstar', desc: 'Earn 1,000 XP' },
  { code: 'perfect', icon: '💯', title: 'Perfectionist', desc: 'Finish a lesson with no mistakes' },
  { code: 'goal_7', icon: '🎯', title: 'Goal getter', desc: 'Hit your daily goal 7 times' },
  { code: 'reviewer', icon: '🧠', title: 'Memory builder', desc: 'Review 50 words and phrases' },
  { code: 'course_done', icon: '🎓', title: 'Graduate', desc: 'Complete a whole course' },
];

export function localDate(tz = 'Asia/Kolkata', d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function localTime(tz = 'Asia/Kolkata', d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const toDateStr = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

export async function getStats(ownerKey) {
  let s = await one('SELECT * FROM learner_stats WHERE owner_key = ?', [ownerKey]);
  if (!s) {
    await query('INSERT OR IGNORE INTO learner_stats (owner_key) VALUES (?)', [ownerKey]);
    s = await one('SELECT * FROM learner_stats WHERE owner_key = ?', [ownerKey]);
  }
  s.last_active_date = toDateStr(s.last_active_date);
  return s;
}

// A streak that missed yesterday is either saved by a freeze or reset. Run lazily on read.
export async function settleStreak(ownerKey) {
  const s = await getStats(ownerKey);
  if (!s.last_active_date || !s.streak_current) return s;
  const today = localDate(s.timezone);
  const gap = dayDiff(s.last_active_date, today);
  if (gap <= 1) return s;
  const missed = gap - 1;
  if (missed <= s.freezes) {
    // freezes cover the missed days; streak survives (but doesn't grow)
    const yesterday = localDate(s.timezone, new Date(Date.now() - 86400000));
    await query('UPDATE learner_stats SET freezes = freezes - ?, last_active_date = ? WHERE owner_key = ?', [missed, yesterday, ownerKey]);
    return { ...(await getStats(ownerKey)), freezeUsed: missed };
  }
  await query('UPDATE learner_stats SET streak_current = 0 WHERE owner_key = ?', [ownerKey]);
  return { ...(await getStats(ownerKey)), streakLost: s.streak_current };
}

async function grant(ownerKey, code, earned) {
  const r = await query('INSERT OR IGNORE INTO achievements (owner_key, code) VALUES (?, ?)', [ownerKey, code]);
  if (r.affectedRows) earned.push(ACHIEVEMENTS.find((a) => a.code === code));
}

// Awards XP, extends the streak, checks the daily goal and achievements. Returns a reward payload for the UI.
export async function awardXp(ownerKey, xp, source, { lessonId = null, perfect = false } = {}) {
  const before = await settleStreak(ownerKey);
  const today = localDate(before.timezone);
  const todayBefore = Number((await one('SELECT COALESCE(SUM(xp),0) x FROM xp_events WHERE owner_key = ? AND day = ?', [ownerKey, today])).x);

  let total = Math.max(0, Math.round(xp));
  const extendsStreak = before.last_active_date !== today;
  let goalReached = false;
  if (todayBefore < before.daily_goal_xp && todayBefore + total >= before.daily_goal_xp) { goalReached = true; total += XP.goalBonus; }
  if (total) await query('INSERT INTO xp_events (owner_key, day, xp, source, lesson_id) VALUES (?, ?, ?, ?, ?)', [ownerKey, today, total, source, lessonId]);

  let streak = before.streak_current;
  if (extendsStreak) {
    streak += 1;
    // every 7-day milestone earns a streak freeze (max 2 in stock)
    const freezeBonus = streak % 7 === 0 ? 1 : 0;
    await query(
      `UPDATE learner_stats SET xp_total = xp_total + ?, streak_current = ?, streak_best = MAX(streak_best, ?),
         last_active_date = ?, freezes = MIN(2, freezes + ?) WHERE owner_key = ?`,
      [total, streak, streak, today, freezeBonus, ownerKey]
    );
  } else {
    await query('UPDATE learner_stats SET xp_total = xp_total + ? WHERE owner_key = ?', [total, ownerKey]);
  }

  const after = await getStats(ownerKey);
  const earned = [];
  if (source === 'practice') await grant(ownerKey, 'first_lesson', earned);
  if (source === 'speaking') await grant(ownerKey, 'first_talk', earned);
  if (perfect) await grant(ownerKey, 'perfect', earned);
  if (after.streak_current >= 3) await grant(ownerKey, 'streak_3', earned);
  if (after.streak_current >= 7) await grant(ownerKey, 'streak_7', earned);
  if (after.streak_current >= 30) await grant(ownerKey, 'streak_30', earned);
  if (after.xp_total >= 100) await grant(ownerKey, 'xp_100', earned);
  if (after.xp_total >= 1000) await grant(ownerKey, 'xp_1000', earned);
  if (goalReached) {
    const g = await one(
      `SELECT COUNT(*) n FROM (SELECT day FROM xp_events WHERE owner_key = ? GROUP BY day HAVING SUM(xp) >= ?) t`, [ownerKey, after.daily_goal_xp]
    );
    if (g.n >= 7) await grant(ownerKey, 'goal_7', earned);
  }
  if (lessonId && source === 'speaking') {
    const c = await one(
      `SELECT COUNT(l.id) total, SUM(p.status = 'completed') done FROM lessons l
       LEFT JOIN progress p ON p.lesson_id = l.id AND p.owner_key = ?
       WHERE l.course_id = (SELECT course_id FROM lessons WHERE id = ?) AND l.is_published = 1`, [ownerKey, lessonId]
    );
    if (c.total && Number(c.done) >= Number(c.total)) await grant(ownerKey, 'course_done', earned);
  }

  return {
    xpEarned: total, xpTotal: after.xp_total, todayXp: todayBefore + total, dailyGoal: after.daily_goal_xp,
    goalReached, streak: after.streak_current, streakExtended: extendsStreak, freezes: after.freezes,
    achievements: earned.filter(Boolean),
  };
}

export async function addReviewItems(ownerKey, lesson) {
  const parse = (v) => { if (!v) return []; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return []; } };
  const items = [
    ...parse(lesson.key_phrases).map((p) => ['phrase', p.en, p.or]),
    ...parse(lesson.vocabulary).map((v) => ['word', v.en, v.or]),
  ].filter(([, en]) => en && en.trim());
  for (const [kind, en, odia] of items) {
    await query(
      `INSERT OR IGNORE INTO review_items (owner_key, lesson_id, kind, en, odia, box, due_at)
       VALUES (?, ?, ?, ?, ?, 1, datetime('now', '+1 day'))`,
      [ownerKey, lesson.id, kind, en.slice(0, 300), (odia || '').slice(0, 300)]
    );
  }
}

export async function answerReview(ownerKey, id, correct) {
  const it = await one('SELECT * FROM review_items WHERE id = ? AND owner_key = ?', [id, ownerKey]);
  if (!it) return null;
  const box = correct ? Math.min(5, it.box + 1) : 1;
  const days = correct ? BOX_DAYS[box] : 0;
  await query(
    `UPDATE review_items SET box = ?, due_at = datetime('now', ? || ' days'),
       correct_count = correct_count + ?, wrong_count = wrong_count + ? WHERE id = ?`,
    [box, days, correct ? 1 : 0, correct ? 0 : 1, id]
  );
  return { box };
}

export async function maybeReviewerBadge(ownerKey) {
  const r = await one('SELECT COALESCE(SUM(correct_count + wrong_count),0) n FROM review_items WHERE owner_key = ?', [ownerKey]);
  const earned = [];
  if (Number(r.n) >= 50) await grant(ownerKey, 'reviewer', earned);
  return earned.filter(Boolean);
}

// Move guest gamification data to the new account on sign-up / sign-in.
export async function adoptGuestGamification(u, g) {
  const gs = await one('SELECT * FROM learner_stats WHERE owner_key = ?', [g]);
  if (gs) {
    const us = await one('SELECT * FROM learner_stats WHERE owner_key = ?', [u]);
    if (!us) await query('UPDATE learner_stats SET owner_key = ? WHERE owner_key = ?', [u, g]);
    else {
      await query(
        `UPDATE learner_stats SET xp_total = xp_total + ?, streak_current = MAX(streak_current, ?),
           streak_best = MAX(streak_best, ?), last_active_date = MAX(COALESCE(last_active_date, '1970-01-01'), COALESCE(?, '1970-01-01'))
         WHERE owner_key = ?`, [gs.xp_total, gs.streak_current, gs.streak_best, toDateStr(gs.last_active_date), u]
      );
      await query('DELETE FROM learner_stats WHERE owner_key = ?', [g]);
    }
  }
  await query('UPDATE xp_events SET owner_key = ? WHERE owner_key = ?', [u, g]);
  await query('UPDATE OR IGNORE review_items SET owner_key = ? WHERE owner_key = ?', [u, g]);
  await query('DELETE FROM review_items WHERE owner_key = ?', [g]);
  await query('UPDATE OR IGNORE achievements SET owner_key = ? WHERE owner_key = ?', [u, g]);
  await query('DELETE FROM achievements WHERE owner_key = ?', [g]);
}
