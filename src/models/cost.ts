import { many, one, type Db, pool } from '../db/pool.js';

export type FuelPrice = {
  id: string;
  region: string;
  fuel_type: string;
  price: number;
  currency: string;
  source: string;
  effective_from: Date;
};

export type CostCalculation = {
  id: string;
  occurrence_id: string;
  passenger_id: string | null;
  distance_km: number;
  fuel_price: number;
  fuel_price_id: string | null;
  efficiency_kmpl: number;
  occupants: number;
  driver_share: number;
  trip_fuel_cost: number;
  amount: number;
  currency: string;
  formula_version: string;
  reason: string | null;
  created_at: Date;
};

export const currentFuelPrice = (region: string, fuelType: string, db: Db = pool) =>
  one<FuelPrice>(
    `SELECT * FROM fuel_prices
     WHERE region = $1 AND fuel_type = $2 AND effective_from <= now()
     ORDER BY effective_from DESC LIMIT 1`,
    [region, fuelType],
    db,
  );

export const listFuelPrices = (db: Db = pool) =>
  many<FuelPrice>(
    `SELECT DISTINCT ON (region, fuel_type) * FROM fuel_prices
     WHERE effective_from <= now() ORDER BY region, fuel_type, effective_from DESC`,
    [],
    db,
  );

export const setFuelPrice = (p: Partial<FuelPrice>, db: Db = pool) =>
  one<FuelPrice>(
    `INSERT INTO fuel_prices (region, fuel_type, price, currency, source, effective_from)
     VALUES ($1,$2,$3,COALESCE($4,'INR'),$5,COALESCE($6, now())) RETURNING *`,
    [p.region, p.fuel_type, p.price, p.currency ?? null, p.source ?? 'admin', p.effective_from ?? null],
    db,
  );

export const saveCalculation = (c: Partial<CostCalculation>, db: Db = pool) =>
  one<CostCalculation>(
    `INSERT INTO cost_calculations (occurrence_id, passenger_id, distance_km, fuel_price, fuel_price_id,
       efficiency_kmpl, occupants, driver_share, trip_fuel_cost, amount, currency, formula_version, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [c.occurrence_id, c.passenger_id ?? null, c.distance_km, c.fuel_price, c.fuel_price_id ?? null,
     c.efficiency_kmpl, c.occupants, c.driver_share, c.trip_fuel_cost, c.amount,
     c.currency, c.formula_version, c.reason ?? null],
    db,
  );

export const latestCalculation = (occurrenceId: string, passengerId: string | null, db: Db = pool) =>
  one<CostCalculation>(
    `SELECT * FROM cost_calculations
     WHERE occurrence_id = $1 AND (passenger_id = $2 OR ($2::uuid IS NULL AND passenger_id IS NULL))
     ORDER BY created_at DESC LIMIT 1`,
    [occurrenceId, passengerId],
    db,
  );

export const calculationHistory = (occurrenceId: string, db: Db = pool) =>
  many<CostCalculation>(
    'SELECT * FROM cost_calculations WHERE occurrence_id = $1 ORDER BY created_at DESC LIMIT 20',
    [occurrenceId],
    db,
  );
