import { describe, it, expect } from 'bun:test';
import { getPublishReadiness } from '../../src/services/property.service.js';

type Prop = Parameters<typeof getPublishReadiness>[0];

const complete = (): Prop =>
  ({
    title: 'Beach House',
    price_per_night: 150,
    city: 'Malaga',
    country: 'Spain',
    bedrooms: 2,
    bathrooms: 1,
    max_guests: 4,
  } as Prop);

describe('getPublishReadiness', () => {
  it('returns ready when all required fields are present and images exist', () => {
    const result = getPublishReadiness(complete(), 1);
    expect(result.ready).toBe(true);
    expect(result.missingFields).toHaveLength(0);
  });

  it('reports missing title', () => {
    const result = getPublishReadiness({ ...complete(), title: '' } as Prop, 1);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain('title');
  });

  it('reports missing image', () => {
    const result = getPublishReadiness(complete(), 0);
    expect(result.ready).toBe(false);
    expect(result.missingFields).toContain('images');
  });

  it('reports all missing fields when property is empty', () => {
    const result = getPublishReadiness({} as Prop, 0);
    expect(result.ready).toBe(false);
    expect(result.missingFields.length).toBeGreaterThan(3);
  });

  it('treats bedrooms=0 (studio) as a valid value', () => {
    const result = getPublishReadiness({ ...complete(), bedrooms: 0 } as Prop, 1);
    expect(result.missingFields).not.toContain('bedrooms');
  });
});
