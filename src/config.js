import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredDbPath = process.env.SQLITE_DB_PATH || './data/kathai.sqlite';

const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),
  appSecret: required('APP_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
  // Treat relative paths as backend-relative, even when started from another cwd.
  dbPath: path.isAbsolute(configuredDbPath)
    ? configuredDbPath
    : path.resolve(backendRoot, configuredDbPath),
  admin: {
    name: process.env.ADMIN_NAME || 'Kathai Admin',
    email: process.env.ADMIN_EMAIL || 'teamkathai@gmail.com',
    password: process.env.ADMIN_PASSWORD || '',
  },
  bootstrap: {
    geminiKey: process.env.GEMINI_API_KEY || '',
    mail: {
      from_email: process.env.MAIL_FROM_EMAIL || 'teamkathai@gmail.com',
      from_name: process.env.MAIL_FROM_NAME || 'Kathai',
      smtp_host: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtp_port: process.env.SMTP_PORT || '465',
      smtp_secure: process.env.SMTP_SECURE || 'true',
      smtp_user: process.env.SMTP_USER || 'teamkathai@gmail.com',
      smtp_pass: process.env.SMTP_PASS || '',
    },
  },
};
