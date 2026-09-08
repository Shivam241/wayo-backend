import { many, one, query, type Db, pool } from '../db/pool.js';

export type Notification = {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: Date | null;
  pushed_at: Date | null;
  created_at: Date;
};

/** Stored first, pushed second — a missed push never loses the event. */
export const create = (n: Omit<Notification, 'id' | 'read_at' | 'pushed_at' | 'created_at'>, db: Db = pool) =>
  one<Notification>(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [n.user_id, n.type, n.title, n.body, JSON.stringify(n.data ?? {})],
    db,
  );

export const list = (userId: string, limit = 50, db: Db = pool) =>
  many<Notification>(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit],
    db,
  );

export const unreadCount = async (userId: string, db: Db = pool) =>
  Number((await one<{ n: string }>(
    'SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId], db))!.n);

export const markRead = (id: string, userId: string, db: Db = pool) =>
  one<Notification>(
    'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 RETURNING *',
    [id, userId],
    db,
  );

export const markAllRead = (userId: string, db: Db = pool) =>
  query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId], db);

export const markPushed = (id: string, error?: string, db: Db = pool) =>
  query('UPDATE notifications SET pushed_at = now(), push_error = $2 WHERE id = $1', [id, error ?? null], db);
