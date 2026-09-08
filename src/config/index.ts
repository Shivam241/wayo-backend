import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v === undefined ? d : Number(v));
const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v === 'true');

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 3000),
  // Bind all interfaces: the Android emulator reaches the host via 10.0.2.2,
  // and a loopback-only bind is unreachable from a device or container.
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  postgresUrl: process.env.DATABASE_URL ?? 'postgres://wayo:wayo@localhost:5432/wayo',
  // Managed Postgres (Render, Neon, RDS) terminates TLS with its own CA. Auto-on
  // when the URL asks for it, or force it with DATABASE_SSL=true.
  postgresSsl: bool(process.env.DATABASE_SSL, /sslmode=require/.test(process.env.DATABASE_URL ?? '')),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  mongoUrl: process.env.MONGO_URL ?? 'mongodb://wayo:wayo@localhost:27017/wayo?authSource=admin',

  // When no Firebase service account is present the auth middleware falls back to
  // dev tokens so the stack is runnable without cloud credentials.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  // Dev identities let anyone mint a token for any account, so they are OFF by
  // default in production. Setting ALLOW_DEV_AUTH=true there is an explicit,
  // logged decision — see the boot warning in server.ts.
  allowDevAuth: bool(process.env.ALLOW_DEV_AUTH, process.env.NODE_ENV !== 'production'),

  maps: {
    provider: (process.env.MAPS_PROVIDER ?? 'local') as 'google' | 'mapbox' | 'local',
    googleKey: process.env.GOOGLE_MAPS_API_KEY,
    mapboxToken: process.env.MAPBOX_TOKEN,
    routeCacheTtlSec: num(process.env.ROUTE_CACHE_TTL_SEC, 60 * 60 * 24 * 7),
  },

  // Matching tolerances. Configurable, never hard-coded into the algorithm.
  matching: {
    algorithmVersion: process.env.MATCH_ALGO_VERSION ?? 'v1.0.0',
    pickupRadiusKm: num(process.env.MATCH_PICKUP_RADIUS_KM, 2),
    dropRadiusKm: num(process.env.MATCH_DROP_RADIUS_KM, 2),
    timeWindowMin: num(process.env.MATCH_TIME_WINDOW_MIN, 30),
    maxDetourKm: num(process.env.MATCH_MAX_DETOUR_KM, 5),
    maxDetourMin: num(process.env.MATCH_MAX_DETOUR_MIN, 15),
    corridorToleranceKm: num(process.env.MATCH_CORRIDOR_KM, 2.5),
    minScore: num(process.env.MATCH_MIN_SCORE, 0.35),
    weights: {
      routeOverlap: num(process.env.W_ROUTE_OVERLAP, 0.35),
      pickupDeviation: num(process.env.W_PICKUP, 0.2),
      dropDeviation: num(process.env.W_DROP, 0.15),
      timeDifference: num(process.env.W_TIME, 0.15),
      detour: num(process.env.W_DETOUR, 0.1),
      recurrenceOverlap: num(process.env.W_RECURRENCE, 0.05),
    },
  },

  // Contribution policy. Phase 1 shows an amount; it never moves money.
  cost: {
    formulaVersion: process.env.COST_FORMULA_VERSION ?? 'v1.0.0',
    currency: process.env.COST_CURRENCY ?? 'INR',
    driverShare: num(process.env.COST_DRIVER_SHARE, 0.25), // driver keeps this fraction
    roundToNearest: num(process.env.COST_ROUND_TO, 5),
    minAmount: num(process.env.COST_MIN, 10),
    maxAmount: num(process.env.COST_MAX, 2000),
    defaultRegion: process.env.COST_REGION ?? 'IN-DL',
    defaultEfficiencyKmpl: num(process.env.COST_DEFAULT_KMPL, 15),
  },

  // Wall-clock times (ride departure, recurrence days) are local to this zone.
  // Postgres converts them to instants; nothing derives local time from UTC.
  timezone: process.env.APP_TIMEZONE ?? 'Asia/Kolkata',
  occurrenceHorizonDays: num(process.env.OCCURRENCE_HORIZON_DAYS, 28),
} as const;
