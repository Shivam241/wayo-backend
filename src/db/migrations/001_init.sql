-- Wayo Phase 1 schema. PostgreSQL is the transactional source of truth.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Straight-line distance in km. Used only for cheap spatial pre-filtering;
-- real route distance always comes from the routing provider.
CREATE OR REPLACE FUNCTION haversine_km(lat1 double precision, lng1 double precision,
                                        lat2 double precision, lng2 double precision)
RETURNS double precision AS 'SELECT 6371 * 2 * asin(sqrt(
    power(sin(radians($3 - $1) / 2), 2) +
    cos(radians($1)) * cos(radians($3)) * power(sin(radians($4 - $2) / 2), 2)))'
LANGUAGE sql IMMUTABLE;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone           text UNIQUE,
  email           text UNIQUE,
  phone_verified  boolean NOT NULL DEFAULT false,
  email_verified  boolean NOT NULL DEFAULT false,
  org_verified    boolean NOT NULL DEFAULT false,
  org_domain      text,
  status          text NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deletion_requested','deleted')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Provider linking: many firebase/social identities -> one canonical user.
CREATE TABLE user_auth_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,           -- firebase, google.com, apple.com, phone, dev
  provider_uid  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_uid)
);
CREATE INDEX ON user_auth_providers (user_id);

CREATE TABLE profiles (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name      text NOT NULL,
  photo_url         text,
  bio               text,
  preferred_role    text NOT NULL DEFAULT 'both' CHECK (preferred_role IN ('driver','passenger','both')),
  home_label        text,
  home_lat          double precision,
  home_lng          double precision,
  work_label        text,
  work_lat          double precision,
  work_lng          double precision,
  commute_days      smallint[] NOT NULL DEFAULT '{}',   -- 0=Sun .. 6=Sat
  departure_window_start time,
  departure_window_end   time,
  organization      text,
  onboarded         boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  make          text,
  model         text,
  color         text,
  plate         text,
  plate_visible boolean NOT NULL DEFAULT false,
  vehicle_type  text NOT NULL DEFAULT 'car',
  fuel_type     text NOT NULL DEFAULT 'petrol' CHECK (fuel_type IN ('petrol','diesel','cng','ev')),
  efficiency_kmpl numeric(6,2) CHECK (efficiency_kmpl > 0),
  seats         smallint NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 8),
  is_default    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON vehicles (user_id);

CREATE TABLE user_devices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fcm_token    text NOT NULL UNIQUE,
  platform     text NOT NULL CHECK (platform IN ('ios','android')),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON user_devices (user_id);

