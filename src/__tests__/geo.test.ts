import { haversineKm, boundingBox, isValidCoord } from '../utils/geo';

describe('geo utils', () => {
  // Reference points in Buenos Aires.
  const obelisco = { lat: -34.6037, lng: -58.3816 };
  const laPlata = { lat: -34.9215, lng: -57.9545 };

  describe('haversineKm', () => {
    it('is zero for the same point', () => {
      expect(haversineKm(obelisco, obelisco)).toBeCloseTo(0, 6);
    });

    it('matches a known distance (Obelisco → La Plata ≈ 53 km)', () => {
      const d = haversineKm(obelisco, laPlata);
      expect(d).toBeGreaterThan(50);
      expect(d).toBeLessThan(57);
    });

    it('is symmetric', () => {
      expect(haversineKm(obelisco, laPlata)).toBeCloseTo(haversineKm(laPlata, obelisco), 9);
    });
  });

  describe('boundingBox', () => {
    it('contains the centre point', () => {
      const b = boundingBox(obelisco.lat, obelisco.lng, 10);
      expect(obelisco.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(obelisco.lat).toBeLessThanOrEqual(b.maxLat);
      expect(obelisco.lng).toBeGreaterThanOrEqual(b.minLng);
      expect(obelisco.lng).toBeLessThanOrEqual(b.maxLng);
    });

    it('grows with the radius', () => {
      const small = boundingBox(obelisco.lat, obelisco.lng, 5);
      const big = boundingBox(obelisco.lat, obelisco.lng, 50);
      expect(big.maxLat - big.minLat).toBeGreaterThan(small.maxLat - small.minLat);
    });

    it('fully contains points within the radius', () => {
      // ~5km north of the obelisco must fall inside a 10km box.
      const north = { lat: obelisco.lat + 5 / 111.32, lng: obelisco.lng };
      const b = boundingBox(obelisco.lat, obelisco.lng, 10);
      expect(north.lat).toBeLessThanOrEqual(b.maxLat);
    });
  });

  describe('isValidCoord', () => {
    it('accepts valid coordinates', () => {
      expect(isValidCoord(-34.6, -58.4)).toBe(true);
    });
    it('rejects out-of-range or non-numeric', () => {
      expect(isValidCoord(120, 0)).toBe(false);
      expect(isValidCoord(0, 200)).toBe(false);
      expect(isValidCoord(NaN, 0)).toBe(false);
      expect(isValidCoord('a' as unknown, 0)).toBe(false);
    });
  });
});
