import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

// numeric -> number. Amounts here are small and bounded; no need for a decimal lib.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));
// date -> 'YYYY-MM-DD' string. A recurrence start date is a calendar date, not
// an instant; parsing it into a JS Date silently attaches the server timezone.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.postgresUrl,
  // Managed providers present a CA the container does not carry; the transport
  // is still encrypted.
  ssl: config.postgresSsl ? { rejectUnauthorized: false } : undefined,
  max: 20,
  // Fail fast instead of hanging forever: a database outage should surface as a
  // 503 from /health and a clean error to the client, not a stuck request.
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => logger.error({ err }, 'idle postgres client error'));

export type Db = pg.Pool | pg.PoolClient;

export const query = <T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool,
) => db.query<T>(sql, params as any[]);

export const one = async <T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T | null> => (await query<T>(sql, params, db)).rows[0] ?? null;

export const many = async <T extends pg.QueryResultRow = any>(
  sql: string,
  params: unknown[] = [],
  db: Db = pool,
): Promise<T[]> => (await query<T>(sql, params, db)).rows;

/**
 * Runs `fn` inside a transaction. Every state transition that must not tear —
 * accept a request, cancel a ride, publish a ride — goes through here.
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
