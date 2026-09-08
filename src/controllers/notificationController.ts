import type { Request, Response } from 'express';
import * as NotificationModel from '../models/notification.js';
import { notFound } from '../utils/errors.js';

export async function list(req: Request, res: Response) {
  const [notifications, unread] = await Promise.all([
    NotificationModel.list(req.userId!, Number(req.query.limit ?? 50)),
    NotificationModel.unreadCount(req.userId!),
  ]);
  res.json({ notifications, unread });
}

export async function markRead(req: Request, res: Response) {
  const row = await NotificationModel.markRead(req.params.id, req.userId!);
  if (!row) throw notFound('Notification');
  res.json({ notification: row });
}

export async function markAllRead(req: Request, res: Response) {
  await NotificationModel.markAllRead(req.userId!);
  res.json({ unread: 0 });
}
