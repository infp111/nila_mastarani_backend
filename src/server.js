import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { config } from './config.js';
import { one } from './db.js';
import { bootstrapDatabase } from './bootstrap.js';
import { identify } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import learnRoutes from './routes/learn.js';
import { startReminderLoop } from './services/reminders.js';
import { attachVoiceGateway } from './voice/gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Make sure the schema and initial rows exist before accepting requests or
// starting the reminder loop. Safe on every restart.
await bootstrapDatabase();

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)),
  credentials: false,
}));
app.use(express.json({ limit: '1mb' }));
app.use(identify);

app.get('/api/health', async (_req, res) => {
  try { await one('SELECT 1 AS ok'); res.json({ ok: true, db: 'up' }); }
  catch (e) { res.status(500).json({ ok: false, db: e.message }); }
});
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', learnRoutes);
app.use('/api', publicRoutes);

// Serve the built web app (frontend/dist) from the same server in production
const dist = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: err.errors.map((e) => `${e.path.join('.') || 'input'}: ${e.message}`).join('; ') });
  }
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : `Server error: ${err.message}` });
});

const server = http.createServer(app);
attachVoiceGateway(server, { allowedOrigins: config.corsOrigins });
server.listen(config.port, () => console.log(`Kathai API on http://localhost:${config.port}`));
startReminderLoop();
