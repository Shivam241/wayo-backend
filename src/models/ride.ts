import { many, one, query, type Db, pool } from '../db/pool.js';
import type { LatLng } from '../utils/geo.js';

export type Ride = {
  id: string;
  driver_id: string;
  vehicle_id: string | null;
  origin_label: string;
  origin_lat: number;
  origin_lng: number;
  dest_label: string;
  dest_lat: number;
  dest_lng: number;
  is_recurring: boolean;
  recurrence_days: number[];
  departure_time: string;
  series_start_date: string;
  series_end_date: string | null;
  seats_total: number;
  notes: string | null;
  status: 'draft' | 'published' | 'paused' | 'cancelled' | 'expired';
  version: number;
};

export type Occurrence = {
  id: string;
  ride_id: string;
  departs_at: Date;
  seats_total: number;
  seats_taken: number;
  status: 'scheduled' | 'full' | 'in_progress' | 'completed' | 'cancelled' | 'expired';
  version: number;
};

export type RideRoute = {
  id: string;
  ride_id: string;
  provider: string;
  polyline: string;
  geometry: LatLng[];
  distance_km: number;
  duration_min: number;
  fingerprint: string;
  is_current: boolean;
};

export const create = (driverId: string, r: Partial<Ride>, db: Db = pool) =>
  one<Ride>(
    `INSERT INTO rides (driver_id, vehicle_id, origin_label, origin_lat, origin_lng,
       dest_label, dest_lat, dest_lng, is_recurring, recurrence_days, departure_time,
       series_start_date, series_end_date, seats_total, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,false),COALESCE($10::smallint[], '{}'::smallint[]),$11,$12,$13,$14,$15,'draft')
     RETURNING *`,
    [driverId, r.vehicle_id ?? null, r.origin_label, r.origin_lat, r.origin_lng,
     r.dest_label, r.dest_lat, r.dest_lng, r.is_recurring ?? null, r.recurrence_days ?? null,
     r.departure_time, r.series_start_date, r.series_end_date ?? null, r.seats_total, r.notes ?? null],
    db,
  );

export const findById = (id: string, db: Db = pool) =>
  one<Ride>('SELECT * FROM rides WHERE id = $1', [id], db);

/** Locks the row so concurrent edits serialize behind each other. */
export const findByIdForUpdate = (id: string, db: Db) =>
  one<Ride>('SELECT * FROM rides WHERE id = $1 FOR UPDATE', [id], db);

export const listByDriver = (driverId: string, db: Db = pool) =>
  many<Ride>(
    `SELECT r.*, (SELECT count(*) FROM ride_occurrences o
                   WHERE o.ride_id = r.id AND o.status = 'scheduled' AND o.departs_at > now()) AS upcoming_count
     FROM rides r WHERE r.driver_id = $1 AND r.status <> 'cancelled'
     ORDER BY r.created_at DESC`,
    [driverId],
    db,
  );

/**
 * Version-checked update. A stale mobile client cannot silently overwrite
 * newer server state — it gets a 409 and refetches.
 */
export const updateWithVersion = (id: string, expectedVersion: number, patch: Partial<Ride>, db: Db) =>
  one<Ride>(
    `UPDATE rides SET
       vehicle_id = COALESCE($3, vehicle_id),
       origin_label = COALESCE($4, origin_label),
       origin_lat = COALESCE($5, origin_lat),
       origin_lng = COALESCE($6, origin_lng),
       dest_label = COALESCE($7, dest_label),
       dest_lat = COALESCE($8, dest_lat),
       dest_lng = COALESCE($9, dest_lng),
       recurrence_days = COALESCE($10::smallint[], recurrence_days),
       departure_time = COALESCE($11, departure_time),
       series_end_date = COALESCE($12, series_end_date),
       seats_total = COALESCE($13, seats_total),
       notes = COALESCE($14, notes),
       version = version + 1,
       updated_at = now()
     WHERE id = $1 AND version = $2
     RETURNING *`,
    [id, expectedVersion, patch.vehicle_id ?? null, patch.origin_label ?? null, patch.origin_lat ?? null,
     patch.origin_lng ?? null, patch.dest_label ?? null, patch.dest_lat ?? null, patch.dest_lng ?? null,
     patch.recurrence_days ?? null, patch.departure_time ?? null, patch.series_end_date ?? null,
     patch.seats_total ?? null, patch.notes ?? null],
    db,
  );

export const setStatus = (id: string, status: Ride['status'], db: Db = pool) =>
  one<Ride>(
    'UPDATE rides SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status],
    db,
  );

