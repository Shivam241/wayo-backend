# Deploying Wayo to Render

The API and its Postgres database are described in [`render.yaml`](render.yaml).
The app points at the deployed URL by default.

## 1. Push the repo

Render reads the blueprint from a connected Git repository, so the code has to
be on GitHub/GitLab first.

## 2. Create the blueprint

Render dashboard → **New → Blueprint** → pick the repo. It reads `render.yaml`
and provisions:

| Resource | What it is |
|---|---|
| `wayo-postgres` | Managed Postgres — the system of record |
| `wayo-api` | Node web service, built from this repo |

`DATABASE_URL` is wired to the database automatically. Migrations run on boot,
so the first deploy creates the schema; Render holds traffic until
`/api/v1/health` returns 200.

## 3. Choose how people sign in

This is the one decision the blueprint cannot make for you.

**Option A — closed pilot, no Firebase yet.** In the `wayo-api` dashboard set:

```
ALLOW_DEV_AUTH = true
```

Login works immediately with the seeded accounts. **Anyone who knows the URL can
sign in as any user** by sending `Authorization: Bearer dev:<uid>` — there is no
password. Fine for a private pilot, not for real users. The service logs a
warning on every boot while this is on.

**Option B — real authentication.** Create a Firebase project, generate a
service-account key, and set these three in the dashboard (never commit them):

```
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY     paste with real newlines, or \n escapes
```

Leave `ALLOW_DEV_AUTH=false`. The API then verifies Firebase ID tokens and can
send push. The Flutter side needs the matching Firebase SDK wiring in
`SignInScreen._signIn` — that is the only place the app knows a provider exists.

## 4. Seed demo data (optional)

From the `wayo-api` service → **Shell**:

```bash
node dist/db/seed.js
```

Creates Asha (driver, Gurgaon → Noida weekdays 09:00), Vikram (passenger), a
vehicle, Delhi fuel prices and a published recurring ride. Safe to re-run.

## 5. Point the app at it

The default is already the hosted API:

```dart
// wayo-frontend/lib/core/api.dart
const kHostedApi = 'https://wayo-api.onrender.com/api/v1';
```

Render derives the hostname from the service name. **If the service ends up
named differently — because `wayo-api` was taken — change that one line.**

Run against a local backend instead:

```bash
flutter run --dart-define=WAYO_API=http://10.0.2.2:3101/api/v1
```

(`http://localhost:3101/api/v1` on the iOS simulator.)

## Optional services

Both are optional by design; the API degrades rather than failing.

- **Redis** — cache, rate limits and the BullMQ queue. Uncomment the `keyvalue`
  service and `REDIS_URL` in `render.yaml`. Without it the API caches nothing
  and runs jobs on in-process timers. Older blueprints call this type `redis`.
- **MongoDB** — the support diagnostics stream only. Render has no managed
  MongoDB; paste a MongoDB Atlas URI into `MONGO_URL`, or leave it unset.

## Free-tier behaviour

A free instance sleeps after ~15 minutes idle, and the request that wakes it can
take close to a minute. The app handles this: reads get a short first attempt and
a 60-second retry, so a cold start resolves instead of failing. Writes are never
retried — replaying a request that may have committed is exactly the
duplicate-booking failure this product is built to avoid.

Free Postgres instances expire after 30 days. Take a dump before then:

```bash
pg_dump "$DATABASE_URL" > wayo-backup.sql
```

## Verifying a deploy

```bash
curl https://wayo-api.onrender.com/api/v1/health
```

`status: ok` with `postgres: true` is a good deploy. `redis` and `mongo` reading
`false` is expected when those are not provisioned — only Postgres is fatal, and
only Postgres failing returns 503.

## What is not configured

- `/admin/*` endpoints are authenticated but not role-gated. Gate them before a
  wider pilot.
- Rate limiting is per-instance and in memory. Add `rate-limit-redis` before
  scaling past one instance.
- `MAPS_PROVIDER=local` uses a straight-line estimate. Set `google` or `mapbox`
  with a key for real route geometry and distances.
