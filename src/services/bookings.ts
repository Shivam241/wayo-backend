import { tx } from '../db/pool.js';
import * as BookingModel from '../models/booking.js';
import * as RideModel from '../models/ride.js';
import * as UserModel from '../models/user.js';
import * as Audit from '../models/audit.js';
import * as Safety from '../models/safety.js';
import { notify } from './notifications.js';
import { quoteForOccurrence, recalculateForOccurrence } from './cost.js';
import { badRequest, conflict, forbidden, notFound, staleVersion } from '../utils/errors.js';

/** Passenger asks for a seat. Nothing is reserved until the driver accepts. */
export async function requestSeat(
  occurrenceId: string,
  passengerId: string,
  input: { seats?: number; message?: string; pickup?: any; drop?: any },
) {
  const result = await tx(async (c) => {
    const occ = await RideModel.getOccurrence(occurrenceId, c);
    if (!occ) throw notFound('Ride occurrence');
    if (occ.status !== 'scheduled') throw conflict('not_bookable', `Ride is ${occ.status}`);
    if (occ.departs_at < new Date()) throw conflict('departed', 'That ride has already departed');

    const ride = await RideModel.findById(occ.ride_id, c);
    if (!ride) throw notFound('Ride');
    if (ride.driver_id === passengerId) throw badRequest('own_ride', 'You cannot request a seat on your own ride');
    if (await Safety.isBlockedEitherWay(passengerId, ride.driver_id, c)) throw forbidden('Not available');

    const seats = input.seats ?? 1;
    if (occ.seats_total - occ.seats_taken < seats) throw conflict('no_seats', 'No seats left on that ride');

    let req;
    try {
      req = await BookingModel.createRequest(occurrenceId, passengerId, {
        seats,
        message: input.message ?? null,
        pickup_label: input.pickup?.label ?? null,
        pickup_lat: input.pickup?.lat ?? null,
        pickup_lng: input.pickup?.lng ?? null,
        drop_label: input.drop?.label ?? null,
        drop_lat: input.drop?.lat ?? null,
        drop_lng: input.drop?.lng ?? null,
      }, c);
    } catch (err: any) {
      // partial unique index on (occurrence, passenger) where state is live
      if (err.code === '23505') throw conflict('already_requested', 'You already have a live request for this ride');
      throw err;
    }

    await Audit.record({
      entityType: 'booking_request', entityId: req!.id, action: 'request.created', actorId: passengerId,
      toState: 'pending', detail: { occurrenceId, seats },
    }, c);

    return { req: req!, driverId: ride.driver_id, departsAt: occ.departs_at };
  });

  const profile = await UserModel.getProfile(passengerId);
  await notify(result.driverId, 'request_received', {
    name: profile?.display_name ?? 'A passenger',
    when: new Date(result.departsAt).toISOString(),
    requestId: result.req.id,
    occurrenceId,
  });
  return result.req;
}

/**
 * Driver accepts. This is the transaction the whole product hinges on:
 * seat claim, request transition and durable guest row commit together or not
 * at all. The conditional seat UPDATE plus the CHECK constraint make
 * overbooking impossible even when two accepts race.
 */
export async function acceptRequest(requestId: string, driverId: string, expectedVersion?: number) {
  const result = await tx(async (c) => {
    const req = await BookingModel.getRequestForUpdate(requestId, c);
    if (!req) throw notFound('Request');
    if (expectedVersion !== undefined && req.version !== expectedVersion) throw staleVersion('Request', req.version);
    if (req.state !== 'pending') throw conflict('not_pending', `Request is already ${req.state}`);

    const occ = await RideModel.getOccurrenceForUpdate(req.occurrence_id, c);
    if (!occ) throw notFound('Occurrence');
    const ride = await RideModel.findById(occ.ride_id, c);
    if (ride?.driver_id !== driverId) throw forbidden('Only the driver can accept requests');
    if (occ.status === 'cancelled') throw conflict('cancelled', 'That ride was cancelled');

    const claimed = await BookingModel.claimSeats(req.occurrence_id, req.seats, c);
    if (!claimed) throw conflict('no_seats', 'No seats left — the ride filled up');

    await BookingModel.setRequestState(requestId, 'accepted', driverId, c);

    const guest = await BookingModel.createGuest({
      occurrence_id: req.occurrence_id,
      ride_id: occ.ride_id,
      passenger_id: req.passenger_id,
      booking_request_id: req.id,
      seats: req.seats,
      pickup_label: req.pickup_label,
      pickup_lat: req.pickup_lat,
      pickup_lng: req.pickup_lng,
      drop_label: req.drop_label,
      drop_lat: req.drop_lat,
      drop_lng: req.drop_lng,
    } as any, c);

    await Audit.record({
      entityType: 'booking_request', entityId: requestId, action: 'request.accepted', actorId: driverId,
      fromState: 'pending', toState: 'accepted',
      detail: { guestId: guest!.id, seatsTaken: claimed.seats_taken, seatsTotal: claimed.seats_total },
    }, c);
    await Audit.record({
      entityType: 'ride_guest', entityId: guest!.id, action: 'guest.confirmed', actorId: driverId,
      toState: 'confirmed', detail: { occurrenceId: req.occurrence_id, passengerId: req.passenger_id },
    }, c);

    return { guest: guest!, req, departsAt: occ.departs_at, driverName: ride.dest_label };
  });

  // Occupancy changed, so every passenger's share moves.
  const quote = await quoteForOccurrence(result.req.occurrence_id, result.req.passenger_id, {
    persist: true, reason: 'seat accepted',
  });
  await notify(result.req.passenger_id, 'request_accepted', {
    name: 'The driver',
    when: new Date(result.departsAt).toISOString(),
    occurrenceId: result.req.occurrence_id,
    amount: `${quote.currency} ${quote.amount}`,
  });
  for (const m of await recalculateForOccurrence(result.req.occurrence_id, 'occupancy changed')) {
    if (m.passengerId === result.req.passenger_id) continue;
    await notify(m.passengerId, 'contribution_updated', {
      when: new Date(result.departsAt).toISOString(), amount: String(m.to),
      occurrenceId: result.req.occurrence_id,
    });
  }

  return { guest: result.guest, contribution: quote };
}

