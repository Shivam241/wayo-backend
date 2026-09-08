import admin from 'firebase-admin';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Firebase is the identity provider and push transport. The backend stays the
 * business authority: it only verifies tokens and maps the Firebase UID onto a
 * canonical PostgreSQL user.
 */
let app: admin.app.App | null = null;

export function firebaseApp(): admin.app.App | null {
  if (app) return app;
  const { projectId, clientEmail, privateKey } = config.firebase;
  if (!projectId || !clientEmail || !privateKey) {
    logger.warn('firebase credentials absent — token verification and push disabled');
    return null;
  }
  app = admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  return app;
}

export type VerifiedIdentity = {
  provider: string;
  uid: string;
  email?: string;
  phone?: string;
  emailVerified: boolean;
};

export async function verifyIdToken(token: string): Promise<VerifiedIdentity | null> {
  const a = firebaseApp();
  if (!a) return null;
  const decoded = await a.auth().verifyIdToken(token);
  return {
    provider: (decoded.firebase?.sign_in_provider as string) ?? 'firebase',
    uid: decoded.uid,
    email: decoded.email,
    phone: decoded.phone_number,
    emailVerified: Boolean(decoded.email_verified),
  };
}

/** Returns the tokens that failed so callers can prune dead devices. */
export async function sendPush(
  tokens: string[],
  payload: { title: string; body: string; data?: Record<string, string> },
): Promise<{ sent: number; invalidTokens: string[] }> {
  const a = firebaseApp();
  if (!a || tokens.length === 0) return { sent: 0, invalidTokens: [] };

  const res = await a.messaging().sendEachForMulticast({
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data ?? {},
  });

  const invalidTokens = res.responses.flatMap((r, i) =>
    !r.success && r.error?.code === 'messaging/registration-token-not-registered' ? [tokens[i]] : [],
  );
  return { sent: res.successCount, invalidTokens };
}
