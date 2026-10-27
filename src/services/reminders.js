// Daily practice reminders by email for signed-in learners (Duolingo-style "don't lose your streak").
// Runs inside the API process every 10 minutes. Guests get on-device reminders from the app instead.
import { query } from '../db.js';
import { getSettings } from './settings.js';
import { sendMail } from './mailer.js';
import { localDate, localTime } from './gamify.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function runReminders() {
  const s = await getSettings(['reminders_enabled', 'app_name', 'app_url']);
  if (String(s.reminders_enabled) !== 'true') return 0;
  const rows = await query(
    `SELECT ls.*, u.name, u.email FROM learner_stats ls JOIN users u ON ls.owner_key = ('u:' || u.id)
     WHERE ls.reminder_enabled = 1 AND u.is_active = 1 AND u.email_verified = 1`
  );
  let sent = 0;
  for (const r of rows) {
    const today = localDate(r.timezone);
    const last = r.last_active_date ? new Date(r.last_active_date).toISOString().slice(0, 10) : null;
    const lastSent = r.reminder_last_sent ? new Date(r.reminder_last_sent).toISOString().slice(0, 10) : null;
    if (last === today || lastSent === today) continue;
    if (localTime(r.timezone) < r.reminder_time) continue;
    const app = s.app_name || 'Kathai';
    const url = s.app_url || '';
    const first = esc(r.name.split(' ')[0]);
    const streakLine = r.streak_current > 0
      ? `Your ${r.streak_current}-day streak 🔥 ends at midnight. Five minutes keeps it alive.`
      : 'Five minutes of speaking today is all it takes to start a new streak 🔥.';
    try {
      await sendMail({
        to: r.email,
        subject: r.streak_current > 0 ? `🔥 Keep your ${r.streak_current}-day streak, ${r.name.split(' ')[0]}!` : `Time for today's English practice 🎙️`,
        text: `Namaskar ${r.name},\n\n${streakLine}\n\n${url ? `Practise now: ${url}\n\n` : ''}— Team ${app}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #eee;border-radius:12px">
          <h2 style="color:#e8590c;margin:0 0 8px">${esc(app)}</h2>
          <p>ନମସ୍କାର ${first} 🙏</p><p style="font-size:16px">${streakLine}</p>
          ${url ? `<p><a href="${esc(url)}" style="display:inline-block;background:#e8590c;color:#fff;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Practise now</a></p>` : ''}
          <p style="color:#888;font-size:12px">Change or turn off reminders from your profile in the app.</p></div>`,
      });
      await query('UPDATE learner_stats SET reminder_last_sent = ? WHERE owner_key = ?', [today, r.owner_key]);
      sent++;
    } catch (e) {
      console.warn('[reminders] mail failed:', e.message);
      break; // mail misconfigured: stop this round
    }
  }
  return sent;
}

export function startReminderLoop() {
  const tick = () => runReminders().catch((e) => console.warn('[reminders]', e.message));
  setTimeout(tick, 30_000);
  setInterval(tick, 10 * 60_000);
}
