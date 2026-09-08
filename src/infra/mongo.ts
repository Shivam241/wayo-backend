import { MongoClient, type Db } from 'mongodb';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * MongoDB holds the one genuinely document-shaped workload: the support
 * diagnostics stream (raw provider responses, full match-run explanations,
 * arbitrary event payloads). Nothing transactional lives here — Postgres keeps
 * the authoritative `audit_events` row for every transition; Mongo keeps the
 * fat payload next to it. All writes are fire-and-forget.
 */
let db: Db | null = null;

export async function connectMongo(): Promise<void> {
  try {
    const client = new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db();
    await db.collection('diagnostics').createIndex({ entityId: 1, createdAt: -1 });
    await db.collection('diagnostics').createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
    logger.info('mongo connected');
  } catch (err) {
    logger.warn({ err }, 'mongo unavailable — diagnostics stream disabled');
    db = null;
  }
}

export const mongoHealthy = () => db !== null;

export function recordDiagnostic(doc: {
  kind: string;
  entityType: string;
  entityId: string;
  traceId?: string;
  payload: unknown;
}): void {
  if (!db) return;
  db.collection('diagnostics')
    .insertOne({ ...doc, createdAt: new Date() })
    .catch((err) => logger.debug({ err }, 'diagnostic write failed'));
}

export async function readDiagnostics(entityId: string, limit = 50) {
  if (!db) return [];
  return db.collection('diagnostics').find({ entityId }).sort({ createdAt: -1 }).limit(limit).toArray();
}
