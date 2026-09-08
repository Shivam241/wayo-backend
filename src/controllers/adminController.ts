import type { Request, Response } from 'express';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import * as Audit from '../models/audit.js';
import * as CostModel from '../models/cost.js';
import * as MatchModel from '../models/match.js';
import { readDiagnostics, mongoHealthy } from '../infra/mongo.js';
import { redisHealthy } from '../infra/redis.js';
import { config } from '../config/index.js';
import { notFound } from '../utils/errors.js';

export const fuelPriceSchema = z.object({
  region: z.string().min(2).max(20),
  fuel_type: z.enum(['petrol', 'diesel', 'cng', 'ev']),
  price: z.number().positive(),
  currency: z.string().length(3).optional(),
  source: z.string().max(120).optional(),
});

/**
 * Support diagnostics for one ride: current state, guests, requests, the last
 * matching run and the full transition history. This is the endpoint that
 * answers "the guest list disappeared" — it shows exactly what the database
 * holds versus what matching last produced.
 */
export async function rideDiagnostics(req: Request, res: Response) {
  const rideId = req.params.id;
  const ride = await one('SELECT * FROM rides WHERE id = $1', [rideId]);
  if (!ride) throw notFound('Ride');

  const [occurrences, guests, requests, matches, timeline, diagnostics] = await Promise.all([
    many('SELECT * FROM ride_occurrences WHERE ride_id = $1 ORDER BY departs_at', [rideId]),
    many(
      `SELECT g.* FROM ride_guests g WHERE g.ride_id = $1 ORDER BY g.created_at DESC`,
      [rideId],
    ),
    many(
      `SELECT b.* FROM booking_requests b JOIN ride_occurrences o ON o.id = b.occurrence_id
       WHERE o.ride_id = $1 ORDER BY b.created_at DESC`,
      [rideId],
    ),
    many(
      `SELECT m.* FROM match_candidates m JOIN ride_occurrences o ON o.id = m.occurrence_id
       WHERE o.ride_id = $1 ORDER BY m.computed_at DESC LIMIT 100`,
      [rideId],
    ),
    Audit.rideTimeline(rideId),
    readDiagnostics(rideId),
  ]);

  res.json({
    ride,
    occurrences,
    guests,
    requests,
    lastMatchRun: matches[0]?.computed_at ?? null,
    matchAlgorithmVersion: config.matching.algorithmVersion,
    matchDecisions: matches,
    timeline,
    diagnostics,
    // The point of this block: guests are durable regardless of matching state.
    invariants: {
      confirmedGuests: guests.filter((g: any) => g.state === 'confirmed').length,
      matchCandidates: matches.length,
      guestsIndependentOfMatching: true,
    },
  });
}

export const matchExplain = async (req: Request, res: Response) =>
  res.json({ decisions: await MatchModel.explain(req.params.occurrenceId, req.params.userId) });

export const userTimeline = async (req: Request, res: Response) =>
  res.json({ timeline: await Audit.timeline('user', req.params.id) });

export const listFuelPrices = async (_req: Request, res: Response) =>
  res.json({ prices: await CostModel.listFuelPrices() });

export const setFuelPrice = async (req: Request, res: Response) =>
  res.status(201).json({ price: await CostModel.setFuelPrice(req.body) });

/** Runtime config the app fetches at boot — remote configuration without a redeploy. */
export const remoteConfig = (_req: Request, res: Response) =>
  res.json({
    matching: {
      algorithmVersion: config.matching.algorithmVersion,
      pickupRadiusKm: config.matching.pickupRadiusKm,
      dropRadiusKm: config.matching.dropRadiusKm,
      timeWindowMin: config.matching.timeWindowMin,
      maxDetourKm: config.matching.maxDetourKm,
    },
    cost: {
      currency: config.cost.currency,
      formulaVersion: config.cost.formulaVersion,
      roundToNearest: config.cost.roundToNearest,
      paymentMode: 'direct_to_driver',
    },
    maps: { provider: config.maps.provider },
    features: { chat: false, ratings: false, payments: false },
  });

export async function health(_req: Request, res: Response) {
  let postgres = false;
  try {
    await one('SELECT 1');
    postgres = true;
  } catch {
    postgres = false;
  }
  // Only Postgres is fatal — the rest degrade rather than fail.
  res.status(postgres ? 200 : 503).json({
    status: postgres ? 'ok' : 'degraded',
    postgres,
    redis: redisHealthy(),
    mongo: mongoHealthy(),
    mapsProvider: config.maps.provider,
    time: new Date().toISOString(),
  });
}
