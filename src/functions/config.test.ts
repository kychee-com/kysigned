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
