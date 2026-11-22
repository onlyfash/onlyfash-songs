/**
 * Same-origin proxy for the onlyfash.com waitlist form.
 *
 * The iwannafash.com Worker allowlists only its own origins, so the browser
 * posts here and this function forwards server-side with Origin/Referer set
 * to https://iwannafash.com. Nothing on iwannafash.com is changed.
 *
 * After that forward succeeds — or the worker says the address is already
 * on the list — the three answers are posted to the onlyfash answers worker.
 * A failure there is logged and does not change the waitlist response.
 *
 * The answers key is ONLYFASH_ANSWERS_KEY. It is not stored in this file:
 * the GitHub repository is public.
 *
 * Node.js request/response handler (no framework). Vercel serves the rest of
 * this repo as static files; this file is only the /api/waitlist function.
 */

const UPSTREAM = 'https://iwannafash.com/api/waitlist';
const ANSWERS_URL = 'https://onlyfash-answers.heyyy-e22.workers.dev/answers';
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const MAX_BODY = 8192;
const MAX_ANSWER = 600;
const QUESTIONS = [
  'fash. what does it feel like to you?',
  'what are you chasing that nobody knows about?',
  'who do you become when the lights go low?',
];
const DUPLICATE_RE = /duplicate|already|subscribed|on[-_ ]list|exists/i;

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(payload);
}

function honeypotTripped(company) {
  if (company == null) return false;
  if (typeof company === 'string') return company.trim() !== '';
  return true;
}

function cleanReferrer(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\u0000]/g, '').slice(0, 2000);
}

function emailInvalid(email) {
  return typeof email !== 'string' || email.length === 0 || email.length > 254 || !EMAIL_RE.test(email);
}

function answersKey() {
  const env = process.env.ONLYFASH_ANSWERS_KEY;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return '';
}

function headerValue(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  const raw = headers[name] || headers[String(name).toLowerCase()];
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
  return typeof raw === 'string' ? raw : '';
}

function countryFrom(req) {
  const value = headerValue(req, 'x-vercel-ip-country').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return value;
}

function cleanAnswers(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const out = [];
  for (let i = 0; i < QUESTIONS.length; i += 1) {
    const item = value[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const q = typeof item.q === 'string' ? item.q.trim() : '';
    const a = typeof item.a === 'string' ? item.a.replace(/\u0000/g, '').trim() : '';
    if (q !== QUESTIONS[i]) return null;
    if (!a || a.length > MAX_ANSWER) return null;
    out.push({ q: QUESTIONS[i], a: a });
  }
  return out;
}

function isDuplicate(status, data) {
  if (status === 409) return true;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.duplicate === true || data.already === true || data.exists === true) return true;
  const parts = ['status', 'error', 'message', 'code', 'reason']
    .map((key) => (typeof data[key] === 'string' ? data[key] : ''))
    .join(' ');
  return DUPLICATE_RE.test(parts);
}

function shouldStoreAnswers(status, data) {
  if (status >= 200 && status < 300 && data && data.ok !== false) return true;
  return isDuplicate(status, data);
}

async function readJson(req) {
  let body = req.body;
  if (body == null) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY) {
        const err = new Error('too large');
        err.statusCode = 413;
        throw err;
      }
      chunks.push(buf);
    }
    if (size === 0) return {};
    body = Buffer.concat(chunks).toString('utf8');
  }

  if (typeof body === 'string') {
    if (body.length > MAX_BODY) {
      const err = new Error('too large');
      err.statusCode = 413;
      throw err;
    }
    return JSON.parse(body);
  }
  if (Buffer.isBuffer(body)) {
    if (body.length > MAX_BODY) {
      const err = new Error('too large');
      err.statusCode = 413;
      throw err;
    }
    return JSON.parse(body.toString('utf8'));
  }
  return body;
}

async function saveAnswers(req, email, payload) {
  const answers = cleanAnswers(payload && payload.answers);
  if (!answers) {
    console.error('answers skipped');
    return;
  }
  const key = answersKey();
  if (!key) {
    console.error('answers skipped: no key');
    return;
  }

  const body = {
    email: email,
    answers: answers,
    source: 'onlyfash.com',
  };
  const country = countryFrom(req);
  if (country) body.country = country;

  try {
    const saved = await fetch(ANSWERS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-onlyfash-key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!saved.ok) console.error('answers save failed', saved.status);
  } catch (err) {
    console.error('answers save failed');
  }
}

async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    send(res, 405, { ok: false, error: 'method' });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (err) {
    const status = err && err.statusCode === 413 ? 413 : 400;
    send(res, status, { ok: false, error: status === 413 ? 'too_large' : 'invalid' });
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    send(res, 400, { ok: false, error: 'invalid' });
    return;
  }

  // Filled honeypot: same silent success the upstream worker returns, and no forward.
  if (honeypotTripped(payload.company)) {
    send(res, 200, { ok: true, status: 'ok' });
    return;
  }

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (emailInvalid(email)) {
    send(res, 400, { ok: false, error: 'invalid' });
    return;
  }

  const forwarded = {
    email: email,
    company: '',
    source: 'onlyfash.com',
    referrer: cleanReferrer(payload.referrer),
  };

  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://iwannafash.com',
        Referer: 'https://iwannafash.com/',
      },
      body: JSON.stringify(forwarded),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('waitlist upstream failed');
    send(res, 502, { ok: false, error: 'upstream' });
    return;
  }

  const text = await upstream.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (err) {
    data = { ok: false };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    data = { ok: false };
  }

  if (shouldStoreAnswers(upstream.status, data)) {
    try {
      await saveAnswers(req, email, payload);
    } catch (err) {
      console.error('answers save failed');
    }
  }

  send(res, upstream.status, data);
}

module.exports = handler;