export const setPreferences = (rideId: string, p: Record<string, unknown>, db: Db = pool) =>
  one(
    `INSERT INTO ride_preferences (ride_id, smoking, pets, luggage, music, conversation, gender_pref,
       pickup_radius_km, drop_radius_km, max_detour_km, max_detour_min, time_window_min)
     VALUES ($1, COALESCE($2,false), COALESCE($3,false), COALESCE($4,'small'), COALESCE($5,true),
             COALESCE($6,'any'), COALESCE($7,'any'), COALESCE($8,2.0), COALESCE($9,2.0),
             COALESCE($10,5.0), COALESCE($11,15), COALESCE($12,30))
     ON CONFLICT (ride_id) DO UPDATE SET
       smoking = COALESCE($2, ride_preferences.smoking),
       pets = COALESCE($3, ride_preferences.pets),
       luggage = COALESCE($4, ride_preferences.luggage),
       music = COALESCE($5, ride_preferences.music),
       conversation = COALESCE($6, ride_preferences.conversation),
       gender_pref = COALESCE($7, ride_preferences.gender_pref),
       pickup_radius_km = COALESCE($8, ride_preferences.pickup_radius_km),
       drop_radius_km = COALESCE($9, ride_preferences.drop_radius_km),
       max_detour_km = COALESCE($10, ride_preferences.max_detour_km),
       max_detour_min = COALESCE($11, ride_preferences.max_detour_min),
       time_window_min = COALESCE($12, ride_preferences.time_window_min)
     RETURNING *`,
    [rideId, p.smoking ?? null, p.pets ?? null, p.luggage ?? null, p.music ?? null, p.conversation ?? null,
     p.gender_pref ?? null, p.pickup_radius_km ?? null, p.drop_radius_km ?? null, p.max_detour_km ?? null,
     p.max_detour_min ?? null, p.time_window_min ?? null],
    db,
  );

export const getPreferences = (rideId: string, db: Db = pool) =>
  one('SELECT * FROM ride_preferences WHERE ride_id = $1', [rideId], db);

// -------------------------------------------------------------------- route

