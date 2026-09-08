import { config } from '../config/index.js';
import * as MatchModel from '../models/match.js';
import { getRoute } from './routeProvider.js';
import { recordDiagnostic } from '../infra/mongo.js';
import { logger } from '../utils/logger.js';
import {
  clockDiffMinutes,
  distanceToPolylineKm,
  haversineKm,
  progressAlongPolyline,
  routeOverlap,
  type LatLng,
} from '../utils/geo.js';

export type MatchQuery = {
  passengerId: string;
  origin: LatLng;
  destination: LatLng;
  originLabel?: string;
  destLabel?: string;
  departureTime: string; // HH:MM
  days?: number[];
  flexMinutes?: number;
  pickupRadiusKm?: number;
  dropRadiusKm?: number;
  fromDate?: Date;
  toDate?: Date;
  commuteRequestId?: string | null;
};

export type ScoreComponents = {
  routeOverlap: number;
  pickupDeviationKm: number;
  dropDeviationKm: number;
  timeDifferenceMin: number;
  detourKm: number;
  detourMin: number;
  recurrenceOverlap: number;
  seatsAvailable: number;
};

export type MatchResult = {
  occurrenceId: string;
  rideId: string;
  driverId: string;
  departsAt: Date;
  originLabel: string;
  destLabel: string;
  seatsAvailable: number;
  score: number;
  components: ScoreComponents;
  reasons: string[];
  rejectedReason?: string;
  routeFingerprint: string | null;
  polyline: string | null;
  distanceKm: number | null;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** 1 at zero, decaying to 0 at `span`. Linear keeps the score explainable. */
const decay = (value: number, span: number) => clamp01(1 - value / span);
const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;

/**
 * Scores one candidate. Pure, deterministic, and given the same inputs it
 * always produces the same score and the same reason codes — that is what
 * makes matching explainable and testable.
 */
export function scoreCandidate(
  q: { origin: LatLng; destination: LatLng; departureTime: string; days: number[] },
  ride: {
    origin: LatLng;
    destination: LatLng;
    departureTime: string;
    recurrenceDays: number[];
    line: LatLng[];
    routeDistanceKm: number;
    seatsAvailable: number;
    tolerances: {
      pickupRadiusKm: number;
      dropRadiusKm: number;
      timeWindowMin: number;
      maxDetourKm: number;
      maxDetourMin: number;
    };
  },
  passengerRouteKm: number,
  detourKm: number,
  detourMin: number,
): { score: number; components: ScoreComponents; reasons: string[]; rejectedReason?: string } {
  const t = ride.tolerances;
  const w = config.matching.weights;

  const pickupDeviationKm = distanceToPolylineKm(q.origin, ride.line);
  const dropDeviationKm = distanceToPolylineKm(q.destination, ride.line);
  const timeDifferenceMin = clockDiffMinutes(q.departureTime, ride.departureTime);
  const overlap = routeOverlap(q.origin, q.destination, ride.line, config.matching.corridorToleranceKm);
  const dayOverlap =
    q.days.length === 0 || ride.recurrenceDays.length === 0
      ? 1
      : q.days.filter((d) => ride.recurrenceDays.includes(d)).length / q.days.length;

  const components: ScoreComponents = {
    routeOverlap: round(overlap),
    pickupDeviationKm: round(pickupDeviationKm, 2),
    dropDeviationKm: round(dropDeviationKm, 2),
    timeDifferenceMin: Math.round(timeDifferenceMin),
    detourKm: round(detourKm, 2),
    detourMin: Math.round(detourMin),
    recurrenceOverlap: round(dayOverlap),
    seatsAvailable: ride.seatsAvailable,
  };

  // Hard eligibility gates. A gated candidate is still persisted, with its
  // reason, so support can answer "why didn't I see this ride?".
  const gate =
    ride.seatsAvailable <= 0 ? 'no_seats_available'
    : pickupDeviationKm > t.pickupRadiusKm ? `pickup_${pickupDeviationKm.toFixed(1)}km_beyond_${t.pickupRadiusKm}km`
    : dropDeviationKm > t.dropRadiusKm ? `drop_${dropDeviationKm.toFixed(1)}km_beyond_${t.dropRadiusKm}km`
    : timeDifferenceMin > t.timeWindowMin ? `departure_${Math.round(timeDifferenceMin)}min_beyond_${t.timeWindowMin}min`
    : detourKm > t.maxDetourKm ? `detour_${detourKm.toFixed(1)}km_beyond_${t.maxDetourKm}km`
    : detourMin > t.maxDetourMin ? `detour_${Math.round(detourMin)}min_beyond_${t.maxDetourMin}min`
    : dayOverlap === 0 ? 'no_recurring_day_overlap'
    // travelling the opposite way down the same corridor is not a match
    : progressAlongPolyline(q.origin, ride.line) > progressAlongPolyline(q.destination, ride.line)
      ? 'opposite_direction'
    : null;

  if (gate) return { score: 0, components, reasons: [], rejectedReason: gate };

  const score =
    w.routeOverlap * overlap +
    w.pickupDeviation * decay(pickupDeviationKm, t.pickupRadiusKm) +
    w.dropDeviation * decay(dropDeviationKm, t.dropRadiusKm) +
    w.timeDifference * decay(timeDifferenceMin, t.timeWindowMin) +
    w.detour * decay(detourMin, t.maxDetourMin) +
    w.recurrenceOverlap * dayOverlap;

  const reasons: string[] = [];
  if (overlap >= 0.85) reasons.push('same destination corridor');
  else if (overlap >= 0.5) reasons.push(`${Math.round(overlap * 100)}% of your route covered`);
  reasons.push(
    pickupDeviationKm <= 0.3 ? 'pickup on the driver route' : `pickup ${pickupDeviationKm.toFixed(1)} km from route`,
  );
  reasons.push(
    dropDeviationKm <= 0.3 ? 'drop on the driver route' : `drop ${dropDeviationKm.toFixed(1)} km from route`,
  );
  if (timeDifferenceMin === 0) reasons.push('departs at your time');
  else reasons.push(`departure ${Math.round(timeDifferenceMin)} min apart`);
  if (detourMin > 0) reasons.push(`adds ~${Math.round(detourMin)} min for the driver`);
  if (dayOverlap === 1 && q.days.length > 0) reasons.push('all your commute days');
  if (passengerRouteKm > 0) reasons.push(`${passengerRouteKm.toFixed(1)} km trip`);

  return { score: round(clamp01(score)), components, reasons };
}

/**
 * Full two-stage match run.
 *  1. SQL pre-filter (cheap, indexed).
 *  2. Routing calls only for survivors, then scoring.
 * Results are persisted so a later matching outage cannot erase the record of
 * what was decided or why.
 */
export async function findMatches(q: MatchQuery): Promise<MatchResult[]> {
  const from = q.fromDate ?? new Date();
  const to = q.toDate ?? new Date(Date.now() + config.occurrenceHorizonDays * 864e5);
  const windowMin = q.flexMinutes ?? config.matching.timeWindowMin;

  const rows = await MatchModel.prefilterCandidates({
    passengerId: q.passengerId,
    originLat: q.origin.lat,
    originLng: q.origin.lng,
    destLat: q.destination.lat,
    destLng: q.destination.lng,
    departureTime: q.departureTime.length === 5 ? `${q.departureTime}:00` : q.departureTime,
    windowMin,
    pickupRadiusKm: q.pickupRadiusKm ?? config.matching.pickupRadiusKm,
    dropRadiusKm: q.dropRadiusKm ?? config.matching.dropRadiusKm,
    fromDate: from,
    toDate: to,
    days: q.days ?? [],
    timezone: config.timezone,
  });

  // The passenger's own route: one call, reused for every candidate.
  const passengerRoute = await getRoute(q.origin, q.destination);
  const results: MatchResult[] = [];

  for (const row of rows) {
    const line: LatLng[] =
      Array.isArray(row.geometry) && row.geometry.length > 1
        ? row.geometry
        : // ride created before its route was resolved: fall back to a straight
          // corridor rather than dropping the ride out of matching entirely
          [{ lat: row.origin_lat, lng: row.origin_lng }, { lat: row.dest_lat, lng: row.dest_lng }];

    const baseKm = Number(row.distance_km ?? haversineKm(
      { lat: row.origin_lat, lng: row.origin_lng },
      { lat: row.dest_lat, lng: row.dest_lng },
    ) * 1.3);

    // Detour = driver's route via the passenger's pickup and drop, minus the
    // driver's direct route. Two extra routing calls, only for survivors.
    const [legA, legB, legC] = await Promise.all([
      getRoute({ lat: row.origin_lat, lng: row.origin_lng }, q.origin),
      getRoute(q.origin, q.destination),
      getRoute(q.destination, { lat: row.dest_lat, lng: row.dest_lng }),
    ]);
    const viaKm = legA.distanceKm + legB.distanceKm + legC.distanceKm;
    const viaMin = legA.durationMin + legB.durationMin + legC.durationMin;
    const detourKm = Math.max(0, viaKm - baseKm);
    const detourMin = Math.max(0, viaMin - Number(row.duration_min ?? baseKm * 2.4));

    const seatsAvailable = row.seats_total - row.seats_taken;
    const { score, components, reasons, rejectedReason } = scoreCandidate(
      {
        origin: q.origin,
        destination: q.destination,
        departureTime: q.departureTime,
        days: q.days ?? [],
      },
      {
        origin: { lat: row.origin_lat, lng: row.origin_lng },
        destination: { lat: row.dest_lat, lng: row.dest_lng },
        departureTime: String(row.departure_time),
        recurrenceDays: row.recurrence_days ?? [],
        line,
        routeDistanceKm: baseKm,
        seatsAvailable,
        tolerances: {
          pickupRadiusKm: Math.min(Number(row.pickup_radius_km), q.pickupRadiusKm ?? Number(row.pickup_radius_km)),
          dropRadiusKm: Math.min(Number(row.drop_radius_km), q.dropRadiusKm ?? Number(row.drop_radius_km)),
          timeWindowMin: Math.max(Number(row.time_window_min), windowMin),
          maxDetourKm: Number(row.max_detour_km),
          maxDetourMin: Number(row.max_detour_min),
        },
      },
      passengerRoute.distanceKm,
      detourKm,
      detourMin,
    );

    // Persist the decision either way — this is the audit trail that lets
    // support explain a match, and it never gates on the result being good.
    await MatchModel.persistCandidate({
      occurrence_id: row.occurrence_id,
      passenger_id: q.passengerId,
      commute_request_id: q.commuteRequestId ?? null,
      score,
      components: components as unknown as Record<string, number>,
      reasons,
      rejected_reason: rejectedReason ?? null,
      algorithm_version: config.matching.algorithmVersion,
      route_fingerprint: row.fingerprint ?? null,
    }).catch((err) => logger.warn({ err }, 'match persistence failed — result still returned'));

    if (rejectedReason || score < config.matching.minScore) continue;

    results.push({
      occurrenceId: row.occurrence_id,
      rideId: row.ride_id,
      driverId: row.driver_id,
      departsAt: row.departs_at,
      originLabel: row.origin_label,
      destLabel: row.dest_label,
      seatsAvailable,
      score,
      components,
      reasons,
      routeFingerprint: row.fingerprint ?? null,
      polyline: row.polyline ?? null,
      distanceKm: passengerRoute.distanceKm,
    });
  }

  results.sort((a, b) => b.score - a.score || +a.departsAt - +b.departsAt);

  recordDiagnostic({
    kind: 'match_run',
    entityType: 'user',
    entityId: q.passengerId,
    payload: {
      query: { ...q, origin: q.origin, destination: q.destination },
      prefiltered: rows.length,
      returned: results.length,
      algorithmVersion: config.matching.algorithmVersion,
      routeProviderDegraded: passengerRoute.degraded,
    },
  });

  return results;
}
