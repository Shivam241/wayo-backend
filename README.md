# wayo-backend

Node.js + TypeScript API. MVC: thin controllers, SQL-owning models, business rules in services.

```
src/
├── config/         All tolerances, weights and policy — nothing hard-coded in the algorithms
├── db/             Pool, transactions, SQL migrations, seed
├── models/         One module per aggregate; owns its SQL, returns plain rows
├── services/       Business rules: matching, cost, rides, bookings, notifications, routeProvider
├── controllers/    Request → service → JSON. Validation schemas live beside their controller
├── routes/         One table of every endpoint
├── middleware/     auth · idempotency · validate · rateLimit · error
├── infra/          Replaceable externals: redis, mongo, firebase
├── jobs/           Retryable, idempotent background work
└── utils/          geo, errors, logger
```

## Running

```bash
cp .env.example .env && npm install && npm run seed && npm run dev
```

`npm run seed` applies migrations and creates a driver, a passenger, a vehicle, Delhi fuel
prices and a published weekday ride. It prints the two dev tokens.

| Script | Does |
|---|---|
| `npm run dev` | tsx watch, migrations on boot |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run seed` | Migrate + idempotent demo data |
| `npm test` | Matching, cost and recurrence unit tests |
| `npm run build` | Type-check and emit to `dist/` |

## Authentication

`Authorization: Bearer <token>`. With `FIREBASE_*` set, the token is verified with the Admin
SDK and the Firebase UID is mapped onto a canonical `users` row — linking to an existing
account when the verified email or phone already exists, rather than creating a duplicate.

With no Firebase credentials and `ALLOW_DEV_AUTH=true` (never in production), `dev:<uid>`
is accepted so the stack runs locally. Nothing else in the codebase knows which path was used.

## Configuration that matters

| Variable | Default | Why |
|---|---|---|
| `APP_TIMEZONE` | `Asia/Kolkata` | Wall-clock departure times and recurrence days are local to this zone; Postgres converts them to instants |
| `HOST` | `0.0.0.0` | An Android emulator reaches the host at `10.0.2.2`; a loopback-only bind is unreachable from a device |
| `MAPS_PROVIDER` | `local` | `google` / `mapbox` / `local`. `local` is a straight-line estimate — no key, no billing |
| `MATCH_*` | see `.env.example` | Tolerances and score weights. Change these, not the algorithm |
| `COST_DRIVER_SHARE` | `0.25` | Fraction of fuel cost the driver absorbs |
| `COST_ROUND_TO` | `5` | Contribution rounds to a friendly rupee amount |

## The matching engine

`services/matching.ts`, versioned by `MATCH_ALGO_VERSION`.

1. **Pre-filter** (`models/match.ts`) — indexed SQL: published ride, seats free, destination
   corridor, departure window compared against the ride's own wall clock, recurring-day
   overlap, not blocked, not already requested.
2. **Route** — the passenger's route once, then a detour calculation per surviving candidate.
   Nothing that failed the pre-filter ever costs a routing call.
3. **Score** — `scoreCandidate` is pure and deterministic: weighted route overlap, pickup and
   drop deviation, time difference, detour, recurring-day overlap.
4. **Gate** — hard rejections carry a reason code (`pickup_2.6km_beyond_2km`,
   `opposite_direction`, `no_seats_available`, …).
5. **Persist** — every decision, accepted or rejected, is written to `match_candidates` with
   its score components, reason codes, algorithm version and route fingerprint.

`GET /api/v1/matches/:occurrenceId/explain` and
`GET /api/v1/admin/rides/:id/diagnostics` answer "why did (or didn't) this match?" from
those stored decisions.

## The accept transaction

`services/bookings.ts` → `acceptRequest` is the transaction the product hinges on. In one
transaction: lock the request, lock the occurrence, claim seats with a conditional `UPDATE`,
transition the request, insert the durable `ride_guests` row, write two audit events. It
commits together or not at all; the seat claim cannot succeed twice.

## API

All routes under `/api/v1`. `GET /health` and `GET /config` are public; everything else needs
a bearer token. Mutating booking endpoints require an `Idempotency-Key` header.

```
GET    /health                          Per-dependency status; 503 only if Postgres is down
GET    /config                          Remote config: tolerances, cost policy, feature flags

GET    /me                              Bootstrap: user, profile, vehicles, linked providers
PATCH  /me                              Update profile
POST   /me/verify-org                   Work-email badge from a verified domain
POST   /me/devices                      Register an FCM token
POST   /me/logout-all                   Drop every push token
POST   /me/delete                       Request account deletion
GET    /users/:id                       Public profile (no contact details)

GET    /vehicles                        List · POST · PATCH /:id · DELETE /:id

GET    /home                            Dashboard: upcoming, requests to decide, requests sent
GET    /history                         Completed and cancelled trips, both roles

POST   /rides                           Create as draft
GET    /rides                           My ride series
GET    /rides/:id                       Ride, route, preferences, upcoming dates
PATCH  /rides/:id                       Version-checked edit; material changes re-match
POST   /rides/:id/publish               Publish and generate occurrences
POST   /rides/:id/pause                 Toggle out of matching
POST   /rides/:id/cancel                Cancel the series; guests released and notified
GET    /rides/:id/occurrences           Generated dates

GET    /occurrences/:id                 Detail: route, guests, requests, contribution, sync
GET    /occurrences/:id/guests          The durable guest list
GET    /occurrences/:id/contribution    Suggested cost share + pay-driver prompt
POST   /occurrences/:id/cancel          Cancel one date, series intact
POST   /occurrences/:id/start           · /complete

POST   /matches/search                  Ranked, explainable matches
GET    /matches/:occurrenceId/explain   Stored match decisions
GET    /places                          Provider-agnostic place search
GET    /commutes                        Saved commutes · POST · DELETE /:id

POST   /bookings/requests               Request a seat            (Idempotency-Key)
GET    /bookings/requests               My requests
GET    /bookings/inbox                  Requests awaiting my decision
POST   /bookings/requests/:id/accept    Seat claim + durable guest (Idempotency-Key)
POST   /bookings/requests/:id/reject    · /cancel                  (Idempotency-Key)
POST   /bookings/guests/:id/cancel      Release a confirmed seat   (Idempotency-Key)

GET    /notifications                   · POST /:id/read · POST /read-all
GET    /blocks                          · POST/DELETE /users/:id/block · POST /users/:id/report

GET    /admin/rides/:id/diagnostics     Support view: state, guests, matches, full timeline
GET    /admin/fuel-prices               · POST to set a regional price
```

Errors are always `{ "error": { "code", "message", "detail?", "traceId" } }`. Codes worth
handling: `stale_version`, `no_seats`, `already_requested`, `not_bookable`,
`seats_below_confirmed`, `idempotency_key_required`.

## Known limits

- `/admin/*` is authenticated but not role-gated — add a role check before a real pilot.
- Rate limiting is per-instance in memory; use `rate-limit-redis` when running more than one
  container.
- Waitlists, chat and ratings are deliberately Phase 2.
