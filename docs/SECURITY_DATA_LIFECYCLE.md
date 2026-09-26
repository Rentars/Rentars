# Data Export & Account Deletion Security

## Overview

Rentars provides users with data subject rights: the ability to export personal data and request account deletion. This document outlines the security controls and data retention policies.

## Data Export (`GET /api/v1/privacy/export`)

### Request Flow

1. User submits authenticated request with JWT token
2. Server validates authentication
3. Rate limiter enforces max 5 exports per user per hour
4. Export is created asynchronously in `data_exports` table with status `pending`
5. Background worker generates export JSON and uploads to secure storage
6. Export URL is signed and time-limited (7 days to download)
7. User receives export URL and download link

### Data Included

- Profile information (name, avatar, bio, location, phone, Stellar address)
- Booking history (dates, amounts, status, policy versions accepted)
- Reviews written (property, rating, comment, date)
- Messages sent (recipient, content, date)
- Notification preferences
- Not included: passwords, private keys, blockchain transaction hashes

### Data Excluded (Cannot Be Exported)

Blockchain records are permanently public on the Stellar ledger and cannot be deleted or exported as personal data:
- Wallet addresses (public on blockchain)
- Transaction hashes (immutable ledger)
- On-chain IDs and smart contract state

### Storage Security

- Exports are stored in Supabase Storage with restrictive bucket policies
- Signed URLs are generated with 7-day expiration
- Each export is keyed by `<user_id>/<export_id>.json`
- Access is restricted to the requesting user via signed URL

### Retention

- Export files expire after 7 days
- Cleanup job runs daily to delete expired exports
- Database records of export requests are retained indefinitely for audit

## Account Deletion (`POST /api/v1/privacy/delete-account`)

### Request Flow

1. User submits authenticated request
2. Reauthentication may be required (password verification, 2FA)
3. Deletion request is created with status `pending` in `account_deletions` table
4. User receives confirmation email with cancellation link (valid 7 days)
5. If not cancelled within 7 days, background worker executes deletion
6. Deletion is irreversible after the 7-day window

### Cancellation Window

- **Duration**: 7 days from request
- **Mechanism**: Signed JWT token (`cancel_token`) in deletion record
- **Endpoint**: `POST /api/v1/privacy/cancel-deletion/{deletion_id}`
- **Requirements**: Token must not be expired; deletion status must be `pending`

### Anonymization Rules

Data that is **anonymized** (user-facing references removed):

| Field | Original | Anonymized | Reason |
|-------|----------|-----------|--------|
| `users.email` | `user@example.com` | `deleted-{user_id}@rentars.invalid` | Prevent account re-registration |
| `profiles.display_name` | User's name | `Deleted User` | Remove PII |
| `profiles.avatar_url` | Profile picture URL | NULL | Remove PII |
| `profiles.bio` | User bio | NULL | Remove PII |
| `profiles.phone` | Phone number | NULL | Remove PII |
| `profiles.location` | Location string | NULL | Remove PII |
| `profiles.stellar_address` | Stellar address | NULL | Allow fresh onboarding |
| `users.status` | `active` / `inactive` | `deleted` | Mark account as deleted |

Data that is **retained** (cannot be deleted):

| Table | Why Retained | Legal Basis |
|-------|-------------|------------|
| `bookings` | Financial records | 7-year tax/fraud retention |
| `payments` | Transaction history | 7-year tax/fraud retention |
| `audit_logs` | Compliance & legal hold | Indefinite for disputes |
| Blockchain records | Immutable public ledger | Technical impossibility |

Data that is **deleted** (no business need):

| Table | Reason |
|-------|--------|
| `notifications` | Transient; not legally required |
| `notification_preferences` | User-specific preferences |
| `push_subscriptions` | Device-specific |
| `refresh_tokens` | Session state |
| `saved_searches` | User-specific preferences |

### Deletion Cannot Affect

