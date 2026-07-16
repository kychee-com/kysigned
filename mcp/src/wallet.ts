/**
 * wallet — F-30.5/F-30.6 (spec 0.47.0, #132/#151/#152/#153): the MCP wallet
 * foundation.
 *
 * Custody (DD-30): the payer is host-local run402 wallet state; this module
 * exposes ONLY addresses — a private key is never a tool argument, never part
 * of any result, and never leaves the SDK's own signing path.
 *
 * Payer sources (F-30.6, #151 — the Run402 4.7+ explicit-source contract):
 * resolved EXACTLY ONCE per process, precedence order
 *   1. explicit allowance file (`KYSIGNED_RUN402_ALLOWANCE_PATH`),
 *   2. an opaque async signer/provider injected through the server
 *      construction seam (KMS/HSM/secret-broker deployments),
 *   3. the ambient host-local run402 allowance (`run402 init`) — only when
 *      no explicit source is configured.
 * Conflicting or unavailable EXPLICIT sources fail closed (stable codes,
 * never an ambient fallback). Readiness and payment share the one resolved
 * source: the address whose balance is checked is the address that signs.
 *
 * Readiness resilience (F-30.6, #152): balance reads run against independent
 * RPC providers with bounded retry + failover — the kysigned-side equivalent
 * of the Run402 4.7 balance contract (same provider lists). Provider
 * exhaustion is a structured balance-unknown error (`retryable`,
 * `mutation_state: not_started`), NEVER zero and NEVER insufficient-funds.
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

// ── payer sources (F-30.6, #151) ─────────────────────────────────────────────

export type PayerSourceKind = 'allowance_path' | 'payment_signer' | 'default_allowance';

/**
 * Minimum shape of the SDK's opaque signer provider we depend on — kept
 * structural so embedders don't need our exact @run402/sdk type identity.
 */
export interface OpaqueSignerProvider {
  getSigner(context: {
    network: string;
    publicClient: { readContract(args: unknown): Promise<bigint> };
  }): Promise<{ address: string } | null>;
}

export interface PayerSourceConfig {
  /** Explicit allowance file path (KYSIGNED_RUN402_ALLOWANCE_PATH). */
  allowancePath?: string;
  /** Opaque async signer/provider injected via the server construction seam. */
  paymentSigner?: OpaqueSignerProvider;
}

/** Fail-closed payer-source configuration failure (stable machine codes). */
export class PayerConfigError extends Error {
  readonly code: 'payer_source_conflict' | 'payer_source_unavailable';
  readonly next_actions: Array<Record<string, unknown>>;
  constructor(code: PayerConfigError['code'], message: string, nextActions: Array<Record<string, unknown>> = []) {
    super(message);
    this.name = 'PayerConfigError';
    this.code = code;
    this.next_actions = nextActions;
  }
}

/** Resolve which payer source is configured. Throws on conflicts (fail closed). */
export function resolvePayerSourceKind(config: PayerSourceConfig): PayerSourceKind {
  if (config.allowancePath && config.paymentSigner) {
    throw new PayerConfigError(
      'payer_source_conflict',
      'Both an explicit allowance path (KYSIGNED_RUN402_ALLOWANCE_PATH) and an injected payment signer are configured — they are mutually exclusive. Remove one; there is no fallback between explicit sources.',
      [{ type: 'fix_config', why: 'unset KYSIGNED_RUN402_ALLOWANCE_PATH or construct the server without paymentSigner' }],
    );
  }
  if (config.allowancePath) return 'allowance_path';
  if (config.paymentSigner) return 'payment_signer';
  return 'default_allowance';
}

// ── resilient balance reads (F-30.6, #152) ───────────────────────────────────

/**
 * Independent public RPC providers per network — the same lists the Run402
 * 4.7+ SDK payment stack uses, so readiness and payment see the same chain
 * truth. `KYSIGNED_RPC_URL` (advanced override) is PREPENDED, never the sole
 * provider.
 */
export const RPCS_BY_NETWORK: Record<string, string[]> = {
  'eip155:8453': ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://1rpc.io/base'],
  'eip155:84532': ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com', 'https://base-sepolia.drpc.org'],
};

