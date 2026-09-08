export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, msg: string, detail?: unknown) =>
  new AppError(400, code, msg, detail);
export const unauthorized = (msg = 'Authentication required') =>
  new AppError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'Not allowed') => new AppError(403, 'forbidden', msg);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string, detail?: unknown) =>
  new AppError(409, code, msg, detail);
/** Optimistic-lock failure: the client held a stale version. */
export const staleVersion = (entity: string, current: number) =>
  new AppError(409, 'stale_version', `${entity} was modified by someone else`, { currentVersion: current });
