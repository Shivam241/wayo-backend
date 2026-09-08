import type { Request, Response } from 'express';
import { z } from 'zod';
import * as RideModel from '../models/ride.js';
import * as BookingModel from '../models/booking.js';
import * as MatchModel from '../models/match.js';
import * as RideService from '../services/rides.js';
import * as Audit from '../models/audit.js';
import { quoteForOccurrence } from '../services/cost.js';
import { redisHealthy } from '../infra/redis.js';
import { forbidden, notFound } from '../utils/errors.js';

const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:MM');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const rideFields = z.object({
  vehicle_id: z.string().uuid().nullish(),
  origin_label: z.string().min(1).max(200),
  origin_lat: z.number().min(-90).max(90),
  origin_lng: z.number().min(-180).max(180),
  dest_label: z.string().min(1).max(200),
  dest_lat: z.number().min(-90).max(90),
  dest_lng: z.number().min(-180).max(180),
  is_recurring: z.boolean().default(false),
  recurrence_days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  departure_time: time,
  series_start_date: date,
  series_end_date: date.nullish(),
  seats_total: z.number().int().min(1).max(8),
  notes: z.string().max(500).nullish(),
  preferences: z.record(z.any()).optional(),
});

export const createRideSchema = rideFields.refine(
  (v) => !v.is_recurring || v.recurrence_days.length > 0,
  { message: 'A recurring ride needs at least one day', path: ['recurrence_days'] },
);

export const editRideSchema = rideFields.partial().extend({
  version: z.number().int().positive(),
});

export async function create(req: Request, res: Response) {
  const { preferences, ...rideData } = req.body;
  const ride = await RideModel.create(req.userId!, rideData);
  await RideModel.setPreferences(ride!.id, preferences ?? {});
  const route = await RideService.resolveRoute(ride!);
  await Audit.record({
    entityType: 'ride', entityId: ride!.id, action: 'ride.created', actorId: req.userId, toState: 'draft',
  });
  res.status(201).json({ ride, route });
}

export const listMine = async (req: Request, res: Response) =>
  res.json({ rides: await RideModel.listByDriver(req.userId!) });

export async function detail(req: Request, res: Response) {
  const ride = await RideModel.findById(req.params.id);
  if (!ride) throw notFound('Ride');
  const [route, preferences, occurrences] = await Promise.all([
    RideModel.currentRoute(ride.id),
    RideModel.getPreferences(ride.id),
    RideModel.listOccurrences(ride.id, new Date()),
  ]);
  res.json({ ride, route, preferences, occurrences, isDriver: ride.driver_id === req.userId });
}

export async function publish(req: Request, res: Response) {
  res.json(await RideService.publish(req.params.id, req.userId!));
}

export async function edit(req: Request, res: Response) {
  const { version, preferences, ...patch } = req.body;
  const result = await RideService.edit(req.params.id, req.userId!, version, patch);
  if (preferences) await RideModel.setPreferences(req.params.id, preferences);
  res.json({
    ride: result.ride,
    materialChanges: result.material,
    affectedOccurrences: result.affectedOccurrences.length,
  });
}

export async function pause(req: Request, res: Response) {
  const ride = await RideModel.findById(req.params.id);
  if (!ride) throw notFound('Ride');
  if (ride.driver_id !== req.userId) throw forbidden();
  const next = ride.status === 'paused' ? 'published' : 'paused';
  const updated = await RideModel.setStatus(ride.id, next);
  await Audit.record({
    entityType: 'ride', entityId: ride.id, action: `ride.${next}`, actorId: req.userId,
    fromState: ride.status, toState: next,
  });
  res.json({ ride: updated });
}

export const cancel = async (req: Request, res: Response) =>
  res.json(await RideService.cancelRide(req.params.id, req.userId!, req.body?.reason ?? 'driver cancelled'));

export const listOccurrences = async (req: Request, res: Response) =>
  res.json({ occurrences: await RideModel.listOccurrences(req.params.id, new Date()) });

