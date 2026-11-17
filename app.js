// All the web addresses (routes). Same list as the app's src/api/real.js and API_CONTRACT.md,
// plus the cabinet's /api/locker/* routes.
import './lib/tz.js';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ApiError } from './lib/errors.js';
import { LOCKER_KEY, RATE_LIMIT_MAX } from './lib/config.js';
import { db, scheduleSave } from './lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
import * as svc from './lib/service.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  // Save the database after every change
  app.use((req, res, next) => {
    res.on('finish', () => {
      if (req.method !== 'GET') scheduleSave();
    });
    next();
  });

  // Run a handler, send its answer as JSON, and pass any error to the error handler below
  const h = (fn) => (req, res, next) => {
    try {
      const out = fn(req, res);
      if (out && typeof out.then === 'function') out.then((v) => res.json(v)).catch(next);
      else res.json(out);
    } catch (e) {
      next(e);
    }
  };

  // Too many tries from one address (login, sign up, reset)
  const hits = new Map();
  const limit = (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < 60000);
    list.push(now);
    hits.set(key, list);
    if (list.length > RATE_LIMIT_MAX) return next(new ApiError('Too many tries. Please wait a minute and try again.', {}, 429));
    next();
  };
  setInterval(() => hits.clear(), 10 * 60000).unref();

  // Logged-in students and admins
  const auth = (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = svc.userFromToken(token);
    if (!user) return next(new ApiError('Unauthenticated.', {}, 401));
    req.user = user;
    req.token = token;
    next();
  };
  const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : next(new ApiError('Admins only.', {}, 403)));

  // The locker cabinet proves who it is with a secret key
  const cabinet = (req, res, next) => {
    const given = Buffer.from(String(req.headers['x-locker-key'] || ''));
    const real = Buffer.from(LOCKER_KEY);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) return next(new ApiError('Bad locker key.', {}, 401));
    db.meta.lastCabinetContact = new Date().toISOString();
    next();
  };

  app.get('/', (req, res) => res.type('text').send('HelmLock API is running.'));
  app.get('/up', (req, res) => res.json({ ok: true })); // point a free uptime monitor here so the host never sleeps
  app.get('/setup', (req, res) => res.sendFile(path.join(here, 'public', 'setup.html')));

  // ---- Auth ----
  app.post('/api/login', limit, h((req) => svc.login(req.body || {})));
  app.post('/api/register', limit, h((req) => svc.register(req.body || {})));
  app.post('/api/forgot-password', limit, h((req) => svc.forgotPassword(req.body || {})));
  app.post('/api/reset-password', limit, h((req) => svc.resetPassword(req.body || {})));
  app.post('/api/logout', auth, h((req) => {
    svc.revokeToken(req.token);
    return { ok: true };
  }));
  app.get('/api/me', auth, h((req) => svc.getMe(req.user)));

  // ---- Profile ----
  app.put('/api/profile', auth, h((req) => svc.updateProfile(req.user, req.body || {})));
  app.put('/api/profile/password', auth, h((req) => svc.updatePassword(req.user, req.body || {})));

  // ---- Student ----
  app.get('/api/home', auth, h((req) => svc.getHome(req.user)));
  app.get('/api/lockers', auth, h(() => svc.getLockers()));
  app.post('/api/reservations', auth, h((req) => svc.createReservation(req.user, req.body || {})));
  app.get('/api/reservations', auth, h((req) => svc.getHistory(req.user)));
  app.get('/api/reservations/:id', auth, h((req) => svc.getReservation(req.user, req.params.id)));
  app.post('/api/reservations/:id/cancel', auth, h((req) => svc.cancelReservation(req.user, req.params.id)));
  app.get('/api/qr', auth, h((req) => svc.getMyQr(req.user)));
  app.post('/api/qr/out/regenerate', auth, h((req) => svc.regenerateOutQr(req.user)));
  app.get('/api/reports/lockers', auth, h(() => svc.getReportLockers()));
  app.post('/api/reports', auth, h((req) => svc.createReport(req.user, req.body || {})));

  // ---- Admin ----
  const admin = express.Router();
  admin.use(auth, adminOnly);
  admin.get('/dashboard', h(() => svc.adminDashboard()));
  admin.get('/sms-log', h(() => svc.adminSmsLog()));
  admin.get('/status', h(() => svc.adminStatus()));
  admin.post('/sms-test', h((req) => svc.adminSmsTest(req.body || {})));
  admin.post('/simulate-scan', h((req) => svc.adminSimulateScan(req.body || {})));
  admin.get('/lockers', h(() => svc.adminLockers()));
  admin.post('/lockers', h((req) => svc.adminAddLocker(req.user, req.body || {})));
  admin.put('/lockers/:id', h((req) => svc.adminUpdateLocker(req.user, req.params.id, req.body || {})));
  admin.delete('/lockers/:id', h((req) => svc.adminDeleteLocker(req.user, req.params.id)));
  admin.post('/lockers/:id/status', h((req) => svc.adminSetLockerStatus(req.user, req.params.id, (req.body || {}).status)));
  admin.post('/lockers/:id/release', h((req) => svc.adminReleaseLocker(req.user, req.params.id)));
  admin.get('/reservations', h((req) => svc.adminReservations(req.query)));
  admin.get('/students', h((req) => svc.adminStudents(req.query)));
  admin.post('/students/:id/unblock', h((req) => svc.adminUnblockStudent(req.user, req.params.id)));
  admin.get('/reports', h(() => svc.adminReports()));
  admin.post('/reports/:id/toggle', h((req) => svc.adminToggleReport(req.params.id)));
  admin.get('/team', h((req) => svc.adminTeam(req.user)));
  admin.post('/team', h((req) => svc.adminAddAdmin(req.body || {})));
  admin.delete('/team/:id', h((req) => svc.adminRemoveAdmin(req.user, req.params.id)));
  admin.get('/export', h((req) => svc.adminExport(req.query)));
  app.use('/api/admin', admin);

  // ---- The locker cabinet (ESP32) ----
  app.get('/api/locker/status', cabinet, h(() => svc.lockerStatus()));
  app.post('/api/locker/scan', cabinet, h((req) => svc.scan(req.body || {})));
  app.post('/api/locker/door', cabinet, h((req) => svc.lockerDoor(req.body || {})));

  // ---- Errors ----
  app.use('/api', (req, res) => res.status(404).json({ message: 'Not found.' }));
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ message: err.message, errors: err.errors });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Bad JSON.' });
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server.' });
  });

  return app;
}
