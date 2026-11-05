// Runs Trackly's Gmail scan against sample emails, with the Gmail and Anthropic APIs mocked (no real inbox).
//
//   cd tests && npm install && cd .. && python3 -m http.server 8000 &
//   node tests/gmail-sample-emails.mjs [screenshot.png]
//
// Env: TRACKLY_URL (default http://localhost:8000/trackly.html), CHROME_PATH (default: Playwright's bundled Chromium).
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const URL = process.env.TRACKLY_URL || 'http://localhost:8000/trackly.html';
const SHOT = process.argv[2];
const b64 = s => Buffer.from(s, 'utf8').toString('base64url');
const day = d => Date.parse(`2026-${d}T15:00:00Z`);

const EMAILS = [
  { id: 'm01', threadId: 't-acme', at: day('10-01'), from: 'Acme Hiring Team <no-reply@us.greenhouse-mail.io>',
    subject: 'Thank you for applying to Acme',
    text: 'Hi Edvina,\n\nThank you for applying for the Senior Data Scientist position at Acme. We have received your application and our team is reviewing it.\nIf your experience is a match, we will reach out to schedule an interview. If we decide not to move forward, we will let you know.\n\nAcme Talent' },
  { id: 'm02', threadId: 't-acme-2', at: day('10-01'), from: 'Acme Careers <careers@acme.com>',
    subject: 'Application received: Senior Data Scientist',
    text: 'We received your application for the Senior Data Scientist role at Acme.' },
  { id: 'm03', threadId: 't-nw', at: day('10-03'), from: 'LinkedIn <jobs-noreply@linkedin.com>',
    subject: 'Edvina, your application was sent to Northwind Analytics',
    text: 'Your application was sent to Northwind Analytics\nData Analyst\nNorthwind Analytics · Remote\nApplied on October 3, 2026' },
  { id: 'm04', threadId: 't-globex', at: day('10-05'), from: 'Globex Careers <globex@myworkday.com>',
    subject: 'Application Confirmation',
    html: '<html><head><style>p{color:#333}</style></head><body><p>Dear Edvina,</p><p>Thank you for your interest in Globex Corporation. We have received your application for the Machine Learning Engineer role.</p><p>Qualified candidates will be invited to a phone screen.</p></body></html>' },
  { id: 'm05', threadId: 't-acme-int', at: day('10-12'), from: 'Sarah Chen <sarah.chen@acme.com>',
    subject: 'Interview invitation - Senior Data Scientist',
    text: "Hi Edvina,\n\nWe'd like to invite you to interview for the Senior Data Scientist role at Acme. Please select a time that works for you: https://calendly.com/acme-recruiting\n\nBest,\nSarah" },
  { id: 'm06', threadId: 't-nw-offer', at: day('10-20'), from: 'Northwind People Team <people@northwind.io>',
    subject: 'Your offer from Northwind Analytics',
    text: 'Dear Edvina,\n\nWe are delighted to extend an offer for the Data Analyst position at Northwind Analytics. Your offer letter is attached.' },
  { id: 'm07', threadId: 't-initech', at: day('10-14'), from: 'Initech Recruiting <recruiting@initech.com>',
    subject: 'Phone screen with Initech',
    text: "Hi Edvina, thanks for your application. We'd like to schedule a phone screen for the Product Analyst role at Initech. What's your availability next week?" },
  { id: 'm08', threadId: 't-globex', at: day('10-18'), from: 'Globex Careers <globex@myworkday.com>',
    subject: 'Update on your application',
    text: 'Thank you for your interest in Globex. Unfortunately, we have decided to move forward with other candidates for the Machine Learning Engineer role.' },
  { id: 'm09', threadId: 't-news', at: day('10-19'), from: 'Data Weekly <news@dataweekly.com>',
    subject: 'Your application of the week: dbt tips',
    text: 'Ten dbt tips to apply this week.' },
  { id: 'm10', threadId: 't-umbrella', at: day('10-21'), from: 'Jamie Park <jamie@umbrella.dev>',
    subject: 'Quick question',
    text: 'Hey Edvina, loved what you sent over for our Analytics Engineer opening. Are you free Thursday to talk it through with the team?' },
  // Newsletters and promos that mention interviews/offers, including tracked companies, must not move anything.
  { id: 'm11', threadId: 't-muse', at: day('10-22'), from: 'The Muse <newsletter@themuse.com>', bulk: true,
    subject: '5 interview mistakes that cost candidates the offer',
    text: 'Before your next interview at Contoso or Google, read these tips. We would love to invite you to our free webinar on negotiating your job offer.' },
  { id: 'm12', threadId: 't-li-promo', at: day('10-23'), from: 'LinkedIn <messages-noreply@linkedin.com>', labels: ['CATEGORY_PROMOTIONS'],
    subject: 'Land your next job offer faster',
    text: 'Edvina, try Premium free for 1 month. Members get 2x more interview invitations from Contoso and others.' },
  { id: 'm13', threadId: 't-contoso-news', at: day('10-24'), from: 'Contoso Careers <careers@contoso.com>', bulk: true,
    subject: 'Contoso interview day is coming to Berlin',
    text: 'Join Contoso for our open interview day. Meet hiring managers across engineering.' },
  { id: 'm14', threadId: 't-wf-alert', at: day('10-24'), from: 'Wellfound <jobs@wellfound.com>', bulk: true,
    subject: 'Interview-ready roles at Hooli',
    text: 'Jobs you may be interested in: Data Scientist at Hooli. Hooli is interviewing this week.' },
  // Scheduling tools send real invites as bulk mail: they may update a tracked app but not create one.
  { id: 'm15', threadId: 't-contoso-int', at: day('10-25'), from: 'Contoso via GoodTime <no-reply@goodtime.io>', bulk: true,
    subject: 'Interview with Contoso',
    text: 'Hi Edvina, we would like to invite you to an interview for the Data Engineer role at Contoso. Please select a time using the link below.' },
];

