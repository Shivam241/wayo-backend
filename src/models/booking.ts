import { many, one, query, type Db, pool } from '../db/pool.js';

export type BookingRequest = {
  id: string;
  occurrence_id: string;
  passenger_id: string;
  seats: number;
  pickup_label: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  drop_label: string | null;
  drop_lat: number | null;
  drop_lng: number | null;
  message: string | null;
  state: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  version: number;
};

export type RideGuest = {
  id: string;
  occurrence_id: string;
  ride_id: string;
  passenger_id: string;
  booking_request_id: string;
  seats: number;
  state: 'confirmed' | 'cancelled_by_passenger' | 'cancelled_by_driver' | 'no_show' | 'completed';
};

export const createRequest = (
  occurrenceId: string,
  passengerId: string,
  r: Partial<BookingRequest>,
  db: Db = pool,
) =>
  one<BookingRequest>(
    `INSERT INTO booking_requests (occurrence_id, passenger_id, seats, pickup_label, pickup_lat,
       pickup_lng, drop_label, drop_lat, drop_lng, message)
     VALUES ($1,$2,COALESCE($3,1),$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [occurrenceId, passengerId, r.seats ?? null, r.pickup_label ?? null, r.pickup_lat ?? null,
     r.pickup_lng ?? null, r.drop_label ?? null, r.drop_lat ?? null, r.drop_lng ?? null, r.message ?? null],
    db,
  );

export const getRequest = (id: string, db: Db = pool) =>
  one<BookingRequest>('SELECT * FROM booking_requests WHERE id = $1', [id], db);

export const getRequestForUpdate = (id: string, db: Db) =>
  one<BookingRequest>('SELECT * FROM booking_requests WHERE id = $1 FOR UPDATE', [id], db);

export const setRequestState = (
  id: string,
  state: BookingRequest['state'],
  decidedBy: string | null,
  db: Db = pool,
) =>
  one<BookingRequest>(
    `UPDATE booking_requests SET state = $2, decided_by = $3, decided_at = now(),
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, state, decidedBy],
    db,
  );

export const listRequestsForOccurrence = (occurrenceId: string, db: Db = pool) =>
  many(
    `SELECT b.*, p.display_name, p.photo_url, u.phone_verified, u.org_verified
     FROM booking_requests b
     JOIN users u ON u.id = b.passenger_id
     LEFT JOIN profiles p ON p.user_id = b.passenger_id
     WHERE b.occurrence_id = $1 ORDER BY b.created_at`,
    [occurrenceId],
    db,
  );

export const listRequestsByPassenger = (passengerId: string, db: Db = pool) =>
  many(
    `SELECT b.*, o.departs_at, r.id AS ride_id, r.origin_label, r.dest_label,
            p.display_name AS driver_name, p.photo_url AS driver_photo
     FROM booking_requests b
     JOIN ride_occurrences o ON o.id = b.occurrence_id
     JOIN rides r ON r.id = o.ride_id
     LEFT JOIN profiles p ON p.user_id = r.driver_id
     WHERE b.passenger_id = $1
     ORDER BY o.departs_at DESC`,
    [passengerId],
    db,
  );

/** Every pending request the driver must act on, across all their rides. */
export const inboxForDriver = (driverId: string, db: Db = pool) =>
  many(
    `SELECT b.*, o.departs_at, r.id AS ride_id, r.origin_label, r.dest_label,
            p.display_name AS passenger_name, p.photo_url AS passenger_photo,
            u.phone_verified, u.org_verified
     FROM booking_requests b
     JOIN ride_occurrences o ON o.id = b.occurrence_id
     JOIN rides r ON r.id = o.ride_id
     JOIN users u ON u.id = b.passenger_id
     LEFT JOIN profiles p ON p.user_id = b.passenger_id
     WHERE r.driver_id = $1 AND b.state = 'pending' AND o.departs_at > now()
     ORDER BY o.departs_at`,
    [driverId],
    db,
  );

// ------------------------------------------------------------------- guests

