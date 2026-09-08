export type LatLng = { lat: number; lng: number };

const R = 6371; // km
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Shortest distance from point p to segment ab, in km (flat-earth approximation
 *  — fine at city scale, and only ever used for corridor tolerance). */
export function distanceToSegmentKm(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = 111.32 * Math.cos(rad((a.lat + b.lat) / 2));
  const ky = 110.57;
  const px = p.lng * kx, py = p.lat * ky;
  const ax = a.lng * kx, ay = a.lat * ky;
  const bx = b.lng * kx, by = b.lat * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to the nearest part of a polyline, in km. */
export function distanceToPolylineKm(p: LatLng, line: LatLng[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineKm(p, line[0]);
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    best = Math.min(best, distanceToSegmentKm(p, line[i], line[i + 1]));
  }
  return best;
}

/** How far along the polyline (0..1) the point projects. Used to check the
 *  passenger travels in the same direction as the driver, not against it. */
export function progressAlongPolyline(p: LatLng, line: LatLng[]): number {
  if (line.length < 2) return 0;
  let cum = 0, best = Infinity, bestAt = 0, total = 0;
  for (let i = 0; i < line.length - 1; i++) total += haversineKm(line[i], line[i + 1]);
  for (let i = 0; i < line.length - 1; i++) {
    const seg = haversineKm(line[i], line[i + 1]);
    const d = distanceToSegmentKm(p, line[i], line[i + 1]);
    if (d < best) {
      best = d;
      bestAt = cum + seg / 2;
    }
    cum += seg;
  }
  return total === 0 ? 0 : bestAt / total;
}

/**
 * Fraction of the passenger's own trip that is covered by the driver's route.
 * Sampled along the passenger's straight line; a point counts as covered when
 * it lies within `toleranceKm` of the driver's polyline.
 */
export function routeOverlap(
  from: LatLng,
  to: LatLng,
  driverLine: LatLng[],
  toleranceKm: number,
  samples = 20,
): number {
  let covered = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
    if (distanceToPolylineKm(p, driverLine) <= toleranceKm) covered++;
  }
  return covered / (samples + 1);
}

/** Bounding box in degrees around a point, for cheap SQL pre-filtering. */
export function bbox(p: LatLng, km: number) {
  const dLat = km / 110.574;
  const dLng = km / (111.32 * Math.cos(rad(p.lat)) || 1);
  return { minLat: p.lat - dLat, maxLat: p.lat + dLat, minLng: p.lng - dLng, maxLng: p.lng + dLng };
}

/** Minutes between two HH:MM:SS clock times, wrapping across midnight. */
export function clockDiffMinutes(a: string, b: string): number {
  const toMin = (s: string) => {
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const d = Math.abs(toMin(a) - toMin(b));
  return Math.min(d, 1440 - d);
}
