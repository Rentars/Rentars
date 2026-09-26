/**
 * Host-follow service.
 *
 * Provides the business logic for the tenant → host follow graph stored in
 * the `host_follows` table (migration 00023).
 *
 * All functions return a ServiceResponse so controllers stay thin and error
 * handling is consistent with the rest of the codebase.
 */

import { supabase } from '@/config/supabase.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HostFollow {
  id: string;
  follower_id: string;
  host_id: string;
  created_at: string;
}

/** Minimal host profile returned when listing followed hosts. */
export interface HostSummary {
  id: string;
  /** Display name sourced from the profiles table (may be null). */
  display_name: string | null;
  /** Avatar URL sourced from the profiles table (may be null). */
  avatar_url: string | null;
  /** ISO timestamp of when the current user followed this host. */
  followed_at: string;
}

/** Minimal follower profile returned when a host lists their followers. */
export interface FollowerSummary {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  followed_at: string;
}

// ─── Follow / Unfollow ────────────────────────────────────────────────────────

/**
 * Follow a host.
 *
 * Idempotent — if the follow already exists the function succeeds without
 * creating a duplicate row (uses INSERT … ON CONFLICT DO NOTHING).
 *
 * @param followerId - The authenticated user's id (must not equal hostId).
 * @param hostId     - The id of the host to follow.
 */
export async function followHost(
  followerId: string,
  hostId: string,
): Promise<ServiceResponse<HostFollow>> {
  const trimmedFollowerId = (followerId ?? '').trim();
  const trimmedHostId = (hostId ?? '').trim();

  if (!trimmedFollowerId || !trimmedHostId) {
    return { success: false, error: 'follower_id and host_id are required' };
  }
  if (trimmedFollowerId === trimmedHostId) {
    return { success: false, error: 'You cannot follow yourself' };
  }

  followerId = trimmedFollowerId;
  hostId = trimmedHostId;

  // Verify the target user exists (prevents ghost follows)
  const { data: target, error: targetErr } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', hostId)
    .maybeSingle();

  if (targetErr) return { success: false, error: targetErr.message };
  if (!target) return { success: false, error: 'Host not found' };

  // Upsert — ON CONFLICT DO NOTHING keeps the operation idempotent
  const { data, error } = await supabase
    .from('host_follows')
    .upsert(
      { follower_id: followerId, host_id: hostId },
      { onConflict: 'follower_id,host_id', ignoreDuplicates: true },
    )
    .select()
    .maybeSingle();

  if (error) return { success: false, error: error.message };

  // If the row already existed upsert returns null data with ignoreDuplicates
  if (!data) {
    // Re-fetch the existing row so the caller gets the full object
    const { data: existing, error: fetchErr } = await supabase
      .from('host_follows')
      .select('*')
      .eq('follower_id', followerId)
      .eq('host_id', hostId)
      .single();

    if (fetchErr) return { success: false, error: fetchErr.message };
    return { success: true, data: existing as HostFollow };
  }

  return { success: true, data: data as HostFollow };
}

/**
 * Unfollow a host.
 *
 * Idempotent — if no follow row exists the function succeeds silently.
 *
 * @param followerId - The authenticated user's id.
 * @param hostId     - The id of the host to unfollow.
 */
export async function unfollowHost(
  followerId: string,
  hostId: string,
): Promise<ServiceResponse<void>> {
  if (!followerId || !hostId) {
    return { success: false, error: 'follower_id and host_id are required' };
  }

  const { error } = await supabase
    .from('host_follows')
    .delete()
    .eq('follower_id', followerId)
    .eq('host_id', hostId);

  if (error) return { success: false, error: error.message };
  return { success: true };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * List all hosts that `followerId` is currently following.
 *
 * Joins to the `profiles` table to return display names and avatars.
 * Results are ordered by follow date descending (most recently followed first).
 */
export async function getFollowedHosts(
  followerId: string,
): Promise<ServiceResponse<HostSummary[]>> {
  if (!followerId) {
    return { success: false, error: 'follower_id is required' };
  }

  const { data, error } = await supabase
    .from('host_follows')
    .select(`
      host_id,
      created_at,
      profiles!host_follows_host_id_fkey (
        id,
        display_name,
        avatar_url
      )
    `)
    .eq('follower_id', followerId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };

  const hosts: HostSummary[] = (data ?? []).map((row: Record<string, unknown>) => {
    const profile = row.profiles as Record<string, unknown> | null;
    return {
      id:           String(row.host_id),
      display_name: profile ? (profile.display_name as string | null) : null,
      avatar_url:   profile ? (profile.avatar_url as string | null) : null,
      followed_at:  String(row.created_at),
    };
  });

  return { success: true, data: hosts };
}

/**
 * List all followers of a given host.
 *
 * Intended for the host's dashboard.  Returns follower profiles ordered by
 * follow date descending.
 *
 * @param hostId - The host whose follower list to retrieve.
 */
export async function getHostFollowers(
  hostId: string,
): Promise<ServiceResponse<FollowerSummary[]>> {
  if (!hostId) {
    return { success: false, error: 'host_id is required' };
  }

  const { data, error } = await supabase
    .from('host_follows')
    .select(`
      follower_id,
      created_at,
      profiles!host_follows_follower_id_fkey (
        id,
        display_name,
        avatar_url
      )
    `)
    .eq('host_id', hostId)
    .order('created_at', { ascending: false });

  if (error) return { success: false, error: error.message };

  const followers: FollowerSummary[] = (data ?? []).map((row: Record<string, unknown>) => {
    const profile = row.profiles as Record<string, unknown> | null;
    return {
      id:           String(row.follower_id),
      display_name: profile ? (profile.display_name as string | null) : null,
      avatar_url:   profile ? (profile.avatar_url as string | null) : null,
      followed_at:  String(row.created_at),
    };
  });

  return { success: true, data: followers };
}

/**
 * Check whether `followerId` is currently following `hostId`.
 *
 * @returns `{ success: true, data: true }` if following, `{ success: true, data: false }` if not.
 */
export async function isFollowing(
  followerId: string,
  hostId: string,
): Promise<ServiceResponse<boolean>> {
  if (!followerId || !hostId) {
    return { success: false, error: 'follower_id and host_id are required' };
  }

  const { data, error } = await supabase
    .from('host_follows')
    .select('id')
    .eq('follower_id', followerId)
    .eq('host_id', hostId)
    .maybeSingle();

  if (error) return { success: false, error: error.message };
  return { success: true, data: data !== null };
}

/**
 * Return the ids of all followers for a host.
 *
 * Used internally by the notification fan-out — returns raw UUIDs only,
 * no profile joins, for maximum throughput.
 *
 * @param hostId - The host whose follower ids to retrieve.
 */
export async function getHostFollowerIds(
  hostId: string,
): Promise<ServiceResponse<string[]>> {
  if (!hostId) {
    return { success: false, error: 'host_id is required' };
  }

  const { data, error } = await supabase
    .from('host_follows')
    .select('follower_id')
    .eq('host_id', hostId);

  if (error) return { success: false, error: error.message };

  const ids = (data ?? []).map((row: { follower_id: string }) => row.follower_id);
  return { success: true, data: ids };
}
