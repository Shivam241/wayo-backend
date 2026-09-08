import { describe, expect, it } from 'vitest';
import { scoreCandidate } from '../src/services/matching.js';
import { calculate } from '../src/services/cost.js';
import { occurrenceDates } from '../src/services/rides.js';
import { distanceToPolylineKm, haversineKm, routeOverlap } from '../src/utils/geo.js';

// Gurgaon -> Noida corridor, roughly west to east across Delhi.
const GURGAON = { lat: 28.4949, lng: 77.0895 };
const SAKET = { lat: 28.5245, lng: 77.2066 };
const NOIDA = { lat: 28.628, lng: 77.3649 };
const FARIDABAD = { lat: 28.4089, lng: 77.3178 }; // well south of the corridor

const line = [GURGAON, SAKET, NOIDA];

const tolerances = {
  pickupRadiusKm: 5,
  dropRadiusKm: 5,
  timeWindowMin: 30,
  maxDetourKm: 10,
  maxDetourMin: 20,
};

const ride = {
  origin: GURGAON,
  destination: NOIDA,
  departureTime: '09:00',
  recurrenceDays: [1, 2, 3, 4, 5],
  line,
  routeDistanceKm: 45,
  seatsAvailable: 3,
  tolerances,
};

describe('geo', () => {
  it('measures real distance between corridor points', () => {
    expect(haversineKm(GURGAON, NOIDA)).toBeGreaterThan(25);
    expect(haversineKm(GURGAON, NOIDA)).toBeLessThan(35);
  });

  it('places a point on the corridor near the line and one off it far away', () => {
    expect(distanceToPolylineKm(SAKET, line)).toBeLessThan(0.5);
    expect(distanceToPolylineKm(FARIDABAD, line)).toBeGreaterThan(5);
  });

  it('reports high overlap for a same-corridor trip and low for a crossing one', () => {
    expect(routeOverlap(SAKET, NOIDA, line, 2.5)).toBeGreaterThan(0.8);
    expect(routeOverlap(FARIDABAD, { lat: 28.9, lng: 77.1 }, line, 2.5)).toBeLessThan(0.5);
  });
});

describe('matching score', () => {
  const query = { origin: SAKET, destination: NOIDA, departureTime: '09:05', days: [1, 2, 3, 4, 5] };

  it('accepts a same-corridor passenger with an explainable score', () => {
    const r = scoreCandidate(query, ride, 20, 1.2, 4);
    expect(r.rejectedReason).toBeUndefined();
    expect(r.score).toBeGreaterThan(0.5);
    expect(r.reasons.join(' ')).toMatch(/corridor|route covered/);
    expect(r.components.timeDifferenceMin).toBe(5);
  });

  it('is deterministic — same inputs, same score', () => {
    expect(scoreCandidate(query, ride, 20, 1.2, 4)).toEqual(scoreCandidate(query, ride, 20, 1.2, 4));
  });

  it('rejects a pickup outside the driver tolerance, and says so', () => {
    const r = scoreCandidate({ ...query, origin: FARIDABAD }, ride, 20, 1.2, 4);
    expect(r.score).toBe(0);
    expect(r.rejectedReason).toMatch(/^pickup_/);
  });

  it('rejects a departure outside the time window', () => {
    const r = scoreCandidate({ ...query, departureTime: '13:00' }, ride, 20, 1.2, 4);
    expect(r.rejectedReason).toMatch(/^departure_/);
  });

  it('rejects an excessive detour', () => {
    const r = scoreCandidate(query, ride, 20, 25, 40);
    expect(r.rejectedReason).toMatch(/^detour_/);
  });

  it('rejects someone travelling the opposite way down the same corridor', () => {
    const r = scoreCandidate({ ...query, origin: NOIDA, destination: SAKET }, ride, 20, 1, 2);
    expect(r.rejectedReason).toBe('opposite_direction');
  });

  it('rejects a full ride even when the route is perfect', () => {
    const r = scoreCandidate(query, { ...ride, seatsAvailable: 0 }, 20, 0, 0);
    expect(r.rejectedReason).toBe('no_seats_available');
  });

  it('rejects a passenger with no overlapping commute days', () => {
    const r = scoreCandidate({ ...query, days: [0, 6] }, ride, 20, 1, 2);
    expect(r.rejectedReason).toBe('no_recurring_day_overlap');
  });

  it('scores a closer pickup higher than a distant one', () => {
    const near = scoreCandidate(query, ride, 20, 1, 2).score;
    const far = scoreCandidate({ ...query, origin: { lat: 28.549, lng: 77.212 } }, ride, 20, 1, 2).score;
    expect(near).toBeGreaterThan(far);
  });
});

