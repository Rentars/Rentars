import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

export interface PricingRule {
  id: string;
  property_id: string;
  rule_type: 'seasonal' | 'demand' | 'weekend';
  start_date?: string | null;
  end_date?: string | null;
  price_override?: number | null;
  multiplier?: number | null;
  priority: number;
}

export interface PricingRuleInput {
  rule_type: 'seasonal' | 'demand' | 'weekend';
  start_date?: string;
  end_date?: string;
  price_override?: number;
  multiplier?: number;
  priority?: number;
}

export interface PriceBreakdown {
  property_id: string;
  check_in: string;
  check_out: string;
  nights: number;
  base_price_per_night: number;
  applied_rules: Array<{ rule_type: string; effect: string }>;
  total_price: number;
  price_per_night: number;
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function dateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Calculate nightly price for a specific date given sorted pricing rules.
 * Rules are applied by priority (highest first); first match wins.
 */
function applyRules(
  date: Date,
  basePricePerNight: number,
  rules: PricingRule[],
): { price: number; ruleType?: string } {
  const ds = dateStr(date);

  for (const rule of rules) {
    // Weekend rule: applies when the date is Sat or Sun
    if (rule.rule_type === 'weekend' && isWeekend(date)) {
      const price = rule.price_override ?? basePricePerNight * (rule.multiplier ?? 1);
      return { price, ruleType: 'weekend' };
    }

    // Seasonal / demand: applies when date falls in range
    if (
      (rule.rule_type === 'seasonal' || rule.rule_type === 'demand') &&
      rule.start_date &&
      rule.end_date &&
      ds >= rule.start_date &&
      ds < rule.end_date
    ) {
      const price = rule.price_override ?? basePricePerNight * (rule.multiplier ?? 1);
      return { price, ruleType: rule.rule_type };
    }
  }

  return { price: basePricePerNight };
}

/**
 * Calculate price breakdown for a given stay.
 */
export async function calculatePrice(
  propertyId: string,
  checkIn: string,
  checkOut: string,
): Promise<ServiceResponse<PriceBreakdown>> {
  const checkInDate = new Date(checkIn);
  const checkOutDate = new Date(checkOut);

  if (isNaN(checkInDate.getTime()) || isNaN(checkOutDate.getTime())) {
    return { success: false, error: 'Invalid date format' };
  }
  if (checkInDate >= checkOutDate) {
    return { success: false, error: 'check_in must be before check_out' };
  }

  const nights = Math.round(
    (checkOutDate.getTime() - checkInDate.getTime()) / 86400000,
  );

  // Fetch property base price
  const { data: property, error: propError } = await supabase
    .from('properties')
    .select('price_per_night')
    .eq('id', propertyId)
    .single();

  if (propError || !property) return { success: false, error: 'Property not found' };
  const basePricePerNight = (property as { price_per_night: number }).price_per_night;

  // Fetch pricing rules ordered by priority desc
  const { data: rules } = await supabase
    .from('pricing_rules')
    .select('*')
    .eq('property_id', propertyId)
    .order('priority', { ascending: false });

  const sortedRules = (rules ?? []) as PricingRule[];

  // Calculate per-night prices
  let totalPrice = 0;
  const ruleUsage = new Map<string, number>();

  for (let i = 0; i < nights; i++) {
    const date = new Date(checkInDate);
    date.setUTCDate(date.getUTCDate() + i);
    const { price, ruleType } = applyRules(date, basePricePerNight, sortedRules);
    totalPrice += price;
    if (ruleType) {
      ruleUsage.set(ruleType, (ruleUsage.get(ruleType) ?? 0) + 1);
    }
  }

  const appliedRules = Array.from(ruleUsage.entries()).map(([ruleType, count]) => ({
    rule_type: ruleType,
    effect: `Applied for ${count} night(s)`,
  }));

  return {
    success: true,
    data: {
      property_id: propertyId,
      check_in: checkIn,
      check_out: checkOut,
      nights,
      base_price_per_night: basePricePerNight,
      applied_rules: appliedRules,
      total_price: Math.round(totalPrice * 100) / 100,
      price_per_night: Math.round((totalPrice / nights) * 100) / 100,
    },
  };
}

/** List all pricing rules for a property */
export async function getPricingRules(
  propertyId: string,
): Promise<ServiceResponse<PricingRule[]>> {
  const { data, error } = await supabase
    .from('pricing_rules')
    .select('*')
    .eq('property_id', propertyId)
    .order('priority', { ascending: false });

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PricingRule[] };
}

/** Create a pricing rule (owner only) */
export async function createPricingRule(
  propertyId: string,
  ownerId: string,
  input: PricingRuleInput,
): Promise<ServiceResponse<PricingRule>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property) return { success: false, error: 'Property not found' };
  if ((property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  if (!input.price_override && !input.multiplier) {
    return { success: false, error: 'Either price_override or multiplier is required' };
  }

  const { data, error } = await supabase
    .from('pricing_rules')
    .insert({ property_id: propertyId, ...input, priority: input.priority ?? 0 })
    .select()
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as PricingRule };
}

/** Delete a pricing rule (owner only) */
export async function deletePricingRule(
  propertyId: string,
  ruleId: string,
  ownerId: string,
): Promise<ServiceResponse<void>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property || (property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  const { error } = await supabase
    .from('pricing_rules')
    .delete()
    .eq('id', ruleId)
    .eq('property_id', propertyId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Get or upsert property settings (min/max stay) */
export async function getPropertySettings(
  propertyId: string,
): Promise<ServiceResponse<{ min_stay_nights: number; max_stay_nights?: number | null }>> {
  const { data, error } = await supabase
    .from('property_settings')
    .select('min_stay_nights, max_stay_nights')
    .eq('property_id', propertyId)
    .single();

  if (error && error.code !== 'PGRST116') return { success: false, error: error.message };

  return {
    success: true,
    data: data
      ? (data as { min_stay_nights: number; max_stay_nights?: number | null })
      : { min_stay_nights: 1, max_stay_nights: null },
  };
}

/** Update property settings (owner only) */
export async function upsertPropertySettings(
  propertyId: string,
  ownerId: string,
  settings: { min_stay_nights?: number; max_stay_nights?: number | null },
): Promise<ServiceResponse<{ min_stay_nights: number; max_stay_nights?: number | null }>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property) return { success: false, error: 'Property not found' };
  if ((property as { owner_id: string }).owner_id !== ownerId) {
    return { success: false, error: 'Forbidden: you do not own this property' };
  }

  if (settings.min_stay_nights !== undefined && settings.min_stay_nights < 1) {
    return { success: false, error: 'min_stay_nights must be at least 1' };
  }

  const { data, error } = await supabase
    .from('property_settings')
    .upsert({ property_id: propertyId, ...settings }, { onConflict: 'property_id' })
    .select('min_stay_nights, max_stay_nights')
    .single();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data as { min_stay_nights: number; max_stay_nights?: number | null } };
}
