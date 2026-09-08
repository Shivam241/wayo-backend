import { fileURLToPath } from 'node:url';
import { pool, one } from './pool.js';
import { migrate } from './migrate.js';
import * as UserModel from '../models/user.js';
import * as RideModel from '../models/ride.js';
import * as CostModel from '../models/cost.js';
import * as RideService from '../services/rides.js';
import { logger } from '../utils/logger.js';

// Delhi NCR corridor — Gurgaon to Noida via the ring road.
const PLACES = {
  gurgaon: { label: 'Cyber City, Gurgaon', lat: 28.4949, lng: 77.0895 },
  saket: { label: 'Saket, New Delhi', lat: 28.5245, lng: 77.2066 },
  noida: { label: 'Sector 62, Noida', lat: 28.6280, lng: 77.3649 },
  dwarka: { label: 'Dwarka Sector 21', lat: 28.5523, lng: 77.0587 },
};

async function devUser(uid: string, name: string, email: string) {
  const existing = await UserModel.findByProvider('dev', uid);
  if (existing) return existing;
  const user = (await UserModel.create({ email, emailVerified: true, phone: null }))!;
  await UserModel.linkProvider(user.id, 'dev', uid);
  await UserModel.upsertProfile(user.id, {
    display_name: name,
    preferred_role: 'both',
    commute_days: [1, 2, 3, 4, 5],
    onboarded: true,
  });
  return user;
}

async function seed() {
  await migrate();

  for (const [fuel, price] of [['petrol', 96.72], ['diesel', 89.62], ['cng', 76.59]] as const) {
    const current = await CostModel.currentFuelPrice('IN-DL', fuel);
    if (!current) await CostModel.setFuelPrice({ region: 'IN-DL', fuel_type: fuel, price, source: 'seed' });
  }

  const driver = await devUser('driver1', 'Asha Menon', 'asha@example.com');
  const passenger = await devUser('rider1', 'Vikram Rao', 'vikram@example.com');

  let vehicle = (await UserModel.listVehicles(driver.id))[0];
  if (!vehicle) {
    vehicle = (await UserModel.createVehicle(driver.id, {
      make: 'Maruti', model: 'Baleno', color: 'Blue', plate: 'DL3CAB1234',
      fuel_type: 'petrol', efficiency_kmpl: 18.5, seats: 4, is_default: true,
    }))!;
  }

  const already = await one('SELECT id FROM rides WHERE driver_id = $1 LIMIT 1', [driver.id]);
  if (!already) {
    const today = new Date().toISOString().slice(0, 10);
    const ride = (await RideModel.create(driver.id, {
      vehicle_id: vehicle.id,
      origin_label: PLACES.gurgaon.label, origin_lat: PLACES.gurgaon.lat, origin_lng: PLACES.gurgaon.lng,
      dest_label: PLACES.noida.label, dest_lat: PLACES.noida.lat, dest_lng: PLACES.noida.lng,
      is_recurring: true, recurrence_days: [1, 2, 3, 4, 5],
      departure_time: '09:00', series_start_date: today, seats_total: 3,
      notes: 'Leaving from the DLF Cyber City gate 3 pickup point.',
    }))!;
    await RideModel.setPreferences(ride.id, { smoking: false, music: true, pickup_radius_km: 3, drop_radius_km: 3 });
    await RideService.publish(ride.id, driver.id);
    logger.info({ rideId: ride.id }, 'seeded recurring ride');
  }

  logger.info(
    { driver: 'Bearer dev:driver1', passenger: 'Bearer dev:rider1', places: PLACES },
    'seed complete — use these Authorization headers',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}
