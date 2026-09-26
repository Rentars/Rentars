-- Add flag_reason column to reviews table
-- Required by issue #500: flagReview must persist a non-empty reason alongside the flag
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS flag_reason TEXT;
