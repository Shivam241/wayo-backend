import { Queue, Worker, type JobsOptions } from 'bullmq';
import { config } from '../config/index.js';
import { getRedis, redisHealthy } from '../infra/redis.js';
import { pool, many } from '../db/pool.js';
import * as RideService from '../services/rides.js';
import { notify } from '../services/notifications.js';
import { logger } from '../utils/logger.js';

type JobName = 'generate_occurrences' | 'expire_past' | 'ride_reminders';

const handlers: Record<JobName, () => Promise<unknown>> = {
  /** Keeps the rolling occurrence horizon topped up. Idempotent by upsert. */
  generate_occurrences: async () => {
    const rides = await many<{ id: string }>(`SELECT id FROM rides WHERE status = 'published'`);
    let total = 0;
    for (const r of rides) total += await RideService.generateOccurrences(r.id).catch(() => 0);
    return { rides: rides.length, occurrences: total };
  },

  /** Past dates expire. Note what it does NOT do: it never deletes rides or guests. */
  expire_past: async () => {
    const res = await pool.query(
      `UPDATE ride_occurrences SET status = 'expired', updated_at = now()
       WHERE status = 'scheduled' AND departs_at < now() - interval '6 hours'`,
    );
    return { expired: res.rowCount };
  },

  ride_reminders: async () => {
    const rows = await many<{ user_id: string; departs_at: Date; occurrence_id: string }>(
      `SELECT r.driver_id AS user_id, o.departs_at, o.id AS occurrence_id
       FROM ride_occurrences o JOIN rides r ON r.id = o.ride_id
       WHERE o.status = 'scheduled' AND o.departs_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'
       UNION
       SELECT g.passenger_id, o.departs_at, o.id
       FROM ride_guests g JOIN ride_occurrences o ON o.id = g.occurrence_id
       WHERE g.state = 'confirmed' AND o.status = 'scheduled'
         AND o.departs_at BETWEEN now() + interval '23 hours' AND now() + interval '25 hours'`,
    );
    for (const r of rows) {
      await notify(r.user_id, 'ride_reminder', {
        when: new Date(r.departs_at).toISOString(),
        occurrenceId: r.occurrence_id,
      });
    }
    return { reminders: rows.length };
  },
};

const QUEUE = 'wayo';
const retry: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

let queue: Queue | null = null;
let worker: Worker | null = null;

/**
 * Redis-backed jobs when Redis is up, plain timers when it is not. Either way
 * the jobs are idempotent, so running one twice is harmless — which is what
 * makes the fallback safe.
 */
export async function startJobs(): Promise<void> {
  const connection = getRedis();
  if (!connection || !redisHealthy()) {
    logger.warn('redis unavailable — running jobs on in-process timers');
    const run = (name: JobName) =>
      handlers[name]().then(
        (r) => logger.info({ job: name, result: r }, 'job done'),
        (err) => logger.error({ err, job: name }, 'job failed'),
      );
    setInterval(() => void run('generate_occurrences'), 60 * 60_000).unref();
    setInterval(() => void run('expire_past'), 15 * 60_000).unref();
    setInterval(() => void run('ride_reminders'), 60 * 60_000).unref();
    return;
  }

  queue = new Queue(QUEUE, { connection });
  worker = new Worker(
    QUEUE,
    async (job) => handlers[job.name as JobName](),
    { connection, concurrency: 4 },
  );
  worker.on('failed', (job, err) => logger.error({ err, job: job?.name }, 'job failed'));
  worker.on('completed', (job, result) => logger.info({ job: job.name, result }, 'job done'));

  await queue.upsertJobScheduler('hourly-occurrences', { pattern: '0 * * * *' },
    { name: 'generate_occurrences', opts: retry });
  await queue.upsertJobScheduler('quarter-hour-expiry', { pattern: '*/15 * * * *' },
    { name: 'expire_past', opts: retry });
  await queue.upsertJobScheduler('hourly-reminders', { pattern: '30 * * * *' },
    { name: 'ride_reminders', opts: retry });

  logger.info('bullmq scheduler started');
}

export async function stopJobs(): Promise<void> {
  await worker?.close();
  await queue?.close();
}

/** Exposed for tests and manual support runs. */
export const runJob = (name: JobName) => handlers[name]();
