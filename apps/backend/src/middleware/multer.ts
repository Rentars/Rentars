import multer from 'multer';
import { env } from '@/config/env.js';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.memoryStorage();

/**
 * Advisory pre-check only. The client-supplied MIME type is untrusted, and the
 * real format is decided from the bytes in imageValidation.ts.
 */
const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
  }
};

export const upload = multer({
  storage,
  fileFilter,
  // Bound the whole multipart request, not just the file: a client can
  // otherwise stream huge field values or thousands of parts into memory.
  limits: {
    fileSize: env.MAX_IMAGE_SIZE_BYTES,
    files: 1,
    fields: 10,
    parts: 12,
    fieldSize: 16 * 1024,
    fieldNameSize: 128,
  },
});
