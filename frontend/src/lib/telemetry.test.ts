/**
 * telemetry.test.ts — F-38 browser rail (AC-214/AC-215).
 *
 * One delegated listener + a declarative registry (data-telemetry attributes):
 * landing event, named clicks with location, catch-all with normalized
 * destination, home scroll depth once per threshold, per-page-load seq,
 * batched delivery that survives leaving the page, silent on every failure,
 * config-gated (fresh fork sends nothing), ZERO browser-storage WRITES, and
 * the single sanctioned read: the F-37 record that keeps a paid visit tagged
 * paid after its landing page (AC-235).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTelemetryRail,
  isEditorPage,
  normalizeDestination,
  FLUSH_DEBOUNCE_MS,
  type TelemetryBatch,
} from './telemetry';
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
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

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
    const { rail, sent } = harness({ search: '?gclid=Cj0Kabc&utm_campaign=Summer_Launch' });
    rail.pageView('/pricing');
    rail.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].page).toBe('/pricing');
    expect(sent[0].ref).toBe('https://news.ycombinator.com/');
    expect(sent[0].gclid).toBe(true);
    // 0.60.0 — the campaign rider: the RAW landing utm_campaign value; the
    // server normalizes and stores the bounded token.
    expect(sent[0].utm).toBe('Summer_Launch');
    expect(sent[0].records).toEqual([{ event: 'page_view', seq: 1 }]);
  });

  it('the campaign rider stays in page memory across SPA soft-navs of the same load — never in storage', () => {
    const { rail, sent } = harness({ search: '?utm_campaign=spring_promo' });
    rail.pageView('/');
    rail.flush();
    rail.pageView('/pricing'); // soft-nav: URL no longer carries the param
    rail.flush();
    expect(sent[1].utm).toBe('spring_promo');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('no utm_campaign → no utm rider field at all', () => {
    const { rail, sent } = harness({ search: '?gclid=x' });
    rail.pageView('/');
    rail.flush();
    expect('utm' in sent[0]).toBe(false);
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

describe('paid visits stay paid past the landing page (AC-235)', () => {
  // The F-37 first-party record (frontend/src/lib/attribution.ts) — the ONLY
  // browser-storage key the rail reads, and only for presence + freshness.
  const ATTRIBUTION_KEY = 'kysigned.attribution';
  const DAY_MS = 24 * 60 * 60 * 1000;

  function storeCapture(gclid: string, ageMs = 0): void {
    window.localStorage.setItem(
      ATTRIBUTION_KEY,
      JSON.stringify({ gclid, capturedAt: new Date(Date.now() - ageMs).toISOString() }),
    );
  }

  it('a load with NO gclid in its URL still reports paid when the F-37 record holds one', () => {
    storeCapture('Cj0KCQjw_ad_click');
    const { rail, sent } = harness({ search: '' });
    rail.pageView('/dashboard/create');
    rail.flush();
    expect(sent[0].gclid).toBe(true);
  });

  it('every page of the visit stays paid — the flag is re-read per page view', () => {
    // A deep entry into the SPA: the landing page (and its gclid) is a page
    // load ago, so this rail's URL carries nothing — only the record does.
    storeCapture('Cj0KCQjw_ad_click');
    const { rail, sent } = harness({ search: '' });
    rail.pageView('/dashboard');
    rail.flush();
    rail.pageView('/dashboard/create'); // soft-nav
    rail.flush();
    rail.pageView('/pricing');
    rail.flush();
    expect(sent.map((b) => b.gclid)).toEqual([true, true, true]);
  });

  it('an expired capture (past the 90-day window) does not make a visit paid', () => {
    storeCapture('Cj0KCQjw_ad_click', 91 * DAY_MS);
    const { rail, sent } = harness({ search: '' });
    rail.pageView('/pricing');
    rail.flush();
    expect(sent[0].gclid).toBe(false);
  });

  it('a malformed record never makes a visit paid', () => {
    window.localStorage.setItem(ATTRIBUTION_KEY, '{not json');
    const { rail, sent } = harness({ search: '' });
    rail.pageView('/pricing');
    rail.flush();
    expect(sent[0].gclid).toBe(false);
    window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({ gclid: 'has spaces', capturedAt: new Date().toISOString() }));
    rail.pageView('/faq');
    rail.flush();
    expect(sent[1].gclid).toBe(false);
  });

  it('no URL gclid and no record → not paid (direct/organic/referral unchanged)', () => {
    const { rail, sent } = harness({ search: '' });
    rail.pageView('/pricing');
    rail.flush();
    expect(sent[0].gclid).toBe(false);
  });

  it('a URL gclid still reports paid with no record stored at all', () => {
    const { rail, sent } = harness({ search: '?gclid=Cj0KCQjw_ad_click' });
    rail.pageView('/');
    rail.flush();
    expect(sent[0].gclid).toBe(true);
    expect(window.localStorage.length).toBe(0); // the rail did not capture it either
  });

  it('reading the record writes nothing — the record is untouched and no key is added (AC-214)', () => {
    storeCapture('Cj0KCQjw_ad_click');
    const before = window.localStorage.getItem(ATTRIBUTION_KEY);
    const { rail } = harness({ search: '' });
    rail.pageView('/');
    rail.event('click', 'cta_create:hero');
    rail.flush();
    expect(window.localStorage.length).toBe(1);
    expect(window.localStorage.getItem(ATTRIBUTION_KEY)).toBe(before);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('the disabled (fresh-fork) rail never reads browser storage at all', () => {
    storeCapture('Cj0KCQjw_ad_click');
    const spy = vi.spyOn(Storage.prototype, 'getItem');
    const rail = createTelemetryRail({ enabled: false, send: () => true, search: '' });
    rail.pageView('/');
    rail.flush();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

describe('delivery does not wait for page teardown (BT-30.1 / FC30.1, AC-215)', () => {
  // Before FC30.1 the queue's ONLY exits were `pagehide`, `visibilitychange →
  // hidden`, and a 25-record batch. A page load that ended without a delivered
  // pagehide (tab discard, OS kill, crash, an automated ceremony that just
  // closes the context) lost its WHOLE batch, page_view included — which is
  // what cycle 30 measured and read as a missing event name.
  it('a single queued record leaves the page with NO pagehide, NO visibilitychange and far fewer than 25 records', () => {
    vi.useFakeTimers();
    const { rail, sent } = harness();
    rail.pageView('/dashboard/create');
    rail.attach(document);
    rail.event('sample_doc_clicked');
    expect(sent).toHaveLength(0); // nothing has left yet — batching is intact
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 50);
    expect(sent).toHaveLength(1);
    expect(sent[0].page).toBe('/dashboard/create');
    expect(sent[0].records).toEqual([
      { event: 'page_view', seq: 1 },
      { event: 'sample_doc_clicked', seq: 2 },
    ]);
  });

  it('the batch shape is byte-unchanged — a debounced POST is the same wire shape as a pagehide POST', () => {
    vi.useFakeTimers();
    const debounced = harness({ search: '?gclid=x&utm_campaign=Summer_Launch' });
    debounced.rail.pageView('/pricing');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 50);

    const teardown = harness({ search: '?gclid=x&utm_campaign=Summer_Launch' });
    teardown.rail.pageView('/pricing');
    teardown.rail.flush();

    expect(JSON.stringify(debounced.sent[0])).toBe(JSON.stringify(teardown.sent[0]));
  });

  it('several records inside one window coalesce into ONE batch (the per-source limiter must not be approached)', () => {
    vi.useFakeTimers();
    const { rail, sent } = harness();
    rail.pageView('/dashboard/create');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS / 2);
    rail.event('draft_started');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS / 2);
    rail.event('sample_doc_clicked');
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 50);
    expect(sent).toHaveLength(1);
    expect(sent[0].records.map((r) => r.event)).toEqual(['page_view', 'draft_started', 'sample_doc_clicked']);
  });

  it('an ordinary page load stays cheap: a full home visit (view + scroll depth + a click) is a single POST', () => {
    vi.useFakeTimers();
    const { rail, sent } = harness();
    document.body.innerHTML = `<a id="cta" data-telemetry="cta_create:hero" href="/dashboard/create">Create</a>`;
    rail.pageView('/');
    rail.attach(document);
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 100, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 900, configurable: true });
    window.dispatchEvent(new Event('scroll'));
    (document.getElementById('cta') as HTMLElement).click();
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS + 50);
    expect(sent).toHaveLength(1);
  });

  it('the DISABLED (fresh-fork) rail arms no timer and sends nothing, ever (AC-221)', () => {
    vi.useFakeTimers();
    const sent: TelemetryBatch[] = [];
    const rail = createTelemetryRail({ enabled: false, send: (b) => (sent.push(b), true) });
    rail.pageView('/');
    rail.event('click', 'cta_create:hero');
    expect(vi.getTimerCount()).toBe(0); // nothing scheduled at all
    vi.advanceTimersByTime(60_000);
    expect(sent).toHaveLength(0);
  });

  it('pagehide still flushes immediately, and does not re-send what the timer already sent', () => {
    vi.useFakeTimers();
    const { rail, sent } = harness();
    rail.pageView('/pricing');
    rail.attach(document);
    window.dispatchEvent(new Event('pagehide'));
    expect(sent).toHaveLength(1); // immediate, not debounced
    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS * 4);
    expect(sent).toHaveLength(1); // the pending timer found an empty queue
    expect(vi.getTimerCount()).toBe(0); // and disarmed itself
  });

  it('the 25-record batch cap still sends immediately (the backstops are kept, not replaced)', () => {
    vi.useFakeTimers();
    const { rail, sent } = harness();
    rail.pageView('/');
    for (let i = 0; i < 24; i++) rail.event('click', 'signin:header');
    expect(sent).toHaveLength(1);
    expect(sent[0].records).toHaveLength(25);
  });
});

describe('the editor is outside the every-clickable rule (BT-30.2 / FC30.2, AC-227)', () => {
  const EDITOR = '/dashboard/create';

  function editorHarness() {
    const h = harness();
    document.body.innerHTML = `
      <a id="named" data-telemetry="how_it_works:header" href="/how-it-works">How it works</a>
      <a id="anon" href="/how-it-works">how this works &rarr;</a>`;
    h.rail.pageView(EDITOR);
    h.rail.attach(document);
    return h;
  }

  it('an UNNAMED link on the editor records no click (the catch-all bucket)', () => {
    const { rail, sent } = editorHarness();
    (document.getElementById('anon') as HTMLElement).click();
    rail.flush();
    expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'click')).toEqual([]);
  });

  it('a NAMED [data-telemetry] element on the editor records no click either (the header sits on this page)', () => {
    const { rail, sent } = editorHarness();
    (document.getElementById('named') as HTMLElement).click();
    rail.flush();
    expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'click')).toEqual([]);
  });

  it('the editor still records its OWN closed set: draft_started, send_clicked, and both F-44.4 facts', () => {
    const { rail, sent } = editorHarness();
    rail.event('draft_started');
    rail.eventOnce('cover_details_expanded');
    rail.eventOnce('sample_doc_clicked');
    rail.event('send_clicked');
    (document.getElementById('anon') as HTMLElement).click(); // still suppressed
    rail.flush();
    expect(sent.flatMap((b) => b.records).map((r) => r.event)).toEqual([
      'page_view',
      'draft_started',
      'cover_details_expanded',
      'sample_doc_clicked',
      'send_clicked',
    ]);
  });

  it('the guard is EXACT: /dashboard and deeper /dashboard/* paths keep the F-38.2 promise', () => {
    for (const page of ['/dashboard', '/dashboard/env_123', '/dashboard/create/extra']) {
      const { rail, sent } = harness();
      document.body.innerHTML = `<a id="anon" href="/faq">FAQ</a>`;
      rail.pageView(page);
      rail.attach(document);
      (document.getElementById('anon') as HTMLElement).click();
      rail.flush();
      expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'click').map((r) => r.element), page).toEqual([
        'other:faq',
      ]);
    }
  });

  it('public pages are untouched collateral: home still records both buckets (F-38.2)', () => {
    const { rail, sent } = harness();
    document.body.innerHTML = `
      <a id="named" data-telemetry="cta_create:hero" href="/dashboard/create">Create</a>
      <a id="anon" href="/faq">FAQ</a>`;
    rail.pageView('/');
    rail.attach(document);
    (document.getElementById('named') as HTMLElement).click();
    (document.getElementById('anon') as HTMLElement).click();
    rail.flush();
    expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'click').map((r) => r.element)).toEqual([
      'cta_create:hero',
      'other:faq',
    ]);
  });

  it('PIN against the SEGMENT_TO_PAGE trap: the client normalizer never answers "create", so the guard cannot be written against it', () => {
    // The SERVER splits /dashboard/create out of dashboard
    // (`normalizeTelemetryPage`); the CLIENT's own SEGMENT_TO_PAGE has no
    // `create` entry at all. A guard written as
    // `normalizeDestination(state.page) === 'create'` therefore silently never
    // fires. This asserts both halves so the trap cannot be re-entered.
    expect(normalizeDestination(EDITOR, 'kysigned.com')).toBe('dashboard');
    expect(normalizeDestination(EDITOR, 'kysigned.com')).not.toBe('create');
    expect(isEditorPage(EDITOR)).toBe(true);
    const { rail, sent } = editorHarness();
    (document.getElementById('anon') as HTMLElement).click();
    rail.flush();
    expect(sent.flatMap((b) => b.records).filter((r) => r.event === 'click')).toEqual([]);
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
      search: '?utm_campaign=Summer_Launch',
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
    expect(sent[0].utm).toBe('Summer_Launch');
    expect(records[0]).toEqual({ event: 'page_view', seq: 1 });
    expect(records.filter((r) => r.event === 'click').map((r) => r.element)).toEqual([
      'pricing:header',
      'other:faq',
    ]);
    expect(anonPrevented).toBe(false);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('is held to the IDENTICAL timing contract, not just the identical wire shape (FC30.1)', () => {
    // The two implementations must agree on WHEN a record leaves, or a static
    // page keeps the lost-batch defect the SPA just fixed.
    vi.useFakeTimers();

    const spaSent: TelemetryBatch[] = [];
    const spa = createTelemetryRail({ enabled: true, send: (b) => (spaSent.push(b), true), search: '', referrer: '' });
    spa.pageView('/pricing.html');

    const staticSent: TelemetryBatch[] = [];
    initStaticTelemetry({
      send: (b: TelemetryBatch) => (staticSent.push(b), true),
      path: '/pricing.html',
      referrer: '',
      search: '',
      doc: document,
    });

    vi.advanceTimersByTime(FLUSH_DEBOUNCE_MS - 1);
    expect(spaSent, 'SPA rail must still be batching').toHaveLength(0);
    expect(staticSent, 'static mirror must still be batching').toHaveLength(0);

    vi.advanceTimersByTime(2);
    expect(spaSent, 'SPA rail delivered without any teardown').toHaveLength(1);
    expect(staticSent, 'static mirror delivered without any teardown').toHaveLength(1);
    expect(JSON.stringify(staticSent[0].records)).toBe(JSON.stringify(spaSent[0].records));

    // And a later pagehide re-sends nothing that already left.
    window.dispatchEvent(new Event('pagehide'));
    expect(staticSent).toHaveLength(1);
    expect(spaSent).toHaveLength(1);
  });

  it('reports the SAME paid answer as the SPA rail for every state of the F-37 record (AC-235)', () => {
    const ATTRIBUTION_KEY = 'kysigned.attribution';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const fresh = JSON.stringify({ gclid: 'Cj0KCQjw_ad_click', capturedAt: new Date().toISOString() });
    const expired = JSON.stringify({
      gclid: 'Cj0KCQjw_ad_click',
      capturedAt: new Date(Date.now() - 91 * DAY_MS).toISOString(),
    });
    const cases: Array<{ name: string; record: string | null; expected: boolean }> = [
      { name: 'fresh capture', record: fresh, expected: true },
      { name: 'expired capture', record: expired, expected: false },
      { name: 'malformed record', record: '{not json', expected: false },
      { name: 'no record at all', record: null, expected: false },
    ];
    for (const c of cases) {
      window.localStorage.clear();
      if (c.record !== null) window.localStorage.setItem(ATTRIBUTION_KEY, c.record);

      const spaSent: TelemetryBatch[] = [];
      const spa = createTelemetryRail({ enabled: true, send: (b) => (spaSent.push(b), true), search: '', referrer: '' });
      spa.pageView('/pricing.html');
      spa.flush();

      const staticSent: TelemetryBatch[] = [];
      initStaticTelemetry({
        send: (b: TelemetryBatch) => (staticSent.push(b), true),
        path: '/pricing.html',
        referrer: '',
        search: '',
        doc: document,
      });
      window.dispatchEvent(new Event('pagehide'));

      expect(spaSent[0].gclid, `SPA rail — ${c.name}`).toBe(c.expected);
      expect(staticSent[0].gclid, `static mirror — ${c.name}`).toBe(c.expected);
      // Neither implementation ever writes: only the F-37 record is present.
      expect(window.localStorage.length).toBe(c.record === null ? 0 : 1);
      expect(window.sessionStorage.length).toBe(0);
    }
  });
});
