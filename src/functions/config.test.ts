/**
 * config.test — env → AppDeps wiring that isn't covered by the unit suites for
 * the seams themselves. Currently: the F-18.1 session-lifetime knob.
 *
 * `buildAppDeps` is pure over (env, runtime); the run402 runtime is injected, so
 * a tiny structural fake lets us assert the env flows into `sessionConfig`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAppDeps, type AppEnv, type Run402Runtime } from './config.js';
import { isOperator } from '../api/auth/operator.js';
import { isInternalIdentity } from '../api/auth/internalIdentity.js';

type SentEmail = {
  projectId: string;
  opts: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    mailbox?: string;
  };
};

function fakeRuntime(sent: SentEmail[] = []): Run402Runtime {
  // Only the pool + email provider wrap these at construction time; nothing is
  // invoked, so structural stubs suffice.
  return {
    adminDb: () => ({ sql: async () => ({ rows: [], rowCount: 0 }) }),
    sdk: {
      email: {
        send: async (projectId: string, opts: SentEmail['opts']) => {
          sent.push({ projectId, opts });
          return { message_id: 'msg_1' };
        },
        getRaw: async () => ({ content_type: 'message/rfc822', bytes: new Uint8Array() }),
        list: async () => [],
      },
    },
    createRun: async () => ({ id: 'fnrun_test' }),
  } as unknown as Run402Runtime;
}

const baseEnv: AppEnv = { RUN402_PROJECT_ID: 'proj', RUN402_ANON_KEY: 'anon' };

describe('buildAppDeps — F-18.1 session lifetime', () => {
  it('KYSIGNED_SESSION_TTL_DAYS=30 → sessionConfig.sessionTtlDays = 30 (kysigned.com)', () => {
    const deps = buildAppDeps({ ...baseEnv, KYSIGNED_SESSION_TTL_DAYS: '30' }, fakeRuntime());
    assert.equal(deps.sessionConfig.sessionTtlDays, 30);
  });

  it('unset → sessionTtlDays undefined (forker falls to the session.ts default)', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.equal(deps.sessionConfig.sessionTtlDays, undefined);
  });
});

describe('buildAppDeps — F-32.7/F-16.6 operator alert address', () => {
  it('KYSIGNED_OPERATOR_ALERT_EMAIL routes operator alerts to an external inbox', () => {
    const deps = buildAppDeps({ ...baseEnv, KYSIGNED_OPERATOR_ALERT_EMAIL: 'barry@kychee.com' }, fakeRuntime());
    assert.equal(deps.operatorAlertEmail, 'barry@kychee.com');
  });

  it('unset → info@<operatorDomain> (forker default: the in-project human inbox)', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.equal(deps.operatorAlertEmail, `info@${deps.operatorDomain}`);
  });
});

describe('buildAppDeps — F-36 app-events seam (DD-43)', () => {
  it('wires emitAppEvent; without a runtime events surface it resolves as a no-op (never throws)', async () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.equal(typeof deps.emitAppEvent, 'function');
    await assert.doesNotReject(
      deps.emitAppEvent('signature_completed', ['env-1'], { envelope_id: 'env-1' }),
    );
  });

  it('routes through a present runtime emitter with the derived idempotency key', async () => {
    const calls: Array<{ type: string; opts?: { idempotencyKey?: string } }> = [];
    const runtime = fakeRuntime();
    (runtime as { emitEvent?: unknown }).emitEvent = async (
      type: string,
      _payload?: Record<string, unknown>,
      opts?: { idempotencyKey?: string },
    ) => {
      calls.push({ type, opts });
      return {};
    };
    const deps = buildAppDeps(baseEnv, runtime);
    await deps.emitAppEvent('envelope_completed', ['env-7'], { envelope_id: 'env-7' });
    assert.deepEqual(calls, [
      { type: 'envelope_completed', opts: { idempotencyKey: 'envelope_completed:env-7' } },
    ]);
  });
});

describe('buildAppDeps — F-33.1 operator allowlist', () => {
  it('KYSIGNED_OPERATOR_EMAILS parses to the operator allowlist', () => {
    const deps = buildAppDeps({ ...baseEnv, KYSIGNED_OPERATOR_EMAILS: 'op@kychee.com, ops2@kychee.com' }, fakeRuntime());
    assert.deepEqual(deps.operatorEmails, ['op@kychee.com', 'ops2@kychee.com']);
  });

  it('unset → empty allowlist (fail-closed: a fresh install/fork has no operators, AC-181)', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.deepEqual(deps.operatorEmails, []);
  });
});

describe('F-33.4 / AC-181 — forkable operator surface, fail-closed by default', () => {
  it('a fresh fork (no operator config) has an EMPTY allowlist → every session is locked out', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.deepEqual(deps.operatorEmails, []); // the public template bakes in NO operator identity
    assert.equal(isOperator('anyone@fork.example', deps.operatorEmails ?? []), false); // fail-closed
    assert.equal(isOperator('barry@kychee.com', deps.operatorEmails ?? []), false);
  });

  it('a fork grants operator access purely by configuring its own allowlist (no code change)', () => {
    const deps = buildAppDeps({ ...baseEnv, KYSIGNED_OPERATOR_EMAILS: 'ops@lawfirm.example' }, fakeRuntime());
    assert.equal(isOperator('ops@lawfirm.example', deps.operatorEmails ?? []), true);
    assert.equal(isOperator('stranger@lawfirm.example', deps.operatorEmails ?? []), false);
  });
});

describe('buildAppDeps — F-35 internal-identity list', () => {
  it('KYSIGNED_INTERNAL_IDENTITIES parses to the console internal-identity rules', () => {
    const deps = buildAppDeps(
      { ...baseEnv, KYSIGNED_INTERNAL_IDENTITIES: '@kychee.com, volinskey@gmail.com, redteam-*@kysigned.com' },
      fakeRuntime(),
    );
    assert.deepEqual(deps.internalIdentities, ['@kychee.com', 'volinskey@gmail.com', 'redteam-*@kysigned.com']);
  });

  it('unset → empty list (fork default: the exclude-internal toggle then hides only internal_test)', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.deepEqual(deps.internalIdentities, []);
  });
});

describe('F-35.5 / AC-192 — forkable exclude-internal, empty by default', () => {
  it('a fresh fork (no internal-identity config) ships an EMPTY list → excludes no identity', () => {
    const deps = buildAppDeps(baseEnv, fakeRuntime());
    assert.deepEqual(deps.internalIdentities, []); // the public template bakes in NO identity
    assert.equal(isInternalIdentity('barry@kychee.com', deps.internalIdentities ?? []), false);
    assert.equal(isInternalIdentity('anyone@fork.example', deps.internalIdentities ?? []), false);
  });

  it('a fork starts excluding an identity purely by configuring its own list (no code change)', () => {
    const deps = buildAppDeps(
      { ...baseEnv, KYSIGNED_INTERNAL_IDENTITIES: '@lawfirm.example, redteam-*@lawfirm.example' },
      fakeRuntime(),
    );
    assert.equal(isInternalIdentity('ops@lawfirm.example', deps.internalIdentities ?? []), true);
    assert.equal(isInternalIdentity('redteam-bot@lawfirm.example', deps.internalIdentities ?? []), true);
    assert.equal(isInternalIdentity('client@customer.example', deps.internalIdentities ?? []), false);
  });
});

describe('buildAppDeps — run402 up generated env', () => {
  it('uses generated Run402 origin and mailbox ids for clone deployments', () => {
    const deps = buildAppDeps(
      {
        ...baseEnv,
        RUN402_PUBLIC_ORIGIN: 'https://kysigned5.run402.com',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ID: 'mbx_forward',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS: 'forward-to-sign@kysigned5.mail.run402.com',
        RUN402_MAILBOX_NOTIFICATIONS_ID: 'mbx_notifications',
        RUN402_MAILBOX_NOTIFICATIONS_ADDRESS: 'notifications@kysigned5.mail.run402.com',
      },
      fakeRuntime(),
    );

    assert.equal(deps.baseUrl, 'https://kysigned5.run402.com');
    assert.equal(deps.operatorDomain, 'kysigned5.mail.run402.com');
    assert.equal(deps.signingMailboxId, 'mbx_forward');
    assert.equal(deps.notificationMailboxId, 'mbx_notifications');
    assert.equal(deps.signingEmail, 'forward-to-sign@kysigned5.mail.run402.com');
    assert.equal(deps.apiContext('creator@example.com').signingEmail, 'forward-to-sign@kysigned5.mail.run402.com');
    assert.equal(deps.signerCtx().signingEmail, 'forward-to-sign@kysigned5.mail.run402.com');
    assert.equal(deps.reminderSendCtx().signingEmail, 'forward-to-sign@kysigned5.mail.run402.com');
  });

  it('maps generated Core product From addresses to configured mailbox ids', async () => {
    const sent: SentEmail[] = [];
    const deps = buildAppDeps(
      {
        ...baseEnv,
        RUN402_PUBLIC_ORIGIN: 'https://kysigned5.run402.com',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ID: 'mbx_forward',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS: 'forward-to-sign@kysigned5.mail.run402.com',
        RUN402_MAILBOX_NOTIFICATIONS_ID: 'mbx_notifications',
        RUN402_MAILBOX_NOTIFICATIONS_ADDRESS: 'notifications@kysigned5.mail.run402.com',
      },
      fakeRuntime(sent),
    );

    await deps.emailProvider.send({
      to: 'signer@example.com',
      from: 'forward-to-sign@kysigned5.mail.run402.com',
      subject: 'Signature requested',
      html: '<p>x</p>',
      text: 'x',
    });
    await deps.emailProvider.send({
      to: 'creator@example.com',
      from: 'notifications@kysigned5.mail.run402.com',
      subject: 'Status',
      html: '<p>x</p>',
      text: 'x',
    });

    assert.equal(sent[0]?.opts.mailbox, 'mbx_forward');
    assert.equal(sent[1]?.opts.mailbox, 'mbx_notifications');
  });

  it('keeps explicit Kysigned env higher priority than generated defaults', () => {
    const deps = buildAppDeps(
      {
        ...baseEnv,
        KYSIGNED_BASE_URL: 'https://sign.example.com',
        KYSIGNED_OPERATOR_DOMAIN: 'example.com',
        KYSIGNED_SIGNING_EMAIL: 'sign@example.com',
        KYSIGNED_SIGNING_MAILBOX_ID: 'mbx_explicit',
        KYSIGNED_NOTIFICATION_MAILBOX_ID: 'mbx_notify_explicit',
        RUN402_PUBLIC_ORIGIN: 'https://kysigned5.run402.com',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ID: 'mbx_generated',
        RUN402_MAILBOX_FORWARD_TO_SIGN_ADDRESS: 'forward-to-sign@kysigned5.mail.run402.com',
        RUN402_MAILBOX_NOTIFICATIONS_ID: 'mbx_notify_generated',
      },
      fakeRuntime(),
    );

    assert.equal(deps.baseUrl, 'https://sign.example.com');
    assert.equal(deps.operatorDomain, 'example.com');
    assert.equal(deps.signingMailboxId, 'mbx_explicit');
    assert.equal(deps.notificationMailboxId, 'mbx_notify_explicit');
    assert.equal(deps.signingEmail, 'sign@example.com');
  });
});
