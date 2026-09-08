import { many, one, type Db, pool } from '../db/pool.js';

export type User = {
  id: string;
  phone: string | null;
  email: string | null;
  phone_verified: boolean;
  email_verified: boolean;
  org_verified: boolean;
  org_domain: string | null;
  status: string;
  created_at: Date;
};

export type Profile = {
  user_id: string;
  display_name: string;
  photo_url: string | null;
  bio: string | null;
  preferred_role: 'driver' | 'passenger' | 'both';
  home_label: string | null;
  home_lat: number | null;
  home_lng: number | null;
  work_label: string | null;
  work_lat: number | null;
  work_lng: number | null;
  commute_days: number[];
  departure_window_start: string | null;
  departure_window_end: string | null;
  organization: string | null;
  onboarded: boolean;
};

export type Vehicle = {
  id: string;
  user_id: string;
  make: string | null;
  model: string | null;
  color: string | null;
  plate: string | null;
  plate_visible: boolean;
  vehicle_type: string;
  fuel_type: 'petrol' | 'diesel' | 'cng' | 'ev';
  efficiency_kmpl: number | null;
  seats: number;
  is_default: boolean;
};

export const findById = (id: string, db: Db = pool) =>
  one<User>('SELECT * FROM users WHERE id = $1 AND status <> $2', [id, 'deleted'], db);

export const findByProvider = (provider: string, uid: string, db: Db = pool) =>
  one<User>(
    `SELECT u.* FROM users u
     JOIN user_auth_providers p ON p.user_id = u.id
     WHERE p.provider = $1 AND p.provider_uid = $2 AND u.status <> 'deleted'`,
    [provider, uid],
    db,
  );

export const findByContact = (email: string | null, phone: string | null, db: Db = pool) =>
  one<User>(
    `SELECT * FROM users
     WHERE status <> 'deleted' AND (($1::text IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND phone = $2))
     LIMIT 1`,
    [email, phone],
    db,
  );

export const create = (
  data: { email?: string | null; phone?: string | null; emailVerified?: boolean; phoneVerified?: boolean },
  db: Db = pool,
) =>
  one<User>(
    `INSERT INTO users (email, phone, email_verified, phone_verified)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [data.email ?? null, data.phone ?? null, data.emailVerified ?? false, data.phoneVerified ?? false],
    db,
  );

export const linkProvider = (userId: string, provider: string, uid: string, db: Db = pool) =>
  one(
    `INSERT INTO user_auth_providers (user_id, provider, provider_uid)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_uid) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [userId, provider, uid],
    db,
  );

export const listProviders = (userId: string, db: Db = pool) =>
  many('SELECT id, provider, provider_uid, created_at FROM user_auth_providers WHERE user_id = $1', [userId], db);

