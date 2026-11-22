/**
 * Higher-level service that stores a canonical data-hash for each property
 * on-chain. The Supabase DB holds the authoritative property data; the hash
 * on-chain allows tamper-evidence verification via verifyPropertyIntegrity().
 *
 * Assumed contract interface (Soroban):
 *   create_property_listing(id: String, data_hash: String, owner: Address)
 *   update_property_listing(id: String, data_hash: String, owner: Address)
 *   get_property_listing(id: String) -> { owner: Address, data_hash: String, status: Symbol }
 *   update_property_status(id: String, owner: Address, status: Symbol)
 *   get_property_listings_page(cursor: Option<String>, limit: u32)
 *     -> { items: Vec<{ id: String, owner: Address, data_hash: String, status: Symbol }>,
 *          next_cursor: Option<String> }
 *
 * Listing enumeration is keyset-paginated: the cursor is the last id returned
 * on the previous page, and the contract returns ids in ascending order. This
 * keeps every read bounded regardless of how many listings exist.
 */

import { createHash } from 'crypto';
import {
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import {
  NETWORK_PASSPHRASE,
  PROPERTY_LISTING_CONTRACT_ID,
  STELLAR_SOURCE_ACCOUNT,
} from './config.js';
import { getSorobanServer, simulateReadOnly, submitAndWait } from './soroban.js';
import { buildPrepareAndSign } from './transactionUtils.js';
import { ContractError } from './errors.js';
import type { ListingStatus } from './types.js';

export interface OnChainPropertyData {
  owner: string;
  data_hash: string;
  status: ListingStatus;
}

export interface OnChainPropertyListing extends OnChainPropertyData {
  id: string;
}

export interface PropertyListingPage {
  items: OnChainPropertyListing[];
  /** Cursor to pass as `cursor` for the next page, or null when exhausted. */
  next_cursor: string | null;
}

/**
 * Maximum number of listings the contract will return in a single page.
 * Mirrors the contract-side cap so clients never request more than the
 * contract is willing to serve (and never exceed Soroban resource limits).
 */
export const MAX_PROPERTY_LISTING_PAGE_SIZE = 50;

/** Default page size used when callers do not specify one. */
export const DEFAULT_PROPERTY_LISTING_PAGE_SIZE = 20;

// ─── Serialisation ────────────────────────────────────────────────────────────

/**
 * Serialise the canonical subset of property fields to a deterministic JSON
 * string for hashing. Keys are always sorted alphabetically.
 *
 * @param property - Property record (any extra keys are ignored)
 * @returns Deterministic JSON string of the canonical fields
 */
export function propertyToHashData(property: Record<string, unknown>): string {
  const CANONICAL_FIELDS = [
    'address',
    'bathrooms',
    'bedrooms',
    'city',
    'country',
    'description',
    'id',
    'max_guests',
    'price_per_night',
    'title',
  ] as const;

  const canonical: Record<string, unknown> = {};
  for (const field of CANONICAL_FIELDS) {
    if (field in property) {
      canonical[field] = property[field];
    }
  }

  return JSON.stringify(canonical);
}

function computeSha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the on-chain hash record for a property.
 *
 * @param id - Supabase property UUID used as the on-chain identifier
 * @returns On-chain property data including owner address, data hash, and listing status
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or the call fails
 */
export async function getPropertyListing(id: string): Promise<OnChainPropertyData> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      'get_property_listing',
    );
  }

  const server = getSorobanServer();
  const contract = new Contract(PROPERTY_LISTING_CONTRACT_ID);

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call('get_property_listing', nativeToScVal(id, { type: 'string' })),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_property_listing');
  const native = scValToNative(retval) as {
    owner: string;
    data_hash: string;
    status: string;
  };

  return {
    owner: native.owner,
    data_hash: native.data_hash,
    status: native.status as ListingStatus,
  };
}

/**
 * Fetch a single bounded page of on-chain property listings.
 *
 * Ordering is deterministic (ascending by listing id) and the cursor is the
 * last id of the previous page, so pages never overlap or skip records.
 *
 * @param cursor - Last id from the previous page, or null/undefined for the first page
 * @param limit - Requested page size; clamped to [1, MAX_PROPERTY_LISTING_PAGE_SIZE]
 * @returns A page of listings plus the cursor for the next page (null when done)
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or the call fails
 */
export async function getPropertyListingsPage(
  cursor?: string | null,
  limit: number = DEFAULT_PROPERTY_LISTING_PAGE_SIZE,
): Promise<PropertyListingPage> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      'get_property_listings_page',
    );
  }

  const pageSize = Math.min(
    Math.max(Math.trunc(limit) || 1, 1),
    MAX_PROPERTY_LISTING_PAGE_SIZE,
  );

  const server = getSorobanServer();
  const contract = new Contract(PROPERTY_LISTING_CONTRACT_ID);

  const cursorScVal =
    cursor === undefined || cursor === null
      ? xdr.ScVal.scvVoid()
      : nativeToScVal(cursor, { type: 'string' });

  const sourceAccount = await server.getAccount(STELLAR_SOURCE_ACCOUNT);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: '100',
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        'get_property_listings_page',
        cursorScVal,
        nativeToScVal(pageSize, { type: 'u32' }),
      ),
    )
    .setTimeout(30)
    .build();

  const retval = await simulateReadOnly(server, tx, 'get_property_listings_page');
  const native = scValToNative(retval) as {
    items: Array<{ id: string; owner: string; data_hash: string; status: string }>;
    next_cursor: string | null | undefined;
  };

  const items = (native.items ?? []).map((item) => ({
    id: item.id,
    owner: item.owner,
    data_hash: item.data_hash,
    status: item.status as ListingStatus,
  }));

  return {
    items,
    next_cursor: native.next_cursor ?? null,
  };
}

