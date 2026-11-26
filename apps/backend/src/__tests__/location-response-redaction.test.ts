/** #936: one response-level redaction helper covers every public payload. */
import { describe, it, expect } from 'vitest';
import {
  redactPublicLocationResponse,
  PUBLIC_LOCATION_RADIUS_M,
} from '../utils/locationPrivacy.js';

const listing = {
  id: 'p1',
  latitude: 48.856613,
  longitude: 2.352222,
  address: '12 Rue Privée',
  location: { lat: 48.856613, lng: 2.352222, city: 'Paris' },
};

describe('redactPublicLocationResponse', () => {
  it('removes exact coordinates and private addresses from public response bodies', () => {
    const body = { data: [listing] };
    const redacted = redactPublicLocationResponse(body);
    const json = JSON.stringify(redacted);

    expect(json).not.toContain('48.856613');
    expect(json).not.toContain('2.352222');
    expect(json).not.toContain('12 Rue Privée');
    expect(json).not.toContain('"address"');
    expect(redacted.data[0].approximate_latitude).toBeTypeOf('number');
    expect(redacted.data[0].location_radius_m).toBe(PUBLIC_LOCATION_RADIUS_M);
  });

  it('keeps exact values for a host, including nested location objects', () => {
    const redacted = redactPublicLocationResponse(listing, { tier: 'host' });
    expect(redacted.latitude).toBe(48.856613);
    expect(redacted.location.lat).toBe(48.856613);
    expect(redacted.address).toBe('12 Rue Privée');
  });

  it('withholds exact coordinates from booking participants unless the host opted in', () => {
    const withoutOptIn = redactPublicLocationResponse(listing, { tier: 'booking' });
    expect(JSON.stringify(withoutOptIn)).not.toContain('48.856613');

    const withOptIn = redactPublicLocationResponse(listing, {
      tier: 'booking',
      hostAllowsExact: true,
    });
    expect(withOptIn.latitude).toBe(48.856613);
  });

  it('produces stable public cache variants with no coordinate leakage', () => {
    const first = JSON.stringify(redactPublicLocationResponse([listing]));
    const second = JSON.stringify(redactPublicLocationResponse([listing]));
    expect(first).toBe(second);
    expect(first).not.toContain('latitude":48');
  });
});
