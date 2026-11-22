/**
 * Backend client for the Booking Soroban contract.
 *
 * ABI reference: apps/contracts/booking_abi.json
 *
 * This module wraps the @stellar/stellar-sdk contract invocation API and
 * provides typed methods that mirror every function in the ABI. All i128/u64
 * values are represented as bigint in TypeScript.
 */

import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import type {
  Booking,
  BookingStatus,
  CreateBookingParams,
  DisputeBookingParams,
  EscrowStatus,
  FundEscrowParams,
  ResolveDisputeParams,
} from './types.js';

import { describe, it, expect } from 'vitest';

// ─── ABI metadata (sourced from booking_abi.json) ────────────────────────────
const ABI_VERSION = '0.1.0';
const CONTRACT_NAME = 'booking';

// ─── Client ──────────────────────────────────────────────────────────────────

export class BookingClient {
  private readonly contract: Contract;
  private readonly server: rpc.Server;
  private readonly networkPassphrase: string;

  constructor(
    contractId: string,
    rpcUrl: string,
    networkPassphrase: string = Networks.TESTNET,
  ) {
    this.contract = new Contract(contractId);
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = networkPassphrase;
  }

  // ── Read-only queries ─────────────────────────────────────────────────────

  /**
   * Retrieve a booking by ID.
   *
   * ABI: get_booking(id: u64) -> Booking
   */
  async getBooking(id: bigint): Promise<Booking> {
    const result = await this.simulateReadOnly('get_booking', [
      nativeToScVal(id, { type: 'u64' }),
    ]);
    return scValToNative(result) as Booking;
  }

  /**
   * Return all booking IDs for a given property.
   *
   * ABI: get_property_bookings(property_id: u64) -> Vec<u64>
   */
  async getPropertyBookings(propertyId: bigint): Promise<bigint[]> {
    const result = await this.simulateReadOnly('get_property_bookings', [
      nativeToScVal(propertyId, { type: 'u64' }),
    ]);
    const native = scValToNative(result) as (number | string)[];
    return native.map((v) => BigInt(v));
  }

  /**
   * Check whether a date range is available for a property.
   *
   * ABI: check_availability(property_id, check_in, check_out) -> bool
   */
  async checkAvailability(
    propertyId: bigint,
    checkIn: bigint,
    checkOut: bigint,
  ): Promise<boolean> {
    const result = await this.simulateReadOnly('check_availability', [
      nativeToScVal(propertyId, { type: 'u64' }),
      nativeToScVal(checkIn, { type: 'u64' }),
      nativeToScVal(checkOut, { type: 'u64' }),
    ]);
    return scValToNative(result) as boolean;
  }

  /**
   * Return the total number of bookings ever created.
   *
   * ABI: booking_count() -> u64
   */
  async bookingCount(): Promise<bigint> {
    const result = await this.simulateReadOnly('booking_count', []);
    return BigInt(scValToNative(result) as number | string);
  }

  // ── State-changing operations ─────────────────────────────────────────────

  /**
   * Build the XDR operation for initialize.
   *
   * ABI: initialize(admin: Address)
   *
   * Must be called exactly once after deployment. The caller is responsible
   * for wrapping in a transaction, signing with the admin keypair, and
   * submitting via the Stellar network.
   */
  buildInitialize(admin: string): xdr.Operation {
    return this.contract.call(
      'initialize',
      nativeToScVal(admin, { type: 'address' }),
    );
  }

