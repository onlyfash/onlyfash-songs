/**
 * Local tests for api/waitlist.js. Fetch is mocked; nothing is sent to
 * iwannafash.com or the answers worker.
 */

const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');

const handler = require('../api/waitlist');

const UPSTREAM = 'https://iwannafash.com/api/waitlist';
const ANSWERS = 'https://onlyfash-answers.heyyy-e22.workers.dev/answers';
const QUESTIONS = [
  'fash. what does it feel like to you?',
  'what are you chasing that nobody knows about?',
  'who do you become when the lights go low?',
];

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: '',
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(payload) {
      this.payload = payload == null ? '' : String(payload);
    },
  };
}

function mockReq({ method = 'POST', body = '', headers = {} } = {}) {
  return { method, body, headers };
}

function answers(overrides) {
  return QUESTIONS.map((q, i) => ({ q, a: overrides && overrides[i] != null ? overrides[i] : 'a short answer ' + (i + 1) }));
}

function signupBody(extra) {
  return JSON.stringify(Object.assign({
    email: 'person@example.com',
    company: '',
    answers: answers(),
    referrer: 'https://example.test/from',
  }, extra || {}));
}

async function invoke(req) {
  const res = mockRes();
  await handler(req, res);
  let json = null;
  if (res.payload) {
    try { json = JSON.parse(res.payload); } catch (err) { json = res.payload; }
  }
  return { res, json };
}

