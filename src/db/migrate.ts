import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { logger } from '../utils/logger.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    logger.info({ file }, 'applying migration');
    await tx(async (c) => {
      await c.query(readFileSync(join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
  logger.info({ count: files.length }, 'migrations up to date');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
