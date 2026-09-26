import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Privacy Policy — Rentars',
  description:
    'How Rentars collects, uses, retains, and shares your personal data, including wallet addresses and blockchain records.',
};

/**
 * /privacy — Canonical Privacy Policy page.
 *
 * Keep in sync with:
 *   docs/data-inventory.md  — internal data inventory
 *   apps/backend/src/services/platformPolicy.service.ts — CURRENT_TERMS_VERSION
 *
 * When updating this page, bump POLICY_VERSION and EFFECTIVE_DATE, and add
 * an entry to the Change Log section at the bottom.
 */

const EFFECTIVE_DATE = '24 September 2026';
const POLICY_VERSION = '2026-09-24.1';

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{title}</h2>
      <div className="text-gray-700 dark:text-gray-300 space-y-3 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}

function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-x-auto mt-3">
      <table className="w-full text-sm border-collapse" aria-label="Data table">
        <thead>
          <tr className="bg-gray-100 dark:bg-gray-800">
            {headers.map((h) => (
              <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-gray-200 dark:border-gray-700 align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 py-12">
      <div className="max-w-3xl mx-auto px-4 space-y-10">

        {/* Header */}
        <header>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Privacy Policy</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Effective: {EFFECTIVE_DATE} · Policy version:{' '}
            <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">
              {POLICY_VERSION}
            </code>
          </p>
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            This policy explains what personal data Rentars collects, why, how long we keep it, who
            can see it, and what rights you have over it. We have written it to be specific and
            honest, including about the parts of your data that live permanently on the public
            Stellar blockchain and can never be deleted.
          </p>
        </header>

        {/* TOC */}
        <nav aria-label="Table of contents">
          <ol className="list-decimal list-inside space-y-1 text-sm text-blue-600 dark:text-blue-400">
            {[
              ['who', 'Who we are'],
              ['collect', 'What we collect and why'],
              ['blockchain', 'Blockchain and public data'],
              ['sharing', 'Who we share data with'],
              ['retention', 'How long we keep your data'],
              ['rights', 'Your rights'],
              ['cookies', 'Cookies and local storage'],
              ['children', 'Children'],
              ['changes', 'Changes to this policy'],
              ['contact', 'Contact'],
            ].map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="hover:underline">
                  {label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* 1. Who we are */}
        <Section id="who" title="1. Who we are">
          <p>
            Rentars is a decentralized peer-to-peer short-term rental platform built on the Stellar
            blockchain. References to &quot;Rentars&quot;, &quot;we&quot;, &quot;us&quot;, or
            &quot;our&quot; in this policy mean the Rentars platform operator. Contact us at{' '}
            <a
              href="mailto:privacy@rentars.app"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              privacy@rentars.app
            </a>
            .
          </p>
        </Section>

        {/* 2. What we collect */}
        <Section id="collect" title="2. What we collect and why">
          <p>
            We collect the minimum data needed to run the platform. The table below summarises the
            main categories. For the full field-level inventory see our internal{' '}
            <strong>Data Inventory</strong> (available on request to verified researchers and
            regulators).
          </p>

          <DataTable
            headers={['Category', 'Examples', 'Purpose']}
            rows={[
              [
                'Identity & auth',
                'Email address, password hash (bcrypt), email-verified flag',
                'Account creation, login, password recovery',
              ],
              [
                'Profile',
                'Display name, avatar, bio, optional phone number',
                'Public identity on listings and reviews',
              ],
              [
                'Wallet address',
                'Stellar public key (e.g. GABC…)',
                'USDC payment settlement via TrustlessWork escrow',
              ],
              [
                'Property data',
                'Address, coordinates (fuzzed on public map), photos (EXIF stripped)',
                'Listing display, geospatial search',
              ],
              [
                'Booking data',
                'Dates, guest count, total price, escrow ID, terms accepted version & timestamp',
                'Contract between tenant and host, financial record, legal consent proof',
              ],
              [
                'Payment data',
                'USDC amount, Stellar transaction hash, payment status',
                'Settlement record and dispute resolution',
              ],
              [
                'Reviews',
                'Star rating, comment text',
                'Platform trust and listing quality',
              ],
              [
                'Messages',
                'Host–tenant communication',
                'Facilitate bookings; moderation only on reports',
              ],
              [
                'Analytics',
                'Hashed IPs, search queries (no user ID), property view counts',
                'Search improvement, listing analytics',
              ],
              [
                'Audit logs',
                'Actor ID, action, resource, IP address, timestamp',
                'Security, compliance, dispute evidence',
              ],
            ]}
          />
        </Section>

        {/* 3. Blockchain */}
        <Section id="blockchain" title="3. Blockchain and public data">
          <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 text-sm text-amber-800 dark:text-amber-200">
            <strong>Important:</strong> The following data is written to the public Stellar
            blockchain and <strong>cannot be deleted or modified</strong> after it is recorded,
            regardless of any deletion request you make to us.
          </div>

          <ul className="list-disc list-inside space-y-2 mt-3">
            <li>
              <strong>Your Stellar wallet address</strong> — linked to any booking, escrow, or
              payment you make on the platform. Visible to anyone querying the Stellar network.
            </li>
            <li>
              <strong>USDC payment amounts</strong> — the value of each escrow creation, release,
              or cancellation is publicly visible.
            </li>
            <li>
              <strong>Escrow IDs and transaction hashes</strong> — permanently recorded on-chain by
              TrustlessWork.
            </li>
            <li>
              <strong>On-chain property and booking IDs</strong> — numeric identifiers created by
              the Soroban smart contract.
            </li>
          </ul>

          <p>
            We disclose this prominently during wallet connection and at the terms-acceptance step
            of every booking. If you do not wish your wallet activity to be permanently public, do
            not connect your wallet to Rentars. You may use a purpose-created wallet address that
            is not linked to your identity elsewhere.
          </p>

          <p>
            No names, email addresses, or property street addresses are written to the blockchain.
            Only wallet addresses, USDC amounts, and opaque numeric IDs are stored on-chain.
          </p>
        </Section>

        {/* 4. Sharing */}
        <Section id="sharing" title="4. Who we share data with">
          <DataTable
            headers={['Recipient', 'Data shared', 'Purpose']}
            rows={[
              [
                'Supabase',
                'All database tables and storage objects',
                'Database hosting, authentication, file storage (EU/US data centres)',
              ],
              [
                'TrustlessWork',
                'Escrow ID, booking ID, wallet addresses, USDC amounts',
                'Non-custodial escrow creation and settlement',
              ],
              [
                'Stellar Network (public)',
                'Wallet addresses, transaction amounts, contract calls',
                'Blockchain settlement — publicly visible to anyone',
              ],
              [
                'SMTP provider (Nodemailer)',
                'Email address, notification content',
                'Transactional email delivery',
              ],
              [
                'Hosts',
                'Tenant display name, guest count, booking dates',
                'Enable the host to prepare for the stay',
              ],
              [
                'Tenants',
                'Host display name, property address (after confirmed booking)',
                'Enable the tenant to find and access the property',
              ],
            ]}
          />
          <p className="mt-3">
            We do not sell personal data. We do not share data with advertising networks. We do not
            use personal data for automated profiling or decisions that produce legal effects.
          </p>
        </Section>

        {/* 5. Retention */}
        <Section id="retention" title="5. How long we keep your data">
          <DataTable
            headers={['Category', 'Retention', 'Reason']}
            rows={[
              ['Account (email, profile)', 'Life of account + 30 days', 'Active service delivery'],
              ['Booking & payment records', '7 years after booking', 'Financial and legal compliance'],
              ['Terms acceptance (version + timestamp)', '7 years', 'Legal consent evidence'],
              ['Audit logs', '7 years', 'Security and regulatory compliance'],
              ['Messages', '2 years', 'Dispute resolution window'],
              ['Search analytics (anonymised)', '1 year', 'Product improvement'],
              ['Property views (hashed IPs)', '1 year', 'Host analytics'],
              ['Notifications', '90 days', 'Operational relevance'],
              ['Refresh tokens', '7 days (TTL)', 'Session management'],
              ['Blockchain records', 'Permanent (cannot be deleted)', 'Stellar network immutability'],
            ]}
          />
        </Section>

        {/* 6. Rights */}
        <Section id="rights" title="6. Your rights">
          <p>You have the following rights over your personal data:</p>
          <ul className="list-disc list-inside space-y-2">
            <li>
              <strong>Access:</strong> Request a copy of all personal data we hold about you.
              Contact{' '}
              <a href="mailto:privacy@rentars.app" className="text-blue-600 dark:text-blue-400 hover:underline">
                privacy@rentars.app
              </a>{' '}
              or use the dashboard export when available.
            </li>
            <li>
              <strong>Rectification:</strong> Correct inaccurate profile data via your dashboard
              settings.
            </li>
            <li>
              <strong>Deletion (right to be forgotten):</strong> Request account deletion. We will
              anonymise your email, profile, and booking tenant identity. We cannot delete data
              already written to the Stellar blockchain, financial records required by law (7-year
              retention), or audit log entries.
            </li>
            <li>
              <strong>Portability:</strong> Request a JSON export of your profile, bookings,
              reviews, and messages via{' '}
              <a href="mailto:privacy@rentars.app" className="text-blue-600 dark:text-blue-400 hover:underline">
                privacy@rentars.app
              </a>
              .
            </li>
            <li>
              <strong>Withdraw consent (notifications):</strong> Toggle email and push notification
              preferences on your{' '}
              <Link href="/preferences" className="text-blue-600 dark:text-blue-400 hover:underline">
                Preferences
              </Link>{' '}
              page at any time.
            </li>
            <li>
              <strong>Objection / restriction:</strong> Contact us if you believe we are processing
              your data in a way that is incompatible with this policy.
            </li>
          </ul>
          <p>
            We aim to respond to all privacy requests within 30 days. If you are unsatisfied with
            our response you have the right to complain to the relevant data protection authority
            in your jurisdiction.
          </p>
        </Section>

        {/* 7. Cookies */}
        <Section id="cookies" title="7. Cookies and local storage">
          <p>Rentars uses browser local storage (not cookies) to store:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">token</code>{' '}
              — your JWT access token (expires in 15 minutes).
            </li>
            <li>
              <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">walletAddress</code>{' '}
              — your connected Stellar public key (cleared on disconnect).
            </li>
          </ul>
          <p>
            We do not use analytics cookies, advertising cookies, or third-party tracking pixels.
            If you clear local storage you will be logged out.
          </p>
        </Section>

        {/* 8. Children */}
        <Section id="children" title="8. Children">
          <p>
            Rentars is not directed at children under 18. We do not knowingly collect personal data
            from anyone under 18. If you believe a child has created an account, contact{' '}
            <a href="mailto:privacy@rentars.app" className="text-blue-600 dark:text-blue-400 hover:underline">
              privacy@rentars.app
            </a>{' '}
            and we will delete the account promptly.
          </p>
        </Section>

        {/* 9. Changes */}
        <Section id="changes" title="9. Changes to this policy">
          <p>
            We will update this page when our data practices change. The version string and
            effective date at the top change with each update. For material changes (new data
            categories, new third-party sharing, shorter retention periods) we will notify you by
            email at least 14 days before the change takes effect.
          </p>
          <p>
            Your <strong>existing bookings are always governed by the policy in effect at booking
            time</strong>, recorded as <code className="font-mono text-xs bg-gray-100 dark:bg-gray-800 px-1 rounded">terms_version</code> on
            your booking record.
          </p>

          <h3 className="text-base font-semibold text-gray-900 dark:text-white mt-4 mb-2">Change log</h3>
          <DataTable
            headers={['Date', 'Version', 'Summary']}
            rows={[
              ['2026-09-24', '2026-09-24.1', 'Initial versioned privacy policy'],
            ]}
          />
        </Section>

        {/* 10. Contact */}
        <Section id="contact" title="10. Contact">
          <p>
            For any privacy question, data request, or concern contact us at{' '}
            <a
              href="mailto:privacy@rentars.app"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              privacy@rentars.app
            </a>
            . We aim to respond within 30 days.
          </p>
        </Section>

        {/* Footer nav */}
        <footer className="border-t border-gray-200 dark:border-gray-800 pt-6 flex gap-4 text-sm text-blue-600 dark:text-blue-400">
          <Link href="/terms" className="hover:underline">Terms of Service</Link>
          <Link href="/" className="hover:underline">Back to home</Link>
        </footer>

      </div>
    </main>
  );
}