function gmailMessage(e) {
  const headers = [{ name: 'Subject', value: e.subject }, { name: 'From', value: e.from }, { name: 'Date', value: new Date(e.at).toUTCString() }];
  if (e.bulk) headers.push({ name: 'List-Unsubscribe', value: '<mailto:unsubscribe@example.com>' });
  const payload = e.html
    ? { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/html', body: { data: b64(e.html) } }] }
    : { mimeType: 'multipart/alternative', headers, parts: [{ mimeType: 'text/plain', body: { data: b64(e.text) } }] };
  return { id: e.id, threadId: e.threadId, labelIds: ['INBOX', ...(e.labels || [])], internalDate: String(e.at), snippet: (e.text || '').slice(0, 100), payload };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const gmailCalls = [];
await page.route('https://gmail.googleapis.com/**', route => {
  const u = new globalThis.URL(route.request().url());
  gmailCalls.push(u.pathname + u.search);
  assert.equal(route.request().headers().authorization, 'Bearer fake-token');
  const m = u.pathname.match(/messages\/([^/]+)$/);
  if (m) return route.fulfill({ json: gmailMessage(EMAILS.find(e => e.id === m[1])) });
  // Gmail lists newest first.
  return route.fulfill({ json: { messages: [...EMAILS].sort((a, b) => b.at - a.at).map(e => ({ id: e.id, threadId: e.threadId })) } });
});

const aiRequests = [];
await page.route('https://api.anthropic.com/**', route => {
  const req = route.request();
  aiRequests.push({ headers: req.headers(), body: req.postDataJSON() });
  const prompt = req.postDataJSON().messages[0].content;
  const out = prompt.includes('Quick question')
    ? { isJobRelated: true, emailType: 'interview_invite', matchedAppId: null, company: 'Umbrella', role: 'Analytics Engineer', summary: 'Invitation to talk with the team.' }
    : { isJobRelated: false, emailType: 'not_related', matchedAppId: null, company: null, role: null, summary: '' };
  return route.fulfill({ json: { content: [{ type: 'text', text: JSON.stringify(out) }] } });
});

await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  localStorage.clear();
  localStorage.setItem('trackly_visited', '1');
  localStorage.setItem('trackly_user_name', 'Edvina');
  localStorage.setItem('trackly_gmail_token', 'fake-token');
  localStorage.setItem('trackly_gmail_token_expiry', String(Date.now() + 3600e3));
  localStorage.setItem('trackly_api_key', 'sk-ant-test');
  localStorage.setItem('trackly_apps', JSON.stringify([{ id: 1, company: 'Contoso', role: 'Data Engineer', date: '2026-09-28', city: 'Berlin', referral: 'No', response: 'Pending', round1: false, round2: false, round3: false, decision: 'Pending' }]));
});

const apps = () => page.evaluate(() => JSON.parse(localStorage.getItem('trackly_apps')));
const waitIdle = () => page.waitForFunction(() => document.getElementById('stext')?.textContent === 'Gmail Connected', null, { timeout: 30000 });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.getElementById('stext'), null, { timeout: 10000 });
await page.waitForTimeout(300);
await waitIdle();

let list = await apps();
const by = c => list.filter(a => a.company === c);
console.table(list.map(a => ({ company: a.company, role: a.role, date: a.date, response: a.response, interview: !!(a.round1 || a.round2 || a.round3), decision: a.decision, source: a.source || 'manual' })));

