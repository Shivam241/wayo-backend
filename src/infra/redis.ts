import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Redis is cache and job coordination only — never a source of truth.
 * Every helper here degrades to a no-op so a Redis outage cannot take the API
 * down or lose a ride, booking or guest.
 */
let client: Redis | null = null;
let healthy = false;

export function getRedis(): Redis | null {
  if (client) return client;
  try {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
      retryStrategy: (times: number) => Math.min(times * 500, 10_000),
    });
    client.on('ready', () => {
      healthy = true;
      logger.info('redis ready');
    });
    client.on('error', (err: Error) => {
      if (healthy) logger.warn({ err: err.message }, 'redis error — degrading to no-cache');
      healthy = false;
    });
    return client;
  } catch (err) {
    logger.warn({ err }, 'redis unavailable — running without cache');
    return null;
  }
}

export const redisHealthy = () => healthy;

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!healthy) return null;
  try {
    const raw = await getRedis()!.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  if (!healthy) return;
  try {
    await getRedis()!.set(key, JSON.stringify(value), 'EX', ttlSec);
  } catch {
    /* cache writes are best-effort by design */
  }
}
