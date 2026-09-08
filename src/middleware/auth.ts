import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';
import { verifyIdToken, type VerifiedIdentity } from '../infra/firebase.js';
import * as UserModel from '../models/user.js';
import { tx } from '../db/pool.js';
import { forbidden, unauthorized } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      identity?: VerifiedIdentity;
    }
  }
}

/**
 * Dev identity, so the whole stack is runnable without Firebase credentials.
 * Gated entirely on ALLOW_DEV_AUTH, which defaults to false when
 * NODE_ENV=production. Enabling it there lets anyone mint a token for any
 * account; server.ts logs a warning when that combination is live.
 * Header: `Authorization: Bearer dev:<uid>[:<email>]`
 */
function devIdentity(token: string): VerifiedIdentity | null {
  if (!config.allowDevAuth || !token.startsWith('dev:')) return null;
  const [, uid, email] = token.split(':');
  if (!uid) return null;
  return { provider: 'dev', uid, email: email || `${uid}@dev.local`, emailVerified: false };
}

/**
 * Maps a verified provider identity onto the canonical PostgreSQL user,
 * linking rather than duplicating when the contact details already exist.
 */
export async function resolveUser(identity: VerifiedIdentity): Promise<string> {
  return tx(async (c) => {
    const linked = await UserModel.findByProvider(identity.provider, identity.uid, c);
    if (linked) return linked.id;

    const existing = await UserModel.findByContact(identity.email ?? null, identity.phone ?? null, c);
    if (existing) {
      await UserModel.linkProvider(existing.id, identity.provider, identity.uid, c);
      return existing.id;
    }

    const created = await UserModel.create({
      email: identity.email ?? null,
      phone: identity.phone ?? null,
      emailVerified: identity.emailVerified,
      phoneVerified: Boolean(identity.phone),
    }, c);
    await UserModel.linkProvider(created!.id, identity.provider, identity.uid, c);
    await UserModel.upsertProfile(created!.id, {
      display_name: identity.email?.split('@')[0] ?? 'New user',
    }, c);
    return created!.id;
  });
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw unauthorized();

    const identity = devIdentity(token) ?? (await verifyIdToken(token));
    if (!identity) throw unauthorized('Invalid token');

    req.identity = identity;
    req.userId = await resolveUser(identity);

    const user = await UserModel.findById(req.userId);
    if (!user) throw unauthorized('Account not found');
    if (user.status === 'suspended') throw forbidden('Account suspended');

    next();
  } catch (err) {
    if ((err as any)?.status) return next(err);
    logger.warn({ err }, 'authentication failed');
    next(unauthorized('Invalid or expired token'));
  }
}
