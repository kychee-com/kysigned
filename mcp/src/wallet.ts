/**
 * wallet — F-30.5 (spec 0.40.0, #132): the MCP wallet foundation.
 *
 * Custody (DD-30): the wallet is the HOST-LOCAL run402 allowance wallet
 * (`run402 init`-provisioned); this module reads it via the run402 SDK and
 * exposes ONLY the address — a private key is never a tool argument, never
 * part of any result, and never leaves the SDK's own signing path.
 *
 * Discovery (DD-31): price/network/asset/payee come from the priced route's
 * own unpaid 402 challenge (`Payment-Required` header, x402 v2) — zero cost,
 * zero side effects (the platform settles pre-invoke, so an unpaid call never
 * runs the function). Nothing operator-specific is baked into the package.
 */

export interface ChallengeTerms {
  network: string;
  asset: string;
  assetName?: string;
  /** Atomic units of `asset` as a decimal string (USDC: atomic == usd micros). */
  amountAtomic: string;
  amountUsdMicros?: number;
  payTo: string;
}

export class X402RouteError extends Error {
  readonly kind: 'not_priced' | 'bad_challenge';
  constructor(kind: 'not_priced' | 'bad_challenge', message: string) {
    super(message);
    this.name = 'X402RouteError';
    this.kind = kind;
  }
}

/** The x402 create route relative to the configured endpoint (F-30.2). */
export const X402_CREATE_PATH = '/v1/x402/envelope';

/**
 * Probe the priced route unpaid and parse its x402 v2 challenge terms.
 * Throws X402RouteError: `not_priced` when the route answers anything but a
 * 402 challenge (e.g. a fork where the operator has not wired x402), and
 * `bad_challenge` when a 402 arrives without a parseable challenge.
 */
export async function fetchChallengeTerms(
  endpoint: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<ChallengeTerms> {
  const url = `${endpoint}${X402_CREATE_PATH}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (res.status !== 402) {
    throw new X402RouteError(
      'not_priced',
      `${url} answered ${res.status}, not an x402 402 challenge — this instance has no wallet-payable create (operator has not wired x402).`,
    );
  }
  const header = res.headers.get('payment-required');
  if (!header) {
    throw new X402RouteError('bad_challenge', `402 from ${url} carried no Payment-Required challenge header.`);
  }
  let accept: Record<string, unknown>;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as {
      accepts?: Array<Record<string, unknown>>;
    };
    const accepts = Array.isArray(decoded.accepts) ? decoded.accepts : [];
    const found = accepts.find((a) => a['scheme'] === 'exact') ?? accepts[0];
    if (!found) throw new Error('no accepts entries');
    accept = found;
  } catch (err) {
    throw new X402RouteError(
      'bad_challenge',
      `Could not parse the Payment-Required challenge from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const network = accept['network'];
  const asset = accept['asset'];
  const amount = accept['amount'];
  const payTo = accept['payTo'];
  if (typeof network !== 'string' || typeof asset !== 'string' || typeof payTo !== 'string' ||
      typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new X402RouteError('bad_challenge', `Challenge accepts entry from ${url} is missing network/asset/amount/payTo.`);
  }
  const extra = (accept['extra'] ?? {}) as Record<string, unknown>;
  const terms: ChallengeTerms = { network, asset, amountAtomic: amount, payTo };
  if (typeof extra['name'] === 'string') terms.assetName = extra['name'];
  if (typeof extra['amount_usd_micros'] === 'number') terms.amountUsdMicros = extra['amount_usd_micros'];
  return terms;
}

export interface WalletSeams {
  /** The allowance wallet's ADDRESS, or null when no wallet is configured. Never the key. */
  readAllowanceAddress(): Promise<string | null>;
  /** Where the allowance file lives (for actionable "not configured" guidance). */
  allowancePath(): Promise<string>;
  /** Fetch used for the unpaid challenge probe and the free preflight. */
  fetchFn: typeof fetch;
  /** On-chain ERC-20 balance of `address` in atomic units. */
  readBalanceAtomic(q: { network: string; asset: string; address: string }): Promise<bigint>;
  /**
   * The x402-paying fetch (signs and retries 402 challenges from the local
   * allowance wallet). Null when no wallet is configured or the payment stack
   * is unavailable — callers must treat null as "cannot pay", never fall back
   * to an unpaid fetch for the paid call.
   */
  paidFetchFactory(): Promise<typeof fetch | null>;
}

export type WalletStatus =
  | { configured: false; allowance_path: string; hint: string }
  | {
      configured: true;
      address: string;
      network: string;
      asset: string;
      asset_name?: string;
      balance_atomic: string;
      price_atomic: string;
      price_usd_micros?: number;
      sufficient: boolean;
      envelopes_affordable: number;
      fund_hint?: string;
    };

function usd(micros: number | undefined): string | undefined {
  return micros === undefined ? undefined : `$${(micros / 1_000_000).toFixed(2)}`;
}

/** AC-145 — the readiness facts: address, terms, balance, coverage. Never spends. */
export async function getWalletStatus(endpoint: string, seams: WalletSeams): Promise<WalletStatus> {
  const address = await seams.readAllowanceAddress();
  if (!address) {
    const path = await seams.allowancePath();
    return {
      configured: false,
      allowance_path: path,
      hint:
        `No run402 wallet is configured (expected at ${path}). ` +
        `Run \`run402 init\` to create one, then fund it — the create tool pays from that wallet.`,
    };
  }
  const terms = await fetchChallengeTerms(endpoint, seams.fetchFn);
  const balance = await seams.readBalanceAtomic({ network: terms.network, asset: terms.asset, address });
  const price = BigInt(terms.amountAtomic);
  const sufficient = balance >= price;
  const status: WalletStatus = {
    configured: true,
    address,
    network: terms.network,
    asset: terms.asset,
    balance_atomic: balance.toString(),
    price_atomic: terms.amountAtomic,
    sufficient,
    envelopes_affordable: price > 0n ? Number(balance / price) : 0,
  };
  if (terms.assetName) status.asset_name = terms.assetName;
  if (terms.amountUsdMicros !== undefined) status.price_usd_micros = terms.amountUsdMicros;
  if (!sufficient) {
    const short = (price - balance).toString();
    const assetLabel = terms.assetName ?? terms.asset;
    const priceUsd = usd(terms.amountUsdMicros);
    status.fund_hint =
      `Insufficient balance: send at least ${short} atomic units of ${assetLabel} on ${terms.network} ` +
      `to ${address} — one envelope costs ${terms.amountAtomic} atomic units` +
      (priceUsd ? ` (${priceUsd})` : '') +
      `, current balance ${balance.toString()}.`;
  }
  return status;
}

/** RPC endpoints for the networks the run402 x402 rail supports (DD-31). */
const RPC_BY_NETWORK: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:84532': 'https://sepolia.base.org',
};