/**
 * All providers exhausted — the balance is UNKNOWN. This is deliberately a
 * distinct type from an insufficient-funds outcome: an exhausted RPC check is
 * never represented as a zero balance (#152 / AC-171).
 */
export class BalanceUnknownError extends Error {
  readonly code = 'balance_unknown_provider_exhausted';
  readonly retryable = true;
  readonly safe_to_retry = true;
  readonly mutation_state = 'not_started';
  /** Sanitized per-provider diagnostics: host + error class only. */
  readonly providers: Array<{ provider: string; error: string }>;
  constructor(network: string, providers: Array<{ provider: string; error: string }>) {
    super(
      `Could not read the wallet balance on ${network}: every RPC provider failed (${providers.length} tried). ` +
        `The balance is UNKNOWN — this is NOT an insufficient-funds result and no payment was dispatched. Safe to retry.`,
    );
    this.name = 'BalanceUnknownError';
    this.providers = providers;
  }
}

interface BalanceClient {
  readContract(args: unknown): Promise<unknown>;
}

export interface ResilientBalanceOptions {
  rpcs?: string[];
  attemptsPerProvider?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: client per RPC url (defaults to a viem public client). */
  clientFor?: (rpcUrl: string) => Promise<BalanceClient>;
}

function sanitizeProvider(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return 'invalid-url';
  }
}

async function defaultClientFor(rpcUrl: string): Promise<BalanceClient> {
  const { createPublicClient, http } = await import('viem');
  // retryCount 0: OUR loop owns retry/failover; viem's built-in retries would
  // multiply attempts and stretch the failure window.
  return createPublicClient({ transport: http(rpcUrl, { timeout: 4_000, retryCount: 0 }) }) as BalanceClient;
}

/**
 * ERC-20 balanceOf with bounded retry per provider and independent-provider
 * failover (#152 / AC-171). Returns the balance on the FIRST successful read;
 * throws BalanceUnknownError only when every provider is exhausted. A
 * successful read of a low balance is a normal return — callers compare.
 */
