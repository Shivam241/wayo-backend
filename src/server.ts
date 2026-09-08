import { createApp } from './app.js';
import { config } from './config/index.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { connectMongo } from './infra/mongo.js';
import { getRedis } from './infra/redis.js';
import { firebaseApp } from './infra/firebase.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { logger } from './utils/logger.js';

async function main() {
  await migrate();          // Postgres is required; everything else may be absent.
  getRedis();
  await connectMongo();
  firebaseApp();

  if (config.env === 'production' && config.allowDevAuth) {
    logger.warn(
      'ALLOW_DEV_AUTH is enabled in production: anyone can mint a token for any ' +
        'account. Acceptable for a closed pilot only — configure Firebase and ' +
        'set ALLOW_DEV_AUTH=false before real users.',
    );
  }

  const server = createApp().listen(config.port, config.host, () =>
    logger.info({ host: config.host, port: config.port, env: config.env }, 'wayo api listening'),
  );

  // Redis may still be connecting; give it a moment before choosing job mode.
  setTimeout(() => void startJobs(), 2000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close();
    await stopJobs().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
