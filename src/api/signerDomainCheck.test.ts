/**
 * signerDomainCheck tests (F-3.9 / #113, DD-86; AC-311, AC-313).
 *
 * Every lookup goes to an injected FAKE resolver: no test here ever reaches
 * real DNS. The fake answers per `<method> <host>` with a value, a DNS error
 * code, a synchronous throw, or a lookup that never settles (until cancelled).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkSignerDomains,
  checkOneDomain,
  normalizeDomain,
  DOMAIN_CHECK_BUDGET_MS,
  type DomainResolver,
  type DomainCheckDeps,
} from './signerDomainCheck.js';
import { withCreateIdempotency } from './idempotentCreate.js';
import type { DbPool } from '../db/pool.js';

type Method = 'resolveMx' | 'resolve4' | 'resolve6' | 'resolveTxt';
type Answer = { value: unknown } | { code: string } | 'hang' | 'throw';

function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

interface FakeResolver extends DomainResolver {
  calls: Array<{ method: Method; host: string }>;
  cancelled: number;
}

/** answers: `<method> <host>` → Answer. Unlisted lookups answer ENODATA. */
function fakeResolver(answers: Record<string, Answer>): FakeResolver {
  const calls: Array<{ method: Method; host: string }> = [];
  const hanging: Array<(e: Error) => void> = [];
  const r: FakeResolver = {
    calls,
    cancelled: 0,
    cancel() {
      r.cancelled += 1;
      for (const reject of hanging.splice(0)) reject(dnsError('ECANCELLED'));
    },
  } as FakeResolver;
  for (const method of ['resolveMx', 'resolve4', 'resolve6', 'resolveTxt'] as Method[]) {
    (r as unknown as Record<string, unknown>)[method] = (host: string) => {
      calls.push({ method, host });
      const a = answers[`${method} ${host}`] ?? { code: 'ENODATA' };
      if (a === 'throw') throw new Error('resolver exploded synchronously');
      if (a === 'hang') return new Promise((_res, rej) => hanging.push(rej));
      if ('code' in a) return Promise.reject(dnsError(a.code));
      return Promise.resolve(a.value);
    };
  }
  return r;
}

/** A well-configured domain: MX, SPF and DMARC all present. */
function healthy(domain: string): Record<string, Answer> {
  return {
    [`resolveMx ${domain}`]: { value: [{ exchange: `mx.${domain}`, priority: 10 }] },
    [`resolve4 ${domain}`]: { value: ['192.0.2.1'] },
    [`resolveTxt ${domain}`]: { value: [['v=spf1 include:_spf.', domain, ' ~all']] },
    [`resolveTxt _dmarc.${domain}`]: { value: [['v=DMARC1; p=none']] },
  };
}

/** A fake clock: the budget timer fires only when the test says so. */
function fakeClock() {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
    fire() {
      for (const t of timers) if (!t.cleared) t.fn();
    },
  };
}

function deps(resolver: DomainResolver, extra: Partial<DomainCheckDeps> = {}): DomainCheckDeps {
  return { createResolver: () => resolver, ...extra };
}

async function warningsFor(email: string, answers: Record<string, Answer>): Promise<string[]> {
  const out = await checkSignerDomains([email], deps(fakeResolver(answers)));
  return out.find((e) => e.email === email)?.warnings ?? [];
}

describe('F-3.9 signerDomainCheck — cannot receive', () => {
  it('a null MX (exchange "") cannot receive', async () => {
    assert.deepEqual(
      await warningsFor('a@nullmx.test', { 'resolveMx nullmx.test': { value: [{ exchange: '', priority: 0 }] } }),
      ['cannot_receive'],
    );
  });
  it('a null MX written as "." cannot receive', async () => {
    assert.deepEqual(
      await warningsFor('a@nullmx.test', { 'resolveMx nullmx.test': { value: [{ exchange: '.', priority: 0 }] } }),
      ['cannot_receive'],
    );
  });
  it('a domain that does not exist (ENOTFOUND everywhere) cannot receive', async () => {
    const nx: Record<string, Answer> = {};
    for (const m of ['resolveMx', 'resolve4', 'resolve6', 'resolveTxt']) nx[`${m} nope.test`] = { code: 'ENOTFOUND' };
    nx['resolveTxt _dmarc.nope.test'] = { code: 'ENOTFOUND' };
    assert.deepEqual(await warningsFor('a@nope.test', nx), ['cannot_receive']);
  });
  it('no MX and no A/AAAA cannot receive', async () => {
    assert.deepEqual(await warningsFor('a@bare.test', {}), ['cannot_receive']);
  });
  it('no MX but an A record CAN receive (the implicit MX fallback)', async () => {
    const w = await warningsFor('a@ahost.test', {
      'resolve4 ahost.test': { value: ['192.0.2.7'] },
      'resolveTxt ahost.test': { value: [['v=spf1 -all']] },
    });
    assert.ok(!w.includes('cannot_receive'));
  });
  it('no MX but an AAAA record CAN receive', async () => {
    const w = await warningsFor('a@six.test', {
      'resolve6 six.test': { value: ['2001:db8::1'] },
      'resolveTxt six.test': { value: [['v=spf1 -all']] },
    });
    assert.ok(!w.includes('cannot_receive'));
  });
  it('cannot-receive suppresses the other two warnings (a disposable null-MX domain gets cannot_receive only)', async () => {
    assert.deepEqual(
      await warningsFor('a@mailinator.com', { 'resolveMx mailinator.com': { value: [{ exchange: '', priority: 0 }] } }),
      ['cannot_receive'],
    );
  });
});

