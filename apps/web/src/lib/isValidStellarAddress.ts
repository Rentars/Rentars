// Lightweight Stellar address validation — no heavy wallet dependency.
export function isValidStellarAddress(address: string): boolean {
  // Stellar public keys start with 'G' and are base32 encoded (56 chars)
  return /^G[A-Z2-7]{55}$/.test(address);
}
