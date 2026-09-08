import { many, one, type Db, pool } from '../db/pool.js';

export type MatchCandidate = {
  id: string;
  occurrence_id: string;
  passenger_id: string;
  score: number;
  components: Record<string, number>;
  reasons: string[];
  rejected_reason: string | null;
  algorithm_version: string;
  route_fingerprint: string | null;
  commute_request_id?: string | null;
};

/**
 * Cheap spatial + temporal pre-filter, stage 2/3 of the matching spec.
 * Only rows surviving this ever cost a routing API call.
 */
export const prefilterCandidates = (
  p: {
    passengerId: string;
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    departureTime: string;
    windowMin: number;
    pickupRadiusKm: number;
    dropRadiusKm: number;
    fromDate: Date;
    toDate: Date;
    days: number[];
    timezone: string;
  },
  db: Db = pool,
) =>
  many(
    `SELECT o.id AS occurrence_id, o.departs_at, o.seats_total, o.seats_taken, o.version AS occurrence_version,
            r.id AS ride_id, r.driver_id, r.origin_label, r.origin_lat, r.origin_lng,
            r.dest_label, r.dest_lat, r.dest_lng, r.departure_time, r.recurrence_days,
            rr.polyline, rr.geometry, rr.distance_km, rr.duration_min, rr.fingerprint,
            COALESCE(pref.pickup_radius_km, $8) AS pickup_radius_km,
            COALESCE(pref.drop_radius_km, $9) AS drop_radius_km,
            COALESCE(pref.max_detour_km, 5.0) AS max_detour_km,
            COALESCE(pref.max_detour_min, 15) AS max_detour_min,
            COALESCE(pref.time_window_min, $7) AS time_window_min,
            haversine_km($2, $3, r.origin_lat, r.origin_lng) AS origin_gap_km,
            haversine_km($4, $5, r.dest_lat, r.dest_lng) AS dest_gap_km
     FROM ride_occurrences o
     JOIN rides r ON r.id = o.ride_id
     LEFT JOIN ride_routes rr ON rr.ride_id = r.id AND rr.is_current
     LEFT JOIN ride_preferences pref ON pref.ride_id = r.id
     WHERE r.status = 'published'
       AND o.status = 'scheduled'
       AND o.seats_taken < o.seats_total
       AND o.departs_at BETWEEN $10 AND $11
       AND r.driver_id <> $1
       -- destination corridor: the driver must end up near where the passenger is going
       AND haversine_km($4, $5, r.dest_lat, r.dest_lng) <= $9 + COALESCE(pref.max_detour_km, 5.0)
       -- departure-time compatibility, compared on the ride's own wall clock
       -- (never derived from the stored instant, which is timezone-dependent)
       AND LEAST(
             abs(EXTRACT(EPOCH FROM (r.departure_time - $6::time))) / 60,
             1440 - abs(EXTRACT(EPOCH FROM (r.departure_time - $6::time))) / 60
           ) <= GREATEST($7, COALESCE(pref.time_window_min, $7))
       -- recurring-day overlap when the passenger asked for specific days
       AND (cardinality($12::smallint[]) = 0
            OR EXTRACT(DOW FROM (o.departs_at AT TIME ZONE $13))::smallint = ANY($12::smallint[]))
       -- neither party has blocked the other
       AND NOT EXISTS (
         SELECT 1 FROM blocks_reports b WHERE b.kind = 'block'
           AND ((b.actor_id = $1 AND b.target_id = r.driver_id)
             OR (b.actor_id = r.driver_id AND b.target_id = $1)))
       -- already booked or already asked
       AND NOT EXISTS (
         SELECT 1 FROM booking_requests br WHERE br.occurrence_id = o.id
           AND br.passenger_id = $1 AND br.state IN ('pending','accepted'))
     ORDER BY o.departs_at
     LIMIT 200`,
    [p.passengerId, p.originLat, p.originLng, p.destLat, p.destLng, p.departureTime,
     p.windowMin, p.pickupRadiusKm, p.dropRadiusKm, p.fromDate, p.toDate, p.days, p.timezone],
    db,
  );

/** Persist the decision — accepted or rejected — with its algorithm version. */
export const persistCandidate = (c: Partial<MatchCandidate> & { occurrence_id: string; passenger_id: string }, db: Db = pool) =>
  one<MatchCandidate>(
    `INSERT INTO match_candidates (occurrence_id, passenger_id, commute_request_id, score,
       components, reasons, rejected_reason, algorithm_version, route_fingerprint)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (occurrence_id, passenger_id, algorithm_version) DO UPDATE SET
       score = EXCLUDED.score, components = EXCLUDED.components, reasons = EXCLUDED.reasons,
       rejected_reason = EXCLUDED.rejected_reason, route_fingerprint = EXCLUDED.route_fingerprint,
       computed_at = now()
     RETURNING *`,
    [c.occurrence_id, c.passenger_id, (c as any).commute_request_id ?? null, c.score ?? 0,
     JSON.stringify(c.components ?? {}), c.reasons ?? [], c.rejected_reason ?? null,
     c.algorithm_version, c.route_fingerprint ?? null],
    db,
  );

/** Support/diagnostics: why did this passenger see (or not see) this ride? */
export const explain = (occurrenceId: string, passengerId: string, db: Db = pool) =>
  many<MatchCandidate>(
    `SELECT * FROM match_candidates WHERE occurrence_id = $1 AND passenger_id = $2
     ORDER BY computed_at DESC`,
    [occurrenceId, passengerId],
    db,
  );

export const lastRunFor = (occurrenceId: string, db: Db = pool) =>
  one<{ computed_at: Date; algorithm_version: string; n: string }>(
    `SELECT max(computed_at) AS computed_at, max(algorithm_version) AS algorithm_version, count(*) AS n
     FROM match_candidates WHERE occurrence_id = $1`,
    [occurrenceId],
    db,
  );
