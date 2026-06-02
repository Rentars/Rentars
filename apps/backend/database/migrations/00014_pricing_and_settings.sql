-- Migration 00014: Add pricing rules and property settings
-- Supports seasonal rates, demand-based pricing, and minimum stay rules

-- Property settings: minimum stay and base price overrides
CREATE TABLE IF NOT EXISTS property_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  min_stay_nights INT NOT NULL DEFAULT 1 CHECK (min_stay_nights >= 1),
  max_stay_nights INT CHECK (max_stay_nights >= 1),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (property_id)
);

-- Pricing rules: seasonal rates and demand-based multipliers
CREATE TABLE IF NOT EXISTS pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN ('seasonal', 'demand', 'weekend')),
  start_date DATE,
  end_date DATE,
  price_override DECIMAL(10, 2),   -- fixed nightly price (overrides base)
  multiplier DECIMAL(5, 4),         -- e.g. 1.2 = 20% surcharge
  priority INT NOT NULL DEFAULT 0,  -- higher = applied first
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pricing_rule_has_value CHECK (price_override IS NOT NULL OR multiplier IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pricing_rules_property ON pricing_rules(property_id);
CREATE INDEX IF NOT EXISTS idx_property_settings_property ON property_settings(property_id);
CREATE INDEX IF NOT EXISTS idx_pricing_rules_dates ON pricing_rules(property_id, start_date, end_date);
