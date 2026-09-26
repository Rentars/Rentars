import sharp from 'sharp';
import { structuredLog } from '@/middleware/logging.middleware.js';

export interface FileValidationOptions {
  maxSizeBytes: number;
  maxWidth: number;
  maxHeight: number;
  minWidth: number;
  minHeight: number;
  allowedFormats: string[];
}

export const DEFAULT_IMAGE_OPTIONS: FileValidationOptions = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  maxWidth: 4096,
  maxHeight: 4096,
  minWidth: 200,
  minHeight: 200,
  allowedFormats: ['jpeg', 'png', 'webp'],
};

const MAGIC_BYTES = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF header
  gif: [0x47, 0x49, 0x46],
  bmp: [0x42, 0x4d],
  svg: [0x3c, 0x3f, 0x78, 0x6d], // <?xml
  exe: [0x4d, 0x5a], // MZ (PE header)
  zip: [0x50, 0x4b], // PK (ZIP)
};

export async function detectFileType(buffer: Buffer): Promise<string | null> {
  const bytes = Array.from(buffer.slice(0, 20));

  if (bytes.slice(0, 3).every((b, i) => b === MAGIC_BYTES.jpeg[i])) return 'jpeg';
  if (bytes.slice(0, 4).every((b, i) => b === MAGIC_BYTES.png[i])) return 'png';
  if (bytes.slice(0, 4).every((b, i) => b === MAGIC_BYTES.webp[i])) return 'webp';
  if (bytes.slice(0, 3).every((b, i) => b === MAGIC_BYTES.gif[i])) return 'gif';
  if (bytes.slice(0, 2).every((b, i) => b === MAGIC_BYTES.bmp[i])) return 'bmp';
  if (bytes.slice(0, 4).every((b, i) => b === MAGIC_BYTES.svg[i])) return 'svg';
  if (bytes.slice(0, 2).every((b, i) => b === MAGIC_BYTES.exe[i])) return 'exe';
  if (bytes.slice(0, 2).every((b, i) => b === MAGIC_BYTES.zip[i])) return 'zip';

  return null;
}

export async function validateImage(
  buffer: Buffer,
  options: Partial<FileValidationOptions> = {},
): Promise<{ valid: boolean; error?: string }> {
  const opts = { ...DEFAULT_IMAGE_OPTIONS, ...options };

  if (buffer.length > opts.maxSizeBytes) {
    return { valid: false, error: `File exceeds maximum size of ${opts.maxSizeBytes} bytes` };
  }

  const detectedType = await detectFileType(buffer);

  if (!detectedType) {
    return { valid: false, error: 'Could not detect file type — file may be corrupted' };
  }

  if (['exe', 'zip'].includes(detectedType)) {
    structuredLog({
      level: 'warn',
      message: 'Upload rejected: executable file detected',
      timestamp: new Date().toISOString(),
      detectedType,
      fileSize: buffer.length,
    });
    return { valid: false, error: 'Executable files are not allowed' };
  }

  if (detectedType === 'svg') {
    return validateSvg(buffer);
  }

  if (!opts.allowedFormats.includes(detectedType)) {
    return { valid: false, error: `File type '${detectedType}' is not allowed` };
  }

  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      return { valid: false, error: 'Could not determine image dimensions' };
    }

    if (metadata.width < opts.minWidth || metadata.height < opts.minHeight) {
      return {
        valid: false,
        error: `Image dimensions too small. Minimum ${opts.minWidth}x${opts.minHeight}px, got ${metadata.width}x${metadata.height}px`,
      };
    }

    if (metadata.width > opts.maxWidth || metadata.height > opts.maxHeight) {
      return {
        valid: false,
        error: `Image dimensions too large. Maximum ${opts.maxWidth}x${opts.maxHeight}px, got ${metadata.width}x${metadata.height}px`,
      };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: `Image validation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function normalizeImage(buffer: Buffer, format: 'jpeg' | 'png' | 'webp' = 'webp'): Promise<Buffer> {
  return sharp(buffer)
    .withMetadata() // Preserve orientation
    .toFormat(format, { quality: 85, progressive: true })
    .toBuffer();
}

export async function generateImageDerivatives(
  buffer: Buffer,
): Promise<{
  thumbnail: Buffer;
  small: Buffer;
  medium: Buffer;
}> {
  const base = sharp(buffer).withMetadata();

  const [thumbnail, small, medium] = await Promise.all([
    base
      .clone()
      .resize(200, 200, { fit: 'cover', position: 'center' })
      .toFormat('webp', { quality: 75 })
      .toBuffer(),
    base
      .clone()
      .resize(500, 500, { fit: 'cover', position: 'center' })
      .toFormat('webp', { quality: 80 })
      .toBuffer(),
    base
      .clone()
      .resize(1200, 1200, { fit: 'cover', position: 'center' })
      .toFormat('webp', { quality: 85 })
      .toBuffer(),
  ]);

  return { thumbnail, small, medium };
}

export function validateSvg(buffer: Buffer): { valid: boolean; error?: string } {
  try {
    const svg = buffer.toString('utf-8');

    const dangerousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /<iframe/i,
      /<object/i,
      /<embed/i,
      /<link/i,
      /<style/i,
      /<meta/i,
      /<frame/i,
      /<xml/i,
      /<!--/,
      /<!ENTITY/i,
      /SYSTEM/i,
      /DOCTYPE/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(svg)) {
        structuredLog({
          level: 'warn',
          message: 'Upload rejected: unsafe SVG content detected',
          timestamp: new Date().toISOString(),
          pattern: pattern.toString(),
        });
        return { valid: false, error: 'SVG contains unsafe or disallowed content' };
      }
    }

    if (!svg.includes('<svg')) {
      return { valid: false, error: 'File is not a valid SVG' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'SVG validation failed' };
  }
}

export function generateStoragePath(userId: string, propertyId: string, fileName: string): string {
  const timestamp = Date.now();
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
  return `properties/${propertyId}/user-${userId}/${timestamp}-${sanitizedName}`;
}

export function generateSignedUrl(path: string, expiresInSeconds: number = 3600): string {
  return `${path}?expires=${Math.floor(Date.now() / 1000) + expiresInSeconds}`;
}

export async function uploadToStorage(
  bucket: any,
  path: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const { data, error } = await bucket.upload(path, buffer, {
      contentType,
      cacheControl: '3600',
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, url: data.path };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Upload failed',
    };
  }
}