export async function rejectRequest(requestId: string, driverId: string, reason?: string) {
  const result = await tx(async (c) => {
    const req = await BookingModel.getRequestForUpdate(requestId, c);
    if (!req) throw notFound('Request');
    if (req.state !== 'pending') throw conflict('not_pending', `Request is already ${req.state}`);

    const occ = await RideModel.getOccurrence(req.occurrence_id, c);
    const ride = await RideModel.findById(occ!.ride_id, c);
    if (ride?.driver_id !== driverId) throw forbidden('Only the driver can reject requests');

    const updated = await BookingModel.setRequestState(requestId, 'rejected', driverId, c);
    await Audit.record({
      entityType: 'booking_request', entityId: requestId, action: 'request.rejected', actorId: driverId,
      fromState: 'pending', toState: 'rejected', detail: { reason },
    }, c);
    return { updated: updated!, passengerId: req.passenger_id, departsAt: occ!.departs_at };
  });

  await notify(result.passengerId, 'request_rejected', {
    when: new Date(result.departsAt).toISOString(), occurrenceId: result.updated.occurrence_id,
  });
  return result.updated;
}

/** Passenger withdraws a pending request. */
export async function cancelRequest(requestId: string, passengerId: string) {
  return tx(async (c) => {
    const req = await BookingModel.getRequestForUpdate(requestId, c);
    if (!req) throw notFound('Request');
    if (req.passenger_id !== passengerId) throw forbidden();
    if (req.state !== 'pending') throw conflict('not_pending', `Request is already ${req.state}`);

    const updated = await BookingModel.setRequestState(requestId, 'cancelled', passengerId, c);
    await Audit.record({
      entityType: 'booking_request', entityId: requestId, action: 'request.cancelled', actorId: passengerId,
      fromState: 'pending', toState: 'cancelled',
    }, c);
    return updated;
  });
}

/**
 * A confirmed guest leaves — or is removed by the driver. The seat is released
 * atomically and the guest row survives with its terminal state, so the trip
 * history stays intact.
 */
export async function cancelGuest(guestId: string, actorId: string, reason?: string) {
  const result = await tx(async (c) => {
    const guest = await BookingModel.getGuest(guestId, c);
    if (!guest) throw notFound('Guest');
    if (guest.state !== 'confirmed') throw conflict('not_confirmed', `Guest is already ${guest.state}`);

    const occ = await RideModel.getOccurrenceForUpdate(guest.occurrence_id, c);
    const ride = await RideModel.findById(guest.ride_id, c);
    const byDriver = ride?.driver_id === actorId;
    const byPassenger = guest.passenger_id === actorId;
    if (!byDriver && !byPassenger) throw forbidden();

    const state = byDriver ? 'cancelled_by_driver' : 'cancelled_by_passenger';
    await BookingModel.setGuestState(guestId, state, c);
    await BookingModel.releaseSeats(guest.occurrence_id, guest.seats, c);
    await BookingModel.setRequestState(guest.booking_request_id, 'cancelled', actorId, c);

    await Audit.record({
      entityType: 'ride_guest', entityId: guestId, action: 'guest.cancelled', actorId,
      fromState: 'confirmed', toState: state, detail: { reason },
    }, c);

    return {
      guest, byDriver,
      driverId: ride!.driver_id,
      departsAt: occ!.departs_at,
      occurrenceId: guest.occurrence_id,
    };
  });

  const when = new Date(result.departsAt).toISOString();
  if (result.byDriver) {
    await notify(result.guest.passenger_id, 'ride_cancelled', {
      when, dest: 'your ride', occurrenceId: result.occurrenceId,
    });
  } else {
    const p = await UserModel.getProfile(result.guest.passenger_id);
    await notify(result.driverId, 'guest_cancelled', {
      name: p?.display_name ?? 'A passenger', when, occurrenceId: result.occurrenceId,
    });
  }

  for (const m of await recalculateForOccurrence(result.occurrenceId, 'occupancy changed')) {
    await notify(m.passengerId, 'contribution_updated', {
      when, amount: String(m.to), occurrenceId: result.occurrenceId,
    });
  }
  return { cancelled: true, state: result.byDriver ? 'cancelled_by_driver' : 'cancelled_by_passenger' };
}
