/**
 * RLS (Row Level Security) Policy Tests
 *
 * Verifies that Supabase RLS policies correctly enforce cross-user data isolation
 * for all sensitive tables, and that publicly-intended data remains accessible.
 *
 * Tables covered:
 *   - profiles          (own-only read/write)
 *   - bookings          (tenant owns, property-owner can read for their properties)
 *   - wishlists         (own-only)
 *   - notifications     (own-only)
 *   - properties        (public read for authenticated users, owner-only writes)
 *   - property_images   (public read, owner-only write)
 *
 * Setup requirements:
 *   - Local Supabase stack running:  supabase start
 *   - Env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *     (defaults to standard local Supabase keys if not set)
 *
 * Run:
 *   bun test tests/rls/rls-policies.test.ts
 *   # or via package script:
 *   bun run test:rls
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';

// ─── Configuration ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost:54321';

// Anon key — enforces RLS (what a real client uses)
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRFA0NiK7W9fDQlUsleJbhUBCmFB9MpNZB8amTFZO7A';

// Service-role key — bypasses RLS, used only for seeding / teardown
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

// ─── Test-user credentials ────────────────────────────────────────────────────

const USER_A    = { email: 'rls-user-a@rentars-test.local',  password: 'RlsTest@UserA_2024!' };
const USER_B    = { email: 'rls-user-b@rentars-test.local',  password: 'RlsTest@UserB_2024!' };
const OWNER_USR = { email: 'rls-owner@rentars-test.local',   password: 'RlsTest@Owner_2024!' };

// ─── Shared state ─────────────────────────────────────────────────────────────

let adminClient:  SupabaseClient; // service_role — bypasses RLS
let clientA:      SupabaseClient; // signed in as user A
let clientB:      SupabaseClient; // signed in as user B
let clientOwner:  SupabaseClient; // signed in as property owner

let userAId:      string;
let userBId:      string;
let ownerUserId:  string;

let propertyId:      string;
let bookingAId:      string;
let wishlistAId:     string;
let notifAId:        string;
let propertyImageId: string;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAnonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signInAs(email: string, password: string): Promise<SupabaseClient> {
  const client = makeAnonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${email}: ${error?.message ?? 'no session'}`);
  }
  return client;
}

async function ensureAuthUser(email: string, password: string): Promise<string> {
  const { data: list } = await adminClient.auth.admin.listUsers();
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) return existing.id;

  const { data, error } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Cannot create auth user ${email}: ${error?.message}`);
  return data.user.id;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Create auth users
  userAId     = await ensureAuthUser(USER_A.email,    USER_A.password);
  userBId     = await ensureAuthUser(USER_B.email,    USER_B.password);
  ownerUserId = await ensureAuthUser(OWNER_USR.email, OWNER_USR.password);

  // Mirror into public.users
  await adminClient.from('users').upsert([
    { id: userAId,     email: USER_A.email    },
    { id: userBId,     email: USER_B.email    },
    { id: ownerUserId, email: OWNER_USR.email },
  ]);

  // Profiles (RLS uses auth.uid() = id — so profile id = auth user id)
  await adminClient.from('profiles').upsert([
    { id: userAId,     user_id: userAId,     display_name: 'RLS User A'  },
    { id: userBId,     user_id: userBId,     display_name: 'RLS User B'  },
    { id: ownerUserId, user_id: ownerUserId, display_name: 'RLS Owner'   },
  ]);

  // Property owned by ownerUser
  const { data: prop, error: propErr } = await adminClient
    .from('properties')
    .insert({ owner_id: ownerUserId, title: 'RLS Test Property', price_per_night: 100, status: 'available' })
    .select('id').single();
  if (propErr || !prop) throw new Error(`Seed property failed: ${propErr?.message}`);
  propertyId = prop.id;

  // Booking by user A on that property
  const { data: bk, error: bkErr } = await adminClient
    .from('bookings')
    .insert({ property_id: propertyId, tenant_id: userAId, check_in: '2099-01-10', check_out: '2099-01-15', total_price: 500, status: 'Pending' })
    .select('id').single();
  if (bkErr || !bk) throw new Error(`Seed booking failed: ${bkErr?.message}`);
  bookingAId = bk.id;

  // Wishlist entry for user A
  const { data: wl, error: wlErr } = await adminClient
    .from('wishlists')
    .insert({ user_id: userAId, property_id: propertyId })
    .select('id').single();
  if (wlErr || !wl) throw new Error(`Seed wishlist failed: ${wlErr?.message}`);
  wishlistAId = wl.id;

  // Notification for user A
  const { data: notif, error: nErr } = await adminClient
    .from('notifications')
    .insert({ user_id: userAId, type: 'booking_created', data: { booking_id: bookingAId }, read: false })
    .select('id').single();
  if (nErr || !notif) throw new Error(`Seed notification failed: ${nErr?.message}`);
  notifAId = notif.id;

  // Property image
  const { data: img, error: imgErr } = await adminClient
    .from('property_images')
    .insert({ property_id: propertyId, url: 'https://example.com/rls-test.jpg', is_primary: true, display_order: 1 })
    .select('id').single();
  if (imgErr || !img) throw new Error(`Seed property_image failed: ${imgErr?.message}`);
  propertyImageId = img.id;

  // Authenticated clients
  clientA     = await signInAs(USER_A.email,    USER_A.password);
  clientB     = await signInAs(USER_B.email,    USER_B.password);
  clientOwner = await signInAs(OWNER_USR.email, OWNER_USR.password);
}, 60_000);

afterAll(async () => {
  // Delete child rows first to respect FK constraints
  if (notifAId)        await adminClient.from('notifications').delete().eq('id', notifAId);
  if (wishlistAId)     await adminClient.from('wishlists').delete().eq('id', wishlistAId);
  if (bookingAId)      await adminClient.from('bookings').delete().eq('id', bookingAId);
  if (propertyImageId) await adminClient.from('property_images').delete().eq('id', propertyImageId);
  if (propertyId)      await adminClient.from('properties').delete().eq('id', propertyId);
  if (userAId)         await adminClient.from('profiles').delete().eq('id', userAId);
  if (userBId)         await adminClient.from('profiles').delete().eq('id', userBId);
  if (ownerUserId)     await adminClient.from('profiles').delete().eq('id', ownerUserId);
  if (userAId)  { await adminClient.from('users').delete().eq('id', userAId);  await adminClient.auth.admin.deleteUser(userAId); }
  if (userBId)  { await adminClient.from('users').delete().eq('id', userBId);  await adminClient.auth.admin.deleteUser(userBId); }
  if (ownerUserId) { await adminClient.from('users').delete().eq('id', ownerUserId); await adminClient.auth.admin.deleteUser(ownerUserId); }
}, 30_000);

// ─── profiles ─────────────────────────────────────────────────────────────────

describe('RLS — profiles', () => {
  it('user A can read their own profile', async () => {
    const { data, error } = await clientA.from('profiles').select('*').eq('id', userAId).single();
    expect(error).toBeNull();
    expect(data?.id).toBe(userAId);
  });

  it("user B cannot read user A's profile", async () => {
    const { data, error } = await clientB.from('profiles').select('*').eq('id', userAId).single();
    // RLS returns no rows — either null data or a "not found" PostgREST error
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  it("user A cannot overwrite user B's display_name", async () => {
    await clientA.from('profiles').update({ display_name: 'Hacked' }).eq('id', userBId);
    const { data } = await adminClient.from('profiles').select('display_name').eq('id', userBId).single();
    expect(data?.display_name).not.toBe('Hacked');
  });

  it('user A can update their own profile', async () => {
    const { error } = await clientA.from('profiles').update({ display_name: 'A Updated' }).eq('id', userAId);
    expect(error).toBeNull();
  });
});

// ─── bookings ─────────────────────────────────────────────────────────────────

describe('RLS — bookings', () => {
  it('user A can read their own booking', async () => {
    const { data, error } = await clientA.from('bookings').select('*').eq('id', bookingAId).single();
    expect(error).toBeNull();
    expect(data?.tenant_id).toBe(userAId);
  });

  it("user B cannot read user A's booking", async () => {
    const { data, error } = await clientB.from('bookings').select('*').eq('id', bookingAId).single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  it('property owner can read bookings on their property', async () => {
    const { data, error } = await clientOwner.from('bookings').select('id').eq('property_id', propertyId);
    expect(error).toBeNull();
    const ids = (data ?? []).map((b: { id: string }) => b.id);
    expect(ids).toContain(bookingAId);
  });

  it("user B cannot update user A's booking status", async () => {
    await clientB.from('bookings').update({ status: 'Cancelled' }).eq('id', bookingAId);
    const { data } = await adminClient.from('bookings').select('status').eq('id', bookingAId).single();
    expect(data?.status).not.toBe('Cancelled');
  });

  it("user B cannot delete user A's booking", async () => {
    await clientB.from('bookings').delete().eq('id', bookingAId);
    const { data } = await adminClient.from('bookings').select('id').eq('id', bookingAId).single();
    expect(data?.id).toBe(bookingAId);
  });

  it('user A can update their own booking', async () => {
    const { error } = await clientA.from('bookings').update({ status: 'Pending' }).eq('id', bookingAId);
    expect(error).toBeNull();
  });
});

// ─── wishlists ────────────────────────────────────────────────────────────────

describe('RLS — wishlists', () => {
  it("user A can read their own wishlist", async () => {
    const { data, error } = await clientA.from('wishlists').select('*').eq('user_id', userAId);
    expect(error).toBeNull();
    const ids = (data ?? []).map((w: { id: string }) => w.id);
    expect(ids).toContain(wishlistAId);
  });

  it("user B cannot read user A's wishlist entries", async () => {
    const { data, error } = await clientB.from('wishlists').select('*').eq('user_id', userAId);
    if (!error) expect((data ?? []).length).toBe(0);
  });

  it("user B cannot delete user A's wishlist entry", async () => {
    await clientB.from('wishlists').delete().eq('id', wishlistAId);
    const { data } = await adminClient.from('wishlists').select('id').eq('id', wishlistAId).single();
    expect(data?.id).toBe(wishlistAId);
  });
});

// ─── notifications ────────────────────────────────────────────────────────────

describe('RLS — notifications', () => {
  it("user A can read their own notifications", async () => {
    const { data, error } = await clientA.from('notifications').select('*').eq('user_id', userAId);
    expect(error).toBeNull();
    const ids = (data ?? []).map((n: { id: string }) => n.id);
    expect(ids).toContain(notifAId);
  });

  it("user B cannot read user A's notifications", async () => {
    const { data, error } = await clientB.from('notifications').select('*').eq('user_id', userAId);
    if (!error) expect((data ?? []).length).toBe(0);
  });

  it("user B cannot mark user A's notification as read", async () => {
    await clientB.from('notifications').update({ read: true }).eq('id', notifAId);
    const { data } = await adminClient.from('notifications').select('read').eq('id', notifAId).single();
    expect(data?.read).toBe(false);
  });

  it('user A can mark their own notification as read', async () => {
    const { error } = await clientA.from('notifications').update({ read: true }).eq('id', notifAId);
    expect(error).toBeNull();
    // Reset so other tests see read=false
    await adminClient.from('notifications').update({ read: false }).eq('id', notifAId);
  });
});

// ─── properties — public read ─────────────────────────────────────────────────

describe('RLS — properties (public read, owner-only write)', () => {
  it('authenticated user B can read available properties', async () => {
    const { data, error } = await clientB.from('properties').select('id').eq('status', 'available');
    expect(error).toBeNull();
    const ids = (data ?? []).map((p: { id: string }) => p.id);
    expect(ids).toContain(propertyId);
  });

  it('owner can update their own property', async () => {
    const { error } = await clientOwner.from('properties').update({ title: 'RLS Updated' }).eq('id', propertyId);
    expect(error).toBeNull();
    await adminClient.from('properties').update({ title: 'RLS Test Property' }).eq('id', propertyId);
  });

  it('non-owner cannot update the property', async () => {
    await clientA.from('properties').update({ price_per_night: 1 }).eq('id', propertyId);
    const { data } = await adminClient.from('properties').select('price_per_night').eq('id', propertyId).single();
    expect(data?.price_per_night).not.toBe(1);
  });

  it('non-owner cannot delete the property', async () => {
    await clientA.from('properties').delete().eq('id', propertyId);
    const { data } = await adminClient.from('properties').select('id').eq('id', propertyId).single();
    expect(data?.id).toBe(propertyId);
  });
});

// ─── property_images — storage policies ──────────────────────────────────────

describe('RLS — property_images', () => {
  it('any authenticated user can read property images', async () => {
    const { data, error } = await clientB.from('property_images').select('*').eq('property_id', propertyId);
    expect(error).toBeNull();
    const ids = (data ?? []).map((img: { id: string }) => img.id);
    expect(ids).toContain(propertyImageId);
  });

  it('non-owner cannot insert images for a property they do not own', async () => {
    const { data, error } = await clientB
      .from('property_images')
      .insert({ property_id: propertyId, url: 'https://example.com/bad.jpg', is_primary: false, display_order: 99 })
      .select('id').single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('owner can insert images for their own property', async () => {
    const { data, error } = await clientOwner
      .from('property_images')
      .insert({ property_id: propertyId, url: 'https://example.com/ok.jpg', is_primary: false, display_order: 2 })
      .select('id').single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    if (data?.id) await adminClient.from('property_images').delete().eq('id', data.id);
  });

  it('non-owner cannot delete property images', async () => {
    await clientA.from('property_images').delete().eq('id', propertyImageId);
    const { data } = await adminClient.from('property_images').select('id').eq('id', propertyImageId).single();
    expect(data?.id).toBe(propertyImageId);
  });
});

// ─── unauthenticated access ───────────────────────────────────────────────────

describe('RLS — unauthenticated access blocked', () => {
  const anon = makeAnonClient();

  it('anon cannot read bookings', async () => {
    const { data, error } = await anon.from('bookings').select('*');
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });

  it('anon cannot read profiles', async () => {
    const { data, error } = await anon.from('profiles').select('*');
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });

  it('anon cannot read notifications', async () => {
    const { data, error } = await anon.from('notifications').select('*');
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });

  it('anon cannot read wishlists', async () => {
    const { data, error } = await anon.from('wishlists').select('*');
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #664 — Additional RLS coverage tests
// Tables: reviews, wallet_challenges, idempotency_keys, messages,
//         blockchain_logs, reports, booking_modifications, search_analytics
// ─────────────────────────────────────────────────────────────────────────────

// ─── reviews ──────────────────────────────────────────────────────────────────

describe('RLS — reviews', () => {
  let reviewId: string;

  it('authenticated user can read reviews (public reputation)', async () => {
    // Insert via service role first
    const { data, error } = await adminClient
      .from('reviews')
      .insert({
        booking_id: bookingAId,
        reviewer_id: userAId,
        target_id: ownerUserId,
        property_id: propertyId,
        rating: 5,
        comment: 'Great place',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    reviewId = data!.id;

    // User B (unrelated) should be able to read it
    const { data: d2, error: e2 } = await clientB
      .from('reviews')
      .select('id')
      .eq('id', reviewId)
      .single();
    expect(e2).toBeNull();
    expect(d2?.id).toBe(reviewId);
  });

  it('user cannot insert a review where reviewer_id !== auth.uid()', async () => {
    const { data, error } = await clientB
      .from('reviews')
      .insert({
        booking_id: bookingAId,
        reviewer_id: userAId,   // spoofed — not clientB
        target_id: ownerUserId,
        property_id: propertyId,
        rating: 1,
        comment: 'Spoofed',
      })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  // Cleanup
  afterAll(async () => {
    if (reviewId) await adminClient.from('reviews').delete().eq('id', reviewId);
  });
});

// ─── wallet_challenges ────────────────────────────────────────────────────────

describe('RLS — wallet_challenges (service-only)', () => {
  it('authenticated user cannot read wallet_challenges', async () => {
    const { data, error } = await clientA.from('wallet_challenges').select('*');
    // RLS blocks all client reads — expect zero rows or an error
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });

  it('authenticated user cannot insert wallet_challenges', async () => {
    const { data, error } = await clientA
      .from('wallet_challenges')
      .insert({
        stellar_address: 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGJHPN5K5O1X7UAIGVTVB',
        challenge: 'test-challenge-string',
      })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

// ─── idempotency_keys ─────────────────────────────────────────────────────────

describe('RLS — idempotency_keys (own-user only)', () => {
  let keyId: string;

  beforeAll(async () => {
    const { data } = await adminClient
      .from('idempotency_keys')
      .insert({
        key: 'rls-test-idem-key-001',
        user_id: userAId,
        request_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
        response_body: { ok: true },
        status_code: 200,
      })
      .select('id')
      .single();
    keyId = data?.id;
  });

  it("user A can read their own idempotency key", async () => {
    const { data, error } = await clientA
      .from('idempotency_keys')
      .select('id')
      .eq('id', keyId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(keyId);
  });

  it("user B cannot read user A's idempotency key", async () => {
    const { data, error } = await clientB
      .from('idempotency_keys')
      .select('id')
      .eq('id', keyId)
      .single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  afterAll(async () => {
    if (keyId) await adminClient.from('idempotency_keys').delete().eq('id', keyId);
  });
});

// ─── messages ─────────────────────────────────────────────────────────────────

describe('RLS — messages (sender + recipient only)', () => {
  let msgId: string;

  beforeAll(async () => {
    const { data } = await adminClient
      .from('messages')
      .insert({
        property_id: propertyId,
        sender_id: userAId,
        recipient_id: ownerUserId,
        body: 'Is the property available?',
      })
      .select('id')
      .single();
    msgId = data?.id;
  });

  it('sender (userA) can read the message', async () => {
    const { data, error } = await clientA
      .from('messages')
      .select('id')
      .eq('id', msgId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(msgId);
  });

  it('recipient (owner) can read the message', async () => {
    const { data, error } = await clientOwner
      .from('messages')
      .select('id')
      .eq('id', msgId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(msgId);
  });

  it('unrelated user B cannot read the message', async () => {
    const { data, error } = await clientB
      .from('messages')
      .select('id')
      .eq('id', msgId)
      .single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  it('sender cannot spoof a different sender_id on insert', async () => {
    const { data, error } = await clientA
      .from('messages')
      .insert({
        property_id: propertyId,
        sender_id: ownerUserId,    // spoofed
        recipient_id: userBId,
        body: 'Spoofed message',
      })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  afterAll(async () => {
    if (msgId) await adminClient.from('messages').delete().eq('id', msgId);
  });
});

// ─── blockchain_logs ──────────────────────────────────────────────────────────

describe('RLS — blockchain_logs (service-only)', () => {
  it('authenticated user cannot read blockchain_logs', async () => {
    const { data, error } = await clientA.from('blockchain_logs').select('*');
    const blocked = error !== null || (data ?? []).length === 0;
    expect(blocked).toBe(true);
  });

  it('authenticated user cannot insert into blockchain_logs', async () => {
    const { data, error } = await clientA
      .from('blockchain_logs')
      .insert({ operation: 'rls_test', input_json: {} })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });
});

// ─── reports ─────────────────────────────────────────────────────────────────

describe('RLS — reports (reporter reads own, service reads all)', () => {
  let reportId: string;

  it('user A can file a report', async () => {
    const { data, error } = await clientA
      .from('reports')
      .insert({
        target_type: 'property',
        target_id: propertyId,
        reporter_id: userAId,
        reason: 'spam',
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    reportId = data!.id;
  });

  it('user A can read their own report', async () => {
    const { data, error } = await clientA
      .from('reports')
      .select('id')
      .eq('id', reportId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(reportId);
  });

  it('user B cannot read user A\'s report', async () => {
    const { data, error } = await clientB
      .from('reports')
      .select('id')
      .eq('id', reportId)
      .single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  it('user cannot spoof a different reporter_id', async () => {
    const { data, error } = await clientB
      .from('reports')
      .insert({
        target_type: 'property',
        target_id: propertyId,
        reporter_id: userAId,   // spoofed
        reason: 'fraud',
      })
      .select('id')
      .single();
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  afterAll(async () => {
    if (reportId) await adminClient.from('reports').delete().eq('id', reportId);
  });
});

// ─── booking_modifications ───────────────────────────────────────────────────

describe('RLS — booking_modifications (tenant + owner read; tenant inserts)', () => {
  let modId: string;

  beforeAll(async () => {
    const { data } = await adminClient
      .from('booking_modifications')
      .insert({
        booking_id: bookingAId,
        requested_by: userAId,
        requested_start: '2099-01-12',
        requested_end: '2099-01-17',
        original_start: '2099-01-10',
        original_end: '2099-01-15',
        status: 'pending',
      })
      .select('id')
      .single();
    modId = data?.id;
  });

  it('tenant (userA) can read modification for their booking', async () => {
    const { data, error } = await clientA
      .from('booking_modifications')
      .select('id')
      .eq('id', modId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(modId);
  });

  it('property owner can read modification for their property booking', async () => {
    const { data, error } = await clientOwner
      .from('booking_modifications')
      .select('id')
      .eq('id', modId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(modId);
  });

  it('unrelated user B cannot read the modification', async () => {
    const { data, error } = await clientB
      .from('booking_modifications')
      .select('id')
      .eq('id', modId)
      .single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  afterAll(async () => {
    if (modId) await adminClient.from('booking_modifications').delete().eq('id', modId);
  });
});

// ─── search_analytics ────────────────────────────────────────────────────────

describe('RLS — search_analytics (own-user read; service inserts)', () => {
  let analyticsId: string;

  beforeAll(async () => {
    const { data } = await adminClient
      .from('search_analytics')
      .insert({ query: 'rls-test-query', user_id: userAId, result_count: 3 })
      .select('id')
      .single();
    analyticsId = data?.id;
  });

  it('user A can read their own search analytics row', async () => {
    const { data, error } = await clientA
      .from('search_analytics')
      .select('id')
      .eq('id', analyticsId)
      .single();
    expect(error).toBeNull();
    expect(data?.id).toBe(analyticsId);
  });

  it('user B cannot read user A\'s search analytics', async () => {
    const { data, error } = await clientB
      .from('search_analytics')
      .select('id')
      .eq('id', analyticsId)
      .single();
    const blocked = !data || error !== null;
    expect(blocked).toBe(true);
  });

  it('client cannot directly insert into search_analytics', async () => {
    const { data, error } = await clientA
      .from('search_analytics')
      .insert({ query: 'client-direct-insert', user_id: userAId, result_count: 1 })
      .select('id')
      .single();
    // Service role handles inserts; direct client inserts should be blocked
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  afterAll(async () => {
    if (analyticsId) await adminClient.from('search_analytics').delete().eq('id', analyticsId);
  });
});
