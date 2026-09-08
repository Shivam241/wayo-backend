import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const notFoundHandler = (req: Request, res: Response) =>
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const traceId = (req as any).id ?? req.header('x-request-id') ?? undefined;

  if (err instanceof AppError) {
    return res
      .status(err.status)
      .json({ error: { code: err.code, message: err.message, detail: err.detail, traceId } });
  }

  // Postgres constraint violations map to real client errors, not 500s.
  const pg = err as { code?: string; constraint?: string; message?: string };
  if (pg?.code === '23505') {
    return res.status(409).json({ error: { code: 'duplicate', message: 'That record already exists', traceId } });
  }
  if (pg?.code === '23514' && pg.constraint === 'no_overbooking') {
    return res.status(409).json({ error: { code: 'no_seats', message: 'No seats left on that ride', traceId } });
  }
  if (pg?.code === '23503') {
    return res.status(400).json({ error: { code: 'invalid_reference', message: 'Referenced record does not exist', traceId } });
  }

  logger.error({ err, path: req.path, traceId }, 'unhandled error');
  return res.status(500).json({ error: { code: 'internal', message: 'Something went wrong', traceId } });
}
