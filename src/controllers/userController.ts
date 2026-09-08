import type { Request, Response } from 'express';
import { z } from 'zod';
import * as UserModel from '../models/user.js';
import * as Safety from '../models/safety.js';
import * as Audit from '../models/audit.js';
import { notFound } from '../utils/errors.js';

const latlng = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

export const profileSchema = z.object({
  display_name: z.string().min(1).max(80).optional(),
  photo_url: z.string().url().nullish(),
  bio: z.string().max(500).nullish(),
  preferred_role: z.enum(['driver', 'passenger', 'both']).optional(),
  home_label: z.string().max(200).nullish(),
  home_lat: latlng.lat.nullish(),
  home_lng: latlng.lng.nullish(),
  work_label: z.string().max(200).nullish(),
  work_lat: latlng.lat.nullish(),
  work_lng: latlng.lng.nullish(),
  commute_days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  departure_window_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullish(),
  departure_window_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullish(),
  organization: z.string().max(120).nullish(),
  onboarded: z.boolean().optional(),
});

export const vehicleSchema = z.object({
  make: z.string().max(60).nullish(),
  model: z.string().max(60).nullish(),
  color: z.string().max(30).nullish(),
  plate: z.string().max(20).nullish(),
  plate_visible: z.boolean().optional(),
  vehicle_type: z.string().max(30).optional(),
  fuel_type: z.enum(['petrol', 'diesel', 'cng', 'ev']).optional(),
  efficiency_kmpl: z.number().positive().max(100).nullish(),
  seats: z.number().int().min(1).max(8).optional(),
  is_default: z.boolean().optional(),
});

export const deviceSchema = z.object({
  fcm_token: z.string().min(10),
  platform: z.enum(['ios', 'android']),
});

/** The single bootstrap call the app makes on launch. */
export async function me(req: Request, res: Response) {
  const [user, profile, vehicles, providers] = await Promise.all([
    UserModel.findById(req.userId!),
    UserModel.getProfile(req.userId!),
    UserModel.listVehicles(req.userId!),
    UserModel.listProviders(req.userId!),
  ]);
  res.json({ user, profile, vehicles, providers, serverTime: new Date().toISOString() });
}

export async function updateProfile(req: Request, res: Response) {
  const profile = await UserModel.upsertProfile(req.userId!, req.body);
  res.json({ profile });
}

export async function publicProfile(req: Request, res: Response) {
  const profile = await UserModel.getPublicProfile(req.params.id);
  if (!profile) throw notFound('User');
  res.json({ profile });
}

export const listVehicles = async (req: Request, res: Response) =>
  res.json({ vehicles: await UserModel.listVehicles(req.userId!) });

export const createVehicle = async (req: Request, res: Response) =>
  res.status(201).json({ vehicle: await UserModel.createVehicle(req.userId!, req.body) });

export async function updateVehicle(req: Request, res: Response) {
  const vehicle = await UserModel.updateVehicle(req.params.id, req.userId!, req.body);
  if (!vehicle) throw notFound('Vehicle');
  res.json({ vehicle });
}

export async function deleteVehicle(req: Request, res: Response) {
  const deleted = await UserModel.deleteVehicle(req.params.id, req.userId!);
  if (!deleted) throw notFound('Vehicle');
  res.status(204).end();
}

export const registerDevice = async (req: Request, res: Response) =>
  res.json({ device: await UserModel.registerDevice(req.userId!, req.body.fcm_token, req.body.platform) });

/** Logout from all devices: drop every push token for this account. */
export async function logoutAll(req: Request, res: Response) {
  const removed = await UserModel.removeAllDevices(req.userId!);
  await Audit.record({ entityType: 'user', entityId: req.userId!, action: 'user.logout_all', actorId: req.userId });
  res.json({ removedDevices: removed.length });
}

/** Deletion is a request, not an immediate wipe — trips and guests stay intact. */
export async function requestDeletion(req: Request, res: Response) {
  await UserModel.setStatus(req.userId!, 'deletion_requested');
  await UserModel.removeAllDevices(req.userId!);
  await Audit.record({
    entityType: 'user', entityId: req.userId!, action: 'user.deletion_requested', actorId: req.userId,
    toState: 'deletion_requested',
  });
  res.json({ status: 'deletion_requested' });
}

/** Work-email verification by approved domain. Ownership proof happens in
 *  Firebase (email link); the backend records the resulting badge. */
export async function verifyOrg(req: Request, res: Response) {
  const email = req.identity?.email;
  if (!email || !req.identity?.emailVerified) {
    return res.status(400).json({
      error: { code: 'email_unverified', message: 'Verify your work email in the app first' },
    });
  }
  const domain = email.split('@')[1];
  const user = await UserModel.verifyOrgDomain(req.userId!, domain);
  res.json({ user });
}

// ------------------------------------------------------------------- safety

export const listBlocked = async (req: Request, res: Response) =>
  res.json({ blocked: await Safety.listBlocked(req.userId!) });

export async function blockUser(req: Request, res: Response) {
  const row = await Safety.block(req.userId!, req.params.id, req.body?.reason ?? null);
  await Audit.record({
    entityType: 'user', entityId: req.params.id, action: 'user.blocked', actorId: req.userId,
  });
  res.status(201).json({ block: row });
}

export async function unblockUser(req: Request, res: Response) {
  await Safety.unblock(req.userId!, req.params.id);
  res.status(204).end();
}

export async function reportUser(req: Request, res: Response) {
  const row = await Safety.report(req.userId!, req.params.id, req.body?.reason ?? 'unspecified');
  await Audit.record({
    entityType: 'user', entityId: req.params.id, action: 'user.reported', actorId: req.userId,
    detail: { reason: req.body?.reason },
  });
  res.status(201).json({ report: row });
}
