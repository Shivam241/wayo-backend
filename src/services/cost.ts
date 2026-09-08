import { config } from '../config/index.js';
import * as CostModel from '../models/cost.js';
import * as RideModel from '../models/ride.js';
import * as BookingModel from '../models/booking.js';
import * as UserModel from '../models/user.js';
import type { Db } from '../db/pool.js';
import { pool } from '../db/pool.js';

export type CostInputs = {
  distanceKm: number;
  fuelPrice: number;
  efficiencyKmpl: number;
  occupants: number; // driver + confirmed passengers
  driverShare: number; // fraction of the fuel cost the driver absorbs
};

export type CostBreakdown = CostInputs & {
  tripFuelCost: number;
  amount: number;
  currency: string;
  formulaVersion: string;
  rounding: number;
  note: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Suggested contribution — not a fare.
 *
 *   tripFuelCost = distance / efficiency * fuelPrice
 *   passengerShare = tripFuelCost * (1 - driverShare) / passengerCount
 *
 * Pure and deterministic; every displayed amount is stored with these inputs
 * and the formula version that produced it.
 */
export function calculate(i: CostInputs): CostBreakdown {
  const { roundToNearest, minAmount, maxAmount, currency, formulaVersion } = config.cost;
  const passengers = Math.max(1, i.occupants - 1); // the driver is not a payer

  const tripFuelCost = round2((i.distanceKm / i.efficiencyKmpl) * i.fuelPrice);
  const raw = (tripFuelCost * (1 - i.driverShare)) / passengers;

  const rounded = Math.round(raw / roundToNearest) * roundToNearest;
  const amount = Math.min(maxAmount, Math.max(minAmount, rounded));

  return {
    ...i,
    tripFuelCost,
    amount,
    currency,
    formulaVersion,
    rounding: roundToNearest,
    note: `${i.distanceKm} km ÷ ${i.efficiencyKmpl} km/l × ${currency} ${i.fuelPrice} = ${currency} ${tripFuelCost}; ` +
      `driver absorbs ${Math.round(i.driverShare * 100)}%, remainder split between ${passengers} passenger(s)`,
  };
}

/**
 * Resolves the live inputs for an occurrence and calculates the suggested
 * contribution. `persist` stores the audit row; skip it for a preview.
 */
export async function quoteForOccurrence(
  occurrenceId: string,
  passengerId: string | null,
  opts: { persist?: boolean; reason?: string; region?: string; db?: Db } = {},
): Promise<CostBreakdown & { fuelPriceId: string | null; source: string; degraded: boolean }> {
  const db = opts.db ?? pool;
  const occ = await RideModel.getOccurrence(occurrenceId, db);
  if (!occ) throw new Error(`occurrence ${occurrenceId} not found`);

  const ride = await RideModel.findById(occ.ride_id, db);
  const route = await RideModel.currentRoute(occ.ride_id, db);
  const vehicle = ride?.vehicle_id
    ? await UserModel.getVehicle(ride.vehicle_id, db)
    : ride
      ? await UserModel.getDefaultVehicle(ride.driver_id, db)
      : null;

  const fuelType = vehicle?.fuel_type ?? 'petrol';
  const region = opts.region ?? config.cost.defaultRegion;
  const price = await CostModel.currentFuelPrice(region, fuelType, db);

  // Route distance, never straight-line. Falls back to the ride's own distance
  // if the route row is missing so a mapping outage still yields an amount.
  const distanceKm = Number(route?.distance_km ?? 0) || 0;
  const efficiencyKmpl = Number(vehicle?.efficiency_kmpl ?? config.cost.defaultEfficiencyKmpl);

  // Occupancy = driver + confirmed guests (+ this passenger if not yet a guest).
  const guests = await BookingModel.confirmedGuestCount(occurrenceId, db);
  const alreadyGuest = passengerId ? await BookingModel.findGuest(occurrenceId, passengerId, db) : null;
  const occupants = 1 + guests + (passengerId && !alreadyGuest ? 1 : 0);

  const breakdown = calculate({
    distanceKm,
    fuelPrice: Number(price?.price ?? 0) || 100,
    efficiencyKmpl,
    occupants,
    driverShare: config.cost.driverShare,
  });

  if (opts.persist) {
    await CostModel.saveCalculation({
      occurrence_id: occurrenceId,
      passenger_id: passengerId,
      distance_km: breakdown.distanceKm,
      fuel_price: breakdown.fuelPrice,
      fuel_price_id: price?.id ?? null,
      efficiency_kmpl: breakdown.efficiencyKmpl,
      occupants: breakdown.occupants,
      driver_share: breakdown.driverShare,
      trip_fuel_cost: breakdown.tripFuelCost,
      amount: breakdown.amount,
      currency: breakdown.currency,
      formula_version: breakdown.formulaVersion,
      reason: opts.reason ?? null,
    }, db);
  }

  return {
    ...breakdown,
    fuelPriceId: price?.id ?? null,
    source: price?.source ?? 'default',
    degraded: !price || distanceKm === 0,
  };
}

/**
 * Recalculates every passenger's share after occupancy or route changes, and
 * returns the ones whose amount actually moved so they can be notified.
 */
export async function recalculateForOccurrence(occurrenceId: string, reason: string, db: Db = pool) {
  const guests = await BookingModel.listGuests(occurrenceId, db);
  const changed: { passengerId: string; from: number | null; to: number }[] = [];

  for (const g of guests.filter((x: any) => x.state === 'confirmed')) {
    const previous = await CostModel.latestCalculation(occurrenceId, g.passenger_id, db);
    const next = await quoteForOccurrence(occurrenceId, g.passenger_id, { persist: true, reason, db });
    if (!previous || Number(previous.amount) !== next.amount) {
      changed.push({ passengerId: g.passenger_id, from: previous ? Number(previous.amount) : null, to: next.amount });
    }
  }
  return changed;
}
