import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service — Rentars',
  description: 'Rentars platform terms of service, fee schedule, refund policy, and escrow terms.',
};

/**
 * /terms — Canonical Terms of Service page.
 *
 * The policy content here must stay in sync with
 * apps/backend/src/services/platformPolicy.service.ts
 * (CURRENT_TERMS_VERSION, PLATFORM_FEE_PCT, REFUND_TIERS, etc.).
 *
 * When the backend policy version is bumped, update this page and set a new
 * <EffectiveDate /> below.
 */

const EFFECTIVE_DATE = '24 September 2026';
const POLICY_VERSION = '2026-09-24.1';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{title}</h2>
      <div className="text-gray-700 dark:text-gray-300 space-y-3 text-sm leading-relaxed">
        {children}
      </div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-950 py-12">
      <div className="max-w-3xl mx-auto px-4 space-y-10">

        {/* Header */}
        <header>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Terms of Service</h1>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            Effective: {EFFECTIVE_DATE} · Policy version:{' '}
            <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-xs">
              {POLICY_VERSION}
            </code>
          </p>
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            Please read these terms carefully before using Rentars. By booking a property, listing a
            property, or otherwise using the platform you agree to these terms. Each booking records
            the policy version in force at the time; a later update does not change the terms of an
            existing booking.
          </p>
        </header>

        {/* Table of contents */}
        <nav aria-label="Table of contents">
          <ol className="list-decimal list-inside space-y-1 text-sm text-blue-600 dark:text-blue-400">
            {[
              ['platform', 'About the Platform'],
              ['fees', 'Fees'],
              ['payments', 'Payments & USDC Settlement'],
              ['escrow', 'Escrow & Funds Handling'],
              ['refunds', 'Cancellation & Refund Policy'],
              ['disputes', 'Disputes'],
              ['blockchain', 'Blockchain & Network Risks'],
              ['host', 'Host Obligations'],
              ['tenant', 'Tenant Obligations'],
              ['liability', 'Limitation of Liability'],
              ['changes', 'Changes to These Terms'],
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

        <Section id="platform" title="1. About the Platform">
          <p>
            Rentars is a decentralized peer-to-peer short-term rental marketplace built on the
            Stellar blockchain. Rentars provides the technology platform that connects property
            owners (hosts) with guests (tenants). Rentars is not a party to any rental agreement
            between hosts and tenants.
          </p>
        </Section>

        <Section id="fees" title="2. Fees">
          <p>
            Rentars charges a <strong>5% platform fee</strong> on each booking, calculated on the
            dynamic nightly rate (after any seasonal or event-based pricing adjustments). The fee is
            added to the tenant's checkout total and is visible in the booking quote before
            confirmation.
          </p>
          <p>
            The platform fee is <strong>non-refundable</strong> except when a booking is cancelled
            at least 7 days before check-in (full-refund tier), in which case the full amount
            including the fee is returned to the tenant.
          </p>
          <p>
            Stellar network transaction fees (~0.000001–0.001 XLM per transaction) are separate,
            paid by your Freighter wallet directly to the Stellar network. Rentars does not control
            or receive these fees.
          </p>
        </Section>

        <Section id="payments" title="3. Payments & USDC Settlement">
          <p>
            All payments on Rentars are denominated and settled in <strong>USDC</strong> (USD Coin)
            on the <strong>Stellar</strong> blockchain. You must have a Freighter-compatible Stellar
            wallet with sufficient USDC balance to complete a booking.
          </p>
          <p>
            Host earnings are released in USDC to the host's connected Stellar wallet address.
            Rentars does not hold fiat currency on behalf of any user.
          </p>
        </Section>

        <Section id="escrow" title="4. Escrow & Funds Handling">
          <p>
            When a booking is created, the tenant's USDC payment is locked in a{' '}
            <strong>non-custodial smart-contract escrow</strong> on the Stellar blockchain, managed
            by <strong>TrustlessWork</strong>. Rentars never holds your funds directly.
          </p>
          <p>Escrow release happens as follows:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <strong>Normal completion:</strong> Tenant confirms check-in → escrow is released to
              the host.
            </li>
            <li>
              <strong>Full-refund cancellation:</strong> Tenant cancels ≥7 days before check-in →
              escrow is returned to the tenant.
            </li>
            <li>
              <strong>Partial/no-refund cancellation:</strong> Escrow is released to the host; the
              host is responsible for returning any partial-refund amount to the tenant.
            </li>
            <li>
              <strong>Dispute:</strong> Funds remain locked until a Rentars moderator resolves the
              dispute.
            </li>
          </ul>
        </Section>

        <Section id="refunds" title="5. Cancellation & Refund Policy">
          <p>The refund available to a tenant depends on when they cancel relative to check-in:</p>
          <table className="w-full text-sm border-collapse mt-2" aria-label="Refund tiers">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-800">
                <th className="text-left px-3 py-2 font-semibold">Timing</th>
                <th className="text-left px-3 py-2 font-semibold">Refund</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-gray-200 dark:border-gray-700">
                <td className="px-3 py-2">7 or more days before check-in</td>
                <td className="px-3 py-2 font-medium text-green-700 dark:text-green-400">100% (full refund including platform fee)</td>
              </tr>
              <tr className="border-t border-gray-200 dark:border-gray-700">
                <td className="px-3 py-2">2–6 days before check-in</td>
                <td className="px-3 py-2 font-medium text-amber-700 dark:text-amber-400">50% of the nightly rate (platform fee non-refundable)</td>
              </tr>
              <tr className="border-t border-gray-200 dark:border-gray-700">
                <td className="px-3 py-2">Within 48 hours of check-in</td>
                <td className="px-3 py-2 font-medium text-red-700 dark:text-red-400">No refund</td>
              </tr>
            </tbody>
          </table>
          <p>
            These thresholds are configurable and the exact values in force at booking time are
            recorded with your booking. A subsequent policy change does not affect existing bookings.
          </p>
        </Section>

        <Section id="disputes" title="6. Disputes">
          <p>
            Either the tenant or host may raise a dispute on a confirmed booking. While a dispute is
            open, escrowed funds are locked and neither party can access them. Rentars moderators
            review disputes and issue a resolution that may award all funds to one party, or split
            them. Moderator decisions are final. Rentars charges no additional fee for dispute
            resolution.
          </p>
        </Section>

        <Section id="blockchain" title="7. Blockchain & Network Risks">
          <ul className="list-disc list-inside space-y-1.5">
            <li>
              <strong>Irreversibility:</strong> Stellar blockchain transactions cannot be reversed.
              Verify all payment details before confirming.
            </li>
            <li>
              <strong>Public visibility:</strong> Wallet addresses and transaction amounts are
              publicly visible on the Stellar ledger.
            </li>
            <li>
              <strong>Stablecoin risk:</strong> USDC value is pegged to USD but this peg is not
              guaranteed by Rentars.
            </li>
            <li>
              <strong>Smart contract risk:</strong> Bugs or Stellar network outages could delay
              escrow release. Rentars will work to resolve such issues but cannot guarantee specific
              timelines.
            </li>
            <li>
              <strong>Wallet security:</strong> You are solely responsible for securing your
              Freighter wallet and seed phrase. Lost wallet access means lost funds.
            </li>
          </ul>
        </Section>

        <Section id="host" title="8. Host Obligations">
          <ul className="list-disc list-inside space-y-1">
            <li>You must hold all necessary permits and comply with local short-term rental laws.</li>
            <li>
              Listing a property creates a publicly visible on-chain record on the Stellar blockchain.
            </li>
            <li>You must keep your availability calendar accurate to avoid double-bookings.</li>
            <li>Rentars may suspend listings that violate platform policies.</li>
          </ul>
        </Section>

        <Section id="tenant" title="9. Tenant Obligations">
          <ul className="list-disc list-inside space-y-1">
            <li>You must acknowledge and follow the host's house rules.</li>
            <li>You must have a valid Stellar wallet with sufficient USDC before booking.</li>
            <li>You are responsible for any damage caused during your stay.</li>
          </ul>
        </Section>

        <Section id="liability" title="10. Limitation of Liability">
          <p>
            Rentars provides a technology platform only. To the maximum extent permitted by law,
            Rentars is not liable for: the condition of any property; any loss arising from
            blockchain, smart contract, or wallet failures; or any indirect, incidental, or
            consequential damages. Our total liability to you in connection with any booking is
            limited to the platform fee paid on that booking.
          </p>
        </Section>

        <Section id="changes" title="11. Changes to These Terms">
          <p>
            We may update these terms. The version string and effective date at the top of this page
            will change when we do. <strong>Existing bookings are always governed by the policy
            version recorded at booking time</strong>, which you can view in your booking details.
            Continued use of the platform after a policy update constitutes acceptance of the new
            terms for future bookings.
          </p>
        </Section>

        <Section id="contact" title="12. Contact">
          <p>
            For questions about these terms, contact us at{' '}
            <a href="mailto:legal@rentars.app" className="text-blue-600 dark:text-blue-400 hover:underline">
              legal@rentars.app
            </a>
            .
          </p>
        </Section>

        {/* Footer nav */}
        <footer className="border-t border-gray-200 dark:border-gray-800 pt-6 flex gap-4 text-sm text-blue-600 dark:text-blue-400">
          <Link href="/privacy" className="hover:underline">Privacy Policy</Link>
          <Link href="/" className="hover:underline">Back to home</Link>
        </footer>

      </div>
    </main>
  );
}
