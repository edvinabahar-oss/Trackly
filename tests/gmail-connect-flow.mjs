// Connect Gmail end to end with Google's OAuth endpoint and the Gmail API mocked.
//
//   python3 -m http.server 8000 &
//   BROWSER=webkit node tests/gmail-connect-flow.mjs     # Safari's engine; BROWSER=chromium also works
//
// Env: TRACKLY_URL (default http://localhost:8000/trackly.html), CHROME_PATH for chromium.
import { webkit, chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const URL_ = process.env.TRACKLY_URL || 'http://localhost:8000/trackly.html';
const engine = process.env.BROWSER === 'chromium' ? chromium : webkit;
const DEFAULT_ID = '89086489779-er6lib8c6dk55hfqs4g5e1936bmcbdnq.apps.googleusercontent.com';
const STALE_ID = '538567438708-10kgtak498gb4gmbvuk6p0m3hmi42ei0.apps.googleusercontent.com';

const browser = await engine.launch(engine === chromium ? { executablePath: process.env.CHROME_PATH || undefined } : {});
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));
const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

let authMode = 'grant';
const authRequests = [];
await ctx.route('https://accounts.google.com/**', route => {
  const u = new URL(route.request().url());
  authRequests.push(Object.fromEntries(u.searchParams));
  const p = u.searchParams;
  const frag = authMode === 'deny'
    ? `error=access_denied&state=${p.get('state')}`
    : `access_token=fake-token&token_type=Bearer&expires_in=3599&scope=${encodeURIComponent(p.get('scope'))}&state=${authMode === 'forged' ? 'nope' : p.get('state')}`;
  // WebKit can't fulfill a navigation with a 302, so redirect from a stub page instead.
  return route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(`${p.get('redirect_uri')}#${frag}`)})</script>` });
});
const listCalls = [];
await ctx.route('https://gmail.googleapis.com/**', route => {
  assert.equal(route.request().headers().authorization, 'Bearer fake-token');
  if (new URL(route.request().url()).pathname.endsWith('/profile')) return route.fulfill({ json: { emailAddress: 'edvina@example.com' } });
  listCalls.push(Date.now());
  return route.fulfill({ json: { messages: [] } });
});
await ctx.addInitScript(staleId => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  localStorage.clear();
  localStorage.setItem('trackly_visited', '1');
  localStorage.setItem('trackly_user_name', 'Edvina');
  // Saved by an older Trackly version before the registered client ID became the default.
  localStorage.setItem('trackly_gmail_client_id', staleId);
}, STALE_ID);

const connected = () => page.evaluate(() => document.getElementById('stext')?.textContent || '');
const backFromGoogle = () => page.waitForURL(u => u.href.startsWith(URL_) && !u.hash, { timeout: 15000 }).catch(() => {});
// Connect Gmail goes straight to Google; the setup modal only opens from Settings.
const connect = async (via = '#btn-gmail-connect') => {
  const before = authRequests.length;
  if (via === 'settings') {
    await page.click('#btn-gmail-settings');
    assert.equal(await page.inputValue('#gmail-client-id'), DEFAULT_ID, 'client ID is prefilled');
    assert.equal(await page.isEditable('#gmail-client-id'), true, 'client ID stays editable');
    await Promise.all([backFromGoogle(), page.click('text=Authorize with Google')]);
  } else {
    await Promise.all([backFromGoogle(), page.click(via)]);
  }
  await page.waitForTimeout(1500);
  assert.equal(authRequests.length, before + 1, 'went to Google');
  assert.equal(authRequests.at(-1).client_id, DEFAULT_ID);
};

await page.goto(URL_);
assert.deepEqual(errors, [], 'script parses and runs');
assert.equal(await page.evaluate(() => /\(\?<[=!]/.test([...document.scripts].map(s => s.textContent).join(''))), false, 'no regex lookbehind');
assert.equal(await page.evaluate(() => localStorage.getItem('trackly_gmail_client_id')), DEFAULT_ID, 'stale saved client ID migrated');
assert.equal(await page.evaluate(() => document.getElementById('gmail-modal').classList.contains('open')), false, 'setup modal not open on load');

// Cancel on Google's screen: no token, a clear message.
authMode = 'deny';
await connect();
assert.match(dialogs.pop() || '', /access_denied/);
assert.equal(await page.evaluate(() => localStorage.getItem('trackly_gmail_token')), null);

// A response whose state doesn't match is rejected.
authMode = 'forged';
await connect('settings');
assert.match(dialogs.pop() || '', /could not be verified/);
assert.equal(await page.evaluate(() => localStorage.getItem('trackly_gmail_token')), null);

// Real grant.
authMode = 'grant';
listCalls.length = 0;
await connect('#btn-gmail-banner-connect');
const req = authRequests.at(-1);
assert.equal(req.client_id, DEFAULT_ID);
assert.equal(req.redirect_uri, URL_);
assert.equal(req.response_type, 'token');
assert.equal(req.scope, 'https://www.googleapis.com/auth/gmail.readonly');
assert.ok(req.state && req.state.length > 8);
assert.equal(await connected(), 'Gmail Connected');
assert.equal(new URL(page.url()).hash, '', 'token removed from the address bar');
assert.equal(await page.evaluate(() => localStorage.getItem('trackly_gmail_token')), 'fake-token');
await page.waitForTimeout(1500);
assert.equal(listCalls.length, 1, 'one scan after connecting, not two');
assert.equal(await page.evaluate(() => localStorage.getItem('trackly_gmail_client_id')), DEFAULT_ID);

// Reload keeps the session.
listCalls.length = 0;
await page.reload();
await page.waitForTimeout(1500);
assert.equal(await connected(), 'Gmail Connected', 'token survives reload');
assert.equal(listCalls.length, 1);
assert.equal(await page.evaluate(() => document.getElementById('gmail-modal').classList.contains('open')), false, 'setup modal stays closed when connected');
assert.deepEqual(dialogs, []);
assert.deepEqual(errors, []);

await browser.close();
console.log(`Connect flow passed in ${engine.name()} ${browser.version()}.`);