export const updateContact = (
  userId: string,
  patch: { email?: string | null; phone?: string | null; emailVerified?: boolean; phoneVerified?: boolean },
  db: Db = pool,
) =>
  one<User>(
    `UPDATE users SET
       email = COALESCE($2, email),
       phone = COALESCE($3, phone),
       email_verified = COALESCE($4, email_verified),
       phone_verified = COALESCE($5, phone_verified),
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [userId, patch.email ?? null, patch.phone ?? null, patch.emailVerified ?? null, patch.phoneVerified ?? null],
    db,
  );

export const setStatus = (userId: string, status: string, db: Db = pool) =>
  one<User>('UPDATE users SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [userId, status], db);

export const verifyOrgDomain = (userId: string, domain: string, db: Db = pool) =>
  one<User>(
    'UPDATE users SET org_verified = true, org_domain = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [userId, domain],
    db,
  );

// ------------------------------------------------------------------ profile

export const getProfile = (userId: string, db: Db = pool) =>
  one<Profile>('SELECT * FROM profiles WHERE user_id = $1', [userId], db);

export const upsertProfile = (userId: string, p: Partial<Profile>, db: Db = pool) =>
  one<Profile>(
    `INSERT INTO profiles (user_id, display_name, photo_url, bio, preferred_role,
       home_label, home_lat, home_lng, work_label, work_lat, work_lng,
       commute_days, departure_window_start, departure_window_end, organization, onboarded)
     VALUES ($1, COALESCE($2,'New user'), $3, $4, COALESCE($5,'both'), $6, $7, $8, $9, $10, $11,
             COALESCE($12::smallint[], '{}'::smallint[]), $13, $14, $15, COALESCE($16,false))
     ON CONFLICT (user_id) DO UPDATE SET
       display_name = COALESCE($2, profiles.display_name),
       photo_url = COALESCE($3, profiles.photo_url),
       bio = COALESCE($4, profiles.bio),
       preferred_role = COALESCE($5, profiles.preferred_role),
       home_label = COALESCE($6, profiles.home_label),
       home_lat = COALESCE($7, profiles.home_lat),
       home_lng = COALESCE($8, profiles.home_lng),
       work_label = COALESCE($9, profiles.work_label),
       work_lat = COALESCE($10, profiles.work_lat),
       work_lng = COALESCE($11, profiles.work_lng),
       commute_days = COALESCE($12::smallint[], profiles.commute_days),
       departure_window_start = COALESCE($13, profiles.departure_window_start),
       departure_window_end = COALESCE($14, profiles.departure_window_end),
       organization = COALESCE($15, profiles.organization),
       onboarded = COALESCE($16, profiles.onboarded),
       updated_at = now()
     RETURNING *`,
    [
      userId, p.display_name ?? null, p.photo_url ?? null, p.bio ?? null, p.preferred_role ?? null,
      p.home_label ?? null, p.home_lat ?? null, p.home_lng ?? null,
      p.work_label ?? null, p.work_lat ?? null, p.work_lng ?? null,
      p.commute_days ?? null, p.departure_window_start ?? null, p.departure_window_end ?? null,
      p.organization ?? null, p.onboarded ?? null,
    ],
    db,
  );

/** Public view of another user — no contact details before acceptance. */
export const getPublicProfile = (userId: string, db: Db = pool) =>
  one(
    `SELECT u.id, p.display_name, p.photo_url, p.bio, p.organization,
            u.phone_verified, u.email_verified, u.org_verified,
            (SELECT count(*) FROM ride_guests g WHERE g.passenger_id = u.id AND g.state = 'completed') AS trips_as_passenger,
            (SELECT count(*) FROM ride_occurrences o JOIN rides r ON r.id = o.ride_id
              WHERE r.driver_id = u.id AND o.status = 'completed') AS trips_as_driver
     FROM users u LEFT JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1 AND u.status <> 'deleted'`,
    [userId],
    db,
  );

// ----------------------------------------------------------------- vehicles

export const listVehicles = (userId: string, db: Db = pool) =>
  many<Vehicle>('SELECT * FROM vehicles WHERE user_id = $1 ORDER BY is_default DESC, created_at', [userId], db);

export const getVehicle = (id: string, db: Db = pool) =>
  one<Vehicle>('SELECT * FROM vehicles WHERE id = $1', [id], db);

export const getDefaultVehicle = (userId: string, db: Db = pool) =>
  one<Vehicle>(
    'SELECT * FROM vehicles WHERE user_id = $1 ORDER BY is_default DESC, created_at LIMIT 1',
    [userId],
    db,
  );

export const createVehicle = (userId: string, v: Partial<Vehicle>, db: Db = pool) =>
  one<Vehicle>(
    `INSERT INTO vehicles (user_id, make, model, color, plate, plate_visible, vehicle_type,
       fuel_type, efficiency_kmpl, seats, is_default)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,false),COALESCE($7,'car'),COALESCE($8,'petrol'),$9,COALESCE($10,4),
             COALESCE($11, NOT EXISTS (SELECT 1 FROM vehicles WHERE user_id = $1)))
     RETURNING *`,
    [userId, v.make ?? null, v.model ?? null, v.color ?? null, v.plate ?? null, v.plate_visible ?? null,
     v.vehicle_type ?? null, v.fuel_type ?? null, v.efficiency_kmpl ?? null, v.seats ?? null, v.is_default ?? null],
    db,
  );

export const updateVehicle = (id: string, userId: string, v: Partial<Vehicle>, db: Db = pool) =>
  one<Vehicle>(
    `UPDATE vehicles SET make = COALESCE($3, make), model = COALESCE($4, model),
       color = COALESCE($5, color), plate = COALESCE($6, plate),
       plate_visible = COALESCE($7, plate_visible), vehicle_type = COALESCE($8, vehicle_type),
       fuel_type = COALESCE($9, fuel_type), efficiency_kmpl = COALESCE($10, efficiency_kmpl),
       seats = COALESCE($11, seats), is_default = COALESCE($12, is_default)
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, v.make ?? null, v.model ?? null, v.color ?? null, v.plate ?? null, v.plate_visible ?? null,
     v.vehicle_type ?? null, v.fuel_type ?? null, v.efficiency_kmpl ?? null, v.seats ?? null, v.is_default ?? null],
    db,
  );

export const deleteVehicle = (id: string, userId: string, db: Db = pool) =>
  one('DELETE FROM vehicles WHERE id = $1 AND user_id = $2 RETURNING id', [id, userId], db);

// ------------------------------------------------------------------ devices

export const registerDevice = (userId: string, token: string, platform: string, db: Db = pool) =>
  one(
    `INSERT INTO user_devices (user_id, fcm_token, platform) VALUES ($1,$2,$3)
     ON CONFLICT (fcm_token) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = now()
     RETURNING *`,
    [userId, token, platform],
    db,
  );

export const deviceTokens = async (userId: string, db: Db = pool) =>
  (await many<{ fcm_token: string }>('SELECT fcm_token FROM user_devices WHERE user_id = $1', [userId], db))
    .map((r) => r.fcm_token);

export const removeDevices = (tokens: string[], db: Db = pool) =>
  tokens.length ? many('DELETE FROM user_devices WHERE fcm_token = ANY($1) RETURNING id', [tokens], db) : Promise.resolve([]);

export const removeAllDevices = (userId: string, db: Db = pool) =>
  many('DELETE FROM user_devices WHERE user_id = $1 RETURNING id', [userId], db);
