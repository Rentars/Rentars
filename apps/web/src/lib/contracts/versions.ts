/**
 * Contract version registry for dual-read / cutover (#625).
 *
 * During a migration window the app may need to resolve both the current and
 * legacy Soroban contract addresses while keeping booking/payment references
 * stable.
 */

export type ContractKind = 'booking' | 'propertyListing' | 'review' | 'rental';
export type ContractGeneration = 'current' | 'legacy';

export interface ContractEndpoint {
  kind: ContractKind;
  address: string;
  /** Semantic version from on-chain `version()` / CONFIG (major*100+minor). */
  version: number;
  generation: ContractGeneration;
}

/** Minimum supported on-chain version (must match CONTRACT_VERSION in Rust). */
export const CONTRACT_VERSION_MIN = Number(
  process.env.NEXT_PUBLIC_CONTRACT_VERSION_MIN ?? '100',
);

const ENV_KEYS: Record<
  ContractKind,
  { current: string; legacy: string }
> = {
  booking: {
    current: 'NEXT_PUBLIC_BOOKING_CONTRACT_ID',
    legacy: 'NEXT_PUBLIC_BOOKING_CONTRACT_ID_LEGACY',
  },
  propertyListing: {
    current: 'NEXT_PUBLIC_PROPERTY_LISTING_CONTRACT_ID',
    legacy: 'NEXT_PUBLIC_PROPERTY_LISTING_CONTRACT_ID_LEGACY',
  },
  review: {
    current: 'NEXT_PUBLIC_REVIEW_CONTRACT_ID',
    legacy: 'NEXT_PUBLIC_REVIEW_CONTRACT_ID_LEGACY',
  },
  rental: {
    current: 'NEXT_PUBLIC_RENTARS_CONTRACT_ADDRESS',
    legacy: 'NEXT_PUBLIC_RENTARS_CONTRACT_ADDRESS_LEGACY',
  },
};

function readEnv(key: string): string | null {
  const value = process.env[key];
  return value && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Prefer `current` generation unless an explicit override is set
 * (`NEXT_PUBLIC_CONTRACT_GENERATION=legacy` during rollback drills).
 */
export function preferredGeneration(): ContractGeneration {
  const raw = (process.env.NEXT_PUBLIC_CONTRACT_GENERATION ?? 'current').toLowerCase();
  return raw === 'legacy' ? 'legacy' : 'current';
}

export function resolveContract(kind: ContractKind): ContractEndpoint | null {
  const keys = ENV_KEYS[kind];
  const generation = preferredGeneration();
  const primaryKey = generation === 'current' ? keys.current : keys.legacy;
  const fallbackKey = generation === 'current' ? keys.legacy : keys.current;

  const address = readEnv(primaryKey) ?? readEnv(fallbackKey);
  if (!address) return null;

  const usedGeneration: ContractGeneration =
    readEnv(primaryKey) != null ? generation : generation === 'current' ? 'legacy' : 'current';

  return {
    kind,
    address,
    version: CONTRACT_VERSION_MIN,
    generation: usedGeneration,
  };
}

/**
 * Dual-read helper: return [current, legacy] endpoints that are configured.
 * Callers try current first for new writes; historical IDs may live on legacy.
 */
export function resolveContractDualRead(kind: ContractKind): ContractEndpoint[] {
  const keys = ENV_KEYS[kind];
  const out: ContractEndpoint[] = [];

  const current = readEnv(keys.current);
  if (current) {
    out.push({
      kind,
      address: current,
      version: CONTRACT_VERSION_MIN,
      generation: 'current',
    });
  }

  const legacy = readEnv(keys.legacy);
  if (legacy && legacy !== current) {
    out.push({
      kind,
      address: legacy,
      version: CONTRACT_VERSION_MIN,
      generation: 'legacy',
    });
  }

  return out;
}

export function assertContractVersionSupported(onChainVersion: number): void {
  if (onChainVersion < CONTRACT_VERSION_MIN) {
    throw new Error(
      `Contract version ${onChainVersion} is below minimum supported ${CONTRACT_VERSION_MIN}`,
    );
  }
}