describe('F-3.9 signerDomainCheck — disposable and no sender protection', () => {
  it('a disposable domain is warned without needing any lookup answer', async () => {
    const r = fakeResolver({ ...healthy('mailinator.com') });
    const out = await checkSignerDomains(['x@mailinator.com'], deps(r));
    assert.deepEqual(out, [{ email: 'x@mailinator.com', warnings: ['disposable'] }]);
  });
  it('neither SPF nor DMARC → no_sender_protection', async () => {
    assert.deepEqual(
      await warningsFor('a@small.test', {
        'resolveMx small.test': { value: [{ exchange: 'mx.small.test', priority: 5 }] },
        'resolveTxt small.test': { value: [['google-site-verification=abc']] },
        'resolveTxt _dmarc.small.test': { code: 'ENOTFOUND' },
      }),
      ['no_sender_protection'],
    );
  });
  it('SPF alone is enough protection', async () => {
    assert.deepEqual(
      await warningsFor('a@spf.test', {
        'resolveMx spf.test': { value: [{ exchange: 'mx.spf.test', priority: 5 }] },
        'resolveTxt spf.test': { value: [['v=spf1 -all']] },
      }),
      [],
    );
  });
  it('DMARC alone is enough protection', async () => {
    assert.deepEqual(
      await warningsFor('a@dmarc.test', {
        'resolveMx dmarc.test': { value: [{ exchange: 'mx.dmarc.test', priority: 5 }] },
        'resolveTxt _dmarc.dmarc.test': { value: [['v=DMARC1; p=reject']] },
      }),
      [],
    );
  });
  it('SPF / DMARC tags match case-insensitively and multi-string TXT records are joined', async () => {
    assert.deepEqual(
      await warningsFor('a@case.test', {
        'resolveMx case.test': { value: [{ exchange: 'mx.case.test', priority: 5 }] },
        'resolveTxt case.test': { value: [['V=SP', 'F1 include:x ~all']] },
      }),
      [],
    );
    assert.deepEqual(
      await warningsFor('a@case2.test', {
        'resolveMx case2.test': { value: [{ exchange: 'mx.case2.test', priority: 5 }] },
        'resolveTxt _dmarc.case2.test': { value: [['v=dmarc1', '; p=none']] },
      }),
      [],
    );
  });
  it('a well-configured (gmail-like) domain gives no warnings and no entry', async () => {
    const out = await checkSignerDomains(['someone@gmail.test'], deps(fakeResolver(healthy('gmail.test'))));
    assert.deepEqual(out, []);
  });
});

describe('F-3.9 signerDomainCheck — mixed outcomes never invent a warning', () => {
  it('MX has no data and the A lookup errors → no cannot_receive', async () => {
    const w = await warningsFor('a@mixed.test', {
      'resolve4 mixed.test': { code: 'ESERVFAIL' },
      'resolveTxt mixed.test': { value: [['v=spf1 -all']] },
    });
    assert.deepEqual(w, []);
  });
  it('MX has no data and the AAAA lookup errors → no cannot_receive', async () => {
    const w = await warningsFor('a@mixed6.test', {
      'resolve6 mixed6.test': { code: 'ETIMEOUT' },
      'resolveTxt mixed6.test': { value: [['v=spf1 -all']] },
    });
    assert.deepEqual(w, []);
  });
  it('SPF definitely absent but the _dmarc lookup errors → no notice', async () => {
    const w = await warningsFor('a@half.test', {
      'resolveMx half.test': { value: [{ exchange: 'mx.half.test', priority: 5 }] },
      'resolveTxt _dmarc.half.test': { code: 'ESERVFAIL' },
    });
    assert.deepEqual(w, []);
  });
  it('DMARC definitely absent but the SPF lookup errors → no notice (the reverse)', async () => {
    const w = await warningsFor('a@half2.test', {
      'resolveMx half2.test': { value: [{ exchange: 'mx.half2.test', priority: 5 }] },
      'resolveTxt half2.test': { code: 'ETIMEOUT' },
      'resolveTxt _dmarc.half2.test': { code: 'ENOTFOUND' },
    });
    assert.deepEqual(w, []);
  });
  it('SPF definitely absent but the _dmarc lookup is still open at the budget → no notice', async () => {
    const clock = fakeClock();
    const r = fakeResolver({
      'resolveMx open.test': { value: [{ exchange: 'mx.open.test', priority: 5 }] },
      'resolveTxt _dmarc.open.test': 'hang',
    });
    const p = checkSignerDomains(['a@open.test'], deps(r, clock));
    await new Promise((res) => setImmediate(res));
    clock.fire();
    assert.deepEqual(await p, []);
  });
  it('a resolver that throws synchronously → no warnings, and the check still resolves', async () => {
    const r = fakeResolver({ 'resolveMx boom.test': 'throw', 'resolve4 boom.test': 'throw', 'resolveTxt boom.test': 'throw' });
    assert.deepEqual(await checkSignerDomains(['a@boom.test'], deps(r)), []);
  });
  it('a resolver factory that throws → no DNS warnings, disposable still given', async () => {
    const out = await checkSignerDomains(['a@mailinator.com', 'b@fine.test'], {
      createResolver: () => {
        throw new Error('no resolver');
      },
    });
    assert.deepEqual(out, [{ email: 'a@mailinator.com', warnings: ['disposable'] }]);
  });
});