/**
 * Iterate every on-chain listing through bounded pages.
 *
 * Prefer this over any "fetch all" helper: it never asks the contract for an
 * unbounded collection, and it stops as soon as the contract reports no
 * further cursor. A safety cap on the number of pages prevents runaway loops
 * if the contract misbehaves.
 *
 * @param options.pageSize - Page size to request (clamped by the contract cap)
 * @param options.maxPages - Hard limit on pages fetched (default 10_000)
 * @param options.onPage - Optional callback invoked with each page as it arrives
 * @returns All listings, in deterministic ascending-id order
 * @throws ContractError if a page fetch fails or the page cap is exceeded
 */
export async function getAllPropertyListings(options?: {
  pageSize?: number;
  maxPages?: number;
  onPage?: (page: PropertyListingPage) => void | Promise<void>;
}): Promise<OnChainPropertyListing[]> {
  const pageSize = options?.pageSize ?? MAX_PROPERTY_LISTING_PAGE_SIZE;
  const maxPages = options?.maxPages ?? 10_000;

  const all: OnChainPropertyListing[] = [];
  let cursor: string | null = null;
  let pages = 0;

  do {
    if (pages >= maxPages) {
      throw new ContractError(
        `Exceeded maximum of ${maxPages} pages while listing properties`,
        'get_property_listings_page',
      );
    }

    const page = await getPropertyListingsPage(cursor, pageSize);
    pages += 1;

    if (options?.onPage) {
      await options.onPage(page);
    }

    all.push(...page.items);

    // Guard against a contract that returns the same cursor forever.
    if (page.next_cursor !== null && page.next_cursor === cursor) {
      throw new ContractError(
        'Contract returned a non-advancing pagination cursor',
        'get_property_listings_page',
      );
    }

    cursor = page.next_cursor;
  } while (cursor !== null);

  return all;
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Register a property's data-hash on-chain.
 *
 * @param id - Supabase property UUID
 * @param dataHash - SHA-256 hex hash of the canonical property data
 * @param ownerAddress - Stellar public key of the property owner
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function createPropertyListing(
  id: string,
  dataHash: string,
  ownerAddress: string,
): Promise<void> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      'create_property_listing',
    );
  }

  const server = getSorobanServer();
  const contract = new Contract(PROPERTY_LISTING_CONTRACT_ID);

  const op = contract.call(
    'create_property_listing',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(dataHash, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the stored data-hash for a property.
 *
 * @param id - Supabase property UUID
 * @param dataHash - New SHA-256 hex hash of updated canonical property data
 * @param ownerAddress - Stellar public key of the property owner
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function updatePropertyListing(
  id: string,
  dataHash: string,
  ownerAddress: string,
): Promise<void> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      'update_property_listing',
    );
  }

  const server = getSorobanServer();
  const contract = new Contract(PROPERTY_LISTING_CONTRACT_ID);

  const op = contract.call(
    'update_property_listing',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(dataHash, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

/**
 * Update the status of a property listing on-chain.
 *
 * @param id - Supabase property UUID
 * @param ownerAddress - Stellar public key of the property owner
 * @param status - New listing status ('Active', 'Inactive', etc.)
 * @throws ContractError if PROPERTY_LISTING_CONTRACT_ID is not configured or submission fails
 */
export async function updatePropertyStatus(
  id: string,
  ownerAddress: string,
  status: ListingStatus,
): Promise<void> {
  if (!PROPERTY_LISTING_CONTRACT_ID) {
    throw new ContractError(
      'PROPERTY_LISTING_CONTRACT_ID is not configured',
      'update_property_status',
    );
  }

  const server = getSorobanServer();
  const contract = new Contract(PROPERTY_LISTING_CONTRACT_ID);

  const op = contract.call(
    'update_property_status',
    nativeToScVal(id, { type: 'string' }),
    nativeToScVal(ownerAddress, { type: 'address' }),
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(status)]),
  );

  const tx = await buildPrepareAndSign(server, [op]);
  await submitAndWait(server, tx);
}

// ─── Integrity ────────────────────────────────────────────────────────────────

/**
 * Verify that local property data matches the hash stored on-chain.
 *
 * Returns true when the hashes match, false when they diverge (indicating
 * the off-chain record may have been mutated outside the normal update flow).
 *
 * @param id - Supabase property UUID
 * @param localData - Current local property record from Supabase
 * @returns true if hashes match, false if tamper detected
 * @throws ContractError if the on-chain lookup fails
 * @example
 * const isValid = await verifyPropertyIntegrity(property.id, property);
 * if (!isValid) console.warn('Property data has been tampered with!');
 */
export async function verifyPropertyIntegrity(
  id: string,
  localData: Record<string, unknown>,
): Promise<boolean> {
  const onChain = await getPropertyListing(id);
  const localHash = computeSha256(propertyToHashData(localData));
  return localHash === onChain.data_hash;
}
