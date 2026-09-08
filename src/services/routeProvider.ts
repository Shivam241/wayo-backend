import { createHash } from 'node:crypto';
import { config } from '../config/index.js';
import { cacheGet, cacheSet } from '../infra/redis.js';
import { logger } from '../utils/logger.js';
import { haversineKm, type LatLng } from '../utils/geo.js';

export type Route = {
  provider: string;
  polyline: string;
  geometry: LatLng[];
  distanceKm: number;
  durationMin: number;
  fingerprint: string;
  degraded: boolean; // true when this came from the local fallback
};

export type Place = { label: string; lat: number; lng: number };

const key = (a: LatLng, b: LatLng, p: string) =>
  `route:${p}:${a.lat.toFixed(4)},${a.lng.toFixed(4)}:${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

const fingerprint = (r: Omit<Route, 'fingerprint' | 'degraded'>) =>
  createHash('sha1')
    .update(`${r.provider}|${r.polyline}|${r.distanceKm}|${r.durationMin}`)
    .digest('hex')
    .slice(0, 16);

/**
 * Straight-line fallback. Not a real route, but it keeps ride creation,
 * matching and cost calculation working when the mapping provider is down or
 * unconfigured — the charter's graceful-degradation rule.
 */
function localRoute(from: LatLng, to: LatLng): Route {
  const straight = haversineKm(from, to);
  const distanceKm = Math.round(straight * 1.3 * 100) / 100; // road factor
  const geometry: LatLng[] = Array.from({ length: 21 }, (_, i) => ({
    lat: from.lat + ((to.lat - from.lat) * i) / 20,
    lng: from.lng + ((to.lng - from.lng) * i) / 20,
  }));
  const base = {
    provider: 'local',
    polyline: encodePolyline(geometry),
    geometry,
    distanceKm,
    durationMin: Math.max(1, Math.round((distanceKm / 25) * 60)), // 25 km/h city average
  };
  return { ...base, fingerprint: fingerprint(base), degraded: true };
}

async function googleRoute(from: LatLng, to: LatLng): Promise<Route> {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json?origin=${from.lat},${from.lng}` +
    `&destination=${to.lat},${to.lng}&key=${config.maps.googleKey}`;
  const res = await fetch(url);
  const json: any = await res.json();
  if (json.status !== 'OK' || !json.routes?.length) throw new Error(`google: ${json.status}`);
  const r = json.routes[0];
  const leg = r.legs[0];
  const polyline: string = r.overview_polyline.points;
  const base = {
    provider: 'google',
    polyline,
    geometry: decodePolyline(polyline),
    distanceKm: Math.round((leg.distance.value / 1000) * 100) / 100,
    durationMin: Math.round(leg.duration.value / 60),
  };
  return { ...base, fingerprint: fingerprint(base), degraded: false };
}

async function mapboxRoute(from: LatLng, to: LatLng): Promise<Route> {
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lng},${from.lat};${to.lng},${to.lat}` +
    `?overview=full&geometries=polyline&access_token=${config.maps.mapboxToken}`;
  const res = await fetch(url);
  const json: any = await res.json();
  if (!json.routes?.length) throw new Error(`mapbox: ${json.code ?? 'no route'}`);
  const r = json.routes[0];
  const base = {
    provider: 'mapbox',
    polyline: r.geometry as string,
    geometry: decodePolyline(r.geometry),
    distanceKm: Math.round((r.distance / 1000) * 100) / 100,
    durationMin: Math.round(r.duration / 60),
  };
  return { ...base, fingerprint: fingerprint(base), degraded: false };
}

/** Cached, provider-agnostic route lookup. Never throws. */
export async function getRoute(from: LatLng, to: LatLng): Promise<Route> {
  const provider = config.maps.provider;
  const k = key(from, to, provider);
  const cached = await cacheGet<Route>(k);
  if (cached) return cached;

  let route: Route;
  try {
    if (provider === 'google' && config.maps.googleKey) route = await googleRoute(from, to);
    else if (provider === 'mapbox' && config.maps.mapboxToken) route = await mapboxRoute(from, to);
    else route = localRoute(from, to);
  } catch (err) {
    logger.warn({ err, provider }, 'route provider failed — falling back to local estimate');
    route = localRoute(from, to);
  }

  if (!route.degraded) await cacheSet(k, route, config.maps.routeCacheTtlSec);
  return route;
}

/** Place search. Falls back to echoing the query so onboarding still works. */
export async function searchPlaces(q: string, near?: LatLng): Promise<Place[]> {
  if (config.maps.provider === 'mapbox' && config.maps.mapboxToken) {
    const prox = near ? `&proximity=${near.lng},${near.lat}` : '';
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${config.maps.mapboxToken}${prox}`;
    try {
      const json: any = await (await fetch(url)).json();
      return (json.features ?? []).map((f: any) => ({
        label: f.place_name,
        lat: f.center[1],
        lng: f.center[0],
      }));
    } catch (err) {
      logger.warn({ err }, 'geocoding failed');
    }
  }
  if (config.maps.provider === 'google' && config.maps.googleKey) {
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(q)}&key=${config.maps.googleKey}`;
    try {
      const json: any = await (await fetch(url)).json();
      return (json.results ?? []).map((r: any) => ({
        label: r.formatted_address ?? r.name,
        lat: r.geometry.location.lat,
        lng: r.geometry.location.lng,
      }));
    } catch (err) {
      logger.warn({ err }, 'geocoding failed');
    }
  }
  return [];
}

// ---- Google encoded-polyline codec (shared by Google and Mapbox) ----------

export function decodePolyline(str: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const isLat of [true, false]) {
      let result = 0, shift = 0, b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (isLat) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

export function encodePolyline(points: LatLng[], precision = 5): string {
  const factor = 10 ** precision;
  let prevLat = 0, prevLng = 0, out = '';
  const enc = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (n >= 0x20) {
      s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += enc(lat - prevLat) + enc(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}
