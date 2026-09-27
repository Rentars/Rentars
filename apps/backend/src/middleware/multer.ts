import multer from 'multer';
import { env } from '@/config/env.js';

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

const storage = multer.memoryStorage();

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
  limits: { fileSize: env.MAX_IMAGE_SIZE_BYTES },
});

const DISPUTE_EVIDENCE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/json',
  'text/plain',
];

const MAX_DISPUTE_EVIDENCE_BYTES = 10 * 1024 * 1024;

const disputeEvidenceFilter = (
  _req: unknown,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback,
) => {
  if (DISPUTE_EVIDENCE_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Dispute evidence must be JPEG, PNG, WebP, PDF, JSON, or plain text'));
  }
};

/** Multipart upload for dispute evidence (images and documents, up to 10 MB). */
export const disputeEvidenceUpload = multer({
  storage,
  fileFilter: disputeEvidenceFilter,
  limits: { fileSize: MAX_DISPUTE_EVIDENCE_BYTES },
});