export async function readBalanceResilient(
  q: { network: string; asset: string; address: string },
  options: ResilientBalanceOptions = {},
): Promise<bigint> {
  const override = process.env.KYSIGNED_RPC_URL;
  const defaults = RPCS_BY_NETWORK[q.network] ?? [];
  const rpcs = options.rpcs ?? (override ? [override, ...defaults] : defaults);
  if (rpcs.length === 0) {
    throw new X402RouteError(
      'bad_challenge',
      `No RPC known for ${q.network} — set KYSIGNED_RPC_URL to read the wallet balance on that network.`,
    );
  }
  const attemptsPerProvider = options.attemptsPerProvider ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const clientFor = options.clientFor ?? defaultClientFor;

  const failures: Array<{ provider: string; error: string }> = [];
  for (const rpcUrl of rpcs) {
    for (let attempt = 0; attempt < attemptsPerProvider; attempt++) {
      try {
        const client = await clientFor(rpcUrl);
        const raw = await client.readContract({
          address: q.asset as `0x${string}`,
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
          args: [q.address as `0x${string}`],
        });
        return raw as bigint;
      } catch (err) {
        failures.push({
          provider: sanitizeProvider(rpcUrl),
          error: err instanceof Error ? err.name || 'Error' : 'Error',
        });
        if (attempt < attemptsPerProvider - 1) await sleep(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw new BalanceUnknownError(q.network, failures);
}

// ── QR-ready funding actions (F-30.6, #153) ──────────────────────────────────

/** Known token metadata for human-decimal display; atomic math never needs it. */
export const KNOWN_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  // USDC on Base mainnet / Base Sepolia.
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6 },
};

export const NETWORK_LABELS: Record<string, string> = {
  'eip155:8453': 'Base mainnet',
  'eip155:84532': 'Base Sepolia',
};

/** Exact atomic→decimal string via BigInt math — no floating point ever (AC-172). */
export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals > 0 ? `.${frac.toString().padStart(decimals, '0')}`.replace(/\.?0+$/, '') : '';
  return `${negative ? '-' : ''}${whole.toString()}${fracStr === '.' ? '' : fracStr}`;
}

/** ERC-681 token-transfer URI: ethereum:<token>@<chainId>/transfer?address=<dest>&uint256=<atomic>. */
export function erc681TransferUri(tokenContract: string, caip2Network: string, destination: string, amountAtomic: bigint): string {
  const chainId = caip2Network.startsWith('eip155:') ? caip2Network.slice('eip155:'.length) : caip2Network;
  return `ethereum:${tokenContract}@${chainId}/transfer?address=${destination}&uint256=${amountAtomic.toString()}`;
}

export interface FundWalletAction {
  type: 'fund_wallet';
  address: string;
  network: string;
  network_label?: string;
  token_contract: string;
  token_symbol?: string;
  token_decimals?: number;
  balance_atomic: string;
  price_atomic: string;
  shortfall_atomic: string;
  balance_decimal?: string;
  price_decimal?: string;
  shortfall_decimal?: string;
  /** ERC-681 payment URI for EXACTLY the shortfall — render it as a QR code. */
  payment_uri: string;
  instruction: string;
  retry: { tool: string; note: string };
}

/** Build the structured, QR-ready funding action for an underfunded payer (AC-172). */
export function buildFundWalletAction(args: {
  terms: ChallengeTerms;
  address: string;
  balance: bigint;
  retry: { tool: string; note: string };
}): FundWalletAction {
  const { terms, address, balance, retry } = args;
  const price = BigInt(terms.amountAtomic);
  const shortfall = price > balance ? price - balance : 0n;
  const token = KNOWN_TOKENS[terms.asset.toLowerCase()];
  const label = NETWORK_LABELS[terms.network];
  const symbol = token?.symbol ?? terms.assetName;
  const action: FundWalletAction = {
    type: 'fund_wallet',
    address,
    network: terms.network,
    token_contract: terms.asset,
    balance_atomic: balance.toString(),
    price_atomic: terms.amountAtomic,
    shortfall_atomic: shortfall.toString(),
    payment_uri: erc681TransferUri(terms.asset, terms.network, address, shortfall),
    instruction:
      `Send at least ${token ? atomicToDecimal(shortfall, token.decimals) : shortfall.toString() + ' atomic units of'} ` +
      `${symbol ?? terms.asset} on ${label ?? terms.network} to ${address}. ` +
      `${symbol ?? 'This token'} on ${label ?? terms.network} ONLY — other tokens or networks will not arrive.`,
    retry,
  };
  if (label) action.network_label = label;
  if (token) {
    action.token_symbol = token.symbol;
    action.token_decimals = token.decimals;
    action.balance_decimal = atomicToDecimal(balance, token.decimals);
    action.price_decimal = atomicToDecimal(price, token.decimals);
    action.shortfall_decimal = atomicToDecimal(shortfall, token.decimals);
  } else if (symbol) {
    action.token_symbol = symbol;
  }
  return action;
}

// ── seams + status ───────────────────────────────────────────────────────────

export interface PayerPresence {
  configured: boolean;
  sourceKind: PayerSourceKind;
  /** Where the (explicit or default) allowance lives — for guidance messages. */
  allowancePath: string;
}

export interface WalletSeams {
  /**
   * Cheap presence probe of the ONE resolved payer source. Never constructs
   * the paid stack (a replayed intent must never pay or load payment libs).
   * Throws PayerConfigError on conflicting/unavailable EXPLICIT sources.
   */
  payerPresence(): Promise<PayerPresence>;
  /**
   * The resolved payer's public address for `network` — the allowance file's
   * address, or the opaque signer's address for that chain. Null = the source
   * has no payer for that network. NEVER key material.
   */
  payerAddress(network: string): Promise<string | null>;
  /** Fetch used for the unpaid challenge probe and the free preflight. */
  fetchFn: typeof fetch;
  /**
   * On-chain ERC-20 balance in atomic units — resilient (bounded retry +
   * independent-provider failover). Throws BalanceUnknownError on exhaustion.
   */
  readBalanceAtomic(q: { network: string; asset: string; address: string }): Promise<bigint>;
  /**
   * The x402-paying fetch over the SAME resolved payer source (signs and
   * retries 402 challenges). Null when no payer is configured or the payment
   * stack is unavailable — callers must treat null as "cannot pay", never
   * fall back to an unpaid fetch for the paid call.
   */
  paidFetchFactory(): Promise<typeof fetch | null>;
}

export type WalletStatus =
  | { configured: false; payer_source: PayerSourceKind; allowance_path: string; hint: string }
  | {
      configured: true;
      payer_source: PayerSourceKind;
      address: string;
      network: string;
      asset: string;
      asset_name?: string;
      price_atomic: string;
      price_usd_micros?: number;
      balance_status: 'unknown';
      balance_error: {
        code: string;
        retryable: true;
        safe_to_retry: true;
        mutation_state: 'not_started';
        providers: Array<{ provider: string; error: string }>;
      };
      hint: string;
    }
  | {
      configured: true;
      payer_source: PayerSourceKind;
      address: string;
      network: string;
      asset: string;
      asset_name?: string;
      balance_status: 'known';
      balance_atomic: string;
      price_atomic: string;
      price_usd_micros?: number;
      sufficient: boolean;
      envelopes_affordable: number;
      fund_hint?: string;
      next_actions?: [FundWalletAction];
    };

function usd(micros: number | undefined): string | undefined {
  return micros === undefined ? undefined : `$${(micros / 1_000_000).toFixed(2)}`;
}

/**
 * AC-145/AC-170/AC-171/AC-172 — the readiness facts: payer provenance, terms,
 * balance, coverage, and a QR-ready funding action when short. Never spends,
 * never initiates an on-chain transaction.
 */
export async function getWalletStatus(endpoint: string, seams: WalletSeams): Promise<WalletStatus> {
  const presence = await seams.payerPresence();
  if (!presence.configured) {
    return {
      configured: false,
      payer_source: presence.sourceKind,
      allowance_path: presence.allowancePath,
      hint:
        `No run402 payer is configured (allowance expected at ${presence.allowancePath}). ` +
        `Run \`run402 init\` to create one, point KYSIGNED_RUN402_ALLOWANCE_PATH at an explicit allowance file, ` +
        `or (embedders) inject an opaque payment signer — the create tool pays from that payer.`,
    };
  }
  const terms = await fetchChallengeTerms(endpoint, seams.fetchFn);
  const address = await seams.payerAddress(terms.network);
  if (!address) {
    return {
      configured: false,
      payer_source: presence.sourceKind,
      allowance_path: presence.allowancePath,
      hint: `The configured payer source (${presence.sourceKind}) has no payer for ${terms.network} — the priced route settles there.`,
    };
  }
  let balance: bigint;
  try {
    balance = await seams.readBalanceAtomic({ network: terms.network, asset: terms.asset, address });
  } catch (err) {
    if (err instanceof BalanceUnknownError) {
      const status: WalletStatus = {
        configured: true,
        payer_source: presence.sourceKind,
        address,
        network: terms.network,
        asset: terms.asset,
        price_atomic: terms.amountAtomic,
        balance_status: 'unknown',
        balance_error: {
          code: err.code,
          retryable: err.retryable,
          safe_to_retry: err.safe_to_retry,
          mutation_state: err.mutation_state,
          providers: err.providers,
        },
        hint:
          'Every RPC provider failed — the balance is UNKNOWN (this is NOT an insufficient-funds result and ' +
          'nothing was dispatched). Retry wallet_status; if it persists, set KYSIGNED_RPC_URL to a private RPC.',
      };
      if (terms.assetName) status.asset_name = terms.assetName;
      if (terms.amountUsdMicros !== undefined) status.price_usd_micros = terms.amountUsdMicros;
      return status;
    }
    throw err;
  }
  const price = BigInt(terms.amountAtomic);
  const sufficient = balance >= price;
  const status: WalletStatus = {
    configured: true,
    payer_source: presence.sourceKind,
    address,
    network: terms.network,
    asset: terms.asset,
    balance_status: 'known',
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
    status.next_actions = [
      buildFundWalletAction({
        terms,
        address,
        balance,
        retry: { tool: 'wallet_status', note: 'Re-check readiness after funding; then create_envelope_x402.' },
      }),
    ];
  }
  return status;
}

/**
 * Real seams over the ONE resolved payer source (F-30.6). Heavy imports stay
 * lazy so plain key-authenticated MCP sessions never load the wallet stack;
 * the source RESOLUTION (kind + conflict validation) happens exactly once.
 */
export function defaultWalletSeams(config: PayerSourceConfig = {}): WalletSeams {
  const resolved: PayerSourceConfig = {
    allowancePath: config.allowancePath ?? process.env.KYSIGNED_RUN402_ALLOWANCE_PATH ?? undefined,
    paymentSigner: config.paymentSigner,
  };
  // Fail closed NOW if the configuration is contradictory (throws).
  const sourceKind = resolvePayerSourceKind(resolved);

  async function readExplicitOrDefaultAllowance(): Promise<{ address: string } | null> {
    const { NodeCredentialsProvider } = await import('@run402/sdk/node');
    try {
      const provider = resolved.allowancePath
        ? new NodeCredentialsProvider({ allowancePath: resolved.allowancePath })
        : new NodeCredentialsProvider();
      const allowance = await provider.readAllowance();
      return allowance?.address ? { address: allowance.address } : null;
    } catch {
      return null; // malformed/unreadable = not present; explicit-source callers escalate below
    }
  }

  async function allowanceGuidancePath(): Promise<string> {
    if (resolved.allowancePath) return resolved.allowancePath;
    const { NodeCredentialsProvider } = await import('@run402/sdk/node');
    return new NodeCredentialsProvider().getAllowancePath();
  }

  return {
    async payerPresence() {
      const allowancePath = await allowanceGuidancePath();
      if (sourceKind === 'payment_signer') {
        return { configured: true, sourceKind, allowancePath };
      }
      const allowance = await readExplicitOrDefaultAllowance();
      if (!allowance && sourceKind === 'allowance_path') {
        // AC-170: an EXPLICIT source that cannot be read fails closed — never
        // silently falls back to the ambient allowance.
        throw new PayerConfigError(
          'payer_source_unavailable',
          `KYSIGNED_RUN402_ALLOWANCE_PATH points at ${resolved.allowancePath} but no readable allowance is there. ` +
            `Refusing to fall back to the ambient wallet. Fix the path or unset the variable.`,
          [{ type: 'fix_config', why: 'point KYSIGNED_RUN402_ALLOWANCE_PATH at a readable run402 allowance file, or unset it' }],
        );
      }
      return { configured: allowance !== null, sourceKind, allowancePath };
    },
    async payerAddress(network: string) {
      if (sourceKind === 'payment_signer') {
        const provider = resolved.paymentSigner!;
        const rpcs = RPCS_BY_NETWORK[network] ?? [];
        const publicClient: { readContract(args: unknown): Promise<bigint> } = {
          readContract: async (args: unknown) => {
            const client = await defaultClientFor(rpcs[0] ?? '');
            return (await client.readContract(args)) as bigint;
          },
        };
        const signer = await provider.getSigner({ network, publicClient });
        return signer?.address ?? null;
      }
      const allowance = await readExplicitOrDefaultAllowance();
      return allowance?.address ?? null;
    },
    fetchFn: (input, init) => globalThis.fetch(input, init),
    async readBalanceAtomic(q) {
      return readBalanceResilient(q);
    },
    async paidFetchFactory() {
      // The SDK's x402 wrapper over the SAME resolved source (DD-30 + #151):
      // explicit options are threaded verbatim; the SDK guarantees no silent
      // fallback once an explicit source is set.
      const { setupPaidFetch } = await import('@run402/sdk/node');
      const options = resolved.allowancePath
        ? { allowancePath: resolved.allowancePath }
        : resolved.paymentSigner
          ? { paymentSigner: resolved.paymentSigner }
          : {};
      let paid: (typeof fetch & { payer?: unknown }) | null;
      try {
        paid = (await setupPaidFetch(options as never)) as (typeof fetch & { payer?: unknown }) | null;
      } catch (err) {
        if (sourceKind !== 'default_allowance') {
          throw new PayerConfigError(
            'payer_source_unavailable',
            `The explicit payer source (${sourceKind}) failed to initialize: ${err instanceof Error ? err.message : String(err)}. ` +
              `Refusing to fall back to the ambient wallet.`,
          );
        }
        return null;
      }
      if (!paid && sourceKind !== 'default_allowance') {
        throw new PayerConfigError(
          'payer_source_unavailable',
          `The explicit payer source (${sourceKind}) resolved to no usable payer. Refusing to fall back to the ambient wallet.`,
        );
      }
      return paid;
    },
  };
}