/**
 * Real seams: the run402 SDK's local allowance (address only) + a viem
 * balanceOf read. Heavy imports stay lazy so plain key-authenticated MCP
 * sessions never load the wallet stack.
 */
export function defaultWalletSeams(): WalletSeams {
  return {
    async readAllowanceAddress() {
      const { NodeCredentialsProvider } = await import('@run402/sdk/node');
      try {
        const allowance = await new NodeCredentialsProvider().readAllowance();
        return allowance?.address ?? null;
      } catch {
        return null; // malformed/unreadable file = not configured (same graceful posture as the SDK)
      }
    },
    async allowancePath() {
      const { NodeCredentialsProvider } = await import('@run402/sdk/node');
      return new NodeCredentialsProvider().getAllowancePath();
    },
    async paidFetchFactory() {
      // The SDK's x402 wrapper over the same allowance wallet (DD-30): signs
      // 402 challenges; null when unconfigured or the payment libs are absent.
      const { setupPaidFetch } = await import('@run402/sdk/node');
      return setupPaidFetch();
    },
    fetchFn: (input, init) => globalThis.fetch(input, init),
    async readBalanceAtomic({ network, asset, address }) {
      const rpc = process.env.KYSIGNED_RPC_URL ?? RPC_BY_NETWORK[network];
      if (!rpc) {
        throw new X402RouteError(
          'bad_challenge',
          `No RPC known for ${network} — set KYSIGNED_RPC_URL to read the wallet balance on that network.`,
        );
      }
      const { createPublicClient, http } = await import('viem');
      const client = createPublicClient({ transport: http(rpc) });
      const raw = await client.readContract({
        address: asset as `0x${string}`,
        abi: [
          {
            name: 'balanceOf',
            type: 'function',
            stateMutability: 'view',
            inputs: [{ name: 'account', type: 'address' }],
            outputs: [{ name: '', type: 'uint256' }],
          },
        ] as const,
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      });
      return raw as bigint;
    },
  };
}
