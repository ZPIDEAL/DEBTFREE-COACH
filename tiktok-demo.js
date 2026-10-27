/* ============================================================
   TikTok SANDBOX demo — Login Kit + Content Posting API (Direct Post).
   Review demo ONLY: this is not the live feature. It exists so the
   TikTok app review can see the integration working end to end.

   - No client-side JavaScript and no inline styles (the site's CSP
     allows neither); every step is a plain link or form post.
   - Sandbox credentials come ONLY from environment variables
     (TIKTOK_SANDBOX_CLIENT_KEY / TIKTOK_SANDBOX_CLIENT_SECRET).
     They are never hardcoded, never rendered, and never logged.
   - The access token lives server-side in an in-memory session keyed
     by a random HttpOnly cookie. It is never placed in a cookie, a
     URL, or page HTML.
   - Posts are SELF_ONLY (private), as required for unaudited apps,
     and only the sandbox target user can complete the login at all
     (TikTok enforces target users for sandbox apps).
   - Redirect URI: <APP_URL>/tiktok-demo/callback. APP_URL is the
     canonical domain (https://getdebtfreecoach.com in production).
     Register that EXACT URI in the sandbox Login Kit settings.

   Mount BEFORE the SPA fallback: app.use('/tiktok-demo', require('./tiktok-demo')());
   ============================================================ */
'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const https = require('https');
const path = require('path');

const SCOPE = 'user.info.basic,video.upload,video.publish';
const CLIP = path.join(__dirname, 'tiktok-demo-clip.mp4');
const DEMO_TITLE = 'Quest Publications sandbox test — Direct Post demo';
const SESSION_TTL_MS = 60 * 60 * 1000;

/* ---------- tiny helpers ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function redirectUri() {
  const base = (process.env.APP_URL || 'https://getdebtfreecoach.com').replace(/\/$/, '');
  return base + '/tiktok-demo/callback';
}

function configured() {
  return Boolean(process.env.TIKTOK_SANDBOX_CLIENT_KEY && process.env.TIKTOK_SANDBOX_CLIENT_SECRET);
}

/* Minimal https client (no new dependencies). Resolves [status, parsedJson]. */
function callApi(method, url, { token, json, form, raw, contentType } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let body = null;
    const headers = {};
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
    } else if (form !== undefined) {
      body = Buffer.from(new URLSearchParams(form).toString());
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (raw !== undefined) {
      body = raw;
      if (contentType) headers['Content-Type'] = contentType;
    }
    if (body) headers['Content-Length'] = body.length;
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search, headers, timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { _raw: text.slice(0, 400) }; }
        resolve([res.statusCode, parsed]);
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function putBytes(url, buffer, contentRange) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: 'PUT', hostname: u.hostname, path: u.pathname + u.search,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': contentRange,
        'Content-Length': buffer.length,
      },
      timeout: 60000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('upload timed out')));
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

/* ---------- session (in-memory, cookie holds only a random id) ---------- */
const sessions = new Map();
function pruneSessions() {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.created > SESSION_TTL_MS) sessions.delete(sid);
  }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req, res) {
  pruneSessions();
  const cookies = parseCookies(req);
  let sid = cookies.dfc_demo_sid;
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { created: Date.now() });
    const host = req.headers.host || '';
    const local = /localhost|127\.0\.0\.1/.test(host);
    const attrs = [
      'dfc_demo_sid=' + sid,
      'Path=/tiktok-demo',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=3600',
    ];
    if (!local) attrs.push('Secure');
    res.setHeader('Set-Cookie', attrs.join('; '));
  }
  return sessions.get(sid);
}

/* ---------- pages (no client JS, no inline styles) ---------- */
function page(title, body) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + '</title>'
    + '<link rel="stylesheet" href="/styles.css"></head><body><main>'
    + '<h1>' + esc(title) + '</h1>' + body + '</main></body></html>';
}

