import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotency.js';
import { matchLimiter, writeLimiter } from '../middleware/rateLimit.js';
import * as users from '../controllers/userController.js';
import * as rides from '../controllers/rideController.js';
import * as matches from '../controllers/matchController.js';
import * as bookings from '../controllers/bookingController.js';
import * as notifications from '../controllers/notificationController.js';
import * as admin from '../controllers/adminController.js';

/** Async handlers should reject into the error middleware, not crash the process. */
const h = (fn: RequestHandler): RequestHandler => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const uuidParam = { params: z.object({ id: z.string().uuid() }) };

export const router = Router();

// ------------------------------------------------------------------- public
router.get('/health', h(admin.health));
router.get('/config', admin.remoteConfig);

// Everything below needs a verified identity.
router.use(authenticate);

// -------------------------------------------------------------------- users
router.get('/me', h(users.me));
router.patch('/me', validate({ body: users.profileSchema }), h(users.updateProfile));
router.post('/me/verify-org', h(users.verifyOrg));
router.post('/me/logout-all', h(users.logoutAll));
router.post('/me/delete', h(users.requestDeletion));
router.post('/me/devices', validate({ body: users.deviceSchema }), h(users.registerDevice));
router.get('/users/:id', validate(uuidParam), h(users.publicProfile));

router.get('/vehicles', h(users.listVehicles));
router.post('/vehicles', validate({ body: users.vehicleSchema }), h(users.createVehicle));
router.patch('/vehicles/:id', validate({ ...uuidParam, body: users.vehicleSchema }), h(users.updateVehicle));
router.delete('/vehicles/:id', validate(uuidParam), h(users.deleteVehicle));

// ------------------------------------------------------------------- safety
router.get('/blocks', h(users.listBlocked));
router.post('/users/:id/block', validate(uuidParam), h(users.blockUser));
router.delete('/users/:id/block', validate(uuidParam), h(users.unblockUser));
router.post('/users/:id/report', validate(uuidParam), h(users.reportUser));

// --------------------------------------------------------------- dashboards
router.get('/home', h(rides.home));
router.get('/history', h(rides.history));

// -------------------------------------------------------------------- rides
router.post('/rides', writeLimiter, validate({ body: rides.createRideSchema }), h(rides.create));
router.get('/rides', h(rides.listMine));
router.get('/rides/:id', validate(uuidParam), h(rides.detail));
router.patch('/rides/:id', validate({ ...uuidParam, body: rides.editRideSchema }), h(rides.edit));
router.post('/rides/:id/publish', validate(uuidParam), h(rides.publish));
router.post('/rides/:id/pause', validate(uuidParam), h(rides.pause));
router.post('/rides/:id/cancel', validate(uuidParam), h(rides.cancel));
router.get('/rides/:id/occurrences', validate(uuidParam), h(rides.listOccurrences));

// -------------------------------------------------------------- occurrences
router.get('/occurrences/:id', validate(uuidParam), h(rides.occurrenceDetail));
router.get('/occurrences/:id/guests', validate(uuidParam), h(rides.occurrenceGuests));
router.get('/occurrences/:id/contribution', validate(uuidParam), h(bookings.contribution));
router.get('/occurrences/:id/contribution/history', validate(uuidParam), h(bookings.contributionHistory));
router.post('/occurrences/:id/cancel', validate(uuidParam), h(rides.cancelOccurrence));
router.post('/occurrences/:id/start', validate(uuidParam), h(rides.startOccurrence));
router.post('/occurrences/:id/complete', validate(uuidParam), h(rides.completeOccurrence));

// ----------------------------------------------------------------- matching
router.post('/matches/search', matchLimiter, validate({ body: matches.searchSchema }), h(matches.search));
router.get('/matches/:occurrenceId/explain', h(matches.explain));
router.get('/places', h(matches.places));

router.get('/commutes', h(matches.listCommutes));
router.post('/commutes', validate({ body: matches.commuteSchema }), h(matches.createCommute));
router.delete('/commutes/:id', validate(uuidParam), h(matches.deleteCommute));

// ----------------------------------------------------------------- bookings
// Every mutating booking call is idempotent: a retried accept can never create
// a second guest or consume a second seat.
router.post('/bookings/requests', writeLimiter, idempotent(), validate({ body: bookings.requestSchema }), h(bookings.requestSeat));
router.get('/bookings/requests', h(bookings.myRequests));
router.get('/bookings/inbox', h(bookings.inbox));
router.post('/bookings/requests/:id/accept', idempotent(), validate(uuidParam), h(bookings.accept));
router.post('/bookings/requests/:id/reject', idempotent(), validate(uuidParam), h(bookings.reject));
router.post('/bookings/requests/:id/cancel', idempotent(), validate(uuidParam), h(bookings.cancelRequest));
router.post('/bookings/guests/:id/cancel', idempotent(), validate(uuidParam), h(bookings.cancelGuest));

// ------------------------------------------------------------ notifications
router.get('/notifications', h(notifications.list));
router.post('/notifications/read-all', h(notifications.markAllRead));
router.post('/notifications/:id/read', validate(uuidParam), h(notifications.markRead));

// -------------------------------------------------------------------- admin
// ponytail: any authenticated user can read these in Phase 1. Gate behind an
// admin role before this leaves a pilot group.
router.get('/admin/rides/:id/diagnostics', validate(uuidParam), h(admin.rideDiagnostics));
router.get('/admin/matches/:occurrenceId/:userId/explain', h(admin.matchExplain));
router.get('/admin/users/:id/timeline', validate(uuidParam), h(admin.userTimeline));
router.get('/admin/fuel-prices', h(admin.listFuelPrices));
router.post('/admin/fuel-prices', validate({ body: admin.fuelPriceSchema }), h(admin.setFuelPrice));
