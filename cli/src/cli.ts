/**
 * `kysigned`: the reference verifier as an installable command (F-47.1, DD-77).
 *
 *   kysigned verify [--offline] [--json] <bundle.pdf>
 *   kysigned --version
 *   kysigned --help
 *
 * Exit codes: 0 = the bundle verifies at a satisfied assurance tier, 1 = FAILED,
 * 2 = a usage or read error. The check runs on this machine and the bundle is never
 * sent anywhere; kysigned is not in the trust set.
 */
import { readFileSync } from 'node:fs';
import { VERSION, verifyBundleBytes } from './index.js';

export const USAGE = `usage: kysigned verify [--offline] [--json] <bundle.pdf>
       kysigned --version
       kysigned --help

Verifies a kysigned evidence bundle on this machine, with math and public keys.
The bundle is never uploaded, and kysigned is not in the trust set.

  --offline  skip the two online indicators (the Bitcoin timestamp anchor and the
             public key archive); they report pending, and the verdict still holds
  --json     print the verdict as one JSON document (schema kysigned.verdict.v1)

exit codes: 0 = verified at a satisfied assurance tier, 1 = FAILED, 2 = usage or read error`;

interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

function usageError(io: Io, message: string): number {
  io.err(`kysigned: ${message}\n\n${USAGE}`);
  return 2;
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) return usageError(io, 'no command given');
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    io.out(VERSION);
    return 0;
  }
  if (command !== 'verify') return usageError(io, `unknown command: ${command}`);

  let offline = false;
  let json = false;
  const files: string[] = [];
  for (const arg of rest) {
    if (arg === '--offline') offline = true;
    else if (arg === '--json') json = true;
    else if (arg.startsWith('-')) return usageError(io, `unknown option: ${arg}`);
    else files.push(arg);
  }
  if (files.length !== 1) return usageError(io, files.length === 0 ? 'verify needs a bundle file' : 'verify takes exactly one bundle file');

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(files[0]!));
  } catch (e) {
    io.err(`kysigned: cannot read ${files[0]}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const outcome = await verifyBundleBytes(bytes, { offline });
  io.out(json ? JSON.stringify(outcome.json, null, 2) : outcome.report);
  return outcome.exitCode;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`kysigned: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  },
);
