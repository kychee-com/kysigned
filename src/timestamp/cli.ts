/**
 * CLI dev/test harness — F-9 / AC-18, AC-19, AC-20.
 *
 * `runCli` is the testable core: it returns `{ code, out, err }` and takes an
 * injectable provider registry + filesystem, so the whole surface is unit-tested
 * offline. `cli-main.ts` is the thin process/bin adapter.
 *
 * Inputs accept a 32-byte hex hash directly, or a file path (hashed with SHA-256).
 * Stamping a file writes a `<file>.tsproof` artifact (mirroring ots' `.ots` UX).
 */
import { createHash } from 'node:crypto';
import { assertHash32 } from './hash.js';
import { serializeProof, deserializeProof } from './proof.js';
import { createFakeProvider } from './fake.js';
import { createOtsProvider } from './ots/provider.js';
import { createRfc3161Provider } from './rfc3161/provider.js';
import type { TimestampProof, TimestampProvider } from './contract.js';

export interface CliFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface CliDeps {
  providers?: Record<string, TimestampProvider>;
  defaultProvider?: string;
  version?: string;
  fs?: CliFs;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

const COMMANDS = ['stamp', 'verify', 'upgrade'] as const;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const encoder = new TextEncoder();

function builtinProviders(): Record<string, TimestampProvider> {
  return { ots: createOtsProvider(), rfc3161: createRfc3161Provider(), fake: createFakeProvider() };
}

function usage(providers: Record<string, TimestampProvider>): string {
  return `timestamp-module — stamp & verify a hash via a TimestampProvider

Usage:
  timestamp [--provider <id>] stamp   <hash-hex | file>
  timestamp [--provider <id>] verify  <proof-json | proof-file> <hash-hex | file>
  timestamp [--provider <id>] upgrade <proof-json | proof-file>
  timestamp --help | --version

Providers: ${Object.keys(providers).join(', ')}
`;
}

function hexToHash(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  assertHash32(out);
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(bytes).digest());
}

/** Resolve a hash argument: a 64-char hex hash, or a file path to hash. */
async function resolveHash(arg: string, fs?: CliFs): Promise<Uint8Array> {
  if (HEX64.test(arg)) return hexToHash(arg);
  if (!fs) throw new Error(`'${arg}' is not a 32-byte hex hash and no filesystem is available`);
  return sha256(await fs.readFile(arg));
}

/** Resolve a proof argument: inline JSON (starts with '{'), or a file path. */
async function resolveProof(arg: string, fs?: CliFs): Promise<TimestampProof> {
  if (arg.trimStart().startsWith('{')) return deserializeProof(arg);
  if (!fs) throw new Error(`'${arg}' is not inline proof JSON and no filesystem is available`);
  return deserializeProof(new TextDecoder().decode(await fs.readFile(arg)));
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  const providers = deps.providers ?? builtinProviders();
  const version = deps.version ?? '0.0.0';
  const fs = deps.fs;
  let provider = deps.defaultProvider ?? 'ots';
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { code: 0, out: usage(providers), err: '' };
    if (a === '--version' || a === '-v') return { code: 0, out: `${version}\n`, err: '' };
    if (a === '--provider' || a === '-p') {
      provider = argv[++i] ?? '';
      continue;
    }
    rest.push(a);
  }

  if (rest.length === 0) return { code: 0, out: usage(providers), err: '' };

  const cmd = rest[0];
  if (!(COMMANDS as readonly string[]).includes(cmd)) {
    return { code: 2, out: '', err: `unknown command: ${cmd}\n` };
  }
  const p = providers[provider];
  if (!p) return { code: 2, out: '', err: `unknown provider: ${provider}\n` };

  try {
    if (cmd === 'stamp') {
      const arg = rest[1] ?? '';
      if (!arg) return { code: 2, out: '', err: 'stamp: missing argument <hash-hex | file>\n' };
      const proof = await p.stamp(await resolveHash(arg, fs));
      const serialized = serializeProof(proof);
      if (HEX64.test(arg)) return { code: 0, out: `${serialized}\n`, err: '' };
      if (!fs) throw new Error('no filesystem available to write the proof');
      const outPath = `${arg}.tsproof`;
      await fs.writeFile(outPath, encoder.encode(serialized));
      return { code: 0, out: `Stamped ${arg} → ${outPath}\n`, err: '' };
    }

    if (cmd === 'verify') {
      if (!rest[1] || !rest[2]) {
        return { code: 2, out: '', err: 'verify: missing argument(s) — usage: verify <proof> <hash-hex | file>\n' };
      }
      const proof = await resolveProof(rest[1], fs);
      const res = await p.verify(proof, await resolveHash(rest[2], fs));
      return {
        code: res.ok ? 0 : 1,
        out: `${JSON.stringify(res)}\n`,
        err: res.ok ? '' : 'verification failed\n',
      };
    }

    // upgrade
    const arg = rest[1] ?? '';
    if (!arg) return { code: 2, out: '', err: 'upgrade: missing argument <proof>\n' };
    const proof = await resolveProof(arg, fs);
    const upgraded = p.upgrade ? await p.upgrade(proof) : proof;
    const serialized = serializeProof(upgraded);
    if (!arg.trimStart().startsWith('{') && fs) {
      await fs.writeFile(arg, encoder.encode(serialized));
      return { code: 0, out: `Upgraded ${arg} (status: ${upgraded.status})\n`, err: '' };
    }
    return { code: 0, out: `${serialized}\n`, err: '' };
  } catch (e) {
    return { code: 2, out: '', err: `${(e as Error).message}\n` };
  }
}
