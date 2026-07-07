/**
 * run402Email — @run402/sdk email adapters (F-17.5 / 14.1).
 *
 * kysigned runs over run402: outbound email goes through run402 mailboxes
 * (`r.email.send`) and inbound raw MIME is fetched via `r.email.getRaw`. These
 * adapters bridge kysigned's transport-agnostic seams (the `EmailProvider`
 * interface and the reconciler's `fetchRawMime`) to the run402 SDK.
 *
 * The SDK surface is captured here as a STRUCTURAL type (`Run402EmailClient`), so
 * the core library carries no `@run402/sdk` runtime dependency and the adapters are
 * unit-tested against a fake. The real `new Run402({...})` client — whose `.email`
 * satisfies this shape — is injected at the run402-function entry (14.5).
 */
import { Buffer } from 'node:buffer';
import type { EmailProvider, EmailMessage } from '../email/types.js';

/** The subset of the @run402/sdk `email` namespace kysigned uses. */
export interface Run402EmailClient {
  email: {
    send(
      projectId: string,
      opts: {
        to: string;
        subject: string;
        html: string;
        text?: string;
        attachments?: Array<{ filename: string; content_base64: string; content_type: string }>;
        mailbox?: string;
      },
    ): Promise<{ message_id: string }>;
    getRaw(
      projectId: string,
      messageId: string,
      opts?: { mailbox?: string },
    ): Promise<{ content_type: string; bytes: Uint8Array }>;
    list(
      projectId: string,
      opts?: { direction?: 'inbound' | 'outbound'; mailbox?: string; limit?: number },
    ): Promise<Array<{ id: string; direction: string }>>;
  };
}

/**
 * Map a kysigned From address to a run402 mailbox slug. run402 sets the From by
 * which mailbox the send goes through (the SDK send has no `from`/`reply_to`
 * field), so `forward-to-sign@kysigned.com` → mailbox `forward-to-sign` and
 * `notifications@…` → `notifications`. Returns undefined for a missing From (a
 * single-mailbox project then resolves the only mailbox automatically).
 *
 * NOTE (F-19): because From IS the mailbox, a status email's intended Reply-To
 * (info@) is not separately settable — replies land on the From mailbox. Route or
 * monitor `notifications@` accordingly, or add a run402 reply_to field upstream.
 */
export function defaultMailboxForFrom(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const m = from.match(/<([^>]+)>/); // "Name <addr>" → addr
  const addr = (m ? m[1] : from).trim();
  const local = addr.split('@')[0]?.trim().toLowerCase();
  return local || undefined;
}

export interface RunEmailProviderConfig {
  client: Run402EmailClient;
  projectId: string;
  /** From-address → mailbox slug. Default = the local-part of the From address. */
  mailboxForFrom?: (from: string | undefined) => string | undefined;
}

/** kysigned's `EmailProvider`, backed by run402 mailboxes (`r.email.send`, raw mode). */
export function createRunEmailProvider(cfg: RunEmailProviderConfig): EmailProvider {
  const pickMailbox = cfg.mailboxForFrom ?? defaultMailboxForFrom;
  return {
    async send(message: EmailMessage): Promise<{ messageId: string }> {
      const mailbox = pickMailbox(message.from);
      const attachments = message.attachments?.map((a) => ({
        filename: a.filename,
        content_base64: Buffer.from(a.content).toString('base64'),
        content_type: a.contentType,
      }));
      const res = await cfg.client.email.send(cfg.projectId, {
        to: message.to,
        subject: message.subject,
        html: message.html,
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(mailbox ? { mailbox } : {}),
        ...(attachments && attachments.length ? { attachments } : {}),
      });
      return { messageId: res.message_id };
    },
  };
}

export interface FetchRawMimeConfig {
  client: Run402EmailClient;
  projectId: string;
  mailbox?: string;
}

/**
 * The forward reconciler's `fetchRawMime` seam, backed by `r.email.getRaw`. Returns
 * the raw RFC-822 bytes as a byte-preserving latin1 string (DKIM canonicalization
 * must run on the EXACT bytes). Returns null on any error (raw-not-ready /
 * not-found) so the reconciler bumps + retries rather than failing the row.
 */
export function createFetchRawMime(
  cfg: FetchRawMimeConfig,
): (messageId: string) => Promise<string | null> {
  return async (messageId: string) => {
    try {
      const { bytes } = await cfg.client.email.getRaw(
        cfg.projectId,
        messageId,
        cfg.mailbox ? { mailbox: cfg.mailbox } : undefined,
      );
      return Buffer.from(bytes).toString('latin1');
    } catch {
      return null;
    }
  };
}

export interface ListInboundConfig {
  client: Run402EmailClient;
  projectId: string;
  /** Signing-mailbox selector (mbx_… id or slug) — required on multi-mailbox projects. */
  mailbox?: string;
  /** Max messages to scan per tick (default 50). */
  limit?: number;
}

// createListInboundMessageIds (the AC-19 discovery-scan seam) was removed with the
// reconciler in F-29.6 — run402's email trigger is the durable inbound path now.
