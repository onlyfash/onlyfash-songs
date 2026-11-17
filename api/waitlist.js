/**
 * Same-origin proxy for the onlyfash.com waitlist form.
 *
 * The iwannafash.com Worker allowlists only its own origins, so the browser
 * posts here and this function forwards server-side with Origin/Referer set
 * to https://iwannafash.com. Nothing on iwannafash.com is changed.
 *
 * Node.js request/response handler (no framework). Vercel serves the rest of
 * this repo as static files; this file is only the /api/waitlist function.
 */

const UPSTREAM = 'https://iwannafash.com/api/waitlist';
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const MAX_BODY = 8192;

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

  send(res, upstream.status, data);
}

module.exports = handler;
