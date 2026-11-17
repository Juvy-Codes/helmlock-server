// HelmLock rules. This is the real version of the app's src/api/fake.js:
// same function names, same rules, same answers. The difference is that the
// logged-in user comes from the request instead of a global variable.
import crypto from 'node:crypto';
import { ApiError, fail } from './errors.js';
import { RULES, LOCKER_KEY, SMS } from './config.js';
import { feesFor } from './pricing.js';
import { db, newId, STORAGE } from './store.js';
import { sendSms } from './sms.js';
import { sendResetCode } from './mail.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
export const iso = (ms) => new Date(ms).toISOString();
const peso = (n) => '₱' + n;

// 64 random hex characters (256 bits). Impossible to guess.
const randomToken = () => crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// Passwords and login tokens
// ---------------------------------------------------------------------------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(password), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function issueToken(user) {
  const token = randomToken();
  db.tokens.push({ token, user_id: user.id, created_at: iso(Date.now()) });
  return token;
}

export function userFromToken(token) {
  if (!token) return null;
  const row = db.tokens.find((t) => t.token === token);
  return row ? db.users.find((u) => u.id === row.user_id) || null : null;
}

export function revokeToken(token) {
  db.tokens = db.tokens.filter((t) => t.token !== token);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function publicUser(user) {
  const { password, ...rest } = user;
  return rest;
}

const isBlocked = (user) => !!user.blocked_until && new Date(user.blocked_until).getTime() > Date.now();
const userById = (id) => db.users.find((u) => u.id === id) || null;
const lockerById = (id) => db.lockers.find((l) => l.id === id) || null;
const lockerOf = (r) => lockerById(r.locker_id);
const qrOf = (r, type) => db.qrCodes.filter((q) => q.reservation_id === r.id && q.type === type).pop() || null;
const isLate = (r) => r.status === 'stored' && Date.now() > new Date(r.end_time).getTime();
const activeOf = (userId) => db.reservations.find((r) => r.user_id === userId && ['reserved', 'stored'].includes(r.status)) || null;
const activeInLocker = (lockerId) => db.reservations.find((r) => r.locker_id === lockerId && ['reserved', 'stored'].includes(r.status)) || null;
const reservationById = (id) => db.reservations.find((r) => r.id === Number(id)) || null;

function addLog(action, reservation, details = null, amount = 0, when = null, extra = {}) {
  db.logs.unshift({
    id: newId(),
    action,
    reservation_id: reservation?.id ?? null,
    user_id: reservation?.user_id ?? null,
    locker_id: reservation?.locker_id ?? extra.locker_id ?? null,
    admin_id: extra.admin_id ?? null,
    details,
    amount,
    created_at: when || iso(Date.now()),
  });
}

function shapeReservation(r, withUser = false) {
  const locker = lockerOf(r);
  const out = {
    id: r.id,
    locker: locker ? { id: locker.id, number: locker.number, location: locker.location } : { id: null, number: '?', location: '' },
    start_time: r.start_time,
    end_time: r.end_time,
    arrive_by: r.arrive_by,
    status: r.status,
    stored_at: r.stored_at,
    retrieved_at: r.retrieved_at,
    is_late: isLate(r),
    fees: feesFor(r),
    created_at: r.created_at,
  };
  if (withUser) {
    const u = userById(r.user_id);
    out.user = u ? { id: u.id, name: u.name, email: u.email, mobile: u.mobile } : { id: null, name: 'Deleted account', email: '', mobile: null };
  }
  return out;
}

function shapeQr(qr) {
  if (!qr) return null;
  const usable = !qr.used_at && (!qr.expires_at || new Date(qr.expires_at).getTime() > Date.now());
  return { type: qr.type, token: qr.token, used_at: qr.used_at, usable };
}

function expireQrs(r) {
  db.qrCodes.filter((q) => q.reservation_id === r.id && !q.used_at).forEach((q) => (q.expires_at = iso(Date.now())));
}

// 7 -> "7:00 AM", 21 -> "9:00 PM"
const hourLabel = (h) => `${h % 12 || 12}:00 ${h >= 12 ? 'PM' : 'AM'}`;
const clock = (v) => new Date(v).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function todayAt(time) {
  const [h, m] = String(time).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

const validEmail = (mail) => /^\S+@\S+\.\S+$/.test(mail);
const findByEmail = (value) => {
  const v = (value || '').trim().toLowerCase();
  return db.users.find((u) => u.email === v) || null;
};

// Philippine mobile number: 09XXXXXXXXX or +639XXXXXXXXX, saved as 09XXXXXXXXX
function cleanMobile(value) {
  const digits = String(value || '').replace(/[\s-]/g, '');
  if (/^09\d{9}$/.test(digits)) return digits;
  if (/^\+639\d{9}$/.test(digits)) return '0' + digits.slice(3);
  if (/^639\d{9}$/.test(digits)) return '0' + digits.slice(2);
  return null;
}

// Expire reservations whose helmet wasn't stored in time (no-shows)
export function expireOverdue() {
  db.reservations
    .filter((r) => r.status === 'reserved' && new Date(r.arrive_by).getTime() < Date.now())
    .forEach((r) => {
      r.status = 'expired';
      expireQrs(r);
      const locker = lockerOf(r);
      if (locker && locker.status === 'reserved') locker.status = 'available';
      addLog('expired', r, 'No-show: helmet was not stored in time');

      const user = userById(r.user_id);
      if (user) {
        user.no_show_count += 1;
        let text = `HelmLock: your Locker ${locker?.number ?? ''} reservation expired because the helmet was not stored in time.`;
        if (user.no_show_count >= RULES.noShowLimit) {
          user.no_show_count = 0;
          user.blocked_until = iso(Date.now() + RULES.blockHours * HOUR);
          text += ` You can't reserve for ${RULES.blockHours} hours.`;
        }
        sendSms(user, text, 'expired');
      }
    });
}

// Runs every minute from server.js: expiries, "time almost up" and "you're late" texts
export function tick() {
  expireOverdue();
  const now = Date.now();
  db.reservations
    .filter((r) => r.status === 'stored')
    .forEach((r) => {
      const user = userById(r.user_id);
      const end = new Date(r.end_time).getTime();
      const locker = lockerOf(r);
      if (!r.reminded && now >= end - 10 * MIN && now < end) {
        r.reminded = true;
        sendSms(user, `HelmLock: your storage time for Locker ${locker?.number} ends at ${clock(end)} (in about 10 minutes).`, 'reminder');
      }
      if (!r.late_notified && now > end + RULES.lateGraceMinutes * MIN) {
        r.late_notified = true;
        sendSms(user, `HelmLock: your helmet in Locker ${locker?.number} is overdue. A late fee of ${peso(RULES.lateFeePerHour)} per hour now applies. Please retrieve it.`, 'late');
      }
    });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export function login({ email, password }) {
  if (!email?.trim()) fail('email', 'Please enter your email.');
  if (!password) fail('password', 'Please enter your password.');
  const user = findByEmail(email);
  if (!user || !checkPassword(password, user.password)) fail('email', 'Incorrect email or password.');
  return { token: issueToken(user), user: publicUser(user) };
}

export function register({ name, mobile, email, password, password_confirmation, terms }) {
  const errors = {};
  const phone = cleanMobile(mobile);
  const mail = (email || '').trim().toLowerCase();

  if (!name?.trim()) errors.name = ['Please enter your full name.'];
  if (!String(mobile || '').trim()) errors.mobile = ['Please enter your mobile number.'];
  else if (!phone) errors.mobile = ['Please enter a valid mobile number, like 09171234567.'];
  else if (db.users.some((u) => u.mobile === phone)) errors.mobile = ['This mobile number is already registered.'];
  if (!validEmail(mail)) errors.email = ['Please enter a valid email.'];
  else if (db.users.some((u) => u.email === mail)) errors.email = ['This email is already registered.'];
  if (!password || password.length < 8) errors.password = ['Password must be at least 8 characters.'];
  else if (password !== password_confirmation) errors.password_confirmation = ["Passwords don't match."];
  if (!terms) errors.terms = ['Please agree to the Terms and Rules to continue.'];
  if (Object.keys(errors).length) throw new ApiError('Please check the form.', errors);

  const user = { id: newId(), name: name.trim(), mobile: phone, email: mail, password: hashPassword(password), role: 'student', no_show_count: 0, blocked_until: null, created_at: iso(Date.now()) };
  db.users.push(user);
  return { token: issueToken(user), user: publicUser(user) };
}

export const getMe = (user) => ({ user: publicUser(user) });

// Step 1: make a 6-digit code (valid 60 minutes). Always answers the same message.
export function forgotPassword({ email }) {
  if (!validEmail((email || '').trim())) fail('email', 'Please enter a valid email.');
  const user = findByEmail(email);
  if (user) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.resetCodes = db.resetCodes.filter((c) => c.user_id !== user.id);
    db.resetCodes.push({ user_id: user.id, code_hash: hashPassword(code), expires_at: iso(Date.now() + 60 * MIN), tries: 0 });
    sendResetCode(user, code);
  }
  return { message: 'If that account exists, we sent a 6-digit code to its email.' };
}

// Step 2: set a new password with the code
export function resetPassword({ email, code, password, password_confirmation }) {
  const user = findByEmail(email);
  const row = user && db.resetCodes.find((c) => c.user_id === user.id);
  const good = row && new Date(row.expires_at).getTime() > Date.now() && row.tries < 5;
  if (row && good) row.tries += 1;
  if (!good || !checkPassword(String(code || ''), row.code_hash)) fail('code', 'That code is wrong or has expired.');
  if (!password || password.length < 8) fail('password', 'Password must be at least 8 characters.');
  if (password !== password_confirmation) fail('password_confirmation', "Passwords don't match.");
  user.password = hashPassword(password);
  db.resetCodes = db.resetCodes.filter((c) => c.user_id !== user.id);
  db.tokens = db.tokens.filter((t) => t.user_id !== user.id); // log out everywhere
  return { message: 'Your password was reset. You can log in now.' };
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export function updateProfile(user, { name, email, mobile }) {
  const mail = (email || '').trim().toLowerCase();
  const typed = String(mobile || '').trim();
  const phone = cleanMobile(typed);
  if (!name?.trim()) fail('name', 'Please enter your full name.');
  if (!validEmail(mail)) fail('email', 'Please enter a valid email.');
  if (db.users.some((u) => u.email === mail && u.id !== user.id)) fail('email', 'This email is already used by another account.');
  if (!typed && user.role === 'student') fail('mobile', 'Please enter your mobile number.');
  if (typed && !phone) fail('mobile', 'Please enter a valid mobile number, like 09171234567.');
  if (phone && db.users.some((u) => u.mobile === phone && u.id !== user.id)) fail('mobile', 'This mobile number is already used by another account.');
  user.name = name.trim();
  user.email = mail;
  user.mobile = phone;
  return { message: 'Your details were saved.', user: publicUser(user) };
}

export function updatePassword(user, { current_password, password, password_confirmation }) {
  if (!checkPassword(current_password || '', user.password)) fail('current_password', 'Your current password is incorrect.');
  if (!password || password.length < 8) fail('password', 'Password must be at least 8 characters.');
  if (password !== password_confirmation) fail('password_confirmation', "Passwords don't match.");
  user.password = hashPassword(password);
  return { message: 'Your password was changed.' };
}

// ---------------------------------------------------------------------------
// Student: home and lockers
// ---------------------------------------------------------------------------
export function getHome(user) {
  expireOverdue();
  const active = activeOf(user.id);
  return {
    user: publicUser(user),
    active_reservation: active ? shapeReservation(active) : null,
    available_count: db.lockers.filter((l) => l.status === 'available').length,
  };
}

export function getLockers() {
  expireOverdue();
  return {
    lockers: db.lockers.filter((l) => l.status !== 'out_of_service').map(({ id, number, location, status }) => ({ id, number, location, status })),
  };
}

// ---------------------------------------------------------------------------
// Student: reservations
// ---------------------------------------------------------------------------
export function createReservation(user, { locker_id, start_time, end_time }) {
  expireOverdue();

  if (!locker_id) fail('locker_id', 'Please choose a locker.');
  if (isBlocked(user)) fail('locker_id', 'You are temporarily blocked from reserving because of missed reservations.');
  if (activeOf(user.id)) fail('locker_id', 'You already have an active reservation.');

  const start = todayAt(start_time);
  const end = todayAt(end_time);
  if (Number.isNaN(start)) fail('start_time', 'Please choose a drop-off time.');
  if (Number.isNaN(end)) fail('end_time', 'Please choose a retrieval time.');
  if (start < Date.now() - 5 * MIN) fail('start_time', 'That drop-off time has already passed.');
  if (start > Date.now() + RULES.maxAdvanceMinutes * MIN) fail('start_time', `You can only reserve up to ${RULES.maxAdvanceMinutes} minutes ahead.`);
  if (end < start + 15 * MIN) fail('end_time', 'Retrieval time must be at least 15 minutes after drop-off.');
  if (end > start + RULES.maxStorageHours * HOUR) fail('end_time', `You can store your helmet for up to ${RULES.maxStorageHours} hours.`);
  if (start < todayAt(`${RULES.openHour}:00`) || end > todayAt(`${RULES.closeHour}:00`)) fail('start_time', `Lockers are open from ${hourLabel(RULES.openHour)} to ${hourLabel(RULES.closeHour)} only.`);

  const locker = lockerById(Number(locker_id));
  if (!locker || locker.status !== 'available') fail('locker_id', 'That locker was just taken. Please choose another one.');

  const r = {
    id: newId(),
    user_id: user.id,
    locker_id: locker.id,
    start_time: iso(start),
    end_time: iso(end),
    arrive_by: iso(start + RULES.arriveWindowMinutes * MIN),
    status: 'reserved',
    stored_at: null,
    retrieved_at: null,
    created_at: iso(Date.now()),
  };
  db.reservations.push(r);
  locker.status = 'reserved';
  db.qrCodes.push({ id: newId(), reservation_id: r.id, type: 'in', token: randomToken(), used_at: null, expires_at: null });
  db.qrCodes.push({ id: newId(), reservation_id: r.id, type: 'out', token: randomToken(), used_at: null, expires_at: null });
  addLog('reserved', r, 'Locker reserved');

  const f = feesFor(r);
  sendSms(user, `HelmLock: Locker ${locker.number} reserved. Drop off by ${clock(r.arrive_by)}, retrieve by ${clock(r.end_time)}. Bring ${peso(f.drop_off)} now and ${peso(f.retrieval)} at pickup.`, 'reserved');

  return { message: `Locker ${locker.number} is reserved for you.`, reservation: shapeReservation(r) };
}

export function getReservation(user, id) {
  expireOverdue();
  const r = db.reservations.find((x) => x.id === Number(id) && x.user_id === user.id);
  if (!r) throw new ApiError('Reservation not found.', {}, 404);
  return { reservation: shapeReservation(r) };
}

export function cancelReservation(user, id) {
  const r = db.reservations.find((x) => x.id === Number(id) && x.user_id === user.id);
  if (!r) throw new ApiError('Reservation not found.', {}, 404);
  if (r.status !== 'reserved') throw new ApiError('Only reservations that have not been used yet can be cancelled.');
  r.status = 'cancelled';
  expireQrs(r);
  const locker = lockerOf(r);
  if (locker && locker.status === 'reserved') locker.status = 'available';
  addLog('cancelled', r, 'Cancelled by student');
  sendSms(user, `HelmLock: your Locker ${locker?.number} reservation was cancelled.`, 'cancelled');
  return { message: 'Your reservation was cancelled.' };
}

export function getHistory(user) {
  expireOverdue();
  return {
    reservations: db.reservations
      .filter((r) => r.user_id === user.id)
      .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
      .map((r) => shapeReservation(r)),
  };
}

// ---------------------------------------------------------------------------
// Student: QR codes
// ---------------------------------------------------------------------------
export function getMyQr(user) {
  expireOverdue();
  const active = activeOf(user.id);
  if (!active) return { reservation: null, in: null, out: null };
  return { reservation: shapeReservation(active), in: shapeQr(qrOf(active, 'in')), out: shapeQr(qrOf(active, 'out')) };
}

export function regenerateOutQr(user) {
  const active = activeOf(user.id);
  if (!active || active.status !== 'stored') throw new ApiError('You can only make a new OUT QR after your helmet is stored.');
  db.qrCodes.filter((q) => q.reservation_id === active.id && q.type === 'out' && !q.used_at).forEach((q) => (q.expires_at = iso(Date.now())));
  db.qrCodes.push({ id: newId(), reservation_id: active.id, type: 'out', token: randomToken(), used_at: null, expires_at: null });
  addLog('qr_regenerated', active, 'New OUT QR created');
  return { message: 'New OUT QR created. Your old one no longer works.', out: shapeQr(qrOf(active, 'out')) };
}

// ---------------------------------------------------------------------------
// Student: problem reports
// ---------------------------------------------------------------------------
export const getReportLockers = () => ({ lockers: db.lockers.map(({ id, number }) => ({ id, number })) });

export function createReport(user, { locker_id, message }) {
  if (!message || message.trim().length < 10) fail('message', 'Please describe the problem in at least 10 characters.');
  db.reports.unshift({ id: newId(), user_id: user.id, locker_id: locker_id || null, message: message.trim().slice(0, 1000), status: 'open', created_at: iso(Date.now()) });
  return { message: "Thanks! Your report was sent. We'll check it soon." };
}

// ---------------------------------------------------------------------------
// THE CABINET (ESP32): this is what the QR scanner at the locker calls
// ---------------------------------------------------------------------------
const physicalLocker = () => db.lockers.find((l) => l.is_physical) || null;

function scanResult(ok, action, message, lcd, locker, extra = {}) {
  return { ok, action, message, lcd, locker, ...extra };
}

// body: { token, coins, locker }
//   token  = the text inside the QR code
//   coins  = pesos inserted so far (0 on the first scan)
//   locker = the cabinet's own locker number (optional, defaults to the real locker)
//
// First scan (no coins): answers action "pay" and the amount due. The QR is NOT used up yet.
// Second scan (coins >= due): answers action "store" or "retrieve" = open the door.
//
// dry: true  = only CHECK. Nothing is changed and no QR is used up. The cabinet does this first, opens the
//              door, and only if the door really opened does it send the same scan again with dry: false
//              (the commit). So a stuck servo never burns the student's QR or money.
export function scan({ token, coins, locker: cabinetNumber, dry } = {}) {
  expireOverdue();
  const paid = Math.max(0, Number(coins) || 0);
  const cabinet = String(cabinetNumber || physicalLocker()?.number || '');

  const qr = typeof token === 'string' && token.length >= 16 ? db.qrCodes.find((q) => q.token === token.trim()) : null;
  if (!qr) return scanResult(false, null, 'Invalid QR code.', ['Invalid QR', 'Try again'], cabinet);
  if (qr.used_at) return scanResult(false, null, 'This QR was already used.', ['QR already used', 'Make a new one'], cabinet);
  if (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now()) return scanResult(false, null, 'This QR expired.', ['QR expired', 'Check the app'], cabinet);

  const r = db.reservations.find((x) => x.id === qr.reservation_id);
  const locker = r && lockerOf(r);
  if (!r || !locker) return scanResult(false, null, 'Reservation not found.', ['No reservation', ''], cabinet);
  if (locker.number !== cabinet) return scanResult(false, null, `Wrong locker. Go to Locker ${locker.number}.`, ['Wrong locker', `Use Locker ${locker.number}`], cabinet);

  const user = userById(r.user_id);

  // ---- IN: store the helmet --------------------------------------------------
  if (qr.type === 'in') {
    if (r.status !== 'reserved') return scanResult(false, null, 'This reservation is not waiting for a helmet.', ['Not available', r.status], locker.number);
    const due = RULES.dropOffFee;
    if (paid < due) return scanResult(true, 'pay', `Insert ${peso(due)} to open the door.`, ['Insert coins', `Need ${peso(due)}`], locker.number, { due, paid });
    if (dry) return scanResult(true, 'store', 'OK to open. Store your helmet.', ['Door open', 'Store helmet'], locker.number, { paid: due, due, dry: true });

    qr.used_at = iso(Date.now());
    r.status = 'stored';
    r.stored_at = iso(Date.now());
    locker.status = 'occupied';
    addLog('stored', r, 'Helmet stored', due);
    sendSms(user, `HelmLock: helmet stored in Locker ${locker.number}. Retrieve it by ${clock(r.end_time)}. You will pay ${peso(feesFor(r).due_at_retrieval)} at pickup.`, 'stored');
    return scanResult(true, 'store', 'Door open. Store your helmet.', ['Door open', 'Store helmet'], locker.number, { paid: due });
  }

  // ---- OUT: take the helmet back ---------------------------------------------
  if (r.status !== 'stored') return scanResult(false, null, 'No helmet is stored for this QR.', ['No helmet', 'stored here'], locker.number);
  const f = feesFor(r);
  const due = f.due_at_retrieval;
  if (paid < due) {
    return scanResult(true, 'pay', `Insert ${peso(due)} to open the door.${f.late_fee ? ` (includes ${peso(f.late_fee)} late fee)` : ''}`, ['Insert coins', `Need ${peso(due)}`], locker.number, { due, paid, late_fee: f.late_fee });
  }

  if (dry) return scanResult(true, 'retrieve', 'OK to open. Take your helmet.', ['Door open', 'Take helmet'], locker.number, { paid: due, due, late_fee: f.late_fee, dry: true });

  qr.used_at = iso(Date.now());
  r.status = 'completed';
  r.retrieved_at = iso(Date.now());
  locker.status = 'available';
  expireQrs(r);
  addLog('retrieved', r, f.late_fee ? `Helmet retrieved (late ${f.late_hours} hr)` : 'Helmet retrieved', due);
  sendSms(user, `HelmLock: helmet retrieved from Locker ${locker.number}. You paid ${peso(due)}${f.late_fee ? ` including ${peso(f.late_fee)} late fee` : ''}. Ride safe!`, 'retrieved');
  return scanResult(true, 'retrieve', 'Door open. Take your helmet.', ['Door open', 'Take helmet'], locker.number, { paid: due, late_fee: f.late_fee });
}

// The cabinet checks in and asks "who am I and am I OK?"
export function lockerStatus() {
  db.meta.lastCabinetContact = iso(Date.now());
  expireOverdue();
  const l = physicalLocker();
  // `due` = what the next person at the cabinet must pay (the cabinet shows it on its screen)
  const r = l ? activeInLocker(l.id) : null;
  const due = r && r.status === 'stored' ? feesFor(r).due_at_retrieval : RULES.dropOffFee;
  return { ok: true, locker: l?.number ?? null, status: l?.status ?? null, due, server_time: iso(Date.now()), rules: { drop_off_fee: RULES.dropOffFee, hourly_fee: RULES.hourlyFee } };
}

// The cabinet tells the server what the door did (kept in the activity list)
export function lockerDoor({ event } = {}) {
  const l = physicalLocker();
  addLog('door', null, `Door ${String(event || 'event').slice(0, 20)}`, 0, null, { locker_id: l?.id ?? null });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Admin: overview
// ---------------------------------------------------------------------------
function shapeLog(log) {
  const u = userById(log.user_id);
  const a = userById(log.admin_id);
  const l = lockerById(log.locker_id);
  return { id: log.id, action: log.action, details: log.details, amount: log.amount, created_at: log.created_at, user: u ? u.name : null, admin: a ? a.name : null, locker: l ? l.number : null };
}

function lockerWithCurrent(l) {
  const current = activeInLocker(l.id);
  return {
    ...l,
    current: current ? shapeReservation(current, true) : null,
    history_count: db.reservations.filter((r) => r.locker_id === l.id).length,
  };
}

export function adminDashboard() {
  expireOverdue();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayLogs = db.logs.filter((g) => new Date(g.created_at) >= today);
  const count = (status) => db.lockers.filter((l) => l.status === status).length;

  const byHour = {};
  db.logs.filter((g) => g.action === 'stored').forEach((g) => {
    const h = new Date(g.created_at).getHours();
    byHour[h] = (byHour[h] || 0) + 1;
  });
  const busiest = Object.entries(byHour)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([hour, uses]) => ({ hour: Number(hour), uses }));

  return {
    lockers: { available: count('available'), reserved: count('reserved'), occupied: count('occupied'), out_of_service: count('out_of_service') },
    active_reservations: db.reservations.filter((r) => ['reserved', 'stored'].includes(r.status)).length,
    students: db.users.filter((u) => u.role === 'student').length,
    uses_today: todayLogs.filter((g) => g.action === 'stored').length,
    money_today: todayLogs.reduce((sum, g) => sum + g.amount, 0),
    money_total: db.logs.reduce((sum, g) => sum + g.amount, 0),
    total_uses: db.logs.filter((g) => g.action === 'stored').length,
    open_reports: db.reports.filter((r) => r.status === 'open').length,
    busiest_hours: busiest,
    late: db.reservations.filter(isLate).length,
    recent: db.logs.slice(0, 12).map(shapeLog),
  };
}

export const adminSmsLog = () => ({ sms: db.smsLog.slice(0, 100) });

// What the /setup page shows: is everything configured?
export function adminStatus() {
  return {
    ok: true,
    storage: STORAGE, // "postgres" = safe online, "file" = only for a laptop
    sms_driver: SMS.driver,
    locker_key_is_default: LOCKER_KEY === 'change-me-locker-key',
    server_time: iso(Date.now()),
    users: db.users.length,
    lockers: db.lockers.map((l) => ({ number: l.number, status: l.status, is_physical: !!l.is_physical })),
    last_cabinet_contact: db.meta.lastCabinetContact || null,
  };
}

// "Send a test SMS" button
export async function adminSmsTest({ mobile }) {
  const phone = cleanMobile(mobile);
  if (!phone) fail('mobile', 'Please enter a valid mobile number, like 09171234567.');
  const entry = await sendSms({ id: 0, mobile: phone }, 'HelmLock test: SMS is working.', 'test');
  return { sms: entry };
}

// "Cabinet simulator": do exactly what the cabinet does, without the hardware (admin only)
export const adminSimulateScan = (body) => scan({ ...body, locker: body.locker || undefined });

// ---------------------------------------------------------------------------
// Admin: lockers
// ---------------------------------------------------------------------------
export function adminLockers() {
  expireOverdue();
  return { lockers: [...db.lockers].sort((a, b) => a.number.localeCompare(b.number)).map(lockerWithCurrent) };
}

export function adminAddLocker(admin, { number, location }) {
  const n = (number || '').trim();
  if (!n) fail('number', 'Please enter a locker number.');
  if (n.length > 10) fail('number', 'Locker number can be up to 10 characters.');
  if (db.lockers.some((l) => l.number === n)) fail('number', 'That locker number already exists.');
  const locker = { id: newId(), number: n, location: (location || '').trim() || 'USTP CDO Campus', status: 'available', is_physical: false };
  db.lockers.push(locker);
  addLog('locker_added', null, `Locker ${n} added`, 0, null, { locker_id: locker.id, admin_id: admin.id });
  return { message: `Locker ${n} added.`, locker: lockerWithCurrent(locker) };
}

export function adminUpdateLocker(admin, id, { number, location }) {
  const locker = lockerById(Number(id));
  if (!locker) throw new ApiError('Locker not found.', {}, 404);
  const n = (number || '').trim();
  if (!n) fail('number', 'Please enter a locker number.');
  if (db.lockers.some((l) => l.number === n && l.id !== locker.id)) fail('number', 'That locker number already exists.');
  const renamed = n !== locker.number;
  if (renamed && ['reserved', 'occupied'].includes(locker.status)) fail('number', `Locker ${locker.number} is in use. Change its number after it is free.`);
  const old = locker.number;
  locker.number = n;
  locker.location = (location || '').trim() || 'USTP CDO Campus';
  addLog('locker_edited', null, renamed ? `Locker ${old} renamed to ${n}` : `Locker ${n} details updated`, 0, null, { locker_id: locker.id, admin_id: admin.id });
  let message = `Locker ${n} saved.`;
  if (renamed && locker.is_physical) message += ' This is the real locker, so change LOCKER_NUMBER in the ESP32 code too.';
  return { message, locker: lockerWithCurrent(locker) };
}

export function adminDeleteLocker(admin, id) {
  const locker = lockerById(Number(id));
  if (!locker) throw new ApiError('Locker not found.', {}, 404);
  if (locker.is_physical) throw new ApiError(`Locker ${locker.number} is the real ESP32 locker, so it can't be deleted.`);
  if (['reserved', 'occupied'].includes(locker.status)) throw new ApiError(`Locker ${locker.number} is in use. Release it first.`);
  if (db.reservations.some((r) => r.locker_id === locker.id)) throw new ApiError(`Locker ${locker.number} has reservation history, so deleting it would erase records used in reports. Set it Out of Service instead.`);
  db.lockers = db.lockers.filter((l) => l.id !== locker.id);
  addLog('locker_deleted', null, `Locker ${locker.number} deleted`, 0, null, { admin_id: admin.id });
  return { message: `Locker ${locker.number} deleted.` };
}

export function adminSetLockerStatus(admin, id, status) {
  const locker = lockerById(Number(id));
  if (!locker) throw new ApiError('Locker not found.', {}, 404);
  if (!['available', 'out_of_service'].includes(status)) fail('status', 'Status must be available or out_of_service.');
  if (status === 'out_of_service' && locker.status !== 'available') throw new ApiError(`Locker ${locker.number} is in use. Release it first.`);
  if (status === 'available' && locker.status !== 'out_of_service') throw new ApiError(`Locker ${locker.number} is not out of service.`);
  locker.status = status;
  const label = status === 'available' ? 'Available' : 'Out of Service';
  addLog('status_changed', null, `Locker ${locker.number} set to ${label}`, 0, null, { locker_id: locker.id, admin_id: admin.id });
  return { message: `Locker ${locker.number} is now ${label}.` };
}

// After opening a locker with the manual key: end its reservation and free it
export function adminReleaseLocker(admin, id) {
  const locker = lockerById(Number(id));
  if (!locker) throw new ApiError('Locker not found.', {}, 404);
  const r = activeInLocker(locker.id);
  if (r) {
    if (r.status === 'stored') {
      r.status = 'completed';
      r.retrieved_at = iso(Date.now());
    } else {
      r.status = 'cancelled';
    }
    expireQrs(r);
    addLog('released', r, 'Released by admin (manual key)', 0, null, { admin_id: admin.id });
  }
  locker.status = 'available';
  return { message: `Locker ${locker.number} released and available again.` };
}

// ---------------------------------------------------------------------------
// Admin: reservations and students
// ---------------------------------------------------------------------------
export function adminReservations({ status = '', q = '' } = {}) {
  expireOverdue();
  const search = String(q).trim().toLowerCase();
  const list = db.reservations
    .filter((r) => !status || r.status === status)
    .filter((r) => {
      if (!search) return true;
      const u = userById(r.user_id);
      const l = lockerOf(r);
      return (u && (u.name.toLowerCase().includes(search) || u.email.includes(search))) || (l && l.number.includes(search));
    })
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, 100)
    .map((r) => shapeReservation(r, true));
  return { reservations: list };
}

export function adminStudents({ q = '' } = {}) {
  const search = String(q).trim().toLowerCase();
  return {
    students: db.users
      .filter((u) => u.role === 'student')
      .filter((u) => !search || u.name.toLowerCase().includes(search) || u.email.includes(search) || (u.mobile || '').includes(search))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((u) => ({
        ...publicUser(u),
        is_blocked: isBlocked(u),
        total_reservations: db.reservations.filter((r) => r.user_id === u.id).length,
        completed: db.reservations.filter((r) => r.user_id === u.id && r.status === 'completed').length,
        no_shows: db.reservations.filter((r) => r.user_id === u.id && r.status === 'expired').length,
      })),
  };
}

export function adminUnblockStudent(admin, id) {
  const u = userById(Number(id));
  if (!u) throw new ApiError('Student not found.', {}, 404);
  u.blocked_until = null;
  u.no_show_count = 0;
  addLog('unblocked', null, `${u.name} unblocked`, 0, null, { admin_id: admin.id });
  return { message: `${u.name} can reserve again.` };
}

// ---------------------------------------------------------------------------
// Admin: problem reports
// ---------------------------------------------------------------------------
export function adminReports() {
  return {
    reports: db.reports
      .slice()
      .sort((a, b) => (a.status === b.status ? new Date(b.created_at) - new Date(a.created_at) : a.status === 'open' ? -1 : 1))
      .map((r) => {
        const u = userById(r.user_id);
        const l = lockerById(r.locker_id);
        return { ...r, user: u ? { name: u.name, email: u.email } : null, locker: l ? l.number : null };
      }),
  };
}

export function adminToggleReport(id) {
  const r = db.reports.find((x) => x.id === Number(id));
  if (!r) throw new ApiError('Report not found.', {}, 404);
  r.status = r.status === 'open' ? 'resolved' : 'open';
  return { message: r.status === 'resolved' ? 'Marked as resolved.' : 'Opened again.' };
}

// ---------------------------------------------------------------------------
// Admin: team (admin accounts)
// ---------------------------------------------------------------------------
export function adminTeam(admin) {
  return { admins: db.users.filter((u) => u.role === 'admin').map((u) => ({ ...publicUser(u), is_me: u.id === admin.id })) };
}

export function adminAddAdmin({ name, email, password, password_confirmation }) {
  const errors = {};
  const mail = (email || '').trim().toLowerCase();
  if (!name?.trim()) errors.name = ['Please enter the full name.'];
  if (!validEmail(mail)) errors.email = ['Please enter a valid email.'];
  else if (db.users.some((u) => u.email === mail)) errors.email = ['This email is already used by another account.'];
  if (!password || password.length < 8) errors.password = ['Password must be at least 8 characters.'];
  else if (password !== password_confirmation) errors.password_confirmation = ["Passwords don't match."];
  if (Object.keys(errors).length) throw new ApiError('Please check the form.', errors);
  const user = { id: newId(), name: name.trim(), mobile: null, email: mail, password: hashPassword(password), role: 'admin', no_show_count: 0, blocked_until: null, created_at: iso(Date.now()) };
  db.users.push(user);
  return { message: `${user.name} was added as an admin.` };
}

export function adminRemoveAdmin(admin, id) {
  const u = userById(Number(id));
  if (!u || u.role !== 'admin') throw new ApiError('Admin not found.', {}, 404);
  if (u.id === admin.id) throw new ApiError("You can't remove your own account.");
  if (db.users.filter((x) => x.role === 'admin').length <= 1) throw new ApiError('There must be at least one admin.');
  db.users = db.users.filter((x) => x.id !== u.id);
  db.tokens = db.tokens.filter((t) => t.user_id !== u.id);
  return { message: `${u.name} was removed from the team.` };
}

// ---------------------------------------------------------------------------
// Admin: export as CSV (opens in Excel / Google Sheets)
// ---------------------------------------------------------------------------
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // stop Excel formulas
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const toCsv = (headers, rows) => [headers, ...rows].map((row) => row.map(cell).join(',')).join('\n');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hm = (v) => {
  if (!v) return '';
  const d = new Date(v);
  let h = d.getHours();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
};

export function adminExport({ type, from, to }) {
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T23:59:59');
  if (isNaN(start) || isNaN(end)) fail('from', 'Please pick valid dates.');
  if (end < start) fail('to', 'The end date must be on or after the start date.');
  const inRange = (v) => {
    const d = new Date(v);
    return d >= start && d <= end;
  };
  const logs = db.logs.filter((g) => inRange(g.created_at)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  let headers;
  let rows;

  if (type === 'daily') {
    headers = ['Date', 'Reservations made', 'Helmets stored', 'Helmets retrieved', 'Late returns', 'No-shows', 'Cancelled', 'Money collected (PHP)'];
    rows = [];
    const totals = [0, 0, 0, 0, 0, 0, 0];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = ymd(d);
      const dayLogs = logs.filter((g) => ymd(new Date(g.created_at)) === key);
      const c = (a) => dayLogs.filter((g) => g.action === a).length;
      const late = dayLogs.filter((g) => g.action === 'retrieved' && /late/.test(g.details || '')).length;
      const values = [c('reserved'), c('stored'), c('retrieved'), late, c('expired'), c('cancelled'), dayLogs.reduce((s, g) => s + g.amount, 0)];
      values.forEach((v, i) => (totals[i] += v));
      rows.push([key, ...values]);
    }
    rows.push(['TOTAL', ...totals]);
  } else if (type === 'hours') {
    headers = ['Hour', 'Helmets stored', 'Helmets retrieved', 'Total uses', 'Money collected (PHP)'];
    rows = Array.from({ length: 24 }, (_, h) => {
      const hl = logs.filter((g) => new Date(g.created_at).getHours() === h && ['stored', 'retrieved'].includes(g.action));
      const st = hl.filter((g) => g.action === 'stored').length;
      const rt = hl.filter((g) => g.action === 'retrieved').length;
      const label = `${h % 12 || 12}:00 ${h >= 12 ? 'PM' : 'AM'} - ${h % 12 || 12}:59 ${h >= 12 ? 'PM' : 'AM'}`;
      return [label, st, rt, st + rt, hl.reduce((s, g) => s + g.amount, 0)];
    });
  } else if (type === 'activity') {
    headers = ['Date', 'Time', 'Action', 'Locker', 'Student', 'Done by admin', 'Details', 'Amount (PHP)'];
    rows = logs.map((g) => {
      const x = shapeLog(g);
      return [ymd(new Date(g.created_at)), hm(g.created_at), x.action.replace(/_/g, ' '), x.locker || '', x.user || '', x.admin || '', x.details || '', g.amount];
    });
  } else if (type === 'reservations') {
    headers = ['Reservation ID', 'Student', 'Email', 'Locker', 'Date', 'Drop-off', 'Retrieve by', 'Stored at', 'Retrieved at', 'Hours', 'Late fee (PHP)', 'Total paid (PHP)', 'Status'];
    rows = db.reservations
      .filter((r) => inRange(r.start_time))
      .sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
      .map((r) => {
        const u = userById(r.user_id);
        const f = feesFor(r);
        const paid = r.status === 'completed' ? f.total : r.status === 'stored' ? f.drop_off : 0;
        return [r.id, u?.name || 'Deleted account', u?.email || '', lockerOf(r)?.number || '', ymd(new Date(r.start_time)), hm(r.start_time), hm(r.end_time), hm(r.stored_at), hm(r.retrieved_at), f.hours, r.status === 'completed' ? f.late_fee : 0, paid, r.status];
      });
  } else if (type === 'students') {
    headers = ['Name', 'Email', 'Mobile number', 'Registered', 'Total reservations', 'Completed', 'No-shows', 'Current strikes', 'Blocked until'];
    rows = db.users
      .filter((u) => u.role === 'student')
      .map((u) => [u.name, u.email, u.mobile || '', ymd(new Date(u.created_at)), db.reservations.filter((r) => r.user_id === u.id).length, db.reservations.filter((r) => r.user_id === u.id && r.status === 'completed').length, db.reservations.filter((r) => r.user_id === u.id && r.status === 'expired').length, u.no_show_count, isBlocked(u) ? `${ymd(new Date(u.blocked_until))} ${hm(u.blocked_until)}` : '']);
  } else {
    fail('type', 'Please choose a file to export.');
  }

  const filename = type === 'students' ? `helmlock-students-${ymd(new Date())}.csv` : `helmlock-${type}-${from}-to-${to}.csv`;
  return { filename, rows: rows.length, csv: toCsv(headers, rows) };
}

// ---------------------------------------------------------------------------
// First start: create the starting data
// ---------------------------------------------------------------------------
// demo = true  -> sample students and 10 days of past uses (for showing the admin screens)
// demo = false -> only the admin account and the lockers
export function seed(demo = true) {
  const now = Date.now();
  const day0 = new Date();
  day0.setHours(0, 0, 0, 0);
  const pw = hashPassword('password');

  db.users = [{ id: 1, name: 'HelmLock Admin', mobile: null, email: 'admin@helmlock.test', password: pw, role: 'admin', no_show_count: 0, blocked_until: null, created_at: iso(now) }];
  db.lockers = ['01', '02', '03', '04', '05', '06'].map((number, i) => ({
    id: i + 1,
    number,
    location: 'USTP CDO Campus',
    status: number === '06' ? 'out_of_service' : 'available',
    is_physical: number === '01',
  }));
  if (!demo) {
    db.lockers = db.lockers.filter((l) => ['01', '02', '03'].includes(l.number));
    return;
  }

  db.users.push(
    { id: 2, name: 'Juan Dela Cruz', mobile: '09171234567', email: 'juan.delacruz@gmail.com', password: pw, role: 'student', no_show_count: 1, blocked_until: null, created_at: iso(now - 20 * 24 * HOUR) },
    { id: 3, name: 'Ana Reyes', mobile: '09182345678', email: 'ana.reyes@gmail.com', password: pw, role: 'student', no_show_count: 0, blocked_until: null, created_at: iso(now - 18 * 24 * HOUR) },
    { id: 4, name: 'Mark Santos', mobile: '09193456789', email: 'mark.santos@gmail.com', password: pw, role: 'student', no_show_count: 2, blocked_until: null, created_at: iso(now - 15 * 24 * HOUR) },
    { id: 5, name: 'Liza Cruz', mobile: '09204567890', email: 'liza.cruz@gmail.com', password: pw, role: 'student', no_show_count: 0, blocked_until: iso(now + 9 * HOUR), created_at: iso(now - 12 * 24 * HOUR) },
    { id: 6, name: 'Paolo Lim', mobile: '09215678901', email: 'paolo.lim@gmail.com', password: pw, role: 'student', no_show_count: 0, blocked_until: null, created_at: iso(now - 6 * 24 * HOUR) },
  );
  db.meta.lastId = Math.max(db.meta.lastId, 1000);

  // Same "random" numbers every time, so the sample data looks the same
  let s = 7;
  const rand = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const students = [2, 3, 4, 5, 6];
  const hours = [7, 7, 8, 8, 8, 9, 10, 10, 13, 13, 14, 15];

  for (let d = 9; d >= 0; d--) {
    const dayStart = day0.getTime() - d * 24 * HOUR;
    const uses = d === 0 ? 3 : 2 + Math.floor(rand() * 3);
    for (let k = 0; k < uses; k++) {
      const userId = pick(students);
      const lockerId = 2 + Math.floor(rand() * 4); // keep the real locker (01) free for the live test
      const start = dayStart + pick(hours) * HOUR + Math.floor(rand() * 4) * 15 * MIN;
      if (start + 4 * HOUR > now) continue;
      const length = (2 + Math.floor(rand() * 4)) * HOUR;
      const roll = rand();
      const status = roll < 0.75 ? 'completed' : roll < 0.88 ? 'expired' : 'cancelled';
      const r = {
        id: newId(), user_id: userId, locker_id: lockerId,
        start_time: iso(start), end_time: iso(start + length), arrive_by: iso(start + RULES.arriveWindowMinutes * MIN),
        status,
        stored_at: status === 'completed' ? iso(start + 5 * MIN) : null,
        retrieved_at: status === 'completed' ? iso(start + length - 10 * MIN) : null,
        created_at: iso(start - 20 * MIN),
      };
      if (status === 'completed' && rand() < 0.15) r.retrieved_at = iso(start + length + 50 * MIN);
      db.reservations.push(r);
      addLog('reserved', r, 'Locker reserved', 0, r.created_at);
      if (status === 'completed') {
        addLog('stored', r, 'Helmet stored', RULES.dropOffFee, r.stored_at);
        const f = feesFor(r);
        addLog('retrieved', r, f.late_fee ? `Helmet retrieved (late ${f.late_hours} hr)` : 'Helmet retrieved', f.due_at_retrieval, r.retrieved_at);
      } else if (status === 'expired') {
        addLog('expired', r, 'No-show: helmet was not stored in time', 0, r.arrive_by);
      } else {
        addLog('cancelled', r, 'Cancelled by student', 0, iso(start - 5 * MIN));
      }
    }
  }

  // Ana's helmet is in Locker 03 right now
  const ana = { id: newId(), user_id: 3, locker_id: 3, start_time: iso(now - 70 * MIN), end_time: iso(now + 3 * HOUR), arrive_by: iso(now - 55 * MIN), status: 'stored', stored_at: iso(now - 62 * MIN), retrieved_at: null, created_at: iso(now - 80 * MIN) };
  db.reservations.push(ana);
  db.lockers[2].status = 'occupied';
  addLog('reserved', ana, 'Locker reserved', 0, ana.created_at);
  addLog('stored', ana, 'Helmet stored', RULES.dropOffFee, ana.stored_at);

  db.reports = [
    { id: newId(), user_id: 4, locker_id: 2, message: 'Inserted a ₱5 coin but the locker did not respond. Had to insert another one.', status: 'open', created_at: iso(now - 5 * HOUR) },
    { id: newId(), user_id: 3, locker_id: 1, message: 'The LCD screen was very dim this morning, hard to read the message.', status: 'resolved', created_at: iso(now - 3 * 24 * HOUR) },
  ];
  db.logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}