export const createGuest = (g: Omit<RideGuest, 'id' | 'state'> & Record<string, unknown>, db: Db) =>
  one<RideGuest>(
    `INSERT INTO ride_guests (occurrence_id, ride_id, passenger_id, booking_request_id, seats,
       pickup_label, pickup_lat, pickup_lng, drop_label, drop_lat, drop_lng)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [g.occurrence_id, g.ride_id, g.passenger_id, g.booking_request_id, g.seats,
     g.pickup_label ?? null, g.pickup_lat ?? null, g.pickup_lng ?? null,
     g.drop_label ?? null, g.drop_lat ?? null, g.drop_lng ?? null],
    db,
  );

/**
 * The guest list. Read straight from ride_guests — never reconstructed from a
 * matching run, so it survives a matching outage, a Redis flush, or an
 * algorithm change.
 */
export const listGuests = (occurrenceId: string, db: Db = pool) =>
  many(
    `SELECT g.*, p.display_name, p.photo_url, u.phone_verified, u.org_verified,
            CASE WHEN g.state = 'confirmed' THEN u.phone ELSE NULL END AS phone
     FROM ride_guests g
     JOIN users u ON u.id = g.passenger_id
     LEFT JOIN profiles p ON p.user_id = g.passenger_id
     WHERE g.occurrence_id = $1
     ORDER BY g.confirmed_at`,
    [occurrenceId],
    db,
  );

export const getGuest = (id: string, db: Db = pool) =>
  one<RideGuest>('SELECT * FROM ride_guests WHERE id = $1', [id], db);

export const findGuest = (occurrenceId: string, passengerId: string, db: Db = pool) =>
  one<RideGuest>(
    `SELECT * FROM ride_guests WHERE occurrence_id = $1 AND passenger_id = $2 AND state = 'confirmed'`,
    [occurrenceId, passengerId],
    db,
  );

export const setGuestState = (id: string, state: RideGuest['state'], db: Db = pool) =>
  one<RideGuest>(
    `UPDATE ride_guests SET state = $2,
       cancelled_at = CASE WHEN $2 LIKE 'cancelled%' THEN now() ELSE cancelled_at END
     WHERE id = $1 RETURNING *`,
    [id, state],
    db,
  );

export const confirmedGuestCount = async (occurrenceId: string, db: Db = pool) =>
  Number(
    (await one<{ n: string }>(
      `SELECT COALESCE(sum(seats),0) AS n FROM ride_guests WHERE occurrence_id = $1 AND state = 'confirmed'`,
      [occurrenceId],
      db,
    ))!.n,
  );

/** Largest confirmed-seat count across a ride's future dates — the floor below
 *  which the driver cannot shrink capacity without stranding someone. */
export const maxConfirmedSeatsForRide = async (rideId: string, db: Db = pool) =>
  Number(
    (await one<{ n: string }>(
      `SELECT COALESCE(max(taken), 0) AS n FROM (
         SELECT sum(g.seats) AS taken FROM ride_guests g
         JOIN ride_occurrences o ON o.id = g.occurrence_id
         WHERE o.ride_id = $1 AND g.state = 'confirmed' AND o.departs_at > now()
         GROUP BY g.occurrence_id) t`,
      [rideId],
      db,
    ))!.n,
  );

/**
 * Atomic seat claim. Returns null when no seat is left — the CHECK constraint
 * plus this conditional UPDATE is what makes overbooking impossible even under
 * concurrent accepts.
 */
export const claimSeats = (occurrenceId: string, seats: number, db: Db) =>
  one<{ id: string; seats_taken: number; seats_total: number }>(
    `UPDATE ride_occurrences
     SET seats_taken = seats_taken + $2,
         status = CASE WHEN seats_taken + $2 >= seats_total THEN 'full' ELSE status END,
         version = version + 1, updated_at = now()
     WHERE id = $1 AND status IN ('scheduled','full') AND seats_taken + $2 <= seats_total
     RETURNING id, seats_taken, seats_total`,
    [occurrenceId, seats],
    db,
  );

export const releaseSeats = (occurrenceId: string, seats: number, db: Db) =>
  one(
    `UPDATE ride_occurrences
     SET seats_taken = GREATEST(0, seats_taken - $2),
         status = CASE WHEN status = 'full' THEN 'scheduled' ELSE status END,
         version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING id, seats_taken, seats_total`,
    [occurrenceId, seats],
    db,
  );

// --------------------------------------------------------- commute requests

export const createCommuteRequest = (passengerId: string, c: Record<string, any>, db: Db = pool) =>
  one(
    `INSERT INTO commute_requests (passenger_id, origin_label, origin_lat, origin_lng,
       dest_label, dest_lat, dest_lng, departure_time, recurrence_days, flex_minutes,
       pickup_radius_km, drop_radius_km)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9::smallint[], '{}'::smallint[]),COALESCE($10,30),COALESCE($11,2.0),COALESCE($12,2.0))
     RETURNING *`,
    [passengerId, c.origin_label, c.origin_lat, c.origin_lng, c.dest_label, c.dest_lat, c.dest_lng,
     c.departure_time, c.recurrence_days ?? null, c.flex_minutes ?? null,
     c.pickup_radius_km ?? null, c.drop_radius_km ?? null],
    db,
  );

export const listCommuteRequests = (passengerId: string, db: Db = pool) =>
  many('SELECT * FROM commute_requests WHERE passenger_id = $1 AND active ORDER BY created_at DESC', [passengerId], db);

export const deactivateCommuteRequest = (id: string, passengerId: string, db: Db = pool) =>
  one('UPDATE commute_requests SET active = false WHERE id = $1 AND passenger_id = $2 RETURNING id', [id, passengerId], db);

// --------------------------------------------------------------- idempotency

export const findIdempotent = (key: string, userId: string, db: Db = pool) =>
  one<{ status_code: number; response: unknown }>(
    'SELECT status_code, response FROM idempotency_keys WHERE key = $1 AND user_id = $2',
    [key, userId],
    db,
  );

/** Claims the key. Returns false when another in-flight request already holds it. */
export const claimIdempotencyKey = async (key: string, userId: string, endpoint: string, db: Db = pool) => {
  const res = await query(
    `INSERT INTO idempotency_keys (key, user_id, endpoint) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, userId, endpoint],
    db,
  );
  return res.rowCount === 1;
};

export const storeIdempotentResult = (key: string, status: number, response: unknown, db: Db = pool) =>
  query('UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1', [key, status, response], db);

export const releaseIdempotencyKey = (key: string, db: Db = pool) =>
  query('DELETE FROM idempotency_keys WHERE key = $1 AND status_code IS NULL', [key], db);