assert.equal(list.length, 6, 'one app per job: Contoso + Acme, Northwind, Globex, Initech, Umbrella');
assert.equal(by('Acme').length, 1, 'duplicate Acme confirmation must not create a second app');
assert.deepEqual([by('Acme')[0].role, by('Acme')[0].date, by('Acme')[0].source, by('Acme')[0].round1], ['Senior Data Scientist', '2026-10-01', 'gmail', true]);
assert.equal(by('Northwind Analytics')[0].decision, 'Offer');
assert.equal(by('Northwind Analytics')[0].role, 'Data Analyst', 'role filled in from the offer email');
assert.equal(by('Northwind Analytics')[0].date, '2026-10-03');
assert.deepEqual([by('Globex Corporation')[0].role, by('Globex Corporation')[0].decision, by('Globex Corporation')[0].round1], ['Machine Learning Engineer', 'Rejected', false], 'conditional "will be invited to a phone screen" is not an interview');
assert.deepEqual([by('Initech')[0].role, by('Initech')[0].round1], ['Product Analyst', true], 'interview with no prior confirmation creates the app');
assert.deepEqual([by('Umbrella')[0].role, by('Umbrella')[0].round1], ['Analytics Engineer', true], 'AI fallback result applied');
assert.deepEqual([by('Contoso')[0].decision, by('Contoso')[0].round1], ['Pending', true], 'bulk-sent scheduling invite updates the tracked app');
assert.ok(!list.some(a => /weekly|muse|hooli|wellfound|linkedin/i.test(a.company)), 'newsletters, job alerts and promos ignored');
assert.ok(!list.some(a => a.decision === 'Offer' && a.company !== 'Northwind Analytics'), 'promo "job offer" is not an offer');

const aiSubjects = aiRequests.map(r => r.body.messages[0].content.match(/Subject:"([^"]*)"/)[1]);
assert.deepEqual(aiSubjects.sort(), ['5 interview mistakes that cost candidates the offer', 'Contoso interview day is coming to Berlin', 'Interview-ready roles at Hooli', 'Land your next job offer faster', 'Quick question', 'Your application of the week: dbt tips'], 'AI only called for emails the rules could not classify');
assert.ok(aiRequests.find(r => r.body.messages[0].content.includes('Interview-ready')).body.messages[0].content.includes('mass mail'), 'AI is told when an email is mass mail');
assert.equal(aiRequests[0].headers['x-api-key'], 'sk-ant-test');
assert.equal(aiRequests[0].headers['anthropic-dangerous-direct-browser-access'], 'true');

assert.ok(gmailCalls.every(c => !c.includes('/send') && !c.includes('/modify') && !c.includes('/trash')), 'read-only Gmail calls');
assert.ok(gmailCalls.some(c => c.includes('format=full')));

const stats = await page.$$eval('#stats-bar > div', ds => ds.map(d => d.innerText.replace(/\s+/g, ' ')));
console.log(stats);
assert.match(stats[1], /Interview Rate 67% 4 of 6 applications got an interview/i);
assert.match(stats[2], /Offer Rate 17% 1 of 6 applications got an offer/i);

// Rescan, including after forgetting which emails were processed: content-based dedup must still hold.
await page.evaluate(() => scanEmails()); await waitIdle();
await page.evaluate(() => { localStorage.removeItem('trackly_done_emails'); localStorage.removeItem('trackly_last_scan_date'); return scanEmails(); }); await waitIdle();
assert.equal((await apps()).length, 6, 'rescans do not create duplicates');

const scope = await page.evaluate(() => new globalThis.URL(gmailAuthUrl('cid', 'none')).searchParams.get('scope'));
assert.equal(scope, 'https://www.googleapis.com/auth/gmail.readonly', 'only the read-only scope is requested');
assert.deepEqual(errors, []);

if (SHOT) {
  await page.evaluate(() => {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    document.querySelector('header').style.position = 'static';
    document.getElementById('li-quick-btn').style.display = 'none';
    if (!logOpen) toggleLog();
  });
  await page.evaluate(() => document.getElementById('email-log-wrap').scrollIntoView());
  const top = await page.$eval('#email-log-wrap', el => el.getBoundingClientRect().top + window.scrollY);
  const bottom = await page.$eval('#table-container', el => el.getBoundingClientRect().bottom + window.scrollY);
  await page.screenshot({ path: SHOT, fullPage: true, clip: { x: 0, y: Math.max(0, top - 16), width: 1360, height: bottom - top + 32 } });
  console.log('screenshot:', SHOT);
}
await browser.close();
console.log('All Gmail sample-email checks passed.');
