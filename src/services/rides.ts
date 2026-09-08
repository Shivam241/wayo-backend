import { config } from '../config/index.js';
import { pool, tx, type Db } from '../db/pool.js';
import * as RideModel from '../models/ride.js';
import * as BookingModel from '../models/booking.js';
import * as Audit from '../models/audit.js';
import { getRoute } from './routeProvider.js';
import { notify, notifyMany } from './notifications.js';
import { recalculateForOccurrence } from './cost.js';
import { badRequest, conflict, forbidden, notFound, staleVersion } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 864e5;
/** UTC-anchored calendar arithmetic — these are calendar dates, not instants. */
const toISODate = (d: Date) => d.toISOString().slice(0, 10);
const fromISODate = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * Calendar dates (YYYY-MM-DD, local to the app timezone) a ride should have
 * occurrences for. Returns dates only — Postgres pairs each with the ride's
 * wall-clock departure time and converts to an instant, so this stays free of
 * timezone arithmetic.
 */
export function occurrenceDates(
  ride: Pick<RideModel.Ride, 'is_recurring' | 'recurrence_days' | 'series_start_date' | 'series_end_date'>,
  horizonDays = config.occurrenceHorizonDays,
  now = new Date(),
): string[] {
  const today = fromISODate(toISODate(now));
  const start = fromISODate(String(ride.series_start_date).slice(0, 10));
  const horizonEnd = new Date(+today + horizonDays * DAY_MS);
  const end = ride.series_end_date ? fromISODate(String(ride.series_end_date).slice(0, 10)) : horizonEnd;
  const last = end < horizonEnd ? end : horizonEnd;

  if (!ride.is_recurring) return start >= today && start <= last ? [toISODate(start)] : [];
  if (ride.recurrence_days.length === 0) return [];

  const out: string[] = [];
  for (let d = new Date(Math.max(+start, +today)); d <= last; d = new Date(+d + DAY_MS)) {
    if (ride.recurrence_days.includes(d.getUTCDay())) out.push(toISODate(d));
  }
  return out;
}

/** Idempotent: safe to re-run on edit, publish, or from the nightly job. */
export async function generateOccurrences(rideId: string, db: Db = pool): Promise<number> {
  const ride = await RideModel.findById(rideId, db);
  if (!ride) throw notFound('Ride');
  if (ride.status !== 'published') return 0;

  let created = 0;
  for (const date of occurrenceDates(ride)) {
    const row = await RideModel.upsertOccurrence(
      rideId, date, String(ride.departure_time), config.timezone, ride.seats_total, db,
    );
    if (row) created++;
  }
  return created;
}

/** Resolves and stores the ride's route. Never fails ride creation. */
export async function resolveRoute(ride: RideModel.Ride, db: Db = pool) {
  try {
    const route = await getRoute(
      { lat: ride.origin_lat, lng: ride.origin_lng },
      { lat: ride.dest_lat, lng: ride.dest_lng },
    );
    return await RideModel.saveRoute(ride.id, route, db);
  } catch (err) {
    logger.error({ err, rideId: ride.id }, 'route resolution failed — ride kept, route deferred');
    return null;
  }
}

export async function publish(rideId: string, actorId: string) {
  const ride = await RideModel.findById(rideId);
  if (!ride) throw notFound('Ride');
  if (ride.driver_id !== actorId) throw forbidden();
  if (ride.status === 'cancelled') throw conflict('ride_cancelled', 'A cancelled ride cannot be published');

  await resolveRoute(ride);
  const published = await RideModel.setStatus(rideId, 'published');
  const count = await generateOccurrences(rideId);
  await Audit.record({
    entityType: 'ride', entityId: rideId, action: 'ride.published', actorId,
    fromState: ride.status, toState: 'published', detail: { occurrences: count },
  });
  return { ride: published, occurrences: count };
}

/** Material changes trigger a controlled re-match — they never delete guests. */
const MATERIAL = ['origin_lat', 'origin_lng', 'dest_lat', 'dest_lng', 'departure_time', 'recurrence_days'] as const;

export async function edit(
  rideId: string,
  actorId: string,
  expectedVersion: number,
  patch: Partial<RideModel.Ride>,
) {
  return tx(async (c) => {
    const before = await RideModel.findByIdForUpdate(rideId, c);
    if (!before) throw notFound('Ride');
    if (before.driver_id !== actorId) throw forbidden();
    if (before.version !== expectedVersion) throw staleVersion('Ride', before.version);

    // Shrinking capacity below the seats already confirmed would strand guests.
    if (patch.seats_total !== undefined) {
      const guestSeats = await BookingModel.maxConfirmedSeatsForRide(rideId, c);
      if (patch.seats_total < guestSeats) {
        throw conflict('seats_below_confirmed', `${guestSeats} seats are already confirmed`);
      }
    }

    const after = await RideModel.updateWithVersion(rideId, expectedVersion, patch, c);
    if (!after) throw staleVersion('Ride', before.version);

    const material = MATERIAL.filter(
      (k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k]),
    );

    await Audit.record({
      entityType: 'ride', entityId: rideId, action: 'ride.edited', actorId,
      detail: { material, patch, fromVersion: before.version, toVersion: after.version },
    }, c);

    // Confirmed guests on affected dates are informed, never silently dropped.
    const affected = material.length > 0 ? await RideModel.futureOccurrencesWithGuests(rideId, c) : [];
    return { ride: after, material, affectedOccurrences: affected };
  }).then(async (result) => {
    if (result.material.length > 0) {
      await resolveRoute(result.ride!);
      await generateOccurrences(rideId);
      for (const occ of result.affectedOccurrences) {
        const guests = await BookingModel.listGuests(occ.id);
        await notifyMany(
          guests.filter((g: any) => g.state === 'confirmed').map((g: any) => g.passenger_id),
          'ride_modified',
          { when: new Date(occ.departs_at).toISOString(), change: result.material.join(', '), occurrenceId: occ.id },
        );
        const moved = await recalculateForOccurrence(occ.id, 'ride edited');
        for (const m of moved) {
          await notify(m.passengerId, 'contribution_updated', {
            when: new Date(occ.departs_at).toISOString(), amount: String(m.to), occurrenceId: occ.id,
          });
        }
      }
    }
    return result;
  });
}

