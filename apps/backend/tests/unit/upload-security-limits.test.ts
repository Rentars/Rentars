/** #992: adversarial uploads are rejected before durable storage. */
import { describe, it, expect, mock, beforeAll } from 'bun:test';
import sharp from 'sharp';

const remove = mock(async () => ({ error: null }));
const upload = mock(async () => ({ error: null }));
mock.module('../../src/config/supabase.js', () => ({
  supabase: {
    storage: { from: () => ({ upload, remove, getPublicUrl: () => ({ data: { publicUrl: 'https://example.test/x.webp' } }) }) },
  },
}));

let optimizeImage: typeof import('../../src/config/supabase-storage.js').optimizeImage;
let uploadImage: typeof import('../../src/config/supabase-storage.js').uploadImage;
let detectImageFormat: typeof import('../../src/services/imageValidation.js').detectImageFormat;
let ImageValidationError: typeof import('../../src/services/imageValidation.js').ImageValidationError;

beforeAll(async () => {
  ({ optimizeImage, uploadImage } = await import('../../src/config/supabase-storage.js'));
  ({ detectImageFormat, ImageValidationError } = await import('../../src/services/imageValidation.js'));
});

describe('upload security limits (#992)', () => {
  it('rejects files whose bytes are not a supported image', () => {
    const polyglot = Buffer.concat([
      Buffer.from('GIF89a'),
      Buffer.alloc(1000, 0),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    expect(detectImageFormat(polyglot)).toBeNull();
  });

  it('rejects animated images during validation', async () => {
    const frameA = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#ff0000' },
    }).webp().toBuffer();
    const frameB = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#0000ff' },
    }).webp().toBuffer();
    const animated = await sharp([frameA, frameB], { animated: true })
      .webp({ delay: [100, 100] })
      .toBuffer();

    let error: unknown;
    try {
      await optimizeImage(animated, 'image/webp');
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ImageValidationError);
    expect((error as Error).message).toContain('Animated');
    // Nothing is persisted after failed validation.
    expect(upload).not.toHaveBeenCalled();
  });

  it('normalises a valid image to WebP without storing the original bytes', async () => {
    const png = await sharp({
      create: { width: 400, height: 400, channels: 3, background: '#00ff00' },
    }).png().toBuffer();

    const result = await uploadImage('11111111-1111-4111-8111-111111111111', {
      buffer: png,
      mimetype: 'application/octet-stream', // deliberately untrustworthy
      originalname: 'photo.exe',
    });
    expect(result.url).toContain('webp');
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
