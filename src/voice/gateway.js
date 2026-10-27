// WebSocket voice gateway: browser/app <-> Kathai server <-> AI voice provider.
// API keys never leave the server. The client speaks one simple protocol whatever the provider.
//
// Client -> server (JSON):  { type:'audio', data:<base64 pcm16> } | { type:'text', text } | { type:'end' }
// Server -> client (JSON):  { type:'ready', inputRate, outputRate, engine, maxSeconds }
//                           { type:'audio', data } | { type:'transcript', role, text }
//                           { type:'turn_complete' } | { type:'interrupted' }
//                           { type:'warning', message } | { type:'error', message } | { type:'ended', reason, seconds }
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import { query, one } from '../db.js';
import { decrypt } from '../crypto.js';
import { userFromToken } from '../middleware/auth.js';
import { getSettings } from '../services/settings.js';
import { createProvider } from './providers/index.js';
import { buildSystemPrompt, kickoffText } from './prompt.js';
import { awardXp } from '../services/gamify.js';

const GUEST_RE = /^[a-zA-Z0-9-]{8,48}$/;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };

async function pickEngine(course) {
  let row = null;
  if (course?.engine_id) row = await one('SELECT * FROM llm_engines WHERE id = ? AND is_active = 1', [course.engine_id]);
  if (!row) row = await one('SELECT * FROM llm_engines WHERE is_default = 1 AND is_active = 1');
  if (!row) row = await one('SELECT * FROM llm_engines WHERE is_active = 1 ORDER BY id LIMIT 1');
  if (!row) throw new Error('No active AI engine. Ask the admin to configure one.');
  return { ...row, api_key: decrypt(row.api_key_enc), extra_config: parse(row.extra_config, {}) };
}

export function attachVoiceGateway(server, { allowedOrigins }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws/voice') return socket.destroy();
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin) && !allowedOrigins.includes('*')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url).catch((e) => {
      try { ws.send(JSON.stringify({ type: 'error', message: e.message })); ws.close(); } catch { /* ignore */ }
    }));
  });

  return wss;
}

async function handle(client, url) {
  const send = (obj) => { if (client.readyState === 1) client.send(JSON.stringify(obj)); };
  const user = await userFromToken(url.searchParams.get('token'));
  const guestId = url.searchParams.get('guestId');
  if (!user && !GUEST_RE.test(guestId || '')) throw new Error('Missing guest id');
  const ownerKey = user ? `u:${user.id}` : `g:${guestId}`;

  const s = await getSettings(['tutor_base_prompt', 'guest_session_minutes', 'user_session_minutes', 'guest_daily_sessions']);

  if (!user) {
    const today = await one("SELECT COUNT(*) n FROM voice_sessions WHERE owner_key = ? AND started_at > datetime('now', '-1 day')", [ownerKey]);
    if (today.n >= Number(s.guest_daily_sessions || 5)) {
      throw new Error('You have used today\'s free guest sessions. Sign up free (just name + email) to keep learning!');
    }
  }

  const lessonId = Number(url.searchParams.get('lessonId')) || null;
  let lesson = null, course = null;
  if (lessonId) {
    lesson = await one('SELECT * FROM lessons WHERE id = ? AND is_published = 1', [lessonId]);
    if (!lesson) throw new Error('Lesson not found');
    course = await one('SELECT * FROM courses WHERE id = ?', [lesson.course_id]);
  }

  const engine = await pickEngine(course);
  const provider = createProvider(engine);
  const maxSeconds = 60 * Number(user ? s.user_session_minutes : s.guest_session_minutes) || 600;
  const transcript = [];
  const startedAt = Date.now();
  let ended = false;

  const ins = await query('INSERT INTO voice_sessions (owner_key, lesson_id, engine_id) VALUES (?, ?, ?)', [ownerKey, lessonId, engine.id]);
  const sessionId = ins.insertId;

  const addTranscript = (role, text) => {
    const last = transcript[transcript.length - 1];
    if (last && last.role === role) last.text += text; else transcript.push({ role, text });
  };

  const finish = async (reason) => {
    if (ended) return;
    ended = true;
    clearTimeout(limitTimer); clearTimeout(warnTimer);
    provider.close();
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    send({ type: 'ended', reason, seconds });
    try { client.close(); } catch { /* ignore */ }
    await query('UPDATE voice_sessions SET ended_at = CURRENT_TIMESTAMP, seconds = ?, transcript = ?, end_reason = ? WHERE id = ?',
      [seconds, JSON.stringify(transcript.slice(-200)), reason, sessionId]);
    if (lessonId && seconds > 5) {
      await query(
        `INSERT INTO progress (owner_key, lesson_id, sessions, seconds_practised) VALUES (?, ?, 1, ?)
         ON CONFLICT(owner_key, lesson_id) DO UPDATE SET sessions = sessions + 1,
           seconds_practised = seconds_practised + excluded.seconds_practised, last_practised_at = CURRENT_TIMESTAMP`,
        [ownerKey, lessonId, seconds]
      );
    }
    // Free talk earns 2 XP per minute (max 20). Lesson conversations earn XP when the learner marks them complete.
    if (!lessonId && seconds >= 60) {
      await awardXp(ownerKey, Math.min(20, Math.floor(seconds / 60) * 2), 'speaking').catch(() => {});
    }
  };

  const warnTimer = setTimeout(() => send({ type: 'warning', message: '1 minute left in this session.' }), Math.max(0, (maxSeconds - 60) * 1000));
  const limitTimer = setTimeout(() => finish('time_limit'), maxSeconds * 1000);

  provider.on('audio', (data) => send({ type: 'audio', data }));
  provider.on('transcript', ({ role, text }) => { addTranscript(role, text); send({ type: 'transcript', role, text }); });
  provider.on('turn_complete', () => send({ type: 'turn_complete' }));
  provider.on('interrupted', () => send({ type: 'interrupted' }));
  provider.on('error', (e) => send({ type: 'warning', message: e.message }));
  provider.on('close', (why) => finish(`provider_closed: ${String(why).slice(0, 40)}`));

  client.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'audio' && typeof m.data === 'string') provider.sendAudio(m.data);
    else if (m.type === 'text' && m.text) { addTranscript('user', `${m.text}\n`); provider.sendText(String(m.text).slice(0, 2000)); }
    else if (m.type === 'end') finish('user_ended');
  });
  client.on('close', () => finish('client_closed'));

  const systemPrompt = buildSystemPrompt({ basePrompt: s.tutor_base_prompt, course, lesson, learnerName: user?.name });
  try {
    await provider.connect({ systemPrompt, kickoff: kickoffText(lesson) });
  } catch (e) {
    send({ type: 'error', message: `Could not start the tutor: ${e.message}` });
    await finish('connect_failed');
    return;
  }
  send({ type: 'ready', inputRate: provider.inputRate, outputRate: provider.outputRate, engine: engine.name, maxSeconds });
}
