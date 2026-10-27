-- Kathai SQLite schema. Text columns use UTF-8, including Odia script.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) <= 120),
  email TEXT NOT NULL UNIQUE CHECK (length(email) <= 190),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  password_hash TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'login')),
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  pending_name TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 255),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes (email, purpose, created_at);

CREATE TABLE IF NOT EXISTS llm_engines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (length(name) <= 120),
  provider TEXT NOT NULL CHECK (length(provider) <= 40),
  model TEXT NOT NULL CHECK (length(model) <= 160),
  voice TEXT CHECK (length(voice) <= 80),
  language_code TEXT CHECK (length(language_code) <= 20),
  api_key_enc TEXT,
  base_url TEXT CHECK (length(base_url) <= 255),
  temperature REAL NOT NULL DEFAULT 0.70,
  extra_config TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) <= 140),
  title TEXT NOT NULL CHECK (length(title) <= 160),
  title_odia TEXT CHECK (length(title_odia) <= 200),
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general' CHECK (length(category) <= 60),
  level TEXT NOT NULL DEFAULT 'beginner' CHECK (level IN ('beginner', 'intermediate', 'advanced')),
  icon TEXT CHECK (length(icon) <= 16),
  engine_id INTEGER,
  course_instructions TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (engine_id) REFERENCES llm_engines(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  title TEXT NOT NULL CHECK (length(title) <= 160),
  title_odia TEXT CHECK (length(title_odia) <= 200),
  objective TEXT,
  key_phrases TEXT,
  vocabulary TEXT,
  roleplay_scenario TEXT,
  tutor_instructions TEXT,
  duration_min INTEGER NOT NULL DEFAULT 10 CHECK (duration_min BETWEEN 0 AND 65535),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 1 CHECK (is_published IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lesson_course ON lessons (course_id, sort_order);

-- Progress for both logged-in users ("u:<id>") and guests ("g:<uuid>").
CREATE TABLE IF NOT EXISTS progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL CHECK (length(owner_key) <= 64),
  lesson_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed')),
  sessions INTEGER NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  seconds_practised INTEGER NOT NULL DEFAULT 0 CHECK (seconds_practised >= 0),
  last_practised_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (owner_key, lesson_id),
  FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS voice_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL CHECK (length(owner_key) <= 64),
  lesson_id INTEGER,
  engine_id INTEGER,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at TEXT,
  seconds INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  transcript TEXT,
  end_reason TEXT CHECK (length(end_reason) <= 60)
);
CREATE INDEX IF NOT EXISTS idx_vs_owner ON voice_sessions (owner_key, started_at);

-- Key/value app settings (mail, tutor prompt, guest limits...). Secrets are encrypted.
CREATE TABLE IF NOT EXISTS settings (
  `key` TEXT PRIMARY KEY CHECK (length(`key`) <= 80),
  `value` TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Gamification and habits.
CREATE TABLE IF NOT EXISTS learner_stats (
  owner_key TEXT PRIMARY KEY CHECK (length(owner_key) <= 64),
  xp_total INTEGER NOT NULL DEFAULT 0 CHECK (xp_total >= 0),
  streak_current INTEGER NOT NULL DEFAULT 0 CHECK (streak_current >= 0),
  streak_best INTEGER NOT NULL DEFAULT 0 CHECK (streak_best >= 0),
  last_active_date TEXT,
  freezes INTEGER NOT NULL DEFAULT 1 CHECK (freezes BETWEEN 0 AND 255),
  daily_goal_xp INTEGER NOT NULL DEFAULT 20 CHECK (daily_goal_xp BETWEEN 0 AND 65535),
  motivation TEXT CHECK (length(motivation) <= 40),
  self_level TEXT CHECK (length(self_level) <= 20),
  onboarded INTEGER NOT NULL DEFAULT 0 CHECK (onboarded IN (0, 1)),
  reminder_enabled INTEGER NOT NULL DEFAULT 1 CHECK (reminder_enabled IN (0, 1)),
  reminder_time TEXT NOT NULL DEFAULT '19:00' CHECK (length(reminder_time) = 5),
  reminder_last_sent TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata' CHECK (length(timezone) <= 40),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS xp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL CHECK (length(owner_key) <= 64),
  day TEXT NOT NULL,
  xp INTEGER NOT NULL CHECK (xp BETWEEN 0 AND 65535),
  source TEXT NOT NULL CHECK (length(source) <= 30),
  lesson_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_xp_owner_day ON xp_events (owner_key, day);
CREATE INDEX IF NOT EXISTS idx_xp_day ON xp_events (day);

-- Spaced-repetition review queue (Leitner boxes 1-5).
CREATE TABLE IF NOT EXISTS review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL CHECK (length(owner_key) <= 64),
  lesson_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('phrase', 'word')),
  en TEXT NOT NULL CHECK (length(en) <= 300),
  odia TEXT CHECK (length(odia) <= 300),
  box INTEGER NOT NULL DEFAULT 1 CHECK (box BETWEEN 0 AND 255),
  due_at TEXT NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  wrong_count INTEGER NOT NULL DEFAULT 0 CHECK (wrong_count >= 0),
  UNIQUE (owner_key, kind, en)
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_items (owner_key, due_at);

CREATE TABLE IF NOT EXISTS achievements (
  owner_key TEXT NOT NULL CHECK (length(owner_key) <= 64),
  code TEXT NOT NULL CHECK (length(code) <= 40),
  earned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_key, code)
);

CREATE TRIGGER IF NOT EXISTS touch_llm_engines_updated_at
AFTER UPDATE ON llm_engines WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE llm_engines SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS touch_courses_updated_at
AFTER UPDATE ON courses WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE courses SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS touch_lessons_updated_at
AFTER UPDATE ON lessons WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE lessons SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;
CREATE TRIGGER IF NOT EXISTS touch_settings_updated_at
AFTER UPDATE ON settings WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE `key` = NEW.`key`; END;
CREATE TRIGGER IF NOT EXISTS touch_learner_stats_updated_at
AFTER UPDATE ON learner_stats WHEN NEW.updated_at = OLD.updated_at
BEGIN UPDATE learner_stats SET updated_at = CURRENT_TIMESTAMP WHERE owner_key = NEW.owner_key; END;