export async function saveRoute(
  rideId: string,
  route: { provider: string; polyline: string; geometry: LatLng[]; distanceKm: number; durationMin: number; fingerprint: string },
  db: Db = pool,
): Promise<RideRoute> {
  await query('UPDATE ride_routes SET is_current = false WHERE ride_id = $1 AND is_current', [rideId], db);
  return (await one<RideRoute>(
    `INSERT INTO ride_routes (ride_id, provider, polyline, geometry, distance_km, duration_min, fingerprint, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
    [rideId, route.provider, route.polyline, JSON.stringify(route.geometry), route.distanceKm, route.durationMin, route.fingerprint],
    db,
  ))!;
}

export const currentRoute = (rideId: string, db: Db = pool) =>
  one<RideRoute>('SELECT * FROM ride_routes WHERE ride_id = $1 AND is_current', [rideId], db);

// --------------------------------------------------------------- occurrences

export const getOccurrence = (id: string, db: Db = pool) =>
  one<Occurrence & { ride_id: string }>('SELECT * FROM ride_occurrences WHERE id = $1', [id], db);

export const getOccurrenceForUpdate = (id: string, db: Db) =>
  one<Occurrence>('SELECT * FROM ride_occurrences WHERE id = $1 FOR UPDATE', [id], db);

export const listOccurrences = (rideId: string, from?: Date, db: Db = pool) =>
  many<Occurrence>(
    `SELECT * FROM ride_occurrences
     WHERE ride_id = $1 AND ($2::timestamptz IS NULL OR departs_at >= $2)
     ORDER BY departs_at`,
    [rideId, from ?? null],
    db,
  );

/**
 * Idempotent: re-running occurrence generation never duplicates a date.
 * The local date + wall-clock time are converted to an instant by Postgres in
 * the app timezone, so the stored instant does not depend on the server's TZ.
 * Dates already in the past are skipped rather than inserted.
 */
export const upsertOccurrence = (
  rideId: string,
  localDate: string,
  localTime: string,
  timezone: string,
  seats: number,
  db: Db = pool,
) =>
  one<Occurrence>(
    `INSERT INTO ride_occurrences (ride_id, departs_at, seats_total)
     SELECT $1, ts, $5 FROM (SELECT ($2::date + $3::time) AT TIME ZONE $4 AS ts) t
     WHERE t.ts > now()
     ON CONFLICT (ride_id, departs_at) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [rideId, localDate, localTime, timezone, seats],
    db,
  );

export const setOccurrenceStatus = (id: string, status: Occurrence['status'], db: Db = pool) =>
  one<Occurrence>(
    'UPDATE ride_occurrences SET status = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *',
    [id, status],
    db,
  );

/**
 * Cancels future occurrences with no confirmed guests. Occurrences that DO have
 * guests are left alone — cancelling those is an explicit, notified action.
 */
export const cancelEmptyFutureOccurrences = (rideId: string, db: Db) =>
  many<Occurrence>(
    `UPDATE ride_occurrences o SET status = 'cancelled', version = version + 1, updated_at = now()
     WHERE o.ride_id = $1 AND o.departs_at > now() AND o.status = 'scheduled'
       AND NOT EXISTS (SELECT 1 FROM ride_guests g WHERE g.occurrence_id = o.id AND g.state = 'confirmed')
     RETURNING *`,
    [rideId],
    db,
  );

export const futureOccurrencesWithGuests = (rideId: string, db: Db = pool) =>
  many<Occurrence>(
    `SELECT DISTINCT o.* FROM ride_occurrences o
     JOIN ride_guests g ON g.occurrence_id = o.id AND g.state = 'confirmed'
     WHERE o.ride_id = $1 AND o.departs_at > now() AND o.status <> 'cancelled'
     ORDER BY o.departs_at`,
    [rideId],
    db,
  );

/** Occurrence + its ride + driver, the shape every detail screen needs. */
export const occurrenceDetail = (id: string, db: Db = pool) =>
  one(
    // r.* first, then the occurrence columns — a later column of the same name
    // wins, and the detail screen needs the occurrence's seat counts, not the
    // series-level ones.
    `SELECT r.*,
            o.id AS occurrence_id, o.departs_at, o.seats_total, o.seats_taken,
            o.status AS occurrence_status, o.version AS occurrence_version,
            rr.polyline, rr.geometry, rr.distance_km, rr.duration_min, rr.fingerprint,
            p.display_name AS driver_name, p.photo_url AS driver_photo,
            u.phone_verified AS driver_phone_verified, u.org_verified AS driver_org_verified,
            v.make, v.model, v.color, v.vehicle_type, v.fuel_type, v.efficiency_kmpl,
            CASE WHEN v.plate_visible THEN v.plate ELSE NULL END AS plate,
            row_to_json(pref.*) AS preferences
     FROM ride_occurrences o
     JOIN rides r ON r.id = o.ride_id
     JOIN users u ON u.id = r.driver_id
     LEFT JOIN profiles p ON p.user_id = r.driver_id
     LEFT JOIN vehicles v ON v.id = r.vehicle_id
     LEFT JOIN ride_routes rr ON rr.ride_id = r.id AND rr.is_current
     LEFT JOIN ride_preferences pref ON pref.ride_id = r.id
     WHERE o.id = $1`,
    [id],
    db,
  );

/** Upcoming trips for a user in both roles, driver and passenger. */
export const upcomingForUser = (userId: string, db: Db = pool) =>
  many(
    `SELECT o.id AS occurrence_id, o.departs_at, o.seats_total, o.seats_taken, o.status,
            r.id AS ride_id, r.origin_label, r.dest_label, r.driver_id,
            'driver' AS role,
            (SELECT count(*) FROM ride_guests g WHERE g.occurrence_id = o.id AND g.state = 'confirmed') AS guest_count,
            (SELECT count(*) FROM booking_requests b WHERE b.occurrence_id = o.id AND b.state = 'pending') AS pending_count
     FROM ride_occurrences o JOIN rides r ON r.id = o.ride_id
     WHERE r.driver_id = $1 AND o.departs_at > now() - interval '2 hours'
       AND o.status IN ('scheduled','full','in_progress')
     UNION ALL
     SELECT o.id, o.departs_at, o.seats_total, o.seats_taken, o.status,
            r.id, r.origin_label, r.dest_label, r.driver_id,
            'passenger', 0, 0
     FROM ride_guests g
     JOIN ride_occurrences o ON o.id = g.occurrence_id
     JOIN rides r ON r.id = o.ride_id
     WHERE g.passenger_id = $1 AND g.state = 'confirmed'
       AND o.departs_at > now() - interval '2 hours'
       AND o.status IN ('scheduled','full','in_progress')
     ORDER BY departs_at`,
    [userId],
    db,
  );

export const historyForUser = (userId: string, limit = 50, db: Db = pool) =>
  many(
    `SELECT o.id AS occurrence_id, o.departs_at, o.status, r.origin_label, r.dest_label,
            'driver' AS role, r.id AS ride_id
     FROM ride_occurrences o JOIN rides r ON r.id = o.ride_id
     WHERE r.driver_id = $1 AND o.status IN ('completed','cancelled','expired')
     UNION ALL
     SELECT o.id, o.departs_at, o.status, r.origin_label, r.dest_label, 'passenger', r.id
     FROM ride_guests g JOIN ride_occurrences o ON o.id = g.occurrence_id JOIN rides r ON r.id = o.ride_id
     WHERE g.passenger_id = $1 AND g.state IN ('completed','cancelled_by_passenger','cancelled_by_driver','no_show')
     ORDER BY departs_at DESC LIMIT $2`,
    [userId, limit],
    db,
  );