describe('api/waitlist', () => {
  let calls;
  let upstreamResult;
  let answersResult;
  const originalFetch = global.fetch;
  const originalKey = process.env.ONLYFASH_ANSWERS_KEY;

  beforeEach(() => {
    calls = [];
    upstreamResult = { status: 200, body: { ok: true, status: 'ok' } };
    answersResult = { status: 200, body: { ok: true } };
    process.env.ONLYFASH_ANSWERS_KEY = 'test-key';
    global.fetch = async (url, init) => {
      const href = String(url);
      if (href !== UPSTREAM && href !== ANSWERS) {
        throw new Error('refusing unexpected url ' + href);
      }
      calls.push({
        url: href,
        method: init && init.method,
        headers: init && init.headers,
        body: init && init.body ? JSON.parse(init.body) : null,
      });
      const result = href === UPSTREAM ? upstreamResult : answersResult;
      if (result.throw) throw result.throw;
      return new Response(JSON.stringify(result.body), { status: result.status });
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey == null) delete process.env.ONLYFASH_ANSWERS_KEY;
    else process.env.ONLYFASH_ANSWERS_KEY = originalKey;
  });

  it('rejects non-POST methods and answers OPTIONS', async () => {
    const options = await invoke(mockReq({ method: 'OPTIONS', body: '' }));
    assert.equal(options.res.statusCode, 204);
    assert.equal(options.res.headers.Allow, 'POST, OPTIONS');
    assert.equal(calls.length, 0);

    const get = await invoke(mockReq({ method: 'GET', body: '' }));
    assert.equal(get.res.statusCode, 405);
    assert.deepEqual(get.json, { ok: false, error: 'method' });
    assert.equal(calls.length, 0);
  });

  it('rejects invalid JSON, non-objects, and oversized bodies', async () => {
    const bad = await invoke(mockReq({ body: '{nope' }));
    assert.equal(bad.res.statusCode, 400);
    assert.deepEqual(bad.json, { ok: false, error: 'invalid' });

    const array = await invoke(mockReq({ body: '[1]' }));
    assert.equal(array.res.statusCode, 400);

    const huge = await invoke(mockReq({ body: 'x'.repeat(8193) }));
    assert.equal(huge.res.statusCode, 413);
    assert.deepEqual(huge.json, { ok: false, error: 'too_large' });
    assert.equal(calls.length, 0);
  });

  it('treats a filled honeypot as silent success and does not forward', async () => {
    const out = await invoke(mockReq({ body: signupBody({ company: 'acme' }) }));
    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 0);
  });

  it('rejects a bad email before either forward', async () => {
    const out = await invoke(mockReq({ body: signupBody({ email: 'not-an-email' }) }));
    assert.equal(out.res.statusCode, 400);
    assert.deepEqual(out.json, { ok: false, error: 'invalid' });
    assert.equal(calls.length, 0);
  });

  it('forwards the email exactly as before, then posts the answers', async () => {
    const out = await invoke(mockReq({
      body: signupBody({
        email: '  Person@Example.com ',
        referrer: 'https://from.test/a\nbb',
      }),
      headers: { 'x-vercel-ip-country': 'us' },
    }));

    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, UPSTREAM);
    assert.equal(calls[1].url, ANSWERS);

    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(calls[0].headers, {
      'Content-Type': 'application/json',
      Origin: 'https://iwannafash.com',
      Referer: 'https://iwannafash.com/',
    });
    assert.deepEqual(calls[0].body, {
      email: 'Person@Example.com',
      company: '',
      source: 'onlyfash.com',
      referrer: 'https://from.test/abb',
    });
    assert.equal('answers' in calls[0].body, false);

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].headers['content-type'], 'application/json');
    assert.equal(calls[1].headers['x-onlyfash-key'], 'test-key');
    assert.equal(calls[1].body.email, 'Person@Example.com');
    assert.equal(calls[1].body.source, 'onlyfash.com');
    assert.equal(calls[1].body.country, 'US');
    assert.deepEqual(calls[1].body.answers, answers());
  });

  it('omits country when the Vercel header is missing', async () => {
    await invoke(mockReq({ body: signupBody() }));
    assert.equal(calls.length, 2);
    assert.equal('country' in calls[1].body, false);
  });

  it('accepts a one-character answer and keeps an interior newline', async () => {
    await invoke(mockReq({ body: signupBody({ answers: answers(['warm\nstill here', 'y', 'z']) }) }));
    assert.deepEqual(calls[1].body.answers.map((item) => item.a), ['warm\nstill here', 'y', 'z']);
  });

  it('skips the answers post when a question does not match', async () => {
    const bad = answers();
    bad[0] = { q: 'something else', a: 'x' };
    const out = await invoke(mockReq({ body: signupBody({ answers: bad }) }));
    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, UPSTREAM);
  });

  it('still stores answers when the list says the email is already there', async () => {
    upstreamResult = { status: 409, body: { ok: false, error: 'already on list' } };
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 409);
    assert.deepEqual(out.json, { ok: false, error: 'already on list' });
    assert.equal(calls[1].url, ANSWERS);
    assert.equal(calls[1].body.email, 'person@example.com');
  });

  it('stores answers for a duplicate success body', async () => {
    upstreamResult = { status: 200, body: { ok: true, status: 'duplicate' } };
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'duplicate' });
    assert.equal(calls.length, 2);
  });

  it('does not store answers when the waitlist rejects the email', async () => {
    upstreamResult = { status: 400, body: { ok: false, error: 'invalid' } };
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 400);
    assert.deepEqual(out.json, { ok: false, error: 'invalid' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, UPSTREAM);
  });

  it('returns the waitlist response when the answers save fails', async () => {
    answersResult = { status: 500, body: { ok: false } };
    const errors = [];
    const original = console.error;
    console.error = (...args) => { errors.push(args.join(' ')); };
    try {
      const out = await invoke(mockReq({ body: signupBody() }));
      assert.equal(out.res.statusCode, 200);
      assert.deepEqual(out.json, { ok: true, status: 'ok' });
      assert.equal(calls.length, 2);
      assert.ok(errors.some((line) => line.indexOf('answers save failed') !== -1));
      assert.equal(errors.some((line) => line.indexOf('person@example.com') !== -1), false);
    } finally {
      console.error = original;
    }
  });

  it('returns the waitlist response when the answers request throws', async () => {
    answersResult = { throw: new Error('down') };
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 2);
  });

  it('returns 502 and skips answers when the waitlist forward throws', async () => {
    upstreamResult = { throw: new Error('down') };
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 502);
    assert.deepEqual(out.json, { ok: false, error: 'upstream' });
    assert.equal(calls.length, 1);
  });

  it('still joins the waitlist when the answers are missing', async () => {
    const missing = await invoke(mockReq({ body: signupBody({ answers: [] }) }));
    assert.equal(missing.res.statusCode, 200);
    assert.deepEqual(missing.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, UPSTREAM);
  });

  it('posts the answers with no key header when ONLYFASH_ANSWERS_KEY is unset', async () => {
    delete process.env.ONLYFASH_ANSWERS_KEY;
    const out = await invoke(mockReq({ body: signupBody() }));
    assert.equal(out.res.statusCode, 200);
    assert.deepEqual(out.json, { ok: true, status: 'ok' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, ANSWERS);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].headers, 'x-onlyfash-key'), false);
    assert.equal(calls[1].headers['content-type'], 'application/json');
    assert.deepEqual(calls[1].body.answers, answers());

    calls.length = 0;
    process.env.ONLYFASH_ANSWERS_KEY = '   ';
    await invoke(mockReq({ body: signupBody() }));
    assert.equal(calls.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(calls[1].headers, 'x-onlyfash-key'), false);
  });

  it('reads a streamed body and sends the env key when it is set', async () => {
    process.env.ONLYFASH_ANSWERS_KEY = 'env-key';
    const payload = signupBody();
    const req = {
      method: 'POST',
      headers: { 'x-vercel-ip-country': ['de', 'fr'] },
      body: null,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(payload.slice(0, 20));
        yield Buffer.from(payload.slice(20));
      },
    };
    const out = await invoke(req);
    assert.equal(out.res.statusCode, 200);
    assert.equal(calls[1].headers['x-onlyfash-key'], 'env-key');
    assert.equal(calls[1].body.country, 'DE');
  });
});
