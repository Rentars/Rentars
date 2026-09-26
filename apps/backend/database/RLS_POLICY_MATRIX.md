# RLS Policy Matrix — Rentars Backend

> Issue #664 — Review Row Level Security coverage  
> Last updated: migration `00065_rls_coverage_all_tables.sql`

Every table in `public` is listed below. For each table the matrix records:

- **RLS Enabled** — whether `ALTER TABLE … ENABLE ROW LEVEL SECURITY` has been applied.
- **Policies** — the policy name, operation, and the role/condition it grants.
- **Service-Role Access** — Supabase service-role always bypasses RLS. All backend workers, schedulers, and the API (using the service-role key) have unrestricted access. This is the intentional escape hatch and must not be confused with a missing policy.
- **Decision** — what an unauthorized direct read/write produces (empty result set or error).

---

## Sensitive Tables

### `profiles`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Users can read their own profile | `auth.uid() = id` |
| ✅ | UPDATE | Users can update their own profile | `auth.uid() = id` |
| ✅ | INSERT | Users can insert their own profile | `auth.uid() = id` |
| — | DELETE | _(service role only)_ | — |

**Unauthorized direct read:** zero rows returned (no error, no data).

---

### `bookings`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Tenants can read their own bookings | `auth.uid() = tenant_id` |
| ✅ | SELECT | Owners can read bookings for their properties | `properties.owner_id = auth.uid()` |
| ✅ | INSERT | System can insert bookings | `true` (service role writes) |
| ✅ | UPDATE | Tenants can update their own bookings | `auth.uid() = tenant_id` |
| ✅ | DELETE | Tenants can delete their own bookings | `auth.uid() = tenant_id` |

**Unauthorized direct read:** zero rows for unrelated users.

---

### `wishlists`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Users can read their own wishlists | `auth.uid() = user_id` |
| ✅ | INSERT | Users can insert into their own wishlist | `auth.uid() = user_id` |
| ✅ | DELETE | Users can delete their own wishlist entries | `auth.uid() = user_id` |

**Unauthorized direct read:** zero rows.

---

### `notifications`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Users can read their own notifications | `auth.uid() = user_id` |
| ✅ | UPDATE | Users can update their own notifications | `auth.uid() = user_id` |
| ✅ | DELETE | Users can delete their own notifications | `auth.uid() = user_id` |
| — | INSERT | _(service role only — backend fan-out)_ | — |

**Unauthorized direct read:** zero rows.

---

### `properties`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | All authenticated users can read properties | `auth.role() = 'authenticated'` |
| ✅ | INSERT | Owners can insert properties | `auth.uid() = owner_id` |
| ✅ | UPDATE | Owners can update their own properties | `auth.uid() = owner_id` |
| ✅ | DELETE | Owners can delete their own properties | `auth.uid() = owner_id` |

**Unauthorized write:** error / zero rows affected.

---

### `property_images`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Anyone can read property images | `true` |
| ✅ | ALL | Owners can manage property images | `properties.owner_id = auth.uid()` |

Migration: `00012_create_property_images_table.sql`

---

### `payments`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Tenants can read their own payments | `auth.uid() = tenant_id` |
| ✅ | ALL | Service role full access | `auth.role() = 'service_role'` |

Migration: `00028_create_audit_and_payments.sql`  
**Unauthorized direct read:** zero rows.

---

### `audit_logs`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | ALL | Service role only | `auth.role() = 'service_role'` |

Append-only via service role. No client reads permitted.  
Migration: `00028_create_audit_and_payments.sql`

---

### `reviews` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Authenticated users can read reviews | `auth.role() = 'authenticated'` |
| ✅ | INSERT | Reviewer can insert their own review | `auth.uid() = reviewer_id` |
| — | UPDATE | _(service role only — moderation)_ | — |
| — | DELETE | _(service role only — moderation)_ | — |

Reviews are immutable for normal users; moderation updates via service role.

---