-- ------------------------------------------------------------------- rides
-- rides = stable series/master record. Editing a ride never deletes it.
CREATE TABLE rides (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id         uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  origin_label       text NOT NULL,
  origin_lat         double precision NOT NULL,
  origin_lng         double precision NOT NULL,
  dest_label         text NOT NULL,
  dest_lat           double precision NOT NULL,
  dest_lng           double precision NOT NULL,
  is_recurring       boolean NOT NULL DEFAULT false,
  recurrence_days    smallint[] NOT NULL DEFAULT '{}',  -- 0=Sun .. 6=Sat
  departure_time     time NOT NULL,
  series_start_date  date NOT NULL,
  series_end_date    date,
  seats_total        smallint NOT NULL CHECK (seats_total BETWEEN 1 AND 8),
  notes              text,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','paused','cancelled','expired')),
  version            integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rides (driver_id);
CREATE INDEX ON rides (status);
CREATE INDEX rides_origin_box ON rides (origin_lat, origin_lng);
CREATE INDEX rides_dest_box   ON rides (dest_lat, dest_lng);

CREATE TABLE ride_preferences (
  ride_id          uuid PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  smoking          boolean NOT NULL DEFAULT false,
  pets             boolean NOT NULL DEFAULT false,
  luggage          text NOT NULL DEFAULT 'small' CHECK (luggage IN ('none','small','medium','large')),
  music            boolean NOT NULL DEFAULT true,
  conversation     text NOT NULL DEFAULT 'any' CHECK (conversation IN ('quiet','any','chatty')),
  gender_pref      text NOT NULL DEFAULT 'any' CHECK (gender_pref IN ('any','same')),
  pickup_radius_km numeric(5,2) NOT NULL DEFAULT 2.0,
  drop_radius_km   numeric(5,2) NOT NULL DEFAULT 2.0,
  max_detour_km    numeric(5,2) NOT NULL DEFAULT 5.0,
  max_detour_min   smallint NOT NULL DEFAULT 15,
  time_window_min  smallint NOT NULL DEFAULT 30
);

-- Route geometry from the provider, versioned so a cached match stays traceable
-- to the route it was computed against.
CREATE TABLE ride_routes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id       uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  polyline      text NOT NULL,
  geometry      jsonb NOT NULL,          -- [[lat,lng], ...] sampled points
  distance_km   numeric(8,2) NOT NULL,
  duration_min  integer NOT NULL,
  fingerprint   text NOT NULL,           -- hash of origin/dest/provider result
  is_current    boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ride_routes (ride_id);
CREATE UNIQUE INDEX ride_routes_one_current ON ride_routes (ride_id) WHERE is_current;

-- One row per actual date. Cancelling a date never destroys the series.
CREATE TABLE ride_occurrences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id         uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  departs_at      timestamptz NOT NULL,
  seats_total     smallint NOT NULL CHECK (seats_total >= 0),
  seats_taken     smallint NOT NULL DEFAULT 0 CHECK (seats_taken >= 0),
  status          text NOT NULL DEFAULT 'scheduled'
                  CHECK (status IN ('scheduled','full','in_progress','completed','cancelled','expired')),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ride_id, departs_at),
  -- hard guarantee: a ride can never be overbooked
  CONSTRAINT no_overbooking CHECK (seats_taken <= seats_total)
);
CREATE INDEX ON ride_occurrences (departs_at);
CREATE INDEX ON ride_occurrences (ride_id, status);

-- ---------------------------------------------------------------- matching
-- Passenger's standing commute need.
CREATE TABLE commute_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  passenger_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin_label     text NOT NULL,
  origin_lat       double precision NOT NULL,
  origin_lng       double precision NOT NULL,
  dest_label       text NOT NULL,
  dest_lat         double precision NOT NULL,
  dest_lng         double precision NOT NULL,
  departure_time   time NOT NULL,
  recurrence_days  smallint[] NOT NULL DEFAULT '{}',
  flex_minutes     smallint NOT NULL DEFAULT 30,
  pickup_radius_km numeric(5,2) NOT NULL DEFAULT 2.0,
  drop_radius_km   numeric(5,2) NOT NULL DEFAULT 2.0,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON commute_requests (passenger_id) WHERE active;

-- A candidate may come and go. It is NOT a booking.
CREATE TABLE match_candidates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id      uuid NOT NULL REFERENCES ride_occurrences(id) ON DELETE CASCADE,
  passenger_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  commute_request_id uuid REFERENCES commute_requests(id) ON DELETE SET NULL,
  score              numeric(6,3) NOT NULL,
  components         jsonb NOT NULL,   -- {routeOverlap, pickupDeviationKm, ...}
  reasons            text[] NOT NULL DEFAULT '{}',
  rejected_reason    text,
  algorithm_version  text NOT NULL,
  route_fingerprint  text,
  computed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (occurrence_id, passenger_id, algorithm_version)
);
CREATE INDEX ON match_candidates (passenger_id, score DESC);
CREATE INDEX ON match_candidates (occurrence_id);

