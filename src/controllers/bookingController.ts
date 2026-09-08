import type { Request, Response } from 'express';
import { z } from 'zod';
import * as BookingService from '../services/bookings.js';
import * as BookingModel from '../models/booking.js';
import { quoteForOccurrence } from '../services/cost.js';
import * as CostModel from '../models/cost.js';
import * as UserModel from '../models/user.js';
import * as RideModel from '../models/ride.js';
import { notFound } from '../utils/errors.js';

const point = z.object({ label: z.string().max(200).optional(), lat: z.number(), lng: z.number() }).optional();

export const requestSchema = z.object({
  occurrence_id: z.string().uuid(),
  seats: z.number().int().min(1).max(4).default(1),
  message: z.string().max(300).optional(),
  pickup: point,
  drop: point,
});

export async function requestSeat(req: Request, res: Response) {
  const { occurrence_id, ...rest } = req.body;
  const request = await BookingService.requestSeat(occurrence_id, req.userId!, rest);
  res.status(201).json({ request });
}

export async function accept(req: Request, res: Response) {
  const result = await BookingService.acceptRequest(req.params.id, req.userId!, req.body?.version);
  res.json(result);
}

export const reject = async (req: Request, res: Response) =>
  res.json({ request: await BookingService.rejectRequest(req.params.id, req.userId!, req.body?.reason) });

export const cancelRequest = async (req: Request, res: Response) =>
  res.json({ request: await BookingService.cancelRequest(req.params.id, req.userId!) });

export const cancelGuest = async (req: Request, res: Response) =>
  res.json(await BookingService.cancelGuest(req.params.id, req.userId!, req.body?.reason));

export const myRequests = async (req: Request, res: Response) =>
  res.json({ requests: await BookingModel.listRequestsByPassenger(req.userId!) });

export const inbox = async (req: Request, res: Response) =>
  res.json({ requests: await BookingModel.inboxForDriver(req.userId!) });

// -------------------------------------------------------------------- cost

/**
 * Suggested contribution for one occurrence, with the full input breakdown and
 * the driver's direct-payment handle. Phase 1 moves no money.
 */
export async function contribution(req: Request, res: Response) {
  const occ = await RideModel.getOccurrence(req.params.id);
  if (!occ) throw notFound('Ride occurrence');
  const ride = await RideModel.findById(occ.ride_id);
  const isDriver = ride?.driver_id === req.userId;

  const quote = await quoteForOccurrence(req.params.id, isDriver ? null : req.userId!);
  const driver = ride ? await UserModel.findById(ride.driver_id) : null;

  res.json({
    contribution: quote,
    // Not a fare. Not a gateway. A prompt to settle directly.
    payment: {
      mode: 'direct_to_driver',
      label: `Suggested contribution: ${quote.currency} ${quote.amount} — please pay the driver directly.`,
      driverContact: isDriver ? null : (await UserModel.getProfile(ride!.driver_id))?.display_name ?? null,
      driverPhone: !isDriver && (await BookingModel.findGuest(req.params.id, req.userId!)) ? driver?.phone : null,
    },
    disclaimer: 'This is a cost-share estimate, not a fare. Wayo does not process payments.',
  });
}

export const contributionHistory = async (req: Request, res: Response) =>
  res.json({ calculations: await CostModel.calculationHistory(req.params.id) });
