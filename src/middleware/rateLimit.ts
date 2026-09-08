import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// ponytail: in-memory store, so limits are per-instance. Swap in rate-limit-redis
// when the API runs on more than one container.
const key = (req: Request) => req.userId ?? req.ip ?? 'anonymous';

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: key,
});

/** Matching hits the routing provider, which is metered and billed. */
export const matchLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: key,
  message: { error: { code: 'rate_limited', message: 'Too many searches — try again in a minute' } },
});

/** Blunt anti-spam on seat requests. */
export const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: key,
});
