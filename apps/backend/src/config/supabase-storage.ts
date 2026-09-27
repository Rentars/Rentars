import { supabase } from './supabase.js';

export const STORAGE_BUCKET = 'property-images';
/** Private bucket for dispute case evidence (signed URLs only). */
export const DISPUTE_EVIDENCE_BUCKET = 'dispute-evidence';

interface MulterFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

type Sharp = typeof import('sharp');
let sharpLib: Sharp | null = null;

async function getSharp(): Promise<Sharp | null> {
  if (sharpLib !== null) return sharpLib;
  try {
    sharpLib = (await import('sharp')) as unknown as Sharp;
    return sharpLib;
  } catch {
    return null;
  }
}

export interface OptimizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
}

/**
 * Compresses, auto-rotates, strips metadata, and converts an image buffer to WebP.
 * Strips all EXIF/GPS data by default during re-encoding.
 * Falls back to original buffer when sharp is unavailable.
 */
export async function optimizeImage(
  buffer: Buffer,
  mimetype: string,
  options: OptimizeOptions = {}
): Promise<{ buffer: Buffer; mimetype: string }> {
  const { maxWidth = 1920, maxHeight = 1080, quality = 80 } = options;

  const sharp = await getSharp();
  if (!sharp) {
    return { buffer, mimetype };
  }

  const optimized = await (sharp as any)(buffer)
    .rotate()
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();

  return { buffer: optimized, mimetype: 'image/webp' };
}

/**
 * Extracts the storage file path from a Supabase public URL.
 * URL format: .../object/public/<bucket>/<path>
 */
function extractStoragePath(imageUrl: string): string {
  const marker = `/${STORAGE_BUCKET}/`;
  const idx = imageUrl.indexOf(marker);
  if (idx === -1) throw new Error(`Invalid image URL: cannot resolve storage path`);
  return imageUrl.slice(idx + marker.length);
}

export async function uploadImage(
  propertyId: string,
  file: MulterFile,
): Promise<{ url: string; thumbnailUrl: string }> {
  const timestamp = Date.now();
  const safeBaseName = file.originalname.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'image';

  // Process main image (max 1920px, EXIF stripped, WebP)
  const { buffer: mainBuffer, mimetype: mainMime } = await optimizeImage(
    file.buffer,
    file.mimetype,
    { maxWidth: 1920, maxHeight: 1080, quality: 80 }
  );

  // Process thumbnail variant (max 800px, EXIF stripped, WebP)
  const { buffer: thumbBuffer, mimetype: thumbMime } = await optimizeImage(
    file.buffer,
    file.mimetype,
    { maxWidth: 800, maxHeight: 600, quality: 80 }
  );

  const mainExt = mainMime === 'image/webp' ? 'webp' : 'jpg';
  const thumbExt = thumbMime === 'image/webp' ? 'webp' : 'jpg';

  const mainFileName = `${propertyId}/${timestamp}-${safeBaseName}.${mainExt}`;
  const thumbFileName = `${propertyId}/thumb_${timestamp}-${safeBaseName}.${thumbExt}`;

  // Upload main image
  const { error: mainError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(mainFileName, mainBuffer, {
      contentType: mainMime,
    });

  if (mainError) {
    throw new Error(`Failed to upload image: ${mainError.message}`);
  }

  // Upload thumbnail variant
  const { error: thumbError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(thumbFileName, thumbBuffer, {
      contentType: thumbMime,
    });

  if (thumbError) {
    throw new Error(`Failed to upload thumbnail: ${thumbError.message}`);
  }

  const { data: mainData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(mainFileName);
  const { data: thumbData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(thumbFileName);

  return {
    url: mainData.publicUrl,
    thumbnailUrl: thumbData.publicUrl,
  };
}

export async function deleteImage(imageUrl: string, thumbnailUrl?: string | null): Promise<void> {
  const pathsToDelete: string[] = [extractStoragePath(imageUrl)];

  if (thumbnailUrl) {
    try {
      pathsToDelete.push(extractStoragePath(thumbnailUrl));
    } catch {
      // Ignore if thumbnail storage path extraction fails
    }
  }

  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(pathsToDelete);

  if (error) {
    throw new Error(`Failed to delete image: ${error.message}`);
  }
}

/**
 * Upload a dispute evidence object to the private dispute-evidence bucket.
 * Path must be scoped under bookings/{bookingId}/.
 */
export async function uploadDisputeEvidenceObject(
  storagePath: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ path: string }> {
  const { error } = await supabase.storage.from(DISPUTE_EVIDENCE_BUCKET).upload(storagePath, buffer, {
    contentType,
    upsert: false,
  });

  if (error) {
    throw new Error(`Failed to upload dispute evidence: ${error.message}`);
  }

  return { path: storagePath };
}

/** Time-limited signed URL for moderator/participant download. */
export async function getDisputeEvidenceSignedUrl(
  storagePath: string,
  expiresInSeconds: number,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(DISPUTE_EVIDENCE_BUCKET)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message ?? 'Failed to create signed URL for dispute evidence');
  }

  return data.signedUrl;
}

export async function removeDisputeEvidenceObject(storagePath: string): Promise<void> {
  const { error } = await supabase.storage.from(DISPUTE_EVIDENCE_BUCKET).remove([storagePath]);
  if (error) {
    throw new Error(`Failed to delete dispute evidence object: ${error.message}`);
  }
}
