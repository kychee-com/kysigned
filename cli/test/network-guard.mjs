// Network guard for the local-verification tests (plan 83.2, F-47.5, AC-303). Preloaded
// with `node --import`, it records every network attempt the process makes (fetch,
// raw sockets, DNS, http/https/tls) as one JSON line in the file named by
// KYSIGNED_NETLOG, and fails each one, so a test sees exactly where the verifier would
// reach and what it would send, with no real traffic.
import { appendFileSync } from 'node:fs';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const LOG = process.env.KYSIGNED_NETLOG;
const record = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};

globalThis.fetch = async (input, init = {}) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : Buffer.alloc(0);
  record({ kind: 'fetch', url: req.url, method: req.method, bodyLength: body.length, bodyBase64: body.toString('base64') });
  throw new TypeError('fetch failed (network guard)');
};

const blocked = (kind, detail) => {
  record({ kind, detail: String(detail).slice(0, 200) });
  return new Error(`${kind} blocked (network guard)`);
};

net.Socket.prototype.connect = function connect(...args) {
  throw blocked('socket', JSON.stringify(args[0] ?? null));
};
tls.connect = (...args) => {
  throw blocked('tls', JSON.stringify(args[0] ?? null));
};
for (const mod of [http, https]) {
  mod.request = (...args) => {
    throw blocked('http', String(args[0]?.href ?? args[0]?.host ?? args[0]));
  };
  mod.get = mod.request;
}

const DNS_FNS = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveMx', 'resolveCname', 'resolveAny', 'resolveNs'];
for (const name of DNS_FNS) {
  dns[name] = (host, ...rest) => {
    const cb = rest.find((a) => typeof a === 'function');
    const err = blocked('dns', `${name} ${host}`);
    if (cb) process.nextTick(() => cb(err));
    else throw err;
  };
  if (dns.promises[name]) {
    dns.promises[name] = async (host) => {
      throw blocked('dns', `promises.${name} ${host}`);
    };
  }
}
