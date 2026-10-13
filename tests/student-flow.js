// Student sign-up flow with mocked API. Run with the static server on :8765 (see ui-test.js).
const { chromium } = require('playwright');
const BASE = 'http://localhost:8765/';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const errors = [];
  let user = null;
  const sections = [{ id: 1, code: 'BSCS-2A', name: 'Intro to Programming', teacher_name: 'Dr. Cruz', room_code: 'SH-101', room_id: 1, day_of_week: 1, start_time: '09:00', end_time: '10:30' }];
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_TUNNEL|fonts\.g|Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text()); });
  let registerBody = null;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const p = u.pathname, m = req.method();
    if (p === '/api/me') return user ? json(route, 200, { user }) : json(route, 401, { error: 'Please sign in.' });
    if (p === '/api/setup-status') return json(route, 200, { needsSetup: false });
    if (p === '/api/settings') return json(route, 200, { campusName: 'Campus Room Reservation', openTime: '07:00', closeTime: '20:00' });
    if (p === '/api/register' && m === 'POST') {
      registerBody = req.postDataJSON();
      if (registerBody.joinCode.toUpperCase() !== 'GOODCODE') return json(route, 400, { error: 'That section code is not valid. Check it with your teacher.' });
      user = { id: 9, name: registerBody.name, email: registerBody.email, role: 'student' };
      return json(route, 200, { user });
    }
    if (p === '/api/summary') return json(route, 200, { rooms: 1, approvedToday: 0, mySections: user ? 1 : 0 });
    if (p === '/api/announcements') return json(route, 200, { announcements: [] });
    if (p === '/api/classes') return json(route, 200, { classes: sections });
    if (p === '/api/reservations') return json(route, 200, { reservations: [] });
    if (p === '/api/rooms') return json(route, 200, { rooms: [] });
    if (p === '/api/notifications') return json(route, 200, { notifications: [], unread: 0 });
    if (p === '/api/logout') { user = null; return json(route, 200, { ok: true }); }
    return json(route, 404, { error: 'Not found (mock): ' + p });
  });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('#login-form:not([hidden])');
  await page.click('[data-switch=register]');
  await page.waitForSelector('#register-form:not([hidden])');
  await page.fill('#register-form [name=name]', 'Maria Santos');
  await page.fill('#register-form [name=email]', 'maria@test.edu');
  await page.fill('#register-form [name=password]', 'Student@123');
  await page.fill('#register-form [name=confirm]', 'Student@123');
  await page.fill('#register-form [name=joinCode]', 'BADCODE1');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#register-form [data-error]:not(:empty)');
  console.log('bad code message:', await page.textContent('#register-form [data-error]'));
  await page.fill('#register-form [name=joinCode]', 'goodcode');
  await page.click('#register-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForSelector('#view .stats');
  console.log('sent joinCode as:', registerBody.joinCode, '| nav:', (await page.$$eval('#nav a', (a) => a.map((x) => x.textContent.trim()))).join(' | '));
  await page.screenshot({ path: 'student-dashboard.png' });

  await page.evaluate(() => { location.hash = '#/timetable'; });
  await page.waitForSelector('.week');
  console.log('week columns:', await page.$$eval('.week .day', (d) => d.length), '| block text:', await page.textContent('.week .slot'));
  await page.screenshot({ path: 'student-week.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  console.log('mobile overflow:', await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth));
  await page.setViewportSize({ width: 1280, height: 860 });

  await page.click('#profile-btn'); await page.click('#logout');
  await page.waitForSelector('#login-form:not([hidden])');
  console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
  await browser.close();
})().catch((e) => { console.error('HARNESS', e.message); process.exit(1); });
