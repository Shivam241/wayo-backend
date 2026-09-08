import type { Request, Response } from 'express';
import { z } from 'zod';
import { findMatches } from '../services/matching.js';
import { quoteForOccurrence } from '../services/cost.js';
import { searchPlaces } from '../services/routeProvider.js';
import * as BookingModel from '../models/booking.js';
import * as MatchModel from '../models/match.js';
import { config } from '../config/index.js';

export const searchSchema = z.object({
  origin: z.object({ lat: z.number(), lng: z.number(), label: z.string().optional() }),
  destination: z.object({ lat: z.number(), lng: z.number(), label: z.string().optional() }),
  departure_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  flex_minutes: z.number().int().min(0).max(180).optional(),
  pickup_radius_km: z.number().min(0.1).max(20).optional(),
  drop_radius_km: z.number().min(0.1).max(20).optional(),
  from_date: z.string().datetime().optional(),
  to_date: z.string().datetime().optional(),
  save_commute: z.boolean().default(false),
});

export const commuteSchema = z.object({
  origin_label: z.string().min(1),
  origin_lat: z.number(),
  origin_lng: z.number(),
  dest_label: z.string().min(1),
  dest_lat: z.number(),
  dest_lng: z.number(),
  departure_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  recurrence_days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  flex_minutes: z.number().int().min(0).max(180).optional(),
  pickup_radius_km: z.number().optional(),
  drop_radius_km: z.number().optional(),
});

export async function search(req: Request, res: Response) {
  const b = req.body as z.infer<typeof searchSchema>;

  let commuteRequestId: string | null = null;
  if (b.save_commute) {
    const saved = await BookingModel.createCommuteRequest(req.userId!, {
      origin_label: b.origin.label ?? 'Pickup',
      origin_lat: b.origin.lat,
      origin_lng: b.origin.lng,
      dest_label: b.destination.label ?? 'Destination',
      dest_lat: b.destination.lat,
      dest_lng: b.destination.lng,
      departure_time: b.departure_time,
      recurrence_days: b.days,
      flex_minutes: b.flex_minutes,
      pickup_radius_km: b.pickup_radius_km,
      drop_radius_km: b.drop_radius_km,
    });
    commuteRequestId = (saved as any)?.id ?? null;
  }

  const matches = await findMatches({
    passengerId: req.userId!,
    origin: b.origin,
    destination: b.destination,
    departureTime: b.departure_time,
    days: b.days,
    flexMinutes: b.flex_minutes,
    pickupRadiusKm: b.pickup_radius_km,
    dropRadiusKm: b.drop_radius_km,
    fromDate: b.from_date ? new Date(b.from_date) : undefined,
    toDate: b.to_date ? new Date(b.to_date) : undefined,
    commuteRequestId,
  });

  // Attach the suggested contribution to each result so the passenger sees the
  // number before requesting, not after.
  const withCost = await Promise.all(
    matches.slice(0, 25).map(async (m) => ({
      ...m,
      contribution: await quoteForOccurrence(m.occurrenceId, req.userId!).catch(() => null),
    })),
  );

  res.json({
    matches: withCost,
    algorithmVersion: config.matching.algorithmVersion,
    commuteRequestId,
    searchedAt: new Date().toISOString(),
  });
}

/** Why did (or didn't) this ride match? Powers the in-app "why this match" row
 *  and the support diagnostics endpoint. */
export async function explain(req: Request, res: Response) {
  const rows = await MatchModel.explain(req.params.occurrenceId, req.query.userId as string ?? req.userId!);
  res.json({ decisions: rows });
}

export const listCommutes = async (req: Request, res: Response) =>
  res.json({ commutes: await BookingModel.listCommuteRequests(req.userId!) });

export const createCommute = async (req: Request, res: Response) =>
  res.status(201).json({ commute: await BookingModel.createCommuteRequest(req.userId!, req.body) });

export async function deleteCommute(req: Request, res: Response) {
  await BookingModel.deactivateCommuteRequest(req.params.id, req.userId!);
  res.status(204).end();
}

export async function places(req: Request, res: Response) {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ places: [] });
  const near =
    req.query.lat && req.query.lng
      ? { lat: Number(req.query.lat), lng: Number(req.query.lng) }
      : undefined;
  res.json({ places: await searchPlaces(q, near) });
}
