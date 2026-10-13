/* Campus Room Reservation: front end. Every record comes from the server (MySQL). Nothing is hardcoded. */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const DAYS_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ROLE = { admin: 'Administrator (Dean)', teacher: 'Teacher', student: 'Student' };
  const STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };

  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (s) => parseDate(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const weekday = (s) => (parseDate(s).getDay() + 6) % 7 + 1; // 1 = Monday ... 7 = Sunday
  const badge = (status) => `<span class="badge b-${esc(status)}">${esc(STATUS[status] || status)}</span>`;
  const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;
  const initials = (name) => String(name || '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opts); }
    catch { throw new Error('Cannot reach the server. Is it still running?'); }
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status}).`); err.status = res.status; throw err; }
    return data;
  }
  const get = (p) => api('GET', p);
  const post = (p, b = {}) => api('POST', p, b);

  let toastTimer;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3800);
  }

  // ---------- app state and navigation by role ----------
  const state = { me: null, settings: { campusName: 'Campus Room Reservation', openTime: '07:00', closeTime: '20:00' } };

  // Main navigation for each role. Students see only what is for students.
  const NAV = {
    admin: [['dashboard', 'Dashboard'], ['approvals', 'Approvals'], ['rooms', 'Rooms'], ['timetable', 'Sections'], ['people', 'People'], ['announcements', 'Announcements'], ['settings', 'Settings']],
    teacher: [['dashboard', 'Dashboard'], ['request', 'Request a room'], ['bookings', 'My bookings'], ['timetable', 'My sections'], ['rooms', 'Rooms'], ['announcements', 'Announcements']],
    student: [['dashboard', 'Home'], ['timetable', 'My week'], ['announcements', 'Announcements']],
  };
  // Pages reachable from the top bar (bell and profile menu), for every role.
  const TOP_PAGES = { notifications: 'Notifications', profile: 'My profile' };
  const TITLES = Object.assign({
    dashboard: 'Dashboard', approvals: 'Approvals', rooms: 'Rooms', timetable: 'Sections', people: 'People',
    announcements: 'Announcements', settings: 'Settings', request: 'Request a room', bookings: 'My bookings',
  }, TOP_PAGES);
  const STUDENT_TITLES = { dashboard: 'Home', timetable: 'My week', announcements: 'Announcements' };
  const TEACHER_TITLES = { timetable: 'My sections', rooms: 'Rooms' };

  const currentPage = () => (location.hash.replace(/^#\//, '') || 'dashboard');
  const allowedPage = (page) => (state.me && (NAV[state.me.role].some(([k]) => k === page) || page in TOP_PAGES));
  function titleOf(page) {
    if (state.me?.role === 'student' && STUDENT_TITLES[page]) return STUDENT_TITLES[page];
    if (state.me?.role === 'teacher' && TEACHER_TITLES[page]) return TEACHER_TITLES[page];
    return TITLES[page] || '';
  }

  // ---------- sign-in, registration and setup ----------
  function showAuth(mode) {
    $('#app').hidden = true;
    $('#auth').hidden = false;
    $('#login-form').hidden = mode !== 'login';
    $('#register-form').hidden = mode !== 'register';
    $('#setup-form').hidden = mode !== 'setup';
    $('#auth-campus').textContent = state.settings.campusName;
    const form = { login: $('#login-form'), register: $('#register-form'), setup: $('#setup-form') }[mode];
    form.querySelectorAll('[data-error]').forEach((e) => { e.textContent = ''; });
    setTimeout(() => form.querySelector('input')?.focus(), 0);
  }
  document.querySelectorAll('[data-switch]').forEach((b) => b.addEventListener('click', () => showAuth(b.dataset.switch)));

  async function loadSettings() {
    try { state.settings = await get('/api/settings'); } catch { /* keep defaults */ }
    $('#side-campus').textContent = state.settings.campusName;
    $('#auth-campus').textContent = state.settings.campusName;
    document.title = state.settings.campusName;
  }

  function setProfileUI() {
    const u = state.me;
    $('#avatar').textContent = initials(u.name);
    $('#pname').textContent = u.name;
    $('#menu-name').textContent = u.name;
    $('#menu-email').textContent = u.email;
    $('#menu-role').textContent = ROLE[u.role];
  }

  async function enterApp(user) {
    state.me = user;
    await loadSettings();
    $('#auth').hidden = true;
    $('#app').hidden = false;
    setProfileUI();
    if (!location.hash || !allowedPage(currentPage())) location.hash = '#/dashboard';
    else render();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = f.querySelector('[data-error]');
    err.textContent = '';
    try {
      const { user } = await post('/api/login', { email: f.email.value.trim(), password: f.password.value });
      f.password.value = '';
      await enterApp(user);
    } catch (ex) { err.textContent = ex.message; }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = f.querySelector('[data-error]');
    err.textContent = '';
    if (f.password.value !== f.confirm.value) { err.textContent = 'The two passwords do not match.'; return; }
    try {
      const { user } = await post('/api/register', {
        name: f.name.value.trim(), email: f.email.value.trim(), password: f.password.value, joinCode: f.joinCode.value.trim(),
      });
      f.password.value = ''; f.confirm.value = '';
      toast('Welcome! You have joined your section.');
      await enterApp(user);
    } catch (ex) { err.textContent = ex.message; }
  });

  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const err = f.querySelector('[data-error]');
    err.textContent = '';
    if (f.password.value !== f.confirm.value) { err.textContent = 'The two passwords do not match.'; return; }
    try {
      const { user } = await post('/api/setup', { name: f.name.value.trim(), email: f.email.value.trim(), password: f.password.value });
      f.password.value = ''; f.confirm.value = '';
      toast('Administrator account created.');
      await enterApp(user);
    } catch (ex) { err.textContent = ex.message; }
  });

  // ---------- top bar: navigation, bell, profile menu ----------
  function renderNav() {
    $('#nav').innerHTML = NAV[state.me.role].map(([key, label]) =>
      `<a href="#/${key}" data-page="${key}" ${key === currentPage() ? 'aria-current="page"' : ''}>${esc(label)}</a>`).join('');
  }

  function setMenu(open) {
    $('#profile-menu').hidden = !open;
    $('#profile-btn').setAttribute('aria-expanded', String(open));
  }
  $('#profile-btn').addEventListener('click', (e) => { e.stopPropagation(); setMenu($('#profile-menu').hidden); });
  document.addEventListener('click', (e) => { if (!$('#profile').contains(e.target)) setMenu(false); });
  $('#profile-menu').addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });

  // ---------- light / dark mode (saved per browser, light by default) ----------
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'; }
  function paintThemeToggle() { $('#theme-toggle').textContent = currentTheme() === 'dark' ? 'Light mode' : 'Dark mode'; }
  function setTheme(theme) {
    if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    try { localStorage.setItem('cr-theme', theme); } catch (e) { /* storage blocked: theme still applies for this page */ }
    paintThemeToggle();
  }
  $('#theme-toggle').addEventListener('click', (e) => { e.stopPropagation(); setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); setMenu(false); });
  paintThemeToggle();

  async function refreshBell() {
    try {
      const { unread } = await get('/api/notifications');
      const c = $('#bell-count');
      c.hidden = !unread;
      c.textContent = unread > 99 ? '99+' : String(unread);
    } catch { /* ignore */ }
  }

  $('#logout').addEventListener('click', async () => {
    setMenu(false);
    try { await post('/api/logout'); } catch { /* ignore */ }
    state.me = null;
    location.hash = '';
    boot();
  });

  // ---------- views ----------
  const VIEWS = {};

  function emptyBox(msg) { return `<div class="empty">${esc(msg)}</div>`; }
  function renderDenied(root) {
    root.innerHTML = `<section class="card"><h2>Not available</h2><p class="muted">Your account cannot open this page.</p></section>`;
  }
  function annItem(a) {
    return `<li><strong>${esc(a.title)}</strong><span>${esc(a.body)}</span><span class="muted">${esc(a.author)} · ${esc(a.created_at)}</span></li>`;
  }

  // Busy blocks for one room on one date: approved bookings, requests and classes.
  function busyBlocks(reservations, classes, roomId, date) {
    const blocks = [];
    for (const r of reservations) {
      if (r.room_id !== roomId || r.booking_date !== date) continue;
      if (r.status !== 'approved' && r.status !== 'pending') continue;
      const label = r.status === 'approved' ? ((r.mine || state.me.role === 'admin') ? r.title : 'Booked') : 'Requested';
      blocks.push({ start: r.start_time, end: r.end_time, label, cls: r.status === 'approved' ? '' : 'req' });
    }
    const dow = weekday(date);
    for (const c of classes) {
      if (c.room_id !== roomId || c.day_of_week !== dow) continue;
      blocks.push({ start: c.start_time, end: c.end_time, label: `Class ${c.code}`, cls: 'cls' });
    }
    return blocks.sort((a, b) => a.start.localeCompare(b.start));
  }
  const busyHtml = (blocks) => blocks.length
    ? `<div class="busy">${blocks.map((b) => `<span class="${b.cls}">${esc(b.start)}–${esc(b.end)} · ${esc(b.label)}</span>`).join('')}</div>`
    : '<span class="free">Free all day within opening hours</span>';

  // Which approved bookings or classes overlap a pending request.
  function clashesFor(r, reservations, classes) {
    const out = [];
    for (const o of reservations) {
      if (o.id === r.id || o.room_id !== r.room_id || o.booking_date !== r.booking_date || o.status !== 'approved') continue;
      if (overlaps(o.start_time, o.end_time, r.start_time, r.end_time)) {
        out.push(o.mine || state.me.role === 'admin' ? `booking "${o.title}"` : 'another booking');
      }
    }
    const dow = weekday(r.booking_date);
    for (const c of classes) {
      if (c.room_id === r.room_id && c.day_of_week === dow && overlaps(c.start_time, c.end_time, r.start_time, r.end_time)) {
        out.push(`class ${c.code}`);
      }
    }
    return out;
  }

  // Student home: only the student's own classes.
  async function studentHome(root) {
    const [{ classes }, summary] = await Promise.all([get('/api/classes'), get('/api/summary')]);
    const today = (() => { const d = new Date().getDay(); return d === 0 ? 7 : d; })();
    const todays = classes.filter((c) => c.day_of_week === today);
    root.innerHTML = `
      <section class="stats" aria-label="Summary">
        <div class="stat"><div class="n">${esc(summary.mySections)}</div><div class="l">My sections</div></div>
        <div class="stat"><div class="n">${esc(todays.length)}</div><div class="l">Classes today</div></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Today: ${esc(DAYS[today])}</h2>
          <a class="btn" href="#/timetable">Open my week</a></div>
        ${todays.length ? `<ul class="list">${todays.map((c) => `<li><strong>${esc(c.start_time)}–${esc(c.end_time)} · ${esc(c.code)} ${esc(c.name)}</strong><span>Room ${esc(c.room_code)} · ${esc(c.room_name)}</span><span class="muted">Teacher: ${esc(c.teacher_name)}</span></li>`).join('')}</ul>`
          : emptyBox('No classes today.')}
      </section>
      <section class="card">
        <h2>My classes</h2>
        ${classes.length ? `<ul class="list">${classes.map((c) => `<li><strong>${esc(c.code)} · ${esc(c.name)}</strong><span>${esc(DAYS[c.day_of_week])} ${esc(c.start_time)}–${esc(c.end_time)} · Room ${esc(c.room_code)}</span><span class="muted">Teacher: ${esc(c.teacher_name)}</span></li>`).join('')}</ul>`
          : emptyBox('You have not joined a section yet. Enter the section code from your teacher on the sign-up page.')}
      </section>`;
  }

  VIEWS.dashboard = async (root) => {
    const role = state.me.role;
    if (role === 'student') return studentHome(root);
    const [summary, ann] = await Promise.all([get('/api/summary'), get('/api/announcements')]);
    const mine = role === 'teacher' ? await get('/api/reservations?mine=1&status=approved') : { reservations: [] };
    const stats = [['Rooms available', summary.rooms], ['Approved today', summary.approvedToday]];
    if (role === 'admin') {
      stats.push(['Pending requests', summary.pending], ['Cancellation requests', summary.cancelRequests], ['Active users', summary.users]);
    } else {
      stats.push(['My sections', summary.mySections], ['My pending requests', summary.pending], ['My upcoming bookings', summary.myApproved]);
    }
    const upcoming = mine.reservations.filter((r) => r.booking_date >= todayStr()).slice(0, 5);

    const mainCard = role === 'teacher'
      ? (upcoming.length
        ? `<ul class="list">${upcoming.map((r) => `<li><strong>${esc(r.title)}</strong><span class="muted">${esc(fmtDate(r.booking_date))} · ${esc(r.start_time)}–${esc(r.end_time)} · ${esc(r.room_code)}</span></li>`).join('')}</ul>`
        : emptyBox('No upcoming approved bookings.'))
      : (ann.announcements.length ? `<ul class="list">${ann.announcements.slice(0, 4).map(annItem).join('')}</ul>` : emptyBox('No announcements yet.'));

    const sideCard = role === 'admin'
      ? `<div class="row"><a class="btn primary" href="#/approvals">Review requests</a><a class="btn" href="#/rooms">Manage rooms</a><a class="btn" href="#/people">Add users</a></div>`
      : `<p>Rooms can be booked between <strong>${esc(state.settings.openTime)}</strong> and <strong>${esc(state.settings.closeTime)}</strong>.</p>
         <div class="row"><a class="btn primary" href="#/request">Request a room</a><a class="btn" href="#/timetable">My sections</a></div>`;

    root.innerHTML = `
      <section class="stats" aria-label="Summary">
        ${stats.map(([l, n]) => `<div class="stat"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`).join('')}
      </section>
      <div class="grid-2">
        <section class="card">
          <h2>${role === 'teacher' ? 'My upcoming bookings' : 'Latest announcements'}</h2>
          ${mainCard}
        </section>
        <section class="card">
          <h2>${role === 'admin' ? 'Quick actions' : 'Campus hours'}</h2>
          ${sideCard}
        </section>
      </div>`;
  };

  VIEWS.rooms = async (root) => {
    const isAdmin = state.me.role === 'admin';
    const date = root.dataset.date || todayStr();
    const [{ rooms }, { reservations }, { classes }] = await Promise.all([
      get('/api/rooms'),
      get(`/api/reservations?from=${date}&to=${date}`),
      get('/api/classes'),
    ]);
    root.innerHTML = `
      <section class="card">
        <div class="card-head">
          <div><h2>Rooms and availability</h2><p class="muted">Pick a date to see what is booked. You see whether a slot is taken, not who booked it.</p></div>
          <div class="row">
            <label style="min-width:180px">Date<input type="date" id="avail-date" value="${esc(date)}"></label>
            ${isAdmin ? '<button class="btn gold" data-action="room-add">Add room</button>' : ''}
          </div>
        </div>
        ${rooms.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Room</th><th>Location</th><th>Capacity</th><th>Equipment</th><th>Status on ${esc(fmtDate(date))}</th>${isAdmin ? '<th>Actions</th>' : ''}</tr></thead>
          <tbody>${rooms.map((rm) => `
            <tr>
              <td><strong>${esc(rm.code)}</strong><br><span class="muted">${esc(rm.name)}</span>${rm.active ? '' : '<br><span class="badge b-cancelled">Inactive</span>'}</td>
              <td>${esc([rm.building, rm.floor ? 'Floor ' + rm.floor : ''].filter(Boolean).join(' · ') || '—')}</td>
              <td>${esc(rm.capacity || '—')}</td>
              <td>${esc(rm.equipment || '—')}</td>
              <td>${rm.active ? busyHtml(busyBlocks(reservations, classes, rm.id, date)) : '<span class="muted">Not in use</span>'}</td>
              ${isAdmin ? `<td><div class="actions"><button class="btn small" data-action="room-edit" data-id="${rm.id}">Edit</button><button class="btn small danger" data-action="room-del" data-id="${rm.id}">Delete</button></div></td>` : ''}
            </tr>`).join('')}
          </tbody></table></div>`
          : emptyBox(isAdmin ? 'No rooms yet. Click "Add room" to create the first one.' : 'No rooms have been added yet. Ask the administrator to add rooms.')}
      </section>`;
    $('#avail-date', root).addEventListener('change', (e) => { $('#view').dataset.date = e.target.value; render(); });
  };

  VIEWS.request = async (root) => {
    if (state.me.role !== 'teacher') return renderDenied(root);
    const [{ rooms }, { classes }] = await Promise.all([get('/api/rooms'), get('/api/classes')]);
    const active = rooms.filter((r) => r.active);
    root.innerHTML = `
      <section class="card">
        <div><h2>Request a room</h2><p class="muted">Your request goes to the administrator for approval. Choose the section it is for, so its students see it on their week view. Hours: ${esc(state.settings.openTime)}–${esc(state.settings.closeTime)}.</p></div>
        ${active.length ? `
        <form id="req-form" class="stack" novalidate>
          <div class="grid-form">
            <label class="full">Room<select name="room_id" required>${active.map((r) => `<option value="${r.id}">${esc(r.code)} · ${esc(r.name)}</option>`).join('')}</select></label>
            <label class="full">Section (optional)<select name="class_id"><option value="">No section, general booking</option>${classes.map((c) => `<option value="${c.id}">${esc(c.code)} · ${esc(c.name)} (${esc(DAYS[c.day_of_week])})</option>`).join('')}</select></label>
            <label>Date<input type="date" name="booking_date" required min="${todayStr()}" value="${todayStr()}"></label>
            <label>Title<input name="title" required maxlength="150" placeholder="e.g. Chemistry review session"></label>
            <label>Start time<input type="time" name="start_time" required value="09:00"></label>
            <label>End time<input type="time" name="end_time" required value="10:00"></label>
            <label class="full">Purpose (optional)<textarea name="purpose" maxlength="1000"></textarea></label>
          </div>
          <div id="req-check" class="card" style="padding:14px" aria-live="polite"></div>
          <div class="form-error" id="req-error"></div>
          <div class="row end"><button class="btn" type="button" id="req-check-btn">Check availability</button><button class="btn primary" type="submit">Send request</button></div>
        </form>` : emptyBox('No rooms are available to book yet.')}
      </section>`;
    const form = $('#req-form', root);
    if (!form) return;
    const checkAvail = async () => {
      const roomId = Number(form.room_id.value), date = form.booking_date.value;
      if (!date) return;
      const [{ reservations }, { classes: all }] = await Promise.all([get(`/api/reservations?from=${date}&to=${date}&room_id=${roomId}`), get('/api/classes')]);
      $('#req-check').innerHTML = `<strong>Busy on ${esc(fmtDate(date))}</strong><div style="margin-top:8px">${busyHtml(busyBlocks(reservations, all, roomId, date))}</div>`;
    };
    $('#req-check-btn', root).addEventListener('click', () => checkAvail().catch((e) => toast(e.message, 'bad')));
    form.room_id.addEventListener('change', () => checkAvail().catch(() => {}));
    form.booking_date.addEventListener('change', () => checkAvail().catch(() => {}));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#req-error').textContent = '';
      const body = {
        room_id: Number(form.room_id.value), booking_date: form.booking_date.value,
        start_time: form.start_time.value, end_time: form.end_time.value,
        title: form.title.value.trim(), purpose: form.purpose.value.trim(),
      };
      if (form.class_id.value) body.class_id = Number(form.class_id.value);
      try {
        await post('/api/reservations', body);
        toast('Request sent to the administrator.');
        location.hash = '#/bookings';
      } catch (ex) { $('#req-error').textContent = ex.message; }
    });
    checkAvail().catch(() => {});
  };

  VIEWS.bookings = async (root) => {
    if (state.me.role !== 'teacher') return renderDenied(root);
    const { reservations } = await get('/api/reservations?mine=1');
    root.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>My bookings</h2><p class="muted">Pending requests wait for approval. Cancelling an approved booking asks the administrator first.</p></div>
        <a class="btn primary" href="#/request">New request</a></div>
        ${reservations.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Time</th><th>Room</th><th>Section</th><th>Title</th><th>Status</th><th></th></tr></thead>
          <tbody>${reservations.map((r) => `
            <tr>
              <td>${esc(fmtDate(r.booking_date))}</td>
              <td>${esc(r.start_time)}–${esc(r.end_time)}</td>
              <td>${esc(r.room_code)}</td>
              <td>${esc(r.class_code || '—')}</td>
              <td>${esc(r.title)}${r.decision_note ? `<br><span class="muted">${esc(r.decision_note)}</span>` : ''}</td>
              <td>${badge(r.status)}${r.cancel_requested ? '<br><span class="badge b-pending">Cancellation requested</span>' : ''}</td>
              <td>${canCancel(r) ? `<button class="btn small danger" data-action="res-cancel" data-id="${r.id}">${r.status === 'pending' ? 'Withdraw' : 'Request cancellation'}</button>` : ''}</td>
            </tr>`).join('')}
          </tbody></table></div>`
          : emptyBox('You have not sent any requests yet.')}
      </section>`;
  };

  const canCancel = (r) => (r.status === 'pending' || (r.status === 'approved' && !r.cancel_requested)) && (state.me.role === 'admin' || r.mine);

  VIEWS.approvals = async (root) => {
    if (state.me.role !== 'admin') return renderDenied(root);
    const tab = root.dataset.tab || 'pending';
    const [{ reservations }, { classes }] = await Promise.all([get('/api/reservations'), get('/api/classes')]);
    const groups = {
      pending: reservations.filter((r) => r.status === 'pending'),
      cancel: reservations.filter((r) => r.cancel_requested),
      history: reservations.filter((r) => r.status !== 'pending' && !r.cancel_requested),
    };
    const labels = { pending: `Pending (${groups.pending.length})`, cancel: `Cancellation requests (${groups.cancel.length})`, history: 'History' };
    const rows = groups[tab];
    root.innerHTML = `
      <section class="card">
        <div class="tabs" role="tablist">${Object.keys(labels).map((k) => `<button class="tab" role="tab" aria-selected="${k === tab}" data-tab="${k}">${esc(labels[k])}</button>`).join('')}</div>
        ${rows.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Requested by</th><th>Section</th><th>Date</th><th>Time</th><th>Room</th><th>Title and purpose</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${rows.map((r) => {
            const clashes = tab === 'pending' ? clashesFor(r, reservations, classes) : [];
            return `
            <tr>
              <td>${esc(r.user_name)}</td>
              <td>${esc(r.class_code || '—')}</td>
              <td>${esc(fmtDate(r.booking_date))}</td>
              <td>${esc(r.start_time)}–${esc(r.end_time)}</td>
              <td>${esc(r.room_code)}</td>
              <td><strong>${esc(r.title)}</strong>${r.purpose ? `<br><span class="muted">${esc(r.purpose)}</span>` : ''}${r.decision_note ? `<br><span class="muted">Note: ${esc(r.decision_note)}</span>` : ''}
                ${clashes.length ? `<br><span class="clash">Clashes with ${esc(clashes.join(', '))}</span>` : ''}</td>
              <td>${badge(r.status)}</td>
              <td><div class="actions">${approvalActions(r, tab)}</div></td>
            </tr>`;}).join('')}
          </tbody></table></div>`
          : emptyBox(tab === 'pending' ? 'No pending requests.' : tab === 'cancel' ? 'No cancellation requests.' : 'No past decisions yet.')}
      </section>`;
    root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { $('#view').dataset.tab = b.dataset.tab; render(); }));
  };

  function approvalActions(r, tab) {
    if (tab === 'pending') return `<button class="btn small primary" data-action="res-approve" data-id="${r.id}">Approve</button><button class="btn small danger" data-action="res-reject" data-id="${r.id}">Decline</button>`;
    if (tab === 'cancel') return `<button class="btn small primary" data-action="cancel-yes" data-id="${r.id}">Approve cancellation</button><button class="btn small" data-action="cancel-no" data-id="${r.id}">Keep booking</button>`;
    return r.status === 'approved' ? `<button class="btn small danger" data-action="res-cancel-admin" data-id="${r.id}">Cancel booking</button>` : '';
  }

  // Sections: students see their week; teachers and the administrator manage sections and join codes.
  VIEWS.timetable = async (root) => {
    const role = state.me.role;
    const { classes } = await get('/api/classes');

    if (role === 'student') {
      const today = (() => { const d = new Date().getDay(); return d === 0 ? 7 : d; })();
      const cols = [1, 2, 3, 4, 5, 6, 7].map((d) => {
        const items = classes.filter((c) => c.day_of_week === d);
        return `<div class="day ${d === today ? 'today' : ''}"><h3>${DAYS_SHORT[d]}</h3>
          ${items.length ? items.map((c) => `<div class="slot"><strong>${esc(c.start_time)}–${esc(c.end_time)}</strong>
            <span>${esc(c.code)} · ${esc(c.name)}</span><span class="muted">Room ${esc(c.room_code)} · ${esc(c.teacher_name)}</span></div>`).join('') : '<span class="muted">No class</span>'}
        </div>`;
      }).join('');
      root.innerHTML = `
        <section class="card">
          <p class="muted">Your classes, rooms and times. If a class is missing, check the section code with your teacher.</p>
          ${classes.length ? `<div class="week">${cols}</div>` : emptyBox('You have not joined a section yet. Enter the section code from your teacher on the sign-up page.')}
        </section>`;
      return;
    }

    const isAdmin = role === 'admin';
    root.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>${isAdmin ? 'All sections' : 'My sections'}</h2>
          <p class="muted">Give students the join code so they can create their account and join. Sections block their room, so bookings cannot overlap them.</p></div>
          <button class="btn gold" data-action="class-add">Add section</button></div>
        ${classes.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Section</th><th>Day and time</th><th>Room</th>${isAdmin ? '<th>Teacher</th>' : ''}<th>Students</th><th>Join code</th><th>Actions</th></tr></thead>
          <tbody>${classes.map((c) => `
            <tr>
              <td><strong>${esc(c.code)}</strong><br><span class="muted">${esc(c.name)}</span></td>
              <td>${esc(DAYS[c.day_of_week])}<br><span class="muted">${esc(c.start_time)}–${esc(c.end_time)}</span></td>
              <td>${esc(c.room_code)}</td>
              ${isAdmin ? `<td>${esc(c.teacher_name)}</td>` : ''}
              <td>${esc(c.student_count)}</td>
              <td><span class="join">${esc(c.join_code)}</span></td>
              <td><div class="actions">
                <button class="btn small" data-action="class-edit" data-id="${c.id}">Edit</button>
                <button class="btn small" data-action="class-roster" data-id="${c.id}">Students</button>
                <button class="btn small" data-action="class-newcode" data-id="${c.id}">New code</button>
                <button class="btn small danger" data-action="class-del" data-id="${c.id}">Delete</button>
              </div></td>
            </tr>`).join('')}
          </tbody></table></div>`
          : emptyBox('No sections yet. Add a section, then share its join code with your students.')}
      </section>`;
  };

  VIEWS.people = async (root) => {
    if (state.me.role !== 'admin') return renderDenied(root);
    const { users } = await get('/api/users');
    root.innerHTML = `
      <section class="card">
        <div class="card-head"><div><h2>People</h2><p class="muted">Students normally create their own accounts with a section code. You can also add people here.</p></div>
        <button class="btn gold" data-action="user-add">Add user</button></div>
        ${users.length ? `
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(ROLE[u.role])}</td>
              <td>${u.active ? '<span class="badge b-approved">Active</span>' : '<span class="badge b-cancelled">Inactive</span>'}</td>
              <td>${esc(u.created_at)}</td>
              <td>${u.role === 'admin' ? '<span class="muted">—</span>' : `<div class="actions">
                <button class="btn small" data-action="user-role" data-id="${u.id}" data-role="${u.role === 'teacher' ? 'student' : 'teacher'}">Make ${u.role === 'teacher' ? 'student' : 'teacher'}</button>
                <button class="btn small ${u.active ? 'danger' : ''}" data-action="user-toggle" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Activate'}</button></div>`}</td>
            </tr>`).join('')}
          </tbody></table></div>`
          : emptyBox('No users yet.')}
      </section>`;
  };

  VIEWS.announcements = async (root) => {
    const isAdmin = state.me.role === 'admin';
    const { announcements } = await get('/api/announcements');
    root.innerHTML = `
      ${isAdmin ? `
      <section class="card">
        <h2>Post an announcement</h2>
        <form id="ann-form" class="stack" novalidate>
          <label>Title<input name="title" required maxlength="150"></label>
          <label>Message<textarea name="body" required maxlength="5000"></textarea></label>
          <div class="form-error" id="ann-error"></div>
          <div class="row end"><button class="btn primary" type="submit">Post</button></div>
        </form>
      </section>` : ''}
      <section class="card">
        <h2>Announcements</h2>
        ${announcements.length ? `<ul class="list">${announcements.map((a) => `
          <li><strong>${esc(a.title)}</strong><span>${esc(a.body)}</span>
          <span class="row muted" style="justify-content:space-between"><span>${esc(a.author)} · ${esc(a.created_at)}</span>
          ${isAdmin ? `<button class="btn small danger" data-action="ann-del" data-id="${a.id}">Delete</button>` : ''}</span></li>`).join('')}</ul>`
          : emptyBox('No announcements yet.')}
      </section>`;
    const form = $('#ann-form', root);
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#ann-error').textContent = '';
      try {
        await post('/api/announcements', { title: form.title.value.trim(), body: form.body.value.trim() });
        toast('Announcement posted.');
        render();
      } catch (ex) { $('#ann-error').textContent = ex.message; }
    });
  };

  VIEWS.notifications = async (root) => {
    const { notifications, unread } = await get('/api/notifications');
    root.innerHTML = `
      <section class="card">
        <div class="card-head"><h2>Notifications</h2>${unread ? '<button class="btn small" data-action="notif-read">Mark all as read</button>' : ''}</div>
        ${notifications.length ? `<ul class="list">${notifications.map((n) => `
          <li class="${n.is_read ? '' : 'unread'}"><span>${esc(n.message)}</span><span class="muted">${esc(n.created_at)}</span></li>`).join('')}</ul>`
          : emptyBox('You have no notifications.')}
      </section>`;
    if (unread) { await post('/api/notifications/read').catch(() => {}); refreshBell(); }
  };

  VIEWS.settings = async (root) => {
    if (state.me.role !== 'admin') return renderDenied(root);
    const s = state.settings;
    root.innerHTML = `
      <section class="card">
        <h2>Campus settings</h2>
        <p class="muted">These values control the name shown on screen and when rooms can be booked.</p>
        <form id="set-form" class="stack" novalidate>
          <div class="grid-form">
            <label class="full">Campus name<input name="campusName" required maxlength="100" value="${esc(s.campusName)}"></label>
            <label>Bookings open at<input type="time" name="openTime" required value="${esc(s.openTime)}"></label>
            <label>Bookings close at<input type="time" name="closeTime" required value="${esc(s.closeTime)}"></label>
          </div>
          <div class="form-error" id="set-error"></div>
          <div class="row end"><button class="btn primary" type="submit">Save settings</button></div>
        </form>
      </section>`;
    $('#set-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      $('#set-error').textContent = '';
      try {
        state.settings = await api('PUT', '/api/settings', { campusName: f.campusName.value.trim(), openTime: f.openTime.value, closeTime: f.closeTime.value });
        await loadSettings();
        toast('Settings saved.');
      } catch (ex) { $('#set-error').textContent = ex.message; }
    });
  };

  VIEWS.profile = async (root) => {
    root.innerHTML = `
      <section class="card">
        <h2>My profile</h2>
        <p class="muted">${esc(state.me.email)} · ${esc(ROLE[state.me.role])}</p>
        <form id="name-form" class="stack" novalidate>
          <label>Full name<input name="name" required maxlength="100" value="${esc(state.me.name)}"></label>
          <div class="form-error" id="name-error"></div>
          <div class="row end"><button class="btn primary" type="submit">Save name</button></div>
        </form>
      </section>
      <section class="card">
        <h2>Change password</h2>
        <form id="pw-form" class="stack" novalidate>
          <label>Current password<input type="password" name="currentPassword" required autocomplete="current-password"></label>
          <label>New password<input type="password" name="newPassword" required minlength="8" autocomplete="new-password"><span class="hint">At least 8 characters.</span></label>
          <label>Confirm new password<input type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
          <div class="form-error" id="pw-error"></div>
          <div class="row end"><button class="btn primary" type="submit">Change password</button></div>
        </form>
      </section>`;
    $('#name-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      $('#name-error').textContent = '';
      try {
        const { user } = await api('PATCH', '/api/me', { name: e.currentTarget.name.value.trim() });
        state.me = user;
        setProfileUI();
        toast('Name updated.');
      } catch (ex) { $('#name-error').textContent = ex.message; }
    });
    $('#pw-form', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.currentTarget;
      $('#pw-error').textContent = '';
      if (f.newPassword.value !== f.confirm.value) { $('#pw-error').textContent = 'The new passwords do not match.'; return; }
      try {
        await api('PATCH', '/api/me', { currentPassword: f.currentPassword.value, newPassword: f.newPassword.value });
        f.reset();
        toast('Password changed.');
      } catch (ex) { $('#pw-error').textContent = ex.message; }
    });
  };

  // ---------- modal helpers ----------
  function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
  function showInfo(title, bodyHtml) {
    const modal = $('#modal');
    modal.hidden = false;
    modal.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h3 id="m-title">${esc(title)}</h3>${bodyHtml}
      <div class="row end"><button class="btn primary" type="button" data-close>Close</button></div></div>`;
    modal.querySelector('[data-close]').addEventListener('click', closeModal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  }

  function openForm({ title, fields, submitLabel = 'Save', onSubmit }) {
    const modal = $('#modal');
    const fieldHtml = (f) => {
      const id = 'f_' + f.name;
      const value = f.value ?? '';
      let control;
      if (f.type === 'select') control = `<select id="${id}" name="${f.name}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') control = `<textarea id="${id}" name="${f.name}" maxlength="${f.max || 1000}">${esc(value)}</textarea>`;
      else control = `<input id="${id}" name="${f.name}" type="${f.type || 'text'}" value="${esc(value)}" ${f.required ? 'required' : ''} ${f.max ? `maxlength="${f.max}"` : ''} ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.type === 'password' ? 'autocomplete="new-password"' : ''}>`;
      return `<label class="${f.full ? 'full' : ''}">${esc(f.label)}${control}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
    };
    modal.hidden = false;
    modal.innerHTML = `
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <form id="m-form" class="stack" novalidate>
          <h3 id="m-title">${esc(title)}</h3>
          <div class="grid-form">${fields.map(fieldHtml).join('')}</div>
          <div class="form-error" id="m-error"></div>
          <div class="row end">
            <button class="btn ghost" type="button" data-close>Cancel</button>
            <button class="btn primary" type="submit">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>`;
    const form = $('#m-form', modal);
    modal.onclick = (e) => { if (e.target === modal) closeModal(); };
    modal.querySelector('[data-close]').addEventListener('click', closeModal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = {};
      for (const f of fields) {
        const el = form.elements[f.name];
        values[f.name] = el ? el.value.trim() : '';
      }
      $('#m-error', modal).textContent = '';
      try {
        const result = await onSubmit(values);
        closeModal();
        if (result && result.join_code) toast(`Section saved. Join code: ${result.join_code}`);
        render();
      } catch (ex) { $('#m-error', modal).textContent = ex.message; }
    });
    form.elements[fields[0].name]?.focus();
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#modal').hidden) closeModal(); setMenu(false); }
  });

  // ---------- actions (clicks inside the main view) ----------
  const confirmAsk = (msg) => window.confirm(msg);
  function roomPayload(v) {
    return { code: v.code, name: v.name, building: v.building, floor: v.floor, capacity: Number(v.capacity || 0), equipment: v.equipment, active: v.active === '1' };
  }

  async function sectionForm(id) {
    const isAdmin = state.me.role === 'admin';
    const [{ rooms }, usersRes, { classes }] = await Promise.all([
      get('/api/rooms'),
      isAdmin ? get('/api/users') : Promise.resolve({ users: [] }),
      get('/api/classes'),
    ]);
    const existing = id ? classes.find((c) => String(c.id) === String(id)) : null;
    const activeRooms = rooms.filter((r) => r.active);
    if (!activeRooms.length) return toast('The administrator must add an active room first.', 'bad');
    const teachers = usersRes.users.filter((u) => u.role === 'teacher' && u.active);
    if (isAdmin && !teachers.length) return toast('Add a teacher account first (People page).', 'bad');
    const fields = [
      { name: 'code', label: 'Section code', required: true, max: 30, value: existing?.code || '', hint: 'e.g. BSCS-2A' },
      { name: 'name', label: 'Subject or section name', required: true, max: 120, value: existing?.name || '' },
    ];
    if (isAdmin) fields.push({ name: 'teacher_id', label: 'Teacher', type: 'select', value: existing?.teacher_id || teachers[0].id, options: teachers.map((t) => [t.id, t.name]), full: true });
    fields.push(
      { name: 'room_id', label: 'Room', type: 'select', value: existing?.room_id || activeRooms[0].id, options: activeRooms.map((r) => [r.id, `${r.code} · ${r.name}`]), full: true },
      { name: 'day_of_week', label: 'Day', type: 'select', value: existing?.day_of_week || 1, options: [1, 2, 3, 4, 5, 6, 7].map((d) => [d, DAYS[d]]) },
      { name: 'start_time', label: 'Start time', type: 'time', required: true, value: existing?.start_time || '09:00' },
      { name: 'end_time', label: 'End time', type: 'time', required: true, value: existing?.end_time || '10:00' },
    );
    openForm({
      title: existing ? 'Edit section' : 'Add section',
      submitLabel: existing ? 'Save section' : 'Add section',
      fields,
      onSubmit: (v) => {
        const body = { ...v, room_id: Number(v.room_id), day_of_week: Number(v.day_of_week) };
        if (isAdmin) body.teacher_id = Number(v.teacher_id);
        return existing ? api('PUT', `/api/classes/${existing.id}`, body) : post('/api/classes', body);
      },
    });
  }

  const ACTIONS = {
    'room-add': () => openForm({
      title: 'Add room', submitLabel: 'Add room',
      fields: [
        { name: 'code', label: 'Room code', required: true, max: 20, hint: 'Short code, e.g. SH-101' },
        { name: 'name', label: 'Room name', required: true, max: 100 },
        { name: 'building', label: 'Building', max: 100 },
        { name: 'floor', label: 'Floor', max: 20 },
        { name: 'capacity', label: 'Capacity (seats)', type: 'number', min: 0 },
        { name: 'equipment', label: 'Equipment', max: 255, full: true, hint: 'e.g. Projector, whiteboard, sound system' },
        { name: 'active', label: 'Status', type: 'select', value: '1', options: [['1', 'Active (can be booked)'], ['0', 'Inactive']], full: true },
      ],
      onSubmit: (v) => post('/api/rooms', roomPayload(v)),
    }),
    'room-edit': async (el) => {
      const { rooms } = await get('/api/rooms');
      const rm = rooms.find((r) => String(r.id) === el.dataset.id);
      if (!rm) throw new Error('Room not found.');
      openForm({
        title: 'Edit room', submitLabel: 'Save room',
        fields: [
          { name: 'code', label: 'Room code', required: true, max: 20, value: rm.code },
          { name: 'name', label: 'Room name', required: true, max: 100, value: rm.name },
          { name: 'building', label: 'Building', max: 100, value: rm.building },
          { name: 'floor', label: 'Floor', max: 20, value: rm.floor },
          { name: 'capacity', label: 'Capacity (seats)', type: 'number', min: 0, value: rm.capacity },
          { name: 'equipment', label: 'Equipment', max: 255, full: true, value: rm.equipment },
          { name: 'active', label: 'Status', type: 'select', value: String(rm.active), options: [['1', 'Active (can be booked)'], ['0', 'Inactive']], full: true },
        ],
        onSubmit: (v) => api('PUT', `/api/rooms/${rm.id}`, roomPayload(v)),
      });
    },
    'room-del': async (el) => {
      if (!confirmAsk('Delete this room? This cannot be undone.')) return;
      await api('DELETE', `/api/rooms/${el.dataset.id}`);
      toast('Room deleted.'); render();
    },
    'res-cancel': async (el) => {
      if (!confirmAsk('Send this cancellation? Approved bookings need the administrator to agree.')) return;
      await post(`/api/reservations/${el.dataset.id}/cancel`);
      toast('Done.'); render();
    },
    'res-cancel-admin': async (el) => {
      if (!confirmAsk('Cancel this approved booking?')) return;
      await post(`/api/reservations/${el.dataset.id}/cancel`);
      toast('Booking cancelled.'); render();
    },
    'res-approve': async (el) => {
      if (!confirmAsk('Approve this request? It will block the room for that time.')) return;
      await post(`/api/reservations/${el.dataset.id}/decide`, { decision: 'approve' });
      toast('Request approved.'); render();
    },
    'res-reject': (el) => openForm({
      title: 'Decline request', submitLabel: 'Decline',
      fields: [{ name: 'note', label: 'Reason (shown to the teacher)', type: 'textarea', max: 255, full: true, value: '' }],
      onSubmit: (v) => post(`/api/reservations/${el.dataset.id}/decide`, { decision: 'reject', note: v.note }),
    }),
    'cancel-yes': async (el) => {
      await post(`/api/reservations/${el.dataset.id}/cancel-decision`, { approve: true });
      toast('Cancellation approved.'); render();
    },
    'cancel-no': async (el) => {
      await post(`/api/reservations/${el.dataset.id}/cancel-decision`, { approve: false });
      toast('The booking stays.'); render();
    },
    'class-add': () => sectionForm(null),
    'class-edit': (el) => sectionForm(el.dataset.id),
    'class-del': async (el) => {
      if (!confirmAsk('Delete this section? Students will no longer see it. Bookings made for it stay, without a section.')) return;
      await api('DELETE', `/api/classes/${el.dataset.id}`);
      toast('Section deleted.'); render();
    },
    'class-newcode': async (el) => {
      if (!confirmAsk('Create a new join code? The old code will stop working. Students who already joined keep their place.')) return;
      const { join_code } = await post(`/api/classes/${el.dataset.id}/new-code`);
      showInfo('New join code', `<p>Share this code with your students:</p><p><span class="join" style="font-size:20px">${esc(join_code)}</span></p>`);
      render();
    },
    'class-roster': async (el) => {
      const { students } = await get(`/api/classes/${el.dataset.id}/roster`);
      showInfo('Students in this section', students.length
        ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Joined</th></tr></thead><tbody>${students.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.email)}</td><td>${esc(s.joined_at)}</td></tr>`).join('')}</tbody></table></div>`
        : emptyBox('No students have joined yet. Share the join code with them.'));
    },
    'user-add': () => openForm({
      title: 'Add user', submitLabel: 'Create account',
      fields: [
        { name: 'name', label: 'Full name', required: true, max: 100 },
        { name: 'email', label: 'Email', type: 'email', required: true, max: 190 },
        { name: 'role', label: 'Role', type: 'select', value: 'teacher', options: [['teacher', 'Teacher'], ['student', 'Student']] },
        { name: 'password', label: 'Temporary password', type: 'password', required: true, min: 8, hint: 'At least 8 characters. Share it privately.', full: true },
      ],
      onSubmit: (v) => post('/api/users', v),
    }),
    'user-role': async (el) => {
      await api('PATCH', `/api/users/${el.dataset.id}`, { role: el.dataset.role });
      toast('Role updated.'); render();
    },
    'user-toggle': async (el) => {
      const on = el.dataset.active === '1';
      if (!confirmAsk(on ? 'Activate this account?' : 'Deactivate this account? The person will be signed out and cannot sign in.')) return;
      await api('PATCH', `/api/users/${el.dataset.id}`, { active: on });
      toast(on ? 'Account activated.' : 'Account deactivated.'); render();
    },
    'ann-del': async (el) => {
      if (!confirmAsk('Delete this announcement?')) return;
      await api('DELETE', `/api/announcements/${el.dataset.id}`);
      toast('Announcement deleted.'); render();
    },
    'notif-read': async () => { await post('/api/notifications/read'); refreshBell(); render(); },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (!$('#view').contains(el) && !$('#modal').contains(el)) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    Promise.resolve().then(() => fn(el)).catch((ex) => toast(ex.message, 'bad'));
  });

  // ---------- rendering ----------
  let renderSeq = 0;
  async function render() {
    if (!state.me) return;
    const page = currentPage();
    if (!allowedPage(page)) { location.hash = '#/dashboard'; return; }
    const seq = ++renderSeq;
    const view = $('#view');
    if (view.dataset.page !== page) { view.dataset.page = page; view.dataset.date = ''; view.dataset.tab = ''; }
    $('#page-title').textContent = titleOf(page);
    document.title = `${titleOf(page)} · ${state.settings.campusName}`;
    renderNav();
    const root = document.createElement('div');
    root.style.display = 'grid';
    root.style.gap = '20px';
    root.dataset.tab = view.dataset.tab || '';
    root.dataset.date = view.dataset.date || '';
    try {
      await VIEWS[page](root);
    } catch (ex) {
      root.innerHTML = `<section class="card"><h2>Could not load this page</h2><p class="muted">${esc(ex.message)}</p></section>`;
      if (ex.status === 401) { state.me = null; boot(); return; }
    }
    if (seq !== renderSeq) return;
    view.replaceChildren(...root.childNodes);
    refreshBell();
  }

  window.addEventListener('hashchange', () => { if (state.me) render(); });

  // ---------- startup ----------
  async function boot() {
    await loadSettings();
    try {
      const { user } = await get('/api/me');
      return enterApp(user);
    } catch (e) { /* not signed in: fall through to the sign-in screens */ }
    try {
      const { needsSetup } = await get('/api/setup-status');
      showAuth(needsSetup ? 'setup' : 'login');
    } catch {
      showAuth('login');
      $('#login-form [data-error]').textContent = 'Cannot reach the server. Start it with "npm start" and reload.';
    }
  }
  boot();
})();