/** Cancels the whole series. Guests are released and notified, never orphaned. */
export async function cancelRide(rideId: string, actorId: string, reason: string) {
  const affected = await tx(async (c) => {
    const ride = await RideModel.findByIdForUpdate(rideId, c);
    if (!ride) throw notFound('Ride');
    if (ride.driver_id !== actorId) throw forbidden();

    const withGuests = await RideModel.futureOccurrencesWithGuests(rideId, c);
    const guestRows: { occurrenceId: string; departsAt: Date; passengerId: string }[] = [];

    for (const occ of withGuests) {
      for (const g of await BookingModel.listGuests(occ.id, c)) {
        if (g.state !== 'confirmed') continue;
        await BookingModel.setGuestState(g.id, 'cancelled_by_driver', c);
        await BookingModel.releaseSeats(occ.id, g.seats, c);
        guestRows.push({ occurrenceId: occ.id, departsAt: occ.departs_at, passengerId: g.passenger_id });
      }
      await RideModel.setOccurrenceStatus(occ.id, 'cancelled', c);
    }
    await RideModel.cancelEmptyFutureOccurrences(rideId, c);
    await RideModel.setStatus(rideId, 'cancelled', c);

    await Audit.record({
      entityType: 'ride', entityId: rideId, action: 'ride.cancelled', actorId,
      fromState: ride.status, toState: 'cancelled',
      detail: { reason, affectedGuests: guestRows.length },
    }, c);

    return { guestRows, dest: ride.dest_label };
  });

  for (const g of affected.guestRows) {
    await notify(g.passengerId, 'ride_cancelled', {
      when: new Date(g.departsAt).toISOString(), dest: affected.dest, occurrenceId: g.occurrenceId,
    });
  }
  return { cancelledGuests: affected.guestRows.length };
}

/** Cancels a single date without touching the recurring series. */
export async function cancelOccurrence(occurrenceId: string, actorId: string, reason: string) {
  const result = await tx(async (c) => {
    const occ = await RideModel.getOccurrenceForUpdate(occurrenceId, c);
    if (!occ) throw notFound('Occurrence');
    const ride = await RideModel.findById(occ.ride_id, c);
    if (ride?.driver_id !== actorId) throw forbidden();

    const passengers: string[] = [];
    for (const g of await BookingModel.listGuests(occurrenceId, c)) {
      if (g.state !== 'confirmed') continue;
      await BookingModel.setGuestState(g.id, 'cancelled_by_driver', c);
      passengers.push(g.passenger_id);
    }
    await RideModel.setOccurrenceStatus(occurrenceId, 'cancelled', c);
    await Audit.record({
      entityType: 'occurrence', entityId: occurrenceId, action: 'occurrence.cancelled', actorId,
      fromState: occ.status, toState: 'cancelled', detail: { reason, passengers: passengers.length },
    }, c);
    return { passengers, departsAt: occ.departs_at, dest: ride!.dest_label };
  });

  await notifyMany(result.passengers, 'ride_cancelled', {
    when: new Date(result.departsAt).toISOString(), dest: result.dest, occurrenceId,
  });
  return { cancelledGuests: result.passengers.length };
}

export async function completeOccurrence(occurrenceId: string, actorId: string) {
  return tx(async (c) => {
    const occ = await RideModel.getOccurrenceForUpdate(occurrenceId, c);
    if (!occ) throw notFound('Occurrence');
    const ride = await RideModel.findById(occ.ride_id, c);
    if (ride?.driver_id !== actorId) throw forbidden();
    if (occ.status === 'cancelled') throw badRequest('cancelled', 'A cancelled ride cannot be completed');

    for (const g of await BookingModel.listGuests(occurrenceId, c)) {
      if (g.state === 'confirmed') await BookingModel.setGuestState(g.id, 'completed', c);
    }
    const done = await RideModel.setOccurrenceStatus(occurrenceId, 'completed', c);
    await Audit.record({
      entityType: 'occurrence', entityId: occurrenceId, action: 'occurrence.completed', actorId,
      fromState: occ.status, toState: 'completed',
    }, c);
    return done;
  });
}