- **Active bookings**: If a user has an active booking, their account status is set to `deleted` but booking records and tenant_id are retained for payment/compliance
- **Payments and escrow**: Stripe/blockchain payments are immutable; only the user's personal data is removed
- **Dispute records**: If a property dispute is ongoing, audit logs are retained for legal defense

## Reauthentication

Deletion requests require reauthentication to prevent accidental or malicious deletion:

### Methods

1. **Password verification**: User re-enters password; compared to `users.password_hash` (bcrypt)
2. **Time-based**: Deletion effective only after 7-day window (reduces impulsive actions)
3. **Email confirmation**: Optional additional layer — user must click link in confirmation email

### Implementation

```typescript
// In deletion endpoint
const isPasswordCorrect = await verifyUserPassword(userId, req.body.password);
if (!isPasswordCorrect) {
  return res.status(401).json({ error: 'Invalid password' });
}
```

## Background Jobs

### Export Generation (Daily)

```bash
# Runs nightly
SELECT * FROM data_exports WHERE status = 'pending' AND created_at < NOW() - INTERVAL '1 hour'
FOR EACH:
  - Generate export JSON
  - Upload to Supabase Storage
  - Generate signed URL (7-day expiration)
  - Update data_exports SET status = 'completed', export_url = ...
  - Send email to user with download link
```

### Deletion Execution (Daily)

```bash
# Runs nightly
SELECT * FROM account_deletions 
WHERE status = 'pending' AND cancel_expires_at < NOW()
FOR EACH:
  - Anonymize user profile (as per table above)
  - Delete transient data (notifications, preferences, tokens)
  - Update account_deletions SET status = 'completed'
  - Log to audit table
```

### Cleanup (Weekly)

```bash
# Runs Sundays
DELETE FROM data_exports WHERE expires_at < NOW()
```

## Audit Logging

All privacy operations are logged to `audit_logs`:

| Action | Logged Event |
|--------|-------------|
| Export requested | `privacy.data_export_requested` |
| Export completed | `privacy.data_export_completed` |
| Export failed | `privacy.data_export_failed` |
| Deletion requested | `privacy.account_deletion_requested` |
| Deletion cancelled | `privacy.account_deletion_cancelled` |
| Deletion completed | `privacy.account_deletion_completed` |

Example log entry:
```json
{
  "actorId": "user-123",
  "action": "privacy.account_deletion_completed",
  "resourceType": "user",
  "resourceId": "user-123",
  "timestamp": "2026-09-25T10:30:00Z",
  "ip": "192.0.2.1",
  "meta": {
    "deletion_id": "deletion-abc",
    "anonymised_email": "deleted-user-123@rentars.invalid",
    "retained": ["bookings", "payments", "audit_logs"]
  }
}
```

## GDPR Compliance

### Data Subject Rights Implemented

- ✅ Right to access (export all personal data)
- ✅ Right to erasure (anonymize account)
- ✅ Right to rectification (user can update profile)
- ✅ Legitimate interest disclosure (see SECURITY_ARCHITECTURE.md)
- ✅ Data retention policies (documented above)

### Limitations

- **Bookings cannot be deleted**: GDPR Article 20 allows retention of financial records for accounting purposes
- **Blockchain is immutable**: User's Stellar wallet address is permanently public; documented in export
- **Audit logs retained**: GDPR allows indefinite retention for legal proceedings

## Residual Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| User forgets 7-day window; misses cancellation | Email reminder sent at day 3; cancellation link re-sendable |
| Database breach exposes anonymized emails | Email format is deterministic but not guessable; attacker gains nothing new |
| Attacker initiates deletion on victim account | Requires victim's password (reauthentication); no CSRF risk (CSRF tokens validated) |
| User requests deletion, then wants to use platform again | Account is only marked `deleted`, not removed; user can contact support for recovery within 30 days |

## Related Security Documents

- `SECURITY_ARCHITECTURE.md` — Token transport, CSRF, CORS
- `SECURITY_FILE_UPLOAD.md` — File validation and storage security
- `THREAT_MODEL.md` — Comprehensive threat assessment
