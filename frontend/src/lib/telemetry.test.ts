/**
 * telemetry.test.ts — F-38 browser rail (AC-214/AC-215).
 *
 * One delegated listener + a declarative registry (data-telemetry attributes):
 * landing event, named clicks with location, catch-all with normalized
 * destination, home scroll depth once per threshold, per-page-load seq,
 * batched delivery that survives leaving the page, silent on every failure,
 * config-gated (fresh fork sends nothing), and ZERO browser-storage use.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTelemetryRail, normalizeDestination, type TelemetryBatch } from './telemetry';
import { initStaticTelemetry } from '../../public/telemetry.mjs';

function harness(over: Partial<Parameters<typeof createTelemetryRail>[0]> = {}) {
  const sent: TelemetryBatch[] = [];
  const rail = createTelemetryRail({
    enabled: true,
    send: (batch: TelemetryBatch) => {
      sent.push(batch);
      return true;
    },
    referrer: 'https://news.ycombinator.com/',
    search: '',
    ...over,
  });
  return { rail, sent };
}

beforeEach(() => {
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllEnvs());

describe('normalizeDestination — catch-all dest mirror of the server page set', () => {
  it('maps same-origin paths to page names, unknown to other, off-origin to external', () => {
    expect(normalizeDestination('/faq.html', 'kysigned.com')).toBe('faq');
    expect(normalizeDestination('/pricing', 'kysigned.com')).toBe('pricing');
    expect(normalizeDestination('https://kysigned.com/verify', 'kysigned.com')).toBe('verify');
    expect(normalizeDestination('/some-new-thing', 'kysigned.com')).toBe('other');
    expect(normalizeDestination('https://github.com/kychee-com/kysigned', 'kysigned.com')).toBe('external');
  });
});

describe('disabled (fresh-fork default) — sends nothing, touches nothing', () => {
  it('no events, no sends, no storage writes', () => {
    const sent: TelemetryBatch[] = [];
    const rail = createTelemetryRail({ enabled: false, send: (b) => (sent.push(b), true) });
    rail.pageView('/pricing');
    rail.event('click', 'cta_create:hero');
    rail.flush();
    expect(sent).toHaveLength(0);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('page views, seq, and batching', () => {
  it('pageView queues a page_view with seq 1 and flush sends the batch with riders', () => {
    const { rail, sent } = harness({ search: '?gclid=Cj0Kabc' });
    rail.pageView('/pricing');
    rail.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].page).toBe('/pricing');
    expect(sent[0].ref).toBe('https://news.ycombinator.com/');
    expect(sent[0].gclid).toBe(true);
    expect(sent[0].records).toEqual([{ event: 'page_view', seq: 1 }]);
  });

  it('events number sequentially within one page load; a new pageView resets the sequence', () => {
    const { rail, sent } = harness();
    rail.pageView('/');
    rail.event('click', 'signin:header');
    rail.flush();
    rail.pageView('/pricing'); // SPA soft-nav = a NEW sequence (home → pricing is two)
    rail.flush();
    expect(sent[0].records.map((r) => r.seq)).toEqual([1, 2]);
    expect(sent[1].page).toBe('/pricing');
    expect(sent[1].records).toEqual([{ event: 'page_view', seq: 1 }]);
  });

  it('stops queueing past the per-page-load cap', () => {
    const { rail, sent } = harness();
    rail.pageView('/');
    for (let i = 0; i < 200; i++) rail.event('click', 'signin:header');
    rail.flush();
    const total = sent.reduce((n, b) => n + b.records.length, 0);
    expect(total).toBeLessThanOrEqual(60);
  });

  it('a throwing transport never surfaces — and never breaks later flushes', () => {
    const { rail } = harness({
      send: () => {
        throw new Error('network gone');
      },
    });
    rail.pageView('/');
    expect(() => rail.flush()).not.toThrow();
    expect(() => rail.event('click', 'signin:header')).not.toThrow();
  });

  it('uses NO browser storage whatsoever (AC-214)', () => {
    const { rail } = harness();
    rail.pageView('/');
    rail.event('click', 'cta_create:hero');
    rail.flush();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

describe('delegated clicks — registry + catch-all (AC-215)', () => {
  it('a data-telemetry element records its name:location; adding the attribute to a NEW element records with no other change', () => {
    const { rail, sent } = harness();
    document.body.innerHTML = `
      <a id="cta" data-telemetry="cta_create:hero" href="/dashboard/create">Create</a>
      <span id="fresh">just marked</span>`;
    rail.pageView('/');
    rail.attach(document);
    (document.getElementById('cta') as HTMLElement).click();
    // The AC-215 teeth: mark one more element — markup only, zero code change.
    document.getElementById('fresh')!.setAttribute('data-telemetry', 'video:hero');
    (document.getElementById('fresh') as HTMLElement).click();
    rail.flush();
    const clicks = sent.flatMap((b) => b.records).filter((r) => r.event === 'click');
    expect(clicks.map((c) => c.element)).toEqual(['cta_create:hero', 'video:hero']);
  });

  it('an unnamed link records the catch-all with its normalized destination', () => {
    const { rail, sent } = harness();
    document.body.innerHTML = `
      <a id="faq" href="/faq.html">FAQ</a>
      <a id="ext" href="https://github.com/kychee-com/kysigned">Repo</a>`;
    rail.pageView('/');
    rail.attach(document);
    (document.getElementById('faq') as HTMLElement).click();
    (document.getElementById('ext') as HTMLElement).click();
    rail.flush();
    const clicks = sent.flatMap((b) => b.records).filter((r) => r.event === 'click');
    expect(clicks.map((c) => c.element)).toEqual(['other:faq', 'other:external']);
  });

  it('never blocks or alters navigation — the click handler never preventDefaults', () => {
    const { rail } = harness();
    document.body.innerHTML = `<a id="x" data-telemetry="pricing:header" href="/pricing">P</a>`;
    rail.pageView('/');
    rail.attach(document);
    let defaultPrevented = false;
    document.getElementById('x')!.addEventListener('click', (e) => {
      defaultPrevented = e.defaultPrevented;
      e.preventDefault(); // stop jsdom nav error, AFTER reading the flag
    });
    (document.getElementById('x') as HTMLElement).click();
    expect(defaultPrevented).toBe(false);
  });
});

describe('scroll depth — home only, once per threshold (AC-215)', () => {
  function fakeScrollTo(fraction: number) {
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 100, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: fraction * 900, configurable: true });
    window.dispatchEvent(new Event('scroll'));
  }

  it('records 25/50/75/100 exactly once each on the home page', () => {
    const { rail, sent } = harness();
    rail.pageView('/');
    rail.attach(document);
    fakeScrollTo(0.3);
    fakeScrollTo(0.3); // repeat — no double record
    fakeScrollTo(0.8);
    fakeScrollTo(1);
    rail.flush();
    const scrolls = sent.flatMap((b) => b.records).filter((r) => r.event === 'scroll');
    expect(scrolls.map((s) => s.element)).toEqual(['25', '50', '75', '100']);
  });

  it('non-home pages record no scroll events', () => {
    const { rail, sent } = harness();
    rail.pageView('/pricing');
    rail.attach(document);
    fakeScrollTo(1);
    rail.flush();
    expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'scroll')).toHaveLength(0);
  });
});

describe('static-page mirror (telemetry.mjs) — interop with the SPA rail', () => {
  it('boots, records the landing + a registry click + a catch-all click with the SAME wire shape', () => {
    const sent: TelemetryBatch[] = [];
    document.body.innerHTML = `
      <a id="named" data-telemetry="pricing:header" href="/pricing.html">Pricing</a>
      <a id="anon" href="/faq.html">FAQ</a>`;
    initStaticTelemetry({
      send: (b: TelemetryBatch) => (sent.push(b), true),
      path: '/pricing.html',
      referrer: 'https://www.google.com/',
      search: '',
      doc: document,
    });
    (document.getElementById('named') as HTMLElement).click();
    let anonPrevented = false;
    document.getElementById('anon')!.addEventListener('click', (e) => {
      anonPrevented = e.defaultPrevented;
      e.preventDefault();
    });
    (document.getElementById('anon') as HTMLElement).click();
    window.dispatchEvent(new Event('pagehide'));
    const records = sent.flatMap((b) => b.records);
    expect(sent[0].page).toBe('/pricing.html');
    expect(sent[0].ref).toBe('https://www.google.com/');
    expect(records[0]).toEqual({ event: 'page_view', seq: 1 });
    expect(records.filter((r) => r.event === 'click').map((r) => r.element)).toEqual([
      'pricing:header',
      'other:faq',
    ]);
    expect(anonPrevented).toBe(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
