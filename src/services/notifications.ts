import * as NotificationModel from '../models/notification.js';
import * as UserModel from '../models/user.js';
import { sendPush } from '../infra/firebase.js';
import { logger } from '../utils/logger.js';

export type NotificationType =
  | 'match_available'
  | 'request_received'
  | 'request_accepted'
  | 'request_rejected'
  | 'ride_modified'
  | 'ride_cancelled'
  | 'ride_reminder'
  | 'guest_cancelled'
  | 'contribution_updated'
  | 'sync_issue';

const COPY: Record<NotificationType, (d: Record<string, string>) => { title: string; body: string }> = {
  match_available: (d) => ({ title: 'New ride match', body: `A ride to ${d.dest} matches your commute.` }),
  request_received: (d) => ({ title: 'Seat request', body: `${d.name} asked for a seat on your ${d.when} ride.` }),
  request_accepted: (d) => ({ title: 'Request accepted', body: `${d.name} confirmed your seat for ${d.when}.` }),
  request_rejected: (d) => ({ title: 'Request declined', body: `Your seat request for ${d.when} was declined.` }),
  ride_modified: (d) => ({ title: 'Ride updated', body: `The ${d.when} ride changed: ${d.change}.` }),
  ride_cancelled: (d) => ({ title: 'Ride cancelled', body: `The ${d.when} ride to ${d.dest} was cancelled.` }),
  ride_reminder: (d) => ({ title: 'Ride tomorrow', body: `You have a ride at ${d.when}.` }),
  guest_cancelled: (d) => ({ title: 'Passenger cancelled', body: `${d.name} cancelled for ${d.when}.` }),
  contribution_updated: (d) => ({ title: 'Contribution updated', body: `Your share for ${d.when} is now ${d.amount}.` }),
  sync_issue: () => ({ title: 'Sync problem', body: 'Some ride data could not be synchronised. Open the app to retry.' }),
};

/**
 * Store first, push second. The row is the durable record of the event; a
 * failed or undeliverable push never means the user loses the notification.
 */
export async function notify(
  userId: string,
  type: NotificationType,
  data: Record<string, string> = {},
): Promise<void> {
  const { title, body } = COPY[type](data);
  const row = await NotificationModel.create({ user_id: userId, type, title, body, data });
  if (!row) return;

  try {
    const tokens = await UserModel.deviceTokens(userId);
    if (tokens.length === 0) return;
    const { invalidTokens } = await sendPush(tokens, { title, body, data: { ...data, type, notificationId: row.id } });
    await UserModel.removeDevices(invalidTokens);
    await NotificationModel.markPushed(row.id);
  } catch (err) {
    logger.warn({ err, userId, type }, 'push failed — notification remains stored');
    await NotificationModel.markPushed(row.id, (err as Error).message);
  }
}

export const notifyMany = (userIds: string[], type: NotificationType, data: Record<string, string> = {}) =>
  Promise.allSettled(userIds.map((id) => notify(id, type, data)));