### `wallet_challenges` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | ALL | _(no client policies — service role only)_ | — |

Ephemeral Stellar wallet challenge tokens. All client reads/writes blocked.

---

### `idempotency_keys` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Own-user read | `auth.uid() = user_id` |
| — | INSERT/UPDATE/DELETE | _(service role only)_ | — |

**Unauthorized direct read:** zero rows.

---

### `messages` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Sender or recipient | `auth.uid() = sender_id OR auth.uid() = recipient_id` |
| ✅ | INSERT | Sender only | `auth.uid() = sender_id` |
| ✅ | UPDATE | Recipient only (mark read) | `auth.uid() = recipient_id` |
| — | DELETE | _(service role only — retention jobs)_ | — |

**Unauthorized direct read:** zero rows.

---

### `blockchain_logs` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | ALL | _(no client policies — service role only)_ | — |

Append-only Stellar/Soroban operation audit trail. All client access blocked.

---

### `reports` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Reporter reads own reports | `auth.uid() = reporter_id` |
| ✅ | INSERT | Authenticated users can file reports | `auth.uid() = reporter_id AND auth.role() = 'authenticated'` |
| — | UPDATE | _(service role only — moderation resolution)_ | — |

**Unauthorized read of another user's report:** zero rows.

---

### `booking_modifications` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Tenant (booking owner) | `bookings.tenant_id = auth.uid()` |
| ✅ | SELECT | Property owner | `properties.owner_id = auth.uid()` |
| ✅ | SELECT | Requester | `auth.uid() = requested_by` |
| ✅ | INSERT | Tenant submits modification | `auth.uid() = requested_by AND bookings.tenant_id = auth.uid()` |
| — | UPDATE | _(service role only — approval workflow)_ | — |

**Unauthorized direct read:** zero rows.

---

### `search_analytics` _(added in #664)_
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Own-user search history | `user_id IS NOT NULL AND auth.uid() = user_id` |
| — | INSERT | _(service role only — search handler)_ | — |

Anonymous search rows (`user_id IS NULL`) are invisible to all client queries.

---

### `host_follows`
| RLS | Operation | Policy | Condition |
|-----|-----------|--------|-----------|
| ✅ | SELECT | Follower or host | `auth.uid() = follower_id OR auth.uid() = host_id` |
| ✅ | INSERT | Follower only | `auth.uid() = follower_id` |
| ✅ | DELETE | Follower only | `auth.uid() = follower_id` |

Migration: `00023_create_host_follows_table.sql`

---

## Non-Sensitive / Public Tables

These tables contain no user-specific private data and do not require per-row RLS. They are served via the service role only:

| Table | Rationale |
|-------|-----------|
| `property_views` | Aggregate counters, no user PII |
| `funnel_events` | Anonymised analytics |
| `probe_results` | Internal health-check records |
| `data_exports` | Managed entirely by service role |
| `saved_searches` | User-scoped — should have RLS added in a follow-up |

---

## Verification Query

Run after applying `00065_rls_coverage_all_tables.sql` to confirm all sensitive tables have RLS enabled:

```sql
SELECT
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
```

All tables in the **Sensitive Tables** section above must show `rls_enabled = true`.

---

## Key Invariants

1. **Every sensitive table has an owner and a documented policy decision.**  
   Tables with no client-facing policies (wallet_challenges, blockchain_logs, audit_logs) are intentionally service-role-only — this is the correct decision, not a gap.

2. **Direct unauthorized reads return zero rows, not an error** (except for INSERT attempts which return a policy violation error). This is standard Supabase/PostgreSQL RLS behaviour.

3. **Service-role authorization and database policies do not contradict each other.**  
   The backend never uses a policy to grant access that the application layer denies, and vice versa. Auth middleware rejects unauthenticated requests before they reach Supabase.

4. **No broad `USING (true)` policies on write operations.**  
   The only `true` condition allowed is on public reads (e.g., property listings).
