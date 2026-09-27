# Freighter Wallet Device & Accessibility Matrix (#626)

Real-wallet behaviour was validated against disposable Freighter testnet
accounts. Unsupported combinations must show a non-dead-end message via
`WalletOnboardingModal` / `isUnsupportedWalletEnvironment()`.

## Supported paths

| Platform | Browser | Wallet | Connect | Sign | Reject | Recover |
|----------|---------|--------|---------|------|--------|---------|
| Desktop | Chrome 120+ | Freighter extension | Yes | Yes | Yes | Yes (retry) |
| Desktop | Firefox 121+ | Freighter extension | Yes | Yes | Yes | Yes |
| Desktop | Brave | Freighter extension | Yes | Yes | Yes | Yes |
| macOS | Safari 17+ | Freighter extension | Yes* | Yes* | Yes | Yes |
| Android | Chrome | Freighter mobile handoff | Yes† | Yes† | Yes | Yes |
| iOS | Safari | Freighter mobile handoff | Yes† | Yes† | Yes | Yes |

\* Safari may require Freighter permissions re-grant after updates.  
† Mobile handoff only when Freighter deep-link / in-wallet browser bridge is present.

## Unsupported (clear message, no dead end)

| Environment | Reason | User guidance |
|-------------|--------|---------------|
| Instagram / Facebook / LINE in-app browser | Extension + deep-link blocked | “Open in Safari/Chrome” + Freighter help link |
| Mobile browser without Freighter bridge | No `window.freighter` / stellar API | Same non-dead-end copy + desktop alternative |
| Desktop without Freighter installed | Extension missing | Install link to freighter.app |

## Accessibility requirements

| Check | Implementation |
|-------|----------------|
| Modal focus trap | `WalletOnboardingModal` Tab cycles within panel |
| Escape closes | `keydown` Escape → close + restore focus |
| Status announcements | `role="status"` + `aria-live="polite"` for loading / error / connected |
| Account switch alert | `AccountSwitchBanner` uses `role="alert"` + `aria-live="assertive"` |
| Keyboard reachability | Primary actions are native `<button>` / `<a>` with visible focus rings |

## Automated checks

- `apps/web/src/components/wallet/__tests__/WalletOnboardingModal.a11y.test.tsx`
- `apps/web/src/hooks/__tests__/useWallet.accountSwitch.test.ts`
- `apps/web/src/lib/__tests__/freighter-utils.env.test.ts`

## Manual Freighter testnet checklist

1. Create disposable testnet account in Freighter.
2. Connect → sign a booking fund → reject a second prompt → retry.
3. Switch Freighter account mid-checkout → confirm banner blocks submit.
4. Disconnect → confirm `localStorage` wallet keys cleared.
5. Repeat on one mobile Safari/Chrome path from the supported table.
