// Idempotent initial data for a fresh SQLite database. The schema itself is
// applied by db.js before this module can issue queries.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { query, one } from './db.js';
import { config } from './config.js';
import { encrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function bootstrapDatabase() {
  // ---- Admin ----
  const admin = await one('SELECT id FROM users WHERE email = ?', [config.admin.email]);
  if (!admin && config.admin.password) {
    const hash = await bcrypt.hash(config.admin.password, 12);
    await query(
      'INSERT INTO users (name, email, role, password_hash, email_verified) VALUES (?, ?, \'admin\', ?, 1)',
      [config.admin.name, config.admin.email, hash]
    );
    console.log(`[database] admin created: ${config.admin.email}`);
  } else if (admin) {
    await query('UPDATE users SET role = \'admin\' WHERE email = ?', [config.admin.email]);
  } else {
    console.warn('[database] ADMIN_PASSWORD is empty; no admin account was created');
  }

  // ---- Default AI engines ----
  const engines = await one('SELECT COUNT(*) AS n FROM llm_engines');
  if (!engines.n) {
    await query(
      `INSERT INTO llm_engines (name, provider, model, voice, language_code, api_key_enc, temperature, is_active, is_default)
       VALUES (?, 'gemini_live', ?, 'Kore', '', ?, 0.7, 1, 1)`,
      ['Google Gemini Live (Odia)', 'gemini-2.5-flash-native-audio-preview-09-2025', encrypt(config.bootstrap.geminiKey)]
    );
    await query(
      `INSERT INTO llm_engines (name, provider, model, voice, api_key_enc, temperature, is_active, is_default)
       VALUES ('OpenAI Realtime (backup)', 'openai_realtime', 'gpt-realtime', 'marin', NULL, 0.8, 0, 0)`
    );
  }

  // ---- Mail settings ----
  const m = config.bootstrap.mail;
  const mailSeed = {
    mail_from_email: m.from_email, mail_from_name: m.from_name, smtp_host: m.smtp_host,
    smtp_port: m.smtp_port, smtp_secure: m.smtp_secure, smtp_user: m.smtp_user,
  };
  for (const [key, value] of Object.entries(mailSeed)) {
    await query('INSERT OR IGNORE INTO settings (`key`, `value`, is_secret) VALUES (?, ?, 0)', [key, value]);
  }
  if (m.smtp_pass) {
    await query('INSERT OR IGNORE INTO settings (`key`, `value`, is_secret) VALUES (\'smtp_pass\', ?, 1)', [encrypt(m.smtp_pass)]);
  }

  // ---- Sample courses ----
  // New library entries are added without replacing courses edited by admins.
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-courses.json'), 'utf8'));
  const existing = await query('SELECT slug FROM courses');
  const have = new Set(existing.map((row) => row.slug));
  const { maxOrder } = await one('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM courses');
  let courseOrder = have.size ? maxOrder + 1 : 0;
  let added = 0;
  for (const course of seed) {
    if (have.has(course.slug)) continue;
    const result = await query(
      `INSERT INTO courses (slug, title, title_odia, description, category, level, icon, course_instructions, sort_order, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [course.slug, course.title, course.title_odia, course.description, course.category, course.level, course.icon, course.course_instructions || null, courseOrder++]
    );
    let lessonOrder = 0;
    for (const lesson of course.lessons) {
      await query(
        `INSERT INTO lessons (course_id, title, title_odia, objective, key_phrases, vocabulary, roleplay_scenario, tutor_instructions, duration_min, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [result.insertId, lesson.title, lesson.title_odia, lesson.objective, JSON.stringify(lesson.key_phrases || []),
         JSON.stringify(lesson.vocabulary || []), lesson.roleplay_scenario || null, lesson.tutor_instructions || null, lesson.duration_min || 10, lessonOrder++]
      );
    }
    added++;
  }

  console.log(`[database] ready: ${config.dbPath}; added ${added} sample course(s)`);
}