  /**
   * Build the XDR operation for create_booking.
   *
   * ABI: create_booking(tenant, property_id, check_in, check_out, total_price) -> u64
   */
  buildCreateBooking(params: CreateBookingParams): xdr.Operation {
    return this.contract.call(
      'create_booking',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.property_id, { type: 'u64' }),
      nativeToScVal(params.check_in, { type: 'u64' }),
      nativeToScVal(params.check_out, { type: 'u64' }),
      nativeToScVal(params.total_price, { type: 'i128' }),
    );
  }

  /**
   * Build the XDR operation for cancel_booking.
   *
   * ABI: cancel_booking(caller: Address, booking_id: u64)
   */
  buildCancelBooking(caller: string, bookingId: bigint): xdr.Operation {
    return this.contract.call(
      'cancel_booking',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for update_status.
   *
   * ABI: update_status(caller, booking_id, new_status)
   * Only the admin may call this.
   */
  buildUpdateStatus(
    caller: string,
    bookingId: bigint,
    newStatus: BookingStatus,
  ): xdr.Operation {
    return this.contract.call(
      'update_status',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(newStatus)]),
    );
  }

  /**
   * Build the XDR operation for set_escrow_id.
   *
   * ABI: set_escrow_id(caller, booking_id, escrow_id)
   * Only the admin may call this.
   */
  buildSetEscrowId(
    caller: string,
    bookingId: bigint,
    escrowId: string,
  ): xdr.Operation {
    return this.contract.call(
      'set_escrow_id',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(bookingId, { type: 'u64' }),
      nativeToScVal(escrowId, { type: 'string' }),
    );
  }

  /**
   * Build the XDR operation for set_token_address.
   *
   * ABI: set_token_address(caller, token_address)
   * Only the admin may call this.
   */
  buildSetTokenAddress(
    caller: string,
    tokenAddress: string,
  ): xdr.Operation {
    return this.contract.call(
      'set_token_address',
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(tokenAddress, { type: 'address' }),
    );
  }

  /**
   * Build the XDR operation for fund_escrow.
   *
   * ABI: fund_escrow(tenant, booking_id)
   * The tenant must authorize and have sufficient USDC balance.
   */
  buildFundEscrow(params: FundEscrowParams): xdr.Operation {
    return this.contract.call(
      'fund_escrow',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for dispute_booking.
   *
   * ABI: dispute_booking(tenant, booking_id)
   * Only the tenant may dispute a funded booking.
   */
  buildDisputeBooking(params: DisputeBookingParams): xdr.Operation {
    return this.contract.call(
      'dispute_booking',
      nativeToScVal(params.tenant, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
    );
  }

  /**
   * Build the XDR operation for resolve_dispute.
   *
   * ABI: resolve_dispute(caller, booking_id, release_to_owner)
   * Only the admin may resolve disputes.
   */
  buildResolveDispute(params: ResolveDisputeParams): xdr.Operation {
    return this.contract.call(
      'resolve_dispute',
      nativeToScVal(params.caller, { type: 'address' }),
      nativeToScVal(params.booking_id, { type: 'u64' }),
      nativeToScVal(params.release_to_owner, { type: 'bool' }),
    );
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Simulate a read-only contract call and return the result ScVal.
   */
  private async simulateReadOnly(
    method: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal> {
    const sourceAccount = await this.server.getAccount(
      process.env.STELLAR_SOURCE_ACCOUNT ||
        'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(
        `Contract simulation failed [${CONTRACT_NAME}@${ABI_VERSION}::${method}]: ${simResult.error}`,
      );
    }

    const successResult = simResult as rpc.Api.SimulateTransactionSuccessResponse;
    if (!successResult.result?.retval) {
      throw new Error(`No return value from ${method}`);
    }

    return successResult.result.retval;
  }
}

// ─── Cross-contract ABI compatibility tests ──────────────────────────────────
//
// These tests exercise the low-level XDR builders in BookingClient without any
// network access. They assert that the operations produced by the client match
// the booking contract ABI (apps/contracts/booking_abi.json): the target
// contract ID, the function name, argument order, argument types, and the
// symbol-vector encoding used for status enums. A regression here means the
// backend and the on-chain contract have drifted apart.

const TEST_CONTRACT_ID =
  'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const TEST_RPC_URL = 'https://soroban-testnet.stellar.org';

const ADMIN = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const TENANT = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI';
const TOKEN = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function makeClient(): BookingClient {
  return new BookingClient(TEST_CONTRACT_ID, TEST_RPC_URL);
}

/**
 * Extract the invocation details from an operation built by Contract.call().
 * The operation body is an InvokeHostFunction with a single HostFunction of
 * type InvokeContract carrying the contract address and function name.
 */
function getInvocation(op: xdr.Operation): {
  contractId: string;
  functionName: string;
  args: xdr.ScVal[];
} {
  const body = op.body();
  expect(
    body.switch().name,
    'operation body must be INVOKE_HOST_FUNCTION',
  ).toBe('invokeHostFunction');

  const hostFn = body.invokeHostFunctionOp().hostFunction();
  expect(
    hostFn.switch().name,
    'host function must be INVOKE_CONTRACT',
  ).toBe('invokeContract');

  const invoke = hostFn.invokeContract();
  const contractId = invoke.contractAddress().contractId().toString('hex');
  const functionName = invoke.functionName().toString();
  const args = invoke.args();

  return { contractId, functionName, args };
}

/** Decode a ScVal to its native JS representation for assertions. */
function native(scVal: xdr.ScVal): unknown {
  return scValToNative(scVal);
}

describe('BookingClient cross-contract ABI compatibility', () => {
  it('buildCreateBooking matches create_booking ABI (arg order and types)', () => {
    const client = makeClient();
    const op = client.buildCreateBooking({
      tenant: TENANT,
      property_id: 42n,
      check_in: 1_700_000_000n,
      check_out: 1_700_086_400n,
      total_price: 500_000_000n,
    });

    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'create_booking: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'create_booking: function name must match ABI',
    ).toBe('create_booking');
    expect(
      args.length,
      'create_booking: ABI expects 5 arguments (tenant, property_id, check_in, check_out, total_price)',
    ).toBe(5);

    // tenant: Address
    expect(
      args[0].switch().name,
      'create_booking: arg[0] tenant must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'create_booking: arg[0] tenant value must round-trip',
    ).toBe(TENANT);

    // property_id: u64
    expect(
      args[1].switch().name,
      'create_booking: arg[1] property_id must be u64',
    ).toBe('scvU64');
    expect(
      native(args[1]),
      'create_booking: arg[1] property_id value must round-trip',
    ).toBe(42n);

    // check_in: u64
    expect(
      args[2].switch().name,
      'create_booking: arg[2] check_in must be u64',
    ).toBe('scvU64');
    expect(
      native(args[2]),
      'create_booking: arg[2] check_in value must round-trip',
    ).toBe(1_700_000_000n);

    // check_out: u64
    expect(
      args[3].switch().name,
      'create_booking: arg[3] check_out must be u64',
    ).toBe('scvU64');
    expect(
      native(args[3]),
      'create_booking: arg[3] check_out value must round-trip',
    ).toBe(1_700_086_400n);

    // total_price: i128
    expect(
      args[4].switch().name,
      'create_booking: arg[4] total_price must be i128',
    ).toBe('scvI128');
    expect(
      native(args[4]),
      'create_booking: arg[4] total_price value must round-trip',
    ).toBe(500_000_000n);
  });

  it('buildCancelBooking matches cancel_booking ABI (caller, booking_id)', () => {
    const client = makeClient();
    const op = client.buildCancelBooking(TENANT, 7n);
    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'cancel_booking: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'cancel_booking: function name must match ABI',
    ).toBe('cancel_booking');
    expect(
      args.length,
      'cancel_booking: ABI expects 2 arguments (caller, booking_id)',
    ).toBe(2);
    expect(
      args[0].switch().name,
      'cancel_booking: arg[0] caller must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'cancel_booking: arg[0] caller value must round-trip',
    ).toBe(TENANT);
    expect(
      args[1].switch().name,
      'cancel_booking: arg[1] booking_id must be u64',
    ).toBe('scvU64');
    expect(
      native(args[1]),
      'cancel_booking: arg[1] booking_id value must round-trip',
    ).toBe(7n);
  });

  it('buildUpdateStatus matches update_status ABI and encodes status as a symbol vector', () => {
    const client = makeClient();
    const op = client.buildUpdateStatus(ADMIN, 7n, 'Confirmed');
    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'update_status: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'update_status: function name must match ABI',
    ).toBe('update_status');
    expect(
      args.length,
      'update_status: ABI expects 3 arguments (caller, booking_id, new_status)',
    ).toBe(3);
    expect(
      args[0].switch().name,
      'update_status: arg[0] caller must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'update_status: arg[0] caller value must round-trip',
    ).toBe(ADMIN);
    expect(
      args[1].switch().name,
      'update_status: arg[1] booking_id must be u64',
    ).toBe('scvU64');
    expect(
      native(args[1]),
      'update_status: arg[1] booking_id value must round-trip',
    ).toBe(7n);

    // new_status: enum encoded as a single-element symbol vector
    expect(
      args[2].switch().name,
      'update_status: arg[2] new_status must be a Vec (symbol vector)',
    ).toBe('scvVec');
    const statusVec = args[2].vec();
    expect(
      statusVec?.length,
      'update_status: arg[2] new_status vector must contain exactly one symbol',
    ).toBe(1);
    const statusSymbol = statusVec![0];
    expect(
      statusSymbol.switch().name,
      'update_status: arg[2] new_status element must be a Symbol',
    ).toBe('scvSymbol');
    expect(
      statusSymbol.sym().toString(),
      'update_status: arg[2] new_status symbol must match the BookingStatus variant',
    ).toBe('Confirmed');
  });

  it('buildSetTokenAddress matches set_token_address ABI (caller, token_address)', () => {
    const client = makeClient();
    const op = client.buildSetTokenAddress(ADMIN, TOKEN);
    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'set_token_address: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'set_token_address: function name must match ABI',
    ).toBe('set_token_address');
    expect(
      args.length,
      'set_token_address: ABI expects 2 arguments (caller, token_address)',
    ).toBe(2);
    expect(
      args[0].switch().name,
      'set_token_address: arg[0] caller must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'set_token_address: arg[0] caller value must round-trip',
    ).toBe(ADMIN);
    expect(
      args[1].switch().name,
      'set_token_address: arg[1] token_address must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[1]),
      'set_token_address: arg[1] token_address value must round-trip',
    ).toBe(TOKEN);
  });

  it('buildFundEscrow matches fund_escrow ABI (tenant, booking_id)', () => {
    const client = makeClient();
    const op = client.buildFundEscrow({ tenant: TENANT, booking_id: 7n });
    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'fund_escrow: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'fund_escrow: function name must match ABI',
    ).toBe('fund_escrow');
    expect(
      args.length,
      'fund_escrow: ABI expects 2 arguments (tenant, booking_id)',
    ).toBe(2);
    expect(
      args[0].switch().name,
      'fund_escrow: arg[0] tenant must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'fund_escrow: arg[0] tenant value must round-trip',
    ).toBe(TENANT);
    expect(
      args[1].switch().name,
      'fund_escrow: arg[1] booking_id must be u64',
    ).toBe('scvU64');
    expect(
      native(args[1]),
      'fund_escrow: arg[1] booking_id value must round-trip',
    ).toBe(7n);
  });

  it('buildDisputeBooking matches dispute_booking ABI (tenant, booking_id)', () => {
    const client = makeClient();
    const op = client.buildDisputeBooking({ tenant: TENANT, booking_id: 7n });
    const { contractId, functionName, args } = getInvocation(op);

    expect(
      contractId,
      'dispute_booking: contract ID must match configured BOOKING_CONTRACT_ID',
    ).toBe(TEST_CONTRACT_ID);
    expect(
      functionName,
      'dispute_booking: function name must match ABI',
    ).toBe('dispute_booking');
    expect(
      args.length,
      'dispute_booking: ABI expects 2 arguments (tenant, booking_id)',
    ).toBe(2);
    expect(
      args[0].switch().name,
      'dispute_booking: arg[0] tenant must be an Address',
    ).toBe('scvAddress');
    expect(
      native(args[0]),
      'dispute_booking: arg[0] tenant value must round-trip',
    ).toBe(TENANT);
    expect(
      args[1].switch().name,
      'dispute_booking: arg[1] booking_id must be u64',
    ).toBe('scvU64');
    expect(
      native(args[1]),
      'dispute_booking: arg[1] booking_id value must round-trip',
    ).toBe(7n);
  });
});