describe('contribution calculation', () => {
  it('applies the documented formula', () => {
    // 45 km / 18 kmpl * 100 = 250 fuel cost; driver absorbs 25%; 2 passengers
    // -> 250 * 0.75 / 2 = 93.75 -> rounded to nearest 5 = 95
    const r = calculate({ distanceKm: 45, fuelPrice: 100, efficiencyKmpl: 18, occupants: 3, driverShare: 0.25 });
    expect(r.tripFuelCost).toBe(250);
    expect(r.amount).toBe(95);
    expect(r.amount % 5).toBe(0);
  });

  it('charges each passenger less as occupancy rises', () => {
    const base = { distanceKm: 45, fuelPrice: 100, efficiencyKmpl: 18, driverShare: 0.25 };
    const two = calculate({ ...base, occupants: 2 }).amount;
    const four = calculate({ ...base, occupants: 4 }).amount;
    expect(four).toBeLessThan(two);
  });

  it('never falls below the configured minimum', () => {
    const r = calculate({ distanceKm: 0.5, fuelPrice: 100, efficiencyKmpl: 20, occupants: 4, driverShare: 0.25 });
    expect(r.amount).toBeGreaterThanOrEqual(10);
  });

  it('keeps every input needed to audit the number', () => {
    const r = calculate({ distanceKm: 45, fuelPrice: 100, efficiencyKmpl: 18, occupants: 3, driverShare: 0.25 });
    expect(r).toMatchObject({ distanceKm: 45, fuelPrice: 100, efficiencyKmpl: 18, occupants: 3 });
    expect(r.formulaVersion).toBeTruthy();
  });
});

describe('recurring occurrence generation', () => {
  const now = new Date('2026-09-07T06:00:00Z'); // a Monday
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

  it('emits one future date for a one-off ride', () => {
    const dates = occurrenceDates(
      { is_recurring: false, recurrence_days: [], series_start_date: '2026-09-10', series_end_date: null },
      28, now,
    );
    expect(dates).toEqual(['2026-09-10']);
  });

  it('emits nothing for a one-off ride whose date has passed', () => {
    const dates = occurrenceDates(
      { is_recurring: false, recurrence_days: [], series_start_date: '2026-09-01', series_end_date: null },
      28, now,
    );
    expect(dates).toEqual([]);
  });

  it('emits only the selected weekdays', () => {
    const dates = occurrenceDates(
      { is_recurring: true, recurrence_days: [1, 3], series_start_date: '2026-09-07', series_end_date: null },
      14, now,
    );
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.every((d) => [1, 3].includes(dow(d)))).toBe(true);
  });

  it('stops at the series end date', () => {
    const dates = occurrenceDates(
      { is_recurring: true, recurrence_days: [1, 2, 3, 4, 5],
        series_start_date: '2026-09-07', series_end_date: '2026-09-11' },
      28, now,
    );
    expect(dates.at(-1)).toBe('2026-09-11');
  });

  it('never emits a date before today', () => {
    const dates = occurrenceDates(
      { is_recurring: true, recurrence_days: [0, 1, 2, 3, 4, 5, 6],
        series_start_date: '2026-01-01', series_end_date: null },
      7, now,
    );
    expect(dates.every((d) => d >= '2026-09-07')).toBe(true);
  });

  it('produces no duplicate dates — regeneration stays idempotent', () => {
    const dates = occurrenceDates(
      { is_recurring: true, recurrence_days: [1, 2, 3, 4, 5],
        series_start_date: '2026-09-07', series_end_date: null },
      28, now,
    );
    expect(new Set(dates).size).toBe(dates.length);
  });
});
