import type { NextFunction, Request, Response } from 'express';
import * as BookingModel from '../models/booking.js';
import { badRequest, conflict } from '../utils/errors.js';

/**
 * Replays the stored response for a repeated `Idempotency-Key`, so a retried
 * request/accept/cancel can never create a second booking. Required on the
 * mutating booking endpoints; a missing key is rejected rather than silently
 * accepted, because "the retry worked but created a duplicate" is exactly the
 * failure this product must not have.
 */
export function idempotent(required = true) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('idempotency-key');
    if (!key) {
      if (required) return next(badRequest('idempotency_key_required', 'Idempotency-Key header is required'));
      return next();
    }
    if (!req.userId) return next();

    const prior = await BookingModel.findIdempotent(key, req.userId);
    if (prior) {
      if (prior.status_code === null) {
        return next(conflict('in_progress', 'An identical request is still being processed'));
      }
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(prior.status_code).json(prior.response);
    }

    const claimed = await BookingModel.claimIdempotencyKey(key, req.userId, `${req.method} ${req.path}`);
    if (!claimed) return next(conflict('in_progress', 'An identical request is still being processed'));

    // Capture successful outcomes so the next retry replays them instead of
    // re-executing. Errors created nothing, so the key is released and a
    // corrected retry with the same key is allowed through.
    const send = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 400) {
        void BookingModel.storeIdempotentResult(key, res.statusCode, body);
      } else {
        void BookingModel.releaseIdempotencyKey(key);
      }
      return send(body);
    };
    res.on('close', () => {
      if (!res.writableEnded) void BookingModel.releaseIdempotencyKey(key);
    });
    next();
  };
}
