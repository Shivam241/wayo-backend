import { many, query, type Db, pool } from '../db/pool.js';
import { recordDiagnostic } from '../infra/mongo.js';

export type AuditEvent = {
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  detail?: Record<string, unknown>;
  traceId?: string;
};

/**
 * Every important state transition lands here. The Postgres row is the
 * authoritative, queryable record; the fat payload is mirrored to Mongo for
 * support. Writing the row is part of the caller's transaction when `db` is a
 * transaction client, so an audit gap cannot outlive a committed change.
 */
export async function record(e: AuditEvent, db: Db = pool): Promise<void> {
  await query(
    `INSERT INTO audit_events (entity_type, entity_id, action, actor_id, from_state, to_state, detail, trace_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.entityType, e.entityId, e.action, e.actorId ?? null, e.fromState ?? null,
     e.toState ?? null, JSON.stringify(e.detail ?? {}), e.traceId ?? null],
    db,
  );
  recordDiagnostic({
    kind: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    traceId: e.traceId,
    payload: e.detail ?? {},
  });
}

export const timeline = (entityType: string, entityId: string, db: Db = pool) =>
  many<any>(
    `SELECT * FROM audit_events WHERE entity_type = $1 AND entity_id = $2
     ORDER BY created_at DESC LIMIT 200`,
    [entityType, entityId],
    db,
  );

/** Everything that ever happened to a ride and its occurrences/bookings. */
export const rideTimeline = (rideId: string, db: Db = pool) =>
  many<any>(
    `SELECT a.* FROM audit_events a
     WHERE a.entity_id = $1
        OR a.entity_id IN (SELECT id FROM ride_occurrences WHERE ride_id = $1)
        OR a.entity_id IN (SELECT b.id FROM booking_requests b
                            JOIN ride_occurrences o ON o.id = b.occurrence_id WHERE o.ride_id = $1)
     ORDER BY a.created_at DESC LIMIT 500`,
    [rideId],
    db,
  );
