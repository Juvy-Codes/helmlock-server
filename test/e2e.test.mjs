// Walks through the whole HelmLock flow the way the app and the cabinet use it.
// Run with:  npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'Asia/Manila';
process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'helmlock-')), 'db.json');
process.env.LOCKER_KEY = 'test-key';
process.env.OPEN_HOUR = '0'; // so the test passes at any time of day
process.env.CLOSE_HOUR = '24';
process.env.RATE_LIMIT_MAX = '1000';
process.env.SMS_DRIVER = 'log';

const { createApp } = await import('../app.js');
const { db, saveNow } = await import('../lib/store.js');
const svc = await import('../lib/service.js');

let server;
let base;

const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function call(method, url, body, { token, key } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(key ? { 'X-Locker-Key': key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, body: data };
}

const KEY = 'test-key';
const scan = (token, coins, locker) => call('POST', '/api/locker/scan', { token, coins, ...(locker ? { locker } : {}) }, { key: KEY });

before(async () => {
  svc.seed(true);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Shared between the steps below
const ctx = {};

test('server is up and the sample admin can log in', async () => {
  assert.equal((await call('GET', '/up')).body.ok, true);
  const r = await call('POST', '/api/login', { email: 'admin@helmlock.test', password: 'password' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'admin');
  ctx.admin = r.body.token;
  const dash = await call('GET', '/api/admin/dashboard', null, { token: ctx.admin });
  assert.equal(dash.status, 200);
  ctx.moneyBefore = dash.body.money_total;
});

test('sign up: validation, then success, then login and /me', async () => {
  const bad = await call('POST', '/api/register', { name: 'A', mobile: '12345', email: 'nope', password: 'short', terms: false });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.mobile && bad.body.errors.email && bad.body.errors.password && bad.body.errors.terms);

  const ok = await call('POST', '/api/register', { name: 'Test Student', mobile: '+639301112222', email: 'Test.Student@Example.com', password: 'secret123', password_confirmation: 'secret123', terms: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.mobile, '09301112222'); // +63 form is saved as 09...
  assert.equal(ok.body.user.email, 'test.student@example.com');
  assert.equal(ok.body.user.password, undefined); // never sent to the app
  ctx.student = ok.body.token;

  const dup = await call('POST', '/api/register', { name: 'Again', mobile: '09301112222', email: 'test.student@example.com', password: 'secret123', password_confirmation: 'secret123', terms: true });
  assert.equal(dup.status, 422);
  assert.ok(dup.body.errors.email && dup.body.errors.mobile);

  const wrong = await call('POST', '/api/login', { email: 'test.student@example.com', password: 'nope' });
  assert.equal(wrong.status, 422);
  assert.ok(wrong.body.errors.email);

  const me = await call('GET', '/api/me', null, { token: ctx.student });
  assert.equal(me.body.user.role, 'student');
});

test('login is required, and students cannot use admin routes', async () => {
  assert.equal((await call('GET', '/api/home')).status, 401);
  assert.equal((await call('GET', '/api/admin/dashboard', null, { token: ctx.student })).status, 403);
});

test('reserve the real locker: one active reservation only, unique QR codes', async () => {
  const lockers = await call('GET', '/api/lockers', null, { token: ctx.student });
  const l01 = lockers.body.lockers.find((l) => l.number === '01');
  assert.ok(l01 && l01.status === 'available');
  assert.ok(!lockers.body.lockers.find((l) => l.number === '06'), 'out of service locker is hidden');
  ctx.l01 = l01.id;

  const now = Date.now();
  const res = await call('POST', '/api/reservations', { locker_id: l01.id, start_time: hhmm(now), end_time: hhmm(now + 16 * 60000) }, { token: ctx.student });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.reservation.status, 'reserved');
  assert.equal(res.body.reservation.fees.drop_off, 5);
  ctx.resId = res.body.reservation.id;

  const again = await call('POST', '/api/reservations', { locker_id: l01.id, start_time: hhmm(now), end_time: hhmm(now + 16 * 60000) }, { token: ctx.student });
  assert.equal(again.status, 422);
  assert.ok(again.body.errors.locker_id);

  const qr = await call('GET', '/api/qr', null, { token: ctx.student });
  assert.match(qr.body.in.token, /^[0-9a-f]{64}$/);
  assert.match(qr.body.out.token, /^[0-9a-f]{64}$/);
  assert.notEqual(qr.body.in.token, qr.body.out.token);
  assert.equal(qr.body.in.usable, true);
  ctx.inToken = qr.body.in.token;
  ctx.outToken = qr.body.out.token;
});

test('cabinet: needs the key, rejects fake and wrong-locker QRs', async () => {
  assert.equal((await call('POST', '/api/locker/scan', { token: ctx.inToken })).status, 401);
  assert.equal((await call('POST', '/api/locker/scan', { token: ctx.inToken }, { key: 'wrong' })).status, 401);

  const fake = await scan('f'.repeat(64), 0);
  assert.equal(fake.body.ok, false);
  assert.equal(fake.body.action, null);

  const wrongCab = await scan(ctx.inToken, 5, '02');
  assert.equal(wrongCab.body.ok, false);
  assert.match(wrongCab.body.message, /Wrong locker/);

  const status = await call('GET', '/api/locker/status', null, { key: KEY });
  assert.equal(status.body.locker, '01');
});

test('cabinet IN scan: asks for coins first, then opens the door once', async () => {
  const first = await scan(ctx.inToken, 0);
  assert.equal(first.body.ok, true);
  assert.equal(first.body.action, 'pay');
  assert.equal(first.body.due, 5);

  const short = await scan(ctx.inToken, 3);
  assert.equal(short.body.action, 'pay', 'not enough coins yet, door stays closed');

  const open = await scan(ctx.inToken, 5);
  assert.equal(open.body.action, 'store');
  assert.equal(open.body.paid, 5);
  assert.deepEqual(open.body.lcd, ['Door open', 'Store helmet']);

  const reuse = await scan(ctx.inToken, 5);
  assert.equal(reuse.body.ok, false, 'a used QR cannot open the door again');

  const home = await call('GET', '/api/home', null, { token: ctx.student });
  assert.equal(home.body.active_reservation.status, 'stored');
});

test('a new OUT QR replaces the old one', async () => {
  const regen = await call('POST', '/api/qr/out/regenerate', null, { token: ctx.student });
  assert.equal(regen.status, 200);
  assert.notEqual(regen.body.out.token, ctx.outToken);
  const old = await scan(ctx.outToken, 100);
  assert.equal(old.body.ok, false, 'the old OUT QR is dead');
  ctx.outToken = regen.body.out.token;
});

test('late fee: 45 minutes late = 1 late hour, charged at retrieval', async () => {
  const r = db.reservations.find((x) => x.id === ctx.resId);
  r.end_time = new Date(Date.now() - 45 * 60000).toISOString();
  r.start_time = new Date(Date.now() - 61 * 60000).toISOString();

  const qr = await call('GET', '/api/qr', null, { token: ctx.student });
  const f = qr.body.reservation.fees;
  assert.equal(qr.body.reservation.is_late, true);
  assert.equal(f.late_hours, 1);
  assert.equal(f.late_fee, 5);
  assert.equal(f.due_at_retrieval, 10); // 1 hour x 5 + 1 late hour x 5

  const ask = await scan(ctx.outToken, 0);
  assert.equal(ask.body.action, 'pay');
  assert.equal(ask.body.due, 10);
  assert.equal(ask.body.late_fee, 5);

  const short = await scan(ctx.outToken, 5);
  assert.equal(short.body.action, 'pay');

  const open = await scan(ctx.outToken, 10);
  assert.equal(open.body.action, 'retrieve');
  assert.equal(open.body.paid, 10);
  assert.equal(open.body.late_fee, 5);

  const hist = await call('GET', '/api/reservations', null, { token: ctx.student });
  assert.equal(hist.body.reservations[0].status, 'completed');
  const lockers = await call('GET', '/api/admin/lockers', null, { token: ctx.admin });
  assert.equal(lockers.body.lockers.find((l) => l.number === '01').status, 'available');
});

test('money and SMS notices were recorded', async () => {
  const dash = await call('GET', '/api/admin/dashboard', null, { token: ctx.admin });
  assert.equal(dash.body.money_total - ctx.moneyBefore, 15); // 5 at drop-off + 10 at retrieval

  const sms = await call('GET', '/api/admin/sms-log', null, { token: ctx.admin });
  const mine = sms.body.sms.filter((s) => s.to === '09301112222').map((s) => s.kind);
  for (const kind of ['reserved', 'stored', 'retrieved']) assert.ok(mine.includes(kind), 'missing SMS: ' + kind);
  assert.ok(sms.body.sms.every((s) => s.status === 'sent'));
});

test('no-show: reservation expires, strike added, locker freed, SMS sent', async () => {
  const reg = await call('POST', '/api/register', { name: 'Late Larry', mobile: '09402223333', email: 'larry@example.com', password: 'secret123', password_confirmation: 'secret123', terms: true });
  const token = reg.body.token;
  const lockers = await call('GET', '/api/lockers', null, { token });
  const l02 = lockers.body.lockers.find((l) => l.number === '02');
  const now = Date.now();
  const res = await call('POST', '/api/reservations', { locker_id: l02.id, start_time: hhmm(now), end_time: hhmm(now + 16 * 60000) }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  db.reservations.find((x) => x.id === res.body.reservation.id).arrive_by = new Date(Date.now() - 60000).toISOString();
  const home = await call('GET', '/api/home', null, { token });
  assert.equal(home.body.active_reservation, null);
  assert.equal(home.body.user.no_show_count, 1);

  const after = await call('GET', '/api/admin/lockers', null, { token: ctx.admin });
  assert.equal(after.body.lockers.find((l) => l.number === '02').status, 'available');
  const sms = await call('GET', '/api/admin/sms-log', null, { token: ctx.admin });
  assert.ok(sms.body.sms.some((s) => s.to === '09402223333' && s.kind === 'expired'));

  // and a student can cancel a fresh reservation
  const again = await call('POST', '/api/reservations', { locker_id: l02.id, start_time: hhmm(Date.now()), end_time: hhmm(Date.now() + 16 * 60000) }, { token });
  assert.equal(again.status, 200);
  const cancel = await call('POST', `/api/reservations/${again.body.reservation.id}/cancel`, null, { token });
  assert.equal(cancel.status, 200);
});

test('forgot password: 6-digit code, wrong code fails, right code works', async () => {
  const lines = [];
  const original = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    const r = await call('POST', '/api/forgot-password', { email: 'test.student@example.com' });
    assert.equal(r.status, 200);
  } finally {
    console.log = original;
  }
  const code = lines.join('\n').match(/\[RESET CODE\] test\.student@example\.com: (\d{6})/)?.[1];
  assert.ok(code, 'the code is printed in the server window');

  const bad = await call('POST', '/api/reset-password', { email: 'test.student@example.com', code: '000000' === code ? '111111' : '000000', password: 'newpass123', password_confirmation: 'newpass123' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.code);

  const good = await call('POST', '/api/reset-password', { email: 'test.student@example.com', code, password: 'newpass123', password_confirmation: 'newpass123' });
  assert.equal(good.status, 200);

  assert.equal((await call('GET', '/api/me', null, { token: ctx.student })).status, 401, 'old logins are signed out');
  const login = await call('POST', '/api/login', { email: 'test.student@example.com', password: 'newpass123' });
  assert.equal(login.status, 200);
});

test('admin screens: export, students, lockers, team, reports', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const csv = await call('GET', `/api/admin/export?type=daily&from=${today}&to=${today}`, null, { token: ctx.admin });
  assert.equal(csv.status, 200);
  assert.match(csv.body.csv, /^Date,Reservations made/);
  const rows = await call('GET', `/api/admin/export?type=reservations&from=${today}&to=${today}`, null, { token: ctx.admin });
  assert.ok(rows.body.rows >= 1);

  const students = await call('GET', '/api/admin/students?q=09301112222', null, { token: ctx.admin });
  assert.equal(students.body.students.length, 1);
  assert.equal(students.body.students[0].completed, 1);

  const add = await call('POST', '/api/admin/lockers', { number: '09', location: 'Test Gate' }, { token: ctx.admin });
  assert.equal(add.status, 200);
  const del = await call('DELETE', `/api/admin/lockers/${add.body.locker.id}`, null, { token: ctx.admin });
  assert.equal(del.status, 200);
  const real = await call('DELETE', `/api/admin/lockers/${ctx.l01}`, null, { token: ctx.admin });
  assert.equal(real.status, 422, 'the real locker cannot be deleted');

  const team = await call('GET', '/api/admin/team', null, { token: ctx.admin });
  assert.equal(team.body.admins[0].is_me, true);
  const reports = await call('GET', '/api/admin/reports', null, { token: ctx.admin });
  assert.ok(reports.body.reports.length >= 1);
});

test('the database is saved to disk', () => {
  saveNow();
  const saved = JSON.parse(fs.readFileSync(process.env.DB_FILE, 'utf8'));
  assert.ok(saved.users.some((u) => u.email === 'test.student@example.com'));
  assert.ok(saved.users.every((u) => !u.password || u.password.includes(':')), 'passwords are stored hashed, not as text');
});

test('dry run only checks; the commit scan changes things; status shows what is due', async () => {
  const reg = await call('POST', '/api/register', { name: 'Dry Run', mobile: '09503334444', email: 'dry@example.com', password: 'secret123', password_confirmation: 'secret123', terms: true });
  const token = reg.body.token;
  const now = Date.now();
  const res = await call('POST', '/api/reservations', { locker_id: ctx.l01, start_time: hhmm(now), end_time: hhmm(now + 16 * 60000) }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const qr = (await call('GET', '/api/qr', null, { token })).body;
  const dryScan = (t, c) => call('POST', '/api/locker/scan', { token: t, coins: c, locker: '01', dry: true }, { key: KEY });

  assert.equal((await call('GET', '/api/locker/status', null, { key: KEY })).body.status, 'reserved');
  assert.equal((await dryScan(qr.in.token, 0)).body.action, 'pay');
  const ok = await dryScan(qr.in.token, 5);
  assert.equal(ok.body.action, 'store');
  assert.equal(ok.body.dry, true);
  assert.equal((await call('GET', '/api/home', null, { token })).body.active_reservation.status, 'reserved', 'dry run changed nothing');
  assert.equal((await dryScan(qr.in.token, 5)).body.action, 'store', 'QR not used up by a dry run');

  assert.equal((await scan(qr.in.token, 5)).body.action, 'store');
  assert.equal((await call('GET', '/api/home', null, { token })).body.active_reservation.status, 'stored');
  const st = await call('GET', '/api/locker/status', null, { key: KEY });
  assert.equal(st.body.status, 'occupied');
  assert.equal(st.body.due, 5);

  const outDry = await dryScan(qr.out.token, 5);
  assert.equal(outDry.body.action, 'retrieve');
  assert.equal((await call('GET', '/api/home', null, { token })).body.active_reservation.status, 'stored');
  assert.equal((await scan(qr.out.token, 5)).body.action, 'retrieve');
});

test('admin test tools: status, test SMS, cabinet simulator, setup page', async () => {
  const s = await call('GET', '/api/admin/status', null, { token: ctx.admin });
  assert.equal(s.status, 200);
  assert.equal(s.body.storage, 'file');
  assert.ok(s.body.last_cabinet_contact);

  const sms = await call('POST', '/api/admin/sms-test', { mobile: '0917 123 4567' }, { token: ctx.admin });
  assert.equal(sms.body.sms.status, 'sent');
  assert.equal((await call('POST', '/api/admin/sms-test', { mobile: '123' }, { token: ctx.admin })).status, 422);
  assert.equal((await call('POST', '/api/admin/sms-test', { mobile: '09171234567' }, { token: ctx.student })).status, 401);

  const sim = await call('POST', '/api/admin/simulate-scan', { token: 'a'.repeat(64), coins: 0, locker: '01' }, { token: ctx.admin });
  assert.equal(sim.body.ok, false);

  const page = await fetch(base + '/setup');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /HelmLock server check/);
});
