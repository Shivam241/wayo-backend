import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { router } from './routes/index.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { logger } from './utils/logger.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '256kb' }));
  app.use(
    pinoHttp({
      logger,
      genReqId: (req: { headers: Record<string, unknown> }) => (req.headers['x-request-id'] as string) ?? randomUUID(),
      // Never log auth headers.
      redact: ['req.headers.authorization'],
    }),
  );
  app.use(apiLimiter);

  // Versioned from day one so the mobile client can be pinned.
  app.use('/api/v1', router);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