// -------------------------------------------------------------- occurrences

/**
 * Everything the ride-detail screen needs in one call. The guest list comes
 * straight from ride_guests — it is never reconstructed from matching, so it
 * is present even if matching or Redis is down.
 */
export async function occurrenceDetail(req: Request, res: Response) {
  const detail = await RideModel.occurrenceDetail(req.params.id);
  if (!detail) throw notFound('Ride occurrence');

  const isDriver = detail.driver_id === req.userId;
  const [guests, requests, contribution, lastMatchRun] = await Promise.all([
    BookingModel.listGuests(req.params.id),
    isDriver ? BookingModel.listRequestsForOccurrence(req.params.id) : Promise.resolve([]),
    quoteForOccurrence(req.params.id, isDriver ? null : req.userId!).catch(() => null),
    MatchModel.lastRunFor(req.params.id),
  ]);

  const myGuest = guests.find((g: any) => g.passenger_id === req.userId && g.state === 'confirmed');

  res.json({
    ...detail,
    isDriver,
    // Exact pickup detail and driver contact stay hidden until acceptance.
    guests: isDriver || myGuest
      ? guests
      : guests.map((g: any) => ({ id: g.id, display_name: g.display_name, photo_url: g.photo_url, state: g.state })),
    requests,
    contribution,
    myBooking: myGuest ?? null,
    sync: {
      lastMatchRun: lastMatchRun?.computed_at ?? null,
      matchAlgorithmVersion: lastMatchRun?.algorithm_version ?? null,
      cacheHealthy: redisHealthy(),
      serverTime: new Date().toISOString(),
    },
  });
}

export async function occurrenceGuests(req: Request, res: Response) {
  const occ = await RideModel.getOccurrence(req.params.id);
  if (!occ) throw notFound('Ride occurrence');
  const ride = await RideModel.findById(occ.ride_id);
  const guests = await BookingModel.listGuests(req.params.id);
  const isParticipant =
    ride?.driver_id === req.userId ||
    guests.some((g: any) => g.passenger_id === req.userId && g.state === 'confirmed');
  if (!isParticipant) throw forbidden();
  res.json({ guests, seatsTotal: occ.seats_total, seatsTaken: occ.seats_taken });
}

export const cancelOccurrence = async (req: Request, res: Response) =>
  res.json(await RideService.cancelOccurrence(req.params.id, req.userId!, req.body?.reason ?? 'driver cancelled'));

export async function startOccurrence(req: Request, res: Response) {
  const occ = await RideModel.getOccurrence(req.params.id);
  if (!occ) throw notFound('Ride occurrence');
  const ride = await RideModel.findById(occ.ride_id);
  if (ride?.driver_id !== req.userId) throw forbidden();
  const updated = await RideModel.setOccurrenceStatus(req.params.id, 'in_progress');
  await Audit.record({
    entityType: 'occurrence', entityId: req.params.id, action: 'occurrence.started', actorId: req.userId,
    fromState: occ.status, toState: 'in_progress',
  });
  res.json({ occurrence: updated });
}

export const completeOccurrence = async (req: Request, res: Response) =>
  res.json({ occurrence: await RideService.completeOccurrence(req.params.id, req.userId!) });

// -------------------------------------------------------------------- home

/** Home dashboard. One call, and it degrades cleanly. */
export async function home(req: Request, res: Response) {
  const [upcoming, inbox, myRequests] = await Promise.all([
    RideModel.upcomingForUser(req.userId!),
    BookingModel.inboxForDriver(req.userId!),
    BookingModel.listRequestsByPassenger(req.userId!),
  ]);
  res.json({
    upcoming,
    pendingRequestsForMe: inbox,
    myRequests: myRequests.filter((r: any) => r.state === 'pending'),
    sync: { serverTime: new Date().toISOString(), cacheHealthy: redisHealthy() },
  });
}

export const history = async (req: Request, res: Response) =>
  res.json({ trips: await RideModel.historyForUser(req.userId!) });
