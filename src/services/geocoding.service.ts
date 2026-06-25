/**
 * Address → coordinates geocoding for distance search.
 *
 * Default provider: Nominatim / OpenStreetMap (free, no key). Respects the OSM
 * usage policy: a real User-Agent and ~1 req/s throttle. Results are cached in
 * memory by normalized address so repeated saves don't re-hit the provider
 * (callers also persist `geocodedAt` to avoid re-geocoding unchanged addresses).
 *
 * Swap to Google by setting GEOCODER=google + GOOGLE_MAPS_API_KEY.
 * Always degrades to `null` on any failure — geocoding must never block a save.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

const PROVIDER = (process.env.GEOCODER ?? 'nominatim').toLowerCase();
const USER_AGENT = process.env.NOMINATIM_USER_AGENT ?? 'MediSync/1.0 (+https://medisync.app)';
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY ?? '';
const COUNTRY = process.env.GEOCODER_COUNTRY ?? 'ar';

const cache = new Map<string, GeoPoint | null>();

// Nominatim asks for <= 1 request per second.
const MIN_INTERVAL_MS = 1100;
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function normalize(address: string): string {
  return address.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Serialize + throttle provider calls so we never exceed ~1 req/s. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCallAt = Date.now();
    }
  });
  // Keep the chain alive even if this call rejects.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function geocodeNominatim(address: string): Promise<GeoPoint | null> {
  const url =
    'https://nominatim.openstreetmap.org/search' +
    `?format=jsonv2&limit=1&countrycodes=${encodeURIComponent(COUNTRY)}` +
    `&q=${encodeURIComponent(address)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'es' } });
  if (!res.ok) return null;
  const data = (await res.json()) as Array<{ lat: string; lon: string }>;
  if (!Array.isArray(data) || data.length === 0) return null;
  const lat = Number(data[0].lat);
  const lng = Number(data[0].lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

async function geocodeGoogle(address: string): Promise<GeoPoint | null> {
  if (!GOOGLE_KEY) return null;
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json' +
    `?region=${encodeURIComponent(COUNTRY)}&address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as {
    status: string;
    results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
  };
  if (data.status !== 'OK' || !data.results?.length) return null;
  const { lat, lng } = data.results[0].geometry.location;
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/**
 * Resolve a free-text address to coordinates, or `null` if it can't be
 * geocoded. Cached + throttled. Never throws.
 */
export async function geocodeAddress(address?: string | null): Promise<GeoPoint | null> {
  if (!address || !address.trim()) return null;
  const key = normalize(address);
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const point = await throttled(() =>
      PROVIDER === 'google' ? geocodeGoogle(address) : geocodeNominatim(address),
    );
    cache.set(key, point);
    return point;
  } catch (err) {
    console.error('[geocoding] failed for address:', address, err);
    cache.set(key, null);
    return null;
  }
}
