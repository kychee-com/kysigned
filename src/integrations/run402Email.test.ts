/**
 * run402Email.test.ts — the @run402/sdk email adapters (F-17.5 / 14.1).
 *
 * `createRunEmailProvider` maps kysigned's `EmailProvider.send` → `r.email.send`
 * (raw mode; From is chosen by MAILBOX selection since the SDK has no `from`/
 * `reply_to` field; attachments are base64). `createFetchRawMime` maps the forward
 * reconciler's `fetchRawMime` seam → `r.email.getRaw`, byte-preserving.
 *
 * Tested against a fake structural client — the real `@run402/sdk` `Run402` client
 * is injected at the run402-function entry (14.5), so the core lib needs no SDK
 * runtime dep here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  createRunEmailProvider,
  createFetchRawMime,
  defaultMailboxForFrom,
  type Run402EmailClient,
} from './run402Email.js';

function fakeClient(
  opts: {
    raw?: Uint8Array;
    getRawThrows?: boolean;
    listResult?: Array<{ id: string; direction: string }>;
    listThrows?: boolean;
  } = {},
) {
  const sends: Array<{ projectId: string; opts: Record<string, unknown> }> = [];
  const getRaws: Array<{ projectId: string; messageId: string; opts?: { mailbox?: string } }> = [];
  const lists: Array<{ projectId: string; opts?: { direction?: string; mailbox?: string; limit?: number } }> = [];
  const client: Run402EmailClient = {
    email: {
      async send(projectId, sendOpts) {
        sends.push({ projectId, opts: sendOpts as Record<string, unknown> });
        return { message_id: 'msg-1' };
      },
      async getRaw(projectId, messageId, getRawOpts) {
        getRaws.push({ projectId, messageId, opts: getRawOpts });
        if (opts.getRawThrows) throw new Error('not ready');
        return { content_type: 'message/rfc822', bytes: opts.raw ?? new Uint8Array([0x46, 0x6f, 0x6f]) };
      },
      async list(projectId, listOpts) {
        lists.push({ projectId, opts: listOpts });
        if (opts.listThrows) throw new Error('list failed');
        return opts.listResult ?? [];
      },
    },
  };
  return { client, sends, getRaws, lists };
}

describe('defaultMailboxForFrom — F-19 From-address → run402 mailbox slug', () => {
  it('maps a plain From address to its local-part slug', () => {
    assert.equal(defaultMailboxForFrom('forward-to-sign@kysigned.com'), 'forward-to-sign');
    assert.equal(defaultMailboxForFrom('notifications@kysigned.com'), 'notifications');
  });
  it('extracts the address from a "Name <addr>" From', () => {
    assert.equal(defaultMailboxForFrom('kysigned <reply-to-sign@x.com>'), 'reply-to-sign');
  });
  it('returns undefined for a missing From (single-mailbox project resolves it)', () => {
    assert.equal(defaultMailboxForFrom(undefined), undefined);
    assert.equal(defaultMailboxForFrom(''), undefined);
  });
});

describe('createRunEmailProvider — EmailProvider.send → r.email.send', () => {
  it('sends raw mode, selects the mailbox from From, base64-encodes attachments', async () => {
    const { client, sends } = fakeClient();
    const provider = createRunEmailProvider({ client, projectId: 'prj_1' });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const res = await provider.send({
      to: 'alice@example.com',
      subject: 'Please sign',
      html: '<p>hi</p>',
      text: 'hi',
      from: 'forward-to-sign@kysigned.com',
      replyTo: 'forward-to-sign@kysigned.com',
      attachments: [{ filename: 'doc.pdf', content: pdf, contentType: 'application/pdf' }],
    });
    assert.equal(res.messageId, 'msg-1');
    assert.equal(sends.length, 1);
    const o = sends[0]!.opts;
    assert.equal(sends[0]!.projectId, 'prj_1');
    assert.equal(o.to, 'alice@example.com');
    assert.equal(o.subject, 'Please sign');
    assert.equal(o.html, '<p>hi</p>');
    assert.equal(o.text, 'hi');
    assert.equal(o.mailbox, 'forward-to-sign'); // From → mailbox selection
    const atts = o.attachments as Array<{ filename: string; content_base64: string; content_type: string }>;
    assert.equal(atts.length, 1);
    assert.equal(atts[0]!.filename, 'doc.pdf');
    assert.equal(atts[0]!.content_type, 'application/pdf');
    assert.equal(atts[0]!.content_base64, Buffer.from(pdf).toString('base64'));
  });

  it('omits mailbox + attachments keys when there is no From / no attachments', async () => {
    const { client, sends } = fakeClient();
    const provider = createRunEmailProvider({ client, projectId: 'prj_1' });
    await provider.send({ to: 'a@b.com', subject: 'S', html: '<p>x</p>', text: 'x' });
    const o = sends[0]!.opts;
    assert.ok(!('mailbox' in o), 'no mailbox key when From absent');
    assert.ok(!('attachments' in o), 'no attachments key when none');
  });

  it('honors a custom mailboxForFrom override', async () => {
    const { client, sends } = fakeClient();
    const provider = createRunEmailProvider({
      client,
      projectId: 'prj_1',
      mailboxForFrom: () => 'mbx_explicit',
    });
    await provider.send({ to: 'a@b.com', subject: 'S', html: '<p>x</p>', text: 'x', from: 'whatever@x.com' });
    assert.equal(sends[0]!.opts.mailbox, 'mbx_explicit');
  });
});

describe('createFetchRawMime — reconciler seam → r.email.getRaw (byte-preserving)', () => {
  it('returns the raw bytes as a byte-preserving (latin1) string', async () => {
    const { client, getRaws } = fakeClient({ raw: new Uint8Array([0xc3, 0xa9, 0x0d, 0x0a]) }); // é + CRLF
    const fetchRawMime = createFetchRawMime({ client, projectId: 'prj_1' });
    const raw = await fetchRawMime('m-1');
    assert.equal(getRaws[0]!.messageId, 'm-1');
    // latin1 round-trips bytes 1:1 — re-encoding must yield the identical bytes
    // (DKIM canonicalization runs on exact bytes).
    assert.deepEqual([...Buffer.from(raw!, 'latin1')], [0xc3, 0xa9, 0x0d, 0x0a]);
  });

  it('returns null when getRaw throws (not-ready / not-found → reconciler retries)', async () => {
    const { client } = fakeClient({ getRawThrows: true });
    const fetchRawMime = createFetchRawMime({ client, projectId: 'prj_1' });
    assert.equal(await fetchRawMime('m-x'), null);
  });

  // F-6.9 fix (Barry QA 2026-06-17): on a multi-mailbox project the SDK throws an
  // ambiguity error when the mailbox is omitted — so the seam MUST forward the
  // configured signing mailbox to getRaw, or every raw-fetch fails.
  it('scopes getRaw to the configured signing mailbox', async () => {
    const { client, getRaws } = fakeClient();
    const fetchRawMime = createFetchRawMime({ client, projectId: 'prj_1', mailbox: 'mbx_signing' });
    await fetchRawMime('m-1');
    assert.deepEqual(getRaws[0]!.opts, { mailbox: 'mbx_signing' });
  });

  it('omits the mailbox selector when none is configured (single-mailbox forker)', async () => {
    const { client, getRaws } = fakeClient();
    const fetchRawMime = createFetchRawMime({ client, projectId: 'prj_1' });
    await fetchRawMime('m-1');
    assert.equal(getRaws[0]!.opts, undefined);
  });
});