describe('F-3.9 signerDomainCheck — per domain, ASCII form, parallel, bounded', () => {
  it('one lookup set per distinct domain, however many signers share it', async () => {
    const r = fakeResolver({ ...healthy('acme.test') });
    await checkSignerDomains(['a@acme.test', 'b@ACME.test', 'c@acme.test'], deps(r));
    assert.equal(r.calls.filter((c) => c.method === 'resolveMx').length, 1);
    assert.equal(r.calls.length, 5); // MX, A, AAAA, TXT, _dmarc TXT
  });
  it('a non-ASCII domain is checked in its ASCII (punycode) form', async () => {
    const r = fakeResolver({});
    await checkSignerDomains(['a@bücher.test'], deps(r));
    const hosts = new Set(r.calls.map((c) => c.host));
    assert.ok(hosts.has('xn--bcher-kva.test'));
    assert.ok(hosts.has('_dmarc.xn--bcher-kva.test'));
    assert.ok(![...hosts].some((h) => /ü/.test(h)));
  });
  it('a malformed address is not looked up', async () => {
    const r = fakeResolver({});
    assert.deepEqual(await checkSignerDomains(['not-an-address', 'a@', '@x.test'], deps(r)), []);
    assert.equal(r.calls.length, 0);
  });
  it('all lookups start in parallel, and those open at the budget are cancelled', async () => {
    const clock = fakeClock();
    const answers: Record<string, Answer> = {};
    for (const d of ['p1.test', 'p2.test']) {
      for (const m of ['resolveMx', 'resolve4', 'resolve6', 'resolveTxt']) answers[`${m} ${d}`] = 'hang';
      answers[`resolveTxt _dmarc.${d}`] = 'hang';
    }
    const r = fakeResolver(answers);
    const p = checkSignerDomains(['a@p1.test', 'b@p2.test'], deps(r, clock));
    // Every lookup has been STARTED before any answered (none ever will).
    assert.equal(r.calls.length, 10);
    assert.equal(r.cancelled, 0);
    clock.fire();
    assert.deepEqual(await p, []);
    assert.equal(r.cancelled, 1);
  });
  it('normalizeDomain accepts a valid domain (ASCII form) and refuses a non-domain', () => {
    assert.equal(normalizeDomain('Gmail.COM'), 'gmail.com');
    assert.equal(normalizeDomain('bücher.test'), 'xn--bcher-kva.test');
    for (const bad of ['', 'localhost', 'a b.com', 'x@y.com', '-x.com', '..', 'com.', '1.2.3.4', 42, undefined]) {
      assert.equal(normalizeDomain(bad as never), null, String(bad));
    }
  });
  it('checkOneDomain refuses a non-domain without any lookup', async () => {
    const r = fakeResolver({});
    assert.deepEqual(await checkOneDomain('not a domain', deps(r)), []);
    assert.equal(r.calls.length, 0);
  });
  it('checkOneDomain answers for one domain', async () => {
    assert.deepEqual(await checkOneDomain('bare.test', deps(fakeResolver({}))), ['cannot_receive']);
  });
});

