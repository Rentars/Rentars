-- Reviews table for property/user ratings
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID REFERENCES properties(id) ON DELETE SET NULL,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  on_chain_id BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  -- One review per booking per reviewer
  UNIQUE (booking_id, reviewer_id)
);

CREATE INDEX idx_reviews_property_id ON reviews(property_id);
CREATE INDEX idx_reviews_target_id ON reviews(target_id);
CREATE INDEX idx_reviews_reviewer_id ON reviews(reviewer_id);
