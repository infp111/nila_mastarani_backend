// Initialize the SQLite schema and idempotent starter data. Usage: npm run migrate
import { bootstrapDatabase } from './bootstrap.js';
import { close } from './db.js';

try {
  await bootstrapDatabase();
  await close();
  console.log('Database migration complete.');
} catch (error) {
  console.error(error);
  await close();
  process.exitCode = 1;
}
