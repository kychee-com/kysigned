/**
 * run402Http.test.ts — routed-HTTP marshalling (14.5).
 *
 * Normalize a `run402.routed_http.v1` request envelope into a convenient shape
 * (method/path/query/headers/cookies/body) and build base64 response envelopes.
 * Structurally matches the run402 contract so the deployed function-entry passes
 * these through `@run402/functions` unchanged; pure + testable here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  normalizeRoutedRequest,
  bodyText,
  bodyJson,
  jsonResponse,
  bytesResponse,
  type RoutedHttpRequestV1,
} from './run402Http.js';

function evt(over: Partial<RoutedHttpRequestV1> = {}): RoutedHttpRequestV1 {
  return {
    version: 'run402.routed_http.v1',
    method: 'get',
    url: 'https://kysigned.com/v1/envelopes?limit=10',
    path: '/v1/envelopes',
    rawPath: '/v1/envelopes',
    rawQuery: 'limit=10',
    headers: [['Content-Type', 'application/json'], ['X-Kysigned-Csrf', 'tok']],
    cookies: { raw: 'ksgn_session=abc123; other=1' },
    body: null,
    context: { source: 'route', projectId: 'prj_1', host: 'kysigned.com', proto: 'https' } as RoutedHttpRequestV1['context'],
    ...over,
  };
}

describe('normalizeRoutedRequest', () => {
  it('upper-cases the method, exposes path + parsed query', () => {
    const r = normalizeRoutedRequest(evt());
    assert.equal(r.method, 'GET');
    assert.equal(r.path, '/v1/envelopes');
    assert.equal(r.query.get('limit'), '10');
    assert.equal(r.host, 'kysigned.com');
    assert.equal(r.projectId, 'prj_1');
  });

  it('exposes headers case-insensitively', () => {
    const r = normalizeRoutedRequest(evt());
    assert.equal(r.headers.get('content-type'), 'application/json');
    assert.equal(r.headers.get('x-kysigned-csrf'), 'tok');
  });

  it('parses the raw Cookie header into a map', () => {
    const r = normalizeRoutedRequest(evt());
    assert.equal(r.cookies.ksgn_session, 'abc123');
    assert.equal(r.cookies.other, '1');
  });

  it('base64-decodes the body to bytes; bodyText/bodyJson read it', () => {
    const payload = JSON.stringify({ document_name: 'NDA' });
    const r = normalizeRoutedRequest(
      evt({ method: 'post', body: { encoding: 'base64', data: Buffer.from(payload).toString('base64'), size: payload.length } }),
    );
    assert.equal(bodyText(r), payload);
    assert.deepEqual(bodyJson<{ document_name: string }>(r), { document_name: 'NDA' });
  });

  it('a null body yields empty text / null json', () => {
    const r = normalizeRoutedRequest(evt());
    assert.equal(bodyText(r), '');
    assert.equal(bodyJson(r), null);
  });
});

describe('response builders', () => {
  it('jsonResponse base64-encodes the JSON with a content-type', () => {
    const res = jsonResponse(201, { id: 'env-1' });
    assert.equal(res.status, 201);
    assert.ok(res.headers!.some(([k, v]) => k.toLowerCase() === 'content-type' && v.includes('application/json')));
    const decoded = Buffer.from(res.body!.data, 'base64').toString('utf8');
    assert.deepEqual(JSON.parse(decoded), { id: 'env-1' });
    assert.equal(res.body!.size, Buffer.byteLength(decoded));
  });

  it('jsonResponse passes Set-Cookie strings through', () => {
    const res = jsonResponse(200, { ok: true }, { cookies: ['ksgn_session=x; HttpOnly'] });
    assert.deepEqual(res.cookies, ['ksgn_session=x; HttpOnly']);
  });

  it('bytesResponse carries binary (e.g. a PDF) with its content-type', () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const res = bytesResponse(200, pdf, 'application/pdf');
    assert.ok(res.headers!.some(([k, v]) => k.toLowerCase() === 'content-type' && v === 'application/pdf'));
    assert.deepEqual([...Buffer.from(res.body!.data, 'base64')], [0x25, 0x50, 0x44, 0x46]);
  });
});