-- ---------------------------------------------------------- booking + guests
CREATE TABLE booking_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id   uuid NOT NULL REFERENCES ride_occurrences(id) ON DELETE CASCADE,
  passenger_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seats           smallint NOT NULL DEFAULT 1 CHECK (seats > 0),
  pickup_label    text,
  pickup_lat      double precision,
  pickup_lng      double precision,
  drop_label      text,
  drop_lat        double precision,
  drop_lng        double precision,
  message         text,
  state           text NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','accepted','rejected','cancelled','expired')),
  decided_at      timestamptz,
  decided_by      uuid REFERENCES users(id),
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- one live request per passenger per occurrence
CREATE UNIQUE INDEX booking_requests_one_live
  ON booking_requests (occurrence_id, passenger_id)
  WHERE state IN ('pending','accepted');
CREATE INDEX ON booking_requests (passenger_id, state);
CREATE INDEX ON booking_requests (occurrence_id, state);

-- THE durable record. Never derived from a matching query.
CREATE TABLE ride_guests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id      uuid NOT NULL REFERENCES ride_occurrences(id) ON DELETE CASCADE,
  ride_id            uuid NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  passenger_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  booking_request_id uuid NOT NULL REFERENCES booking_requests(id) ON DELETE RESTRICT,
  seats              smallint NOT NULL DEFAULT 1 CHECK (seats > 0),
  pickup_label       text,
  pickup_lat         double precision,
  pickup_lng         double precision,
  drop_label         text,
  drop_lat           double precision,
  drop_lng           double precision,
  state              text NOT NULL DEFAULT 'confirmed'
                     CHECK (state IN ('confirmed','cancelled_by_passenger','cancelled_by_driver','no_show','completed')),
  confirmed_at       timestamptz NOT NULL DEFAULT now(),
  cancelled_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ride_guests_one_active
  ON ride_guests (occurrence_id, passenger_id)
  WHERE state = 'confirmed';
CREATE INDEX ON ride_guests (occurrence_id);
CREATE INDEX ON ride_guests (passenger_id, state);

-- ------------------------------------------------------------------- money
CREATE TABLE fuel_prices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  region         text NOT NULL,
  fuel_type      text NOT NULL CHECK (fuel_type IN ('petrol','diesel','cng','ev')),
  price          numeric(8,2) NOT NULL CHECK (price > 0),
  currency       text NOT NULL DEFAULT 'INR',
  source         text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region, fuel_type, effective_from)
);
CREATE INDEX ON fuel_prices (region, fuel_type, effective_from DESC);

-- Every displayed amount stores the inputs that produced it.
CREATE TABLE cost_calculations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id     uuid NOT NULL REFERENCES ride_occurrences(id) ON DELETE CASCADE,
  passenger_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  distance_km       numeric(8,2) NOT NULL,
  fuel_price        numeric(8,2) NOT NULL,
  fuel_price_id     uuid REFERENCES fuel_prices(id),
  efficiency_kmpl   numeric(6,2) NOT NULL,
  occupants         smallint NOT NULL CHECK (occupants > 0),
  driver_share      numeric(4,3) NOT NULL,
  trip_fuel_cost    numeric(10,2) NOT NULL,
  amount            numeric(10,2) NOT NULL,
  currency          text NOT NULL DEFAULT 'INR',
  formula_version   text NOT NULL,
  reason            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cost_calculations (occurrence_id, passenger_id, created_at DESC);

-- ------------------------------------------------------- notify / audit / safety
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  data        jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  pushed_at   timestamptz,
  push_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (user_id, created_at DESC);

CREATE TABLE audit_events (
  id           bigserial PRIMARY KEY,
  entity_type  text NOT NULL,
  entity_id    uuid NOT NULL,
  action       text NOT NULL,
  actor_id     uuid REFERENCES users(id),
  from_state   text,
  to_state     text,
  detail       jsonb NOT NULL DEFAULT '{}',
  trace_id     text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_events (entity_type, entity_id, created_at DESC);

CREATE TABLE blocks_reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('block','report')),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (actor_id <> target_id)
);
CREATE UNIQUE INDEX blocks_unique ON blocks_reports (actor_id, target_id) WHERE kind = 'block';
CREATE INDEX ON blocks_reports (target_id);

-- Retries must not create duplicate bookings.
CREATE TABLE idempotency_keys (
  key          text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON idempotency_keys (created_at);