function demoNote() {
  return '<p><strong>SANDBOX DEMO — not the live feature.</strong> '
    + 'This page demonstrates the TikTok integration for DebtFree Coach '
    + '(getdebtfreecoach.com), the website this integration will run on, '
    + 'for the TikTok app review. Only the sandbox test user can complete the login.</p>';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- router ---------- */
function createRouter() {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  router.get('/', (req, res) => {
    const s = getSession(req, res);
    const cfg = configured();
    let body = demoNote();
    body += '<p>Sandbox credentials configured: <strong>' + (cfg ? 'YES' : 'NO') + '</strong></p>';
    body += '<p>Redirect URI registered for this demo (enter this exact URI in the sandbox Login Kit settings): '
      + '<strong>' + esc(redirectUri()) + '</strong></p>';
    if (s.displayName) {
      body += '<p>Logged in as: <strong>' + esc(s.displayName) + '</strong></p>';
    } else {
      body += '<p>Login token: <strong>not yet</strong></p>';
    }
    if (s.publishId) {
      body += '<p>Test post: <strong>' + esc(s.postStatus || 'submitted') + '</strong> '
        + '(publish ID ' + esc(s.publishId) + ')</p>';
    }
    body += '<p><a href="/tiktok-demo/login">1 · Start TikTok login (sandbox test user)</a></p>';
    body += '<p><a href="/tiktok-demo/post">2 · Direct Post the test video</a></p>';
    body += '<p><a href="/tiktok-demo/status">Check post status again</a> · '
      + '<a href="/tiktok-demo/reset">Start over</a></p>';
    res.send(page('TikTok Sandbox Demo — Quest Publications', body));
  });

  router.get('/reset', (req, res) => {
    const cookies = parseCookies(req);
    if (cookies.dfc_demo_sid) sessions.delete(cookies.dfc_demo_sid);
    res.setHeader('Set-Cookie', 'dfc_demo_sid=; Path=/tiktok-demo; Max-Age=0; HttpOnly; SameSite=Lax');
    res.redirect('/tiktok-demo');
  });

  router.get('/login', (req, res) => {
    if (!configured()) {
      res.status(503).send(page('Demo not configured',
        demoNote() + '<p>The sandbox credentials are not set on the server yet. '
        + 'Set TIKTOK_SANDBOX_CLIENT_KEY and TIKTOK_SANDBOX_CLIENT_SECRET and try again.</p>'
        + '<p><a href="/tiktok-demo">Back to the demo</a></p>'));
      return;
    }
    const s = getSession(req, res);
    s.state = crypto.randomBytes(24).toString('hex');
    const params = new URLSearchParams({
      client_key: process.env.TIKTOK_SANDBOX_CLIENT_KEY,
      scope: SCOPE,
      response_type: 'code',
      redirect_uri: redirectUri(),
      state: s.state,
    });
    res.redirect('https://www.tiktok.com/v2/auth/authorize/?' + params.toString());
  });

  router.get('/callback', async (req, res) => {
    const s = getSession(req, res);
    try {
      if (req.query.error) {
        res.send(page('Login not completed',
          '<p>TikTok returned an error: <strong>' + esc(req.query.error) + '</strong></p>'
          + '<p><a href="/tiktok-demo/login">Try the login again</a></p>'));
        return;
      }
      const code = req.query.code;
      const state = req.query.state;
      if (!code || !state || !s.state || state !== s.state) {
        res.status(400).send(page('Invalid session',
          '<p>This login did not come from the demo start page, or the session expired.</p>'
          + '<p><a href="/tiktok-demo/login">Start the login again</a></p>'));
        return;
      }
      delete s.state;
      const [st, resp] = await callApi('POST', 'https://open.tiktokapis.com/v2/oauth/token/', {
        form: {
          client_key: process.env.TIKTOK_SANDBOX_CLIENT_KEY,
          client_secret: process.env.TIKTOK_SANDBOX_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri(),
        },
      });
      const token = resp && resp.access_token;
      if (!token) {
        res.status(502).send(page('Login failed',
          '<p>Token exchange returned HTTP ' + esc(st) + ': '
          + esc(JSON.stringify(resp).slice(0, 400)) + '</p>'
          + '<p><a href="/tiktok-demo/login">Try the login again</a></p>'));
        return;
      }
      s.accessToken = token;
      s.openId = resp.open_id || '';
      let displayName = '(unknown)';
      try {
        const [, info] = await callApi('GET',
          'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name',
          { token });
        displayName = (((info || {}).data || {}).user || {}).display_name || displayName;
      } catch (_) { /* user-info failure does not undo the login */ }
      s.displayName = displayName;
      res.send(page('Step 2 — Login complete',
        '<p><strong>Login Kit worked: access token received.</strong></p>'
        + '<p>Sandbox user: <strong>' + esc(displayName) + '</strong></p>'
        + '<p><a href="/tiktok-demo/post">Continue to Direct Post →</a></p>'));
    } catch (e) {
      res.status(502).send(page('Login failed',
        '<p>Something went wrong talking to TikTok: <strong>' + esc(e.message) + '</strong></p>'
        + '<p><a href="/tiktok-demo/login">Try the login again</a></p>'));
    }
  });

  router.get('/post', (req, res) => {
    const s = getSession(req, res);
    if (!s.accessToken) {
      res.send(page('Login first',
        '<p>No login token yet.</p><p><a href="/tiktok-demo/login">Start the login</a></p>'));
      return;
    }
    res.send(page('Step 3 — Direct Post',
      '<form method="POST" action="/tiktok-demo/post">'
      + '<p><label>Caption / title for the test post<br>'
      + '<input name="title" value="' + esc(DEMO_TITLE) + '"></label></p>'
      + '<p><button type="submit">Upload test video via Direct Post</button></p></form>'
      + '<p>Posts to the sandbox test account as SELF_ONLY (private), as required for unaudited apps.</p>'));
  });

  router.post('/post', async (req, res) => {
    const s = getSession(req, res);
    if (!s.accessToken) {
      res.redirect('/tiktok-demo/login');
      return;
    }
    try {
      const title = (req.body && req.body.title ? String(req.body.title) : DEMO_TITLE).slice(0, 220);
      let clip;
      try {
        clip = fs.readFileSync(CLIP);
      } catch (_) {
        res.status(503).send(page('Test video missing',
          '<p>The demo test clip is not on the server.</p>'
          + '<p><a href="/tiktok-demo">Back to the demo</a></p>'));
        return;
      }
      const size = clip.length;
      const [st, resp] = await callApi('POST',
        'https://open.tiktokapis.com/v2/post/publish/video/init/',
        {
          token: s.accessToken,
          json: {
            post_info: { title, privacy_level: 'SELF_ONLY', disable_comment: true },
            source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 },
          },
        });
      const data = (resp && resp.data) || {};
      if (!data.upload_url) {
        res.status(502).send(page('Upload setup failed',
          '<p>Video init returned HTTP ' + esc(st) + ': '
          + esc(JSON.stringify(resp).slice(0, 500)) + '</p>'
          + '<p><a href="/tiktok-demo/post">Try again</a></p>'));
        return;
      }
      const upStatus = await putBytes(data.upload_url, clip, 'bytes 0-' + (size - 1) + '/' + size);
      s.publishId = data.publish_id || '';
      s.postStatus = 'Video bytes uploaded (HTTP ' + upStatus + '). Checking publish status…';
      let status = 'PROCESSING';
      for (let i = 0; i < 10; i++) {
        await sleep(3000);
        try {
          const [, chk] = await callApi('POST',
            'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
            { token: s.accessToken, json: { publish_id: s.publishId } });
          status = (((chk || {}).data || {}).status) || status;
        } catch (_) { /* keep polling */ }
        if (status === 'PUBLISH_COMPLETE' || status === 'SEND_TO_USER_INBOX' || status === 'FAILED') break;
      }
      s.postStatus = status;
      res.redirect('/tiktok-demo/posted');
    } catch (e) {
      res.status(502).send(page('Upload failed',
        '<p>Something went wrong talking to TikTok: <strong>' + esc(e.message) + '</strong></p>'
        + '<p><a href="/tiktok-demo/post">Try again</a></p>'));
    }
  });

  router.get('/status', async (req, res) => {
    const s = getSession(req, res);
    if (s.accessToken && s.publishId) {
      try {
        const [, chk] = await callApi('POST',
          'https://open.tiktokapis.com/v2/post/publish/status/fetch/',
          { token: s.accessToken, json: { publish_id: s.publishId } });
        const status = (((chk || {}).data || {}).status);
        if (status) s.postStatus = status;
      } catch (_) { /* show last known status */ }
    }
    res.redirect('/tiktok-demo/posted');
  });

  router.get('/posted', (req, res) => {
    const s = getSession(req, res);
    if (!s.publishId) {
      res.send(page('No post yet',
        '<p>No test post has been submitted in this session.</p>'
        + '<p><a href="/tiktok-demo/post">Post the test video</a></p>'));
      return;
    }
    res.send(page('Step 4 — Post submitted',
      '<p><strong>Direct Post worked.</strong></p>'
      + '<p>Publish ID: <strong>' + esc(s.publishId) + '</strong></p>'
      + '<p>Final status: <strong>' + esc(s.postStatus || 'unknown') + '</strong></p>'
      + '<p><a href="/tiktok-demo/status">Check status again</a> · '
      + '<a href="/tiktok-demo">Back to the demo</a></p>'));
  });

  return router;
}

module.exports = createRouter;