describe('F-3.9 — the spec-named AC-313 unit tests', () => {
  it('F-3.9 a DNS error or timeout gives no DNS-based warning', async () => {
    // SERVFAIL everywhere, ETIMEOUT everywhere, and lookups that never settle:
    // none may yield cannot_receive or no_sender_protection.
    for (const failure of [{ code: 'ESERVFAIL' }, { code: 'ETIMEOUT' }, 'hang'] as Answer[]) {
      const clock = fakeClock();
      const answers: Record<string, Answer> = {};
      for (const d of ['broken.test', 'mailinator.com']) {
        for (const m of ['resolveMx', 'resolve4', 'resolve6', 'resolveTxt']) answers[`${m} ${d}`] = failure;
        answers[`resolveTxt _dmarc.${d}`] = failure;
      }
      const p = checkSignerDomains(['a@broken.test', 'b@mailinator.com'], deps(fakeResolver(answers), clock));
      await new Promise((res) => setImmediate(res));
      clock.fire();
      // The disposable warning needs no lookup and is still given.
      assert.deepEqual(await p, [{ email: 'b@mailinator.com', warnings: ['disposable'] }], JSON.stringify(failure));
    }
  });

  it('F-3.9 the check adds at most 2 seconds', async () => {
    assert.equal(DOMAIN_CHECK_BUDGET_MS, 2000);
    const clock = fakeClock();
    const answers: Record<string, Answer> = {};
    const emails: string[] = [];
    for (let i = 0; i < 20; i++) {
      const d = `slow${i}.test`;
      emails.push(`s${i}@${d}`);
      for (const m of ['resolveMx', 'resolve4', 'resolve6', 'resolveTxt']) answers[`${m} ${d}`] = 'hang';
      answers[`resolveTxt _dmarc.${d}`] = 'hang';
    }
    const r = fakeResolver(answers);
    let settled = false;
    const p = checkSignerDomains(emails, deps(r, clock)).then((v) => {
      settled = true;
      return v;
    });
    // ONE budget for the whole request, not one per signer or per lookup.
    assert.equal(clock.timers.length, 1);
    assert.equal(clock.timers[0]!.ms, 2000);
    await new Promise((res) => setImmediate(res));
    assert.equal(settled, false);
    clock.fire(); // the 2-second mark
    assert.deepEqual(await p, []);
    assert.equal(settled, true);
    assert.equal(r.cancelled, 1, 'lookups still open at the budget are cancelled');
  });

  it('F-3.9 only the domain is looked up and nothing is stored', async () => {
    // (1) The resolver only ever sees domain names, never a local part.
    const r = fakeResolver({});
    await checkSignerDomains(['secret.person@acme.test', 'Other.Name@bücher.test'], deps(r));
    assert.ok(r.calls.length > 0);
    for (const c of r.calls) {
      assert.ok(!c.host.includes('@'), c.host);
      assert.ok(!/secret|person|other|name/i.test(c.host), c.host);
    }
    // (2) The module has no store dependency (no pool, no db, no fs writes, no logging).
    const src = readFileSync(join(import.meta.dirname, 'signerDomainCheck.ts'), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!/db|pool|fs|telemetry|events/.test(spec!), `unexpected import ${spec}`);
    }
    assert.ok(!/console\.(log|info)/.test(src), 'nothing about a check is logged at info level');
    // (3) The idempotent create stores its body WITHOUT signer_warnings, and the
    //     replay carries none.
    const stored: unknown[] = [];
    let row: { request_hash: string; response_status: number | null; response_body: unknown } | undefined;
    const pool: DbPool = {
      async query(text: string, values?: unknown[]) {
        if (/^\s*INSERT INTO idempotency_keys/.test(text)) {
          if (row) return { rows: [], rowCount: 0 } as never;
          row = { request_hash: String(values![2]), response_status: null, response_body: null };
          return { rows: [{ creator_email: values![0] }], rowCount: 1 } as never;
        }
        if (/^\s*UPDATE idempotency_keys/.test(text)) {
          stored.push(values![1]);
          row!.response_status = values![0] as number;
          row!.response_body = values![1];
          return { rows: [], rowCount: 1 } as never;
        }
        if (/^\s*SELECT/.test(text)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as never;
        return { rows: [], rowCount: 0 } as never;
      },
      async end() {},
    };
    const run = async () => ({
      status: 201,
      body: { envelope_id: 'e1', signer_warnings: [{ email: 'x@mailinator.com', warnings: ['disposable'] }] },
    });
    const first = await withCreateIdempotency({ pool }, 'c@example.com', 'k1', '{}', run);
    assert.deepEqual((first.body as Record<string, unknown>)['signer_warnings'], [
      { email: 'x@mailinator.com', warnings: ['disposable'] },
    ]);
    assert.equal(stored.length, 1);
    assert.ok(!/signer_warnings/.test(String(stored[0])), 'the stored body never holds signer_warnings');
    const replay = await withCreateIdempotency({ pool }, 'c@example.com', 'k1', '{}', run);
    assert.equal((replay.body as Record<string, unknown>)['signer_warnings'], undefined);
    assert.equal((replay.body as Record<string, unknown>)['envelope_id'], 'e1');
  });
});
