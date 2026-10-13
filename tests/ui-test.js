// UI smoke test with the API mocked (no database here). Run: node ui-test.js
// Needs Playwright and a static server on :8765 serving ./public (python3 -m http.server 8765 -d public).
// The /api calls are mocked, so this checks the browser side only; it does not touch MySQL.
const { chromium } = require('playwright');
const BASE = 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const errors = [];
  let user = null; // mocked session
  const calls = [];
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g|Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    calls.push(m + ' ' + p + u.search);
    if (p === '/api/me') return user ? json(route, 200, { user }) : json(route, 401, { error: 'Please sign in.' });
    if (p === '/api/setup-status') return json(route, 200, { needsSetup: !user && !calls.includes('POST /api/setup') ? true : false });
    if (p === '/api/setup' && m === 'POST') { user = { id: 1, name: 'Dean Test', email: 'dean@test.edu', role: 'admin' }; return json(route, 200, { user }); }
    if (p === '/api/settings') return json(route, 200, { campusName: 'Campus Room Reservation', openTime: '07:00', closeTime: '20:00' });
    if (p === '/api/summary') return json(route, 200, { today: '2026-10-12', rooms: 0, approvedToday: 0, pending: 0, cancelRequests: 0, users: 1 });
    if (p === '/api/announcements') return json(route, 200, { announcements: [] });
    if (p === '/api/reservations') return json(route, 200, { reservations: [] });
    if (p === '/api/rooms') return json(route, 200, { rooms: [] });
    if (p === '/api/classes') return json(route, 200, { classes: [] });
    if (p === '/api/users') return json(route, 200, { users: [{ id: 1, name: 'Dean Test', email: 'dean@test.edu', role: 'admin', active: 1, created_at: '2026-10-12' }] });
    if (p === '/api/notifications') return json(route, 200, { notifications: [], unread: 0 });
    if (p === '/api/notifications/read') return json(route, 200, { ok: true });
    if (p === '/api/logout') { user = null; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: 'Not found (mock): ' + p });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#setup-form:not([hidden])');
  await page.screenshot({ path: 'ui-setup.png' });
  await page.fill('#setup-form [name=name]', 'Dean Test');
  await page.fill('#setup-form [name=email]', 'dean@test.edu');
  await page.fill('#setup-form [name=password]', 'Admin@12345');
  await page.fill('#setup-form [name=confirm]', 'Admin@12345');
  await page.click('#setup-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#view .stats');
  console.log('dashboard title:', await page.textContent('#page-title'));
  console.log('nav:', (await page.$$eval('#nav a', (a) => a.map((x) => x.textContent.trim()))).join(' | '));
  await page.screenshot({ path: 'ui-dashboard.png' });

  for (const pg of ['rooms', 'approvals', 'timetable', 'people', 'announcements', 'notifications', 'settings', 'profile']) {
    await page.evaluate((h) => { location.hash = '#/' + h; }, pg);
    await page.waitForTimeout(250);
    const t = await page.textContent('#view');
    console.log(pg.padEnd(14), 'ok, text length', t.trim().length, '| title', await page.textContent('#page-title'));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { location.hash = '#/rooms'; });
  await page.waitForTimeout(250);
  console.log('mobile overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await page.screenshot({ path: 'ui-mobile-rooms.png', fullPage: true });

  // Sign-out returns to sign-in (setup no longer needed)
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.click('#profile-btn'); await page.click('#logout');
  await page.waitForSelector('#auth:not([hidden])');
  console.log('after sign out, login form visible:', await page.isVisible('#login-form'));
  console.log('calls made:', calls.length);
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch((e) => { console.error('HARNESS', e.message); process.exit(1); });
