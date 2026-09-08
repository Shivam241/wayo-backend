import { many, one, type Db, pool } from '../db/pool.js';

export const block = (actorId: string, targetId: string, reason: string | null, db: Db = pool) =>
  one(
    `INSERT INTO blocks_reports (actor_id, target_id, kind, reason) VALUES ($1,$2,'block',$3)
     ON CONFLICT (actor_id, target_id) WHERE kind = 'block' DO UPDATE SET reason = EXCLUDED.reason
     RETURNING *`,
    [actorId, targetId, reason],
    db,
  );

export const unblock = (actorId: string, targetId: string, db: Db = pool) =>
  one(`DELETE FROM blocks_reports WHERE actor_id = $1 AND target_id = $2 AND kind = 'block' RETURNING id`,
    [actorId, targetId], db);

export const report = (actorId: string, targetId: string, reason: string, db: Db = pool) =>
  one(`INSERT INTO blocks_reports (actor_id, target_id, kind, reason) VALUES ($1,$2,'report',$3) RETURNING *`,
    [actorId, targetId, reason], db);

export const listBlocked = (actorId: string, db: Db = pool) =>
  many(
    `SELECT b.target_id, b.reason, b.created_at, p.display_name, p.photo_url
     FROM blocks_reports b LEFT JOIN profiles p ON p.user_id = b.target_id
     WHERE b.actor_id = $1 AND b.kind = 'block' ORDER BY b.created_at DESC`,
    [actorId],
    db,
  );

export const isBlockedEitherWay = async (a: string, b: string, db: Db = pool) =>
  Boolean(await one(
    `SELECT 1 FROM blocks_reports WHERE kind = 'block'
       AND ((actor_id = $1 AND target_id = $2) OR (actor_id = $2 AND target_id = $1)) LIMIT 1`,
    [a, b], db));
