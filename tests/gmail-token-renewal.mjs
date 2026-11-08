// Checks that Gmail sync keeps running past Google's one-hour token lifetime, with Google sign-in and Gmail mocked.
//
//   cd tests && npm install && cd .. && python3 -m http.server 8000 &
//   node tests/gmail-token-renewal.mjs
//
// Env: TRACKLY_URL (default http://localhost:8000/trackly.html), BROWSER=webkit (default chromium), CHROME_PATH (default: Playwright's bundled Chromium).
import { chromium, webkit } from 'playwright-core';
import assert from 'node:assert/strict';

const URL = process.env.TRACKLY_URL || 'http://localhost:8000/trackly.html';
const browser = process.env.BROWSER === 'webkit' ? await webkit.launch()
  : await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });

async function setup({ seed, googleReplies }) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const authRequests = [], gmailAuth = [];
  await page.route('https://accounts.google.com/**', route => {
    const u = new globalThis.URL(route.request().url());
    authRequests.push(Object.fromEntries(u.searchParams));
    const reply = googleReplies[Math.min(authRequests.length - 1, googleReplies.length - 1)];
    const back = `${u.searchParams.get('redirect_uri')}#${new URLSearchParams({ ...reply, state: u.searchParams.get('state') })}`;
    // WebKit can't fulfill a navigation with a 302, so redirect from a stub page instead.
    return route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(back)})</script>` });
  });
  await page.route('https://gmail.googleapis.com/**', route => {
    gmailAuth.push(route.request().headers().authorization);
    const u = new globalThis.URL(route.request().url());
    if (u.pathname.endsWith('/profile')) return route.fulfill({ json: { emailAddress: 'edvina@example.com' } });
    if (route.request().headers().authorization === 'Bearer revoked') return route.fulfill({ status: 401, json: {} });
    return route.fulfill({ json: { messages: [] } });
  });
  await page.addInitScript(seed => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    localStorage.setItem('trackly_visited', '1');
    localStorage.setItem('trackly_user_name', 'Edvina');
    localStorage.setItem('trackly_gmail_client_id', 'cid.apps.googleusercontent.com');
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, typeof v === 'function' ? v() : String(v));
  }, Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, String(v)])));
  return { page, errors, authRequests, gmailAuth };
}

const status = page => page.evaluate(() => document.getElementById('gmail-status-wrap').innerText.trim());
const ls = (page, k) => page.evaluate(k => localStorage.getItem(k), k);

// 1. Token expired while Trackly was closed: renewed silently on open, then scanning resumes.
{
  const { page, errors, authRequests, gmailAuth } = await setup({
    seed: { trackly_gmail_token: 'old', trackly_gmail_token_expiry: Date.now() - 1000, trackly_gmail_connected: '1', trackly_gmail_email: 'edvina@example.com' },
    googleReplies: [{ access_token: 'renewed', expires_in: '3599', token_type: 'Bearer' }],
  });
  await page.goto(URL);
  await page.waitForFunction(() => document.getElementById('stext')?.textContent === 'Gmail Connected', null, { timeout: 15000 });
  assert.equal(authRequests.length, 1);
  assert.deepEqual([authRequests[0].prompt, authRequests[0].state.split('.')[0], authRequests[0].login_hint, authRequests[0].scope],
    ['none', 'renew', 'edvina@example.com', 'https://www.googleapis.com/auth/gmail.readonly']);
  assert.equal(await ls(page, 'trackly_gmail_token'), 'renewed');
  assert.ok(gmailAuth.length && gmailAuth.every(a => a === 'Bearer renewed'));
  assert.equal(new globalThis.URL(page.url()).hash, '', 'token removed from the address bar');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('ok: renews an expired token on open');
}

// 2. Google can't renew silently (signed out, or several accounts): sync pauses with a one-click resume, no redirect loop.
{
  const { page, errors, authRequests } = await setup({
    seed: { trackly_gmail_token: 'old', trackly_gmail_token_expiry: Date.now() - 1000, trackly_gmail_connected: '1' },
    googleReplies: [{ error: 'interaction_required' }, { access_token: 'after-click', expires_in: '3599' }],
  });
  await page.goto(URL);
  await page.waitForSelector('#btn-gmail-resume', { timeout: 15000 });
  await page.waitForTimeout(1500);
  assert.equal(authRequests.length, 1, 'does not retry in a loop');
  assert.match(await status(page), /Resume Gmail sync/i);
  assert.match(await page.evaluate(() => document.getElementById('email-log').innerText), /Couldn't renew Gmail access automatically \(interaction_required\)/);
  await page.click('#btn-gmail-resume');
  await page.waitForFunction(() => document.getElementById('stext')?.textContent === 'Gmail Connected', null, { timeout: 15000 });
  assert.equal(authRequests.length, 2);
  assert.equal(await ls(page, 'trackly_gmail_token'), 'after-click');
  assert.deepEqual(errors, []);
  await page.close();
  console.log('ok: pauses with a resume button when silent renewal is refused');
}

// 3. Token runs out while Trackly is open: waits while the tab is in use, renews once it's in the background.
{
  const { page, errors, authRequests } = await setup({
    seed: { trackly_gmail_token: 'short', trackly_gmail_token_expiry: Date.now() + 62_000, trackly_gmail_connected: '1' },
    googleReplies: [{ access_token: 'renewed-bg', expires_in: '3599' }],
  });
  await page.goto(URL);
  await page.waitForFunction(() => document.getElementById('stext')?.textContent === 'Gmail Connected', null, { timeout: 15000 });
  await page.waitForSelector('#btn-gmail-resume', { timeout: 15000 });
  assert.equal(authRequests.length, 0, 'does not navigate away from a tab in use');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForFunction(() => localStorage.getItem('trackly_gmail_token') === 'renewed-bg', null, { timeout: 15000 });
  assert.equal(authRequests.length, 1);
  assert.deepEqual(errors, []);
  await page.close();
  console.log('ok: renews in the background when the token runs out mid-session');
}

// 4. Gmail rejects the token (revoked or clock skew): treated like expiry instead of failing silently.
{
  const { page, errors, authRequests } = await setup({
    seed: { trackly_gmail_token: 'revoked', trackly_gmail_token_expiry: Date.now() + 3600_000, trackly_gmail_connected: '1' },
    googleReplies: [{ error: 'login_required' }],
  });
  await page.goto(URL);
  await page.waitForSelector('#btn-gmail-resume', { timeout: 15000 });
  assert.equal(authRequests.length, 0);
  assert.deepEqual(errors, []);
  await page.close();
  console.log('ok: a rejected token pauses sync with a resume button');
}

await browser.close();
console.log('All Gmail token renewal checks passed.');
