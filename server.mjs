import { isAdmin, isSuperAdmin } from './lib/roles.mjs';
import { setAdmin, addVacation, saveService, removeService } from './lib/admin.mjs';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname } from 'node:path';
import { isIP } from 'node:net';
import { openStore, settingsFor, transaction } from './lib/store.mjs';
import { AppError, demand, availability, createBooking, changeBooking, updateSettings, localDate } from './lib/booking.mjs';
import { register, passwordMatches, passwordHash, sessionUser, publicUser, createSession, sendVerification, verifyEmail, validateDetails, hash } from './lib/auth.mjs';

const root = fileURLToPath(new URL('./public/', import.meta.url));
export function createApp({ db = openStore(), production = process.env.NODE_ENV === 'production', appUrl = process.env.APP_URL || 'http://localhost:3000', apiKey = process.env.BREVO_API_KEY, from = process.env.EMAIL_FROM, trustProxy = process.env.TRUST_PROXY === 'true' } = {}) {
  if (production && (!apiKey || !from || !appUrl.startsWith('https://'))) throw new Error('Production requires BREVO_API_KEY, EMAIL_FROM, and an HTTPS APP_URL.');
  const dummyPassword = passwordHash('dummy-password-never-used');
  const limits = new Map();
  const mail = { production, apiKey, from };
  function rateLimit(req, group, max) {
    const forwarded = req.headers['x-erd-client-ip'];
    const address = trustProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
    const key = `${address}:${group}`;
    const now = Date.now();
    if (limits.size > 5000) for (const [key, entry] of limits) if (entry.until <= now) limits.delete(key);
    const entry = limits.get(key) || { until: now + 900000, count: 0 };
    if (entry.until <= now) { entry.until = now + 900000; entry.count = 0; }
    entry.count++; limits.set(key, entry);
    demand(entry.count <= max, 'Too many attempts. Please try again in 15 minutes.', 429);
  }
  return createServer(async (req, res) => {
    const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    const cookie = token => res.setHeader('Set-Cookie', `erd_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? 604800 : 0}${production ? '; Secure' : ''}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, appUrl);
      // Probes do not consume client rate limits or depend on an email provider.
      if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
        demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed.', 405);
        if (url.pathname === '/health/ready') {
          try { demand(db.prepare('SELECT id FROM settings WHERE id = 1').get(), 'Not ready.', 503); }
          catch { throw new AppError('Not ready.', 503); }
        }
        return json({ ok: true });
      }
      if (!url.pathname.startsWith('/api/')) {
        demand(req.method === 'GET' || req.method === 'HEAD', 'Method not allowed.', 405);
        const path = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const file = resolve(root, path);
        demand(file.startsWith(root) && !path.includes('..'), 'Not found.', 404);
        let content;
        try { content = await readFile(file); } catch { throw new AppError('Not found.', 404); }
        if (file === resolve(root, 'index.html')) content = content.toString('utf8').replaceAll('__APP_ORIGIN__', new URL(appUrl).origin);
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' })[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      rateLimit(req, 'api', 1000);
      let input = {};
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        const localOrigins = production ? [] : ['http://localhost:3000', 'http://127.0.0.1:3000'];
        demand(!origin || origin === new URL(appUrl).origin || localOrigins.includes(origin), 'This request is not permitted.', 403);
        demand(!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] !== 'cross-site', 'This request is not permitted.', 403);
        demand(req.headers['content-type']?.startsWith('application/json'), 'Expected JSON.', 415);
        let body = '';
        for await (const chunk of req) { body += chunk; demand(Buffer.byteLength(body) <= 16000, 'Request is too large.', 413); }
        try { input = JSON.parse(body || '{}'); } catch { throw new AppError('Invalid JSON.'); }
        demand(input && typeof input === 'object' && !Array.isArray(input), 'Invalid request.');
      }
      const user = sessionUser(db, req);
      const requireUser = () => demand(user, 'Please sign in to continue.', 401);
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /api/bootstrap') {
        const settings = settingsFor(db);
        return json({ services: db.prepare('SELECT * FROM services WHERE active = 1').all(), settings, user: publicUser(user), today: localDate(Date.now(), settings.timezone), development: !production && !apiKey });
      }
      if (route === 'GET /api/availability') return json(availability(db, url.searchParams.get('service'), url.searchParams.get('date')));
      if (route === 'POST /api/auth/register') {
        rateLimit(req, 'register', 10);
        const account = await register(db, input);
        cookie(createSession(db, account.id));
        try { return json({ user: publicUser(account), ...await sendVerification(db, account, mail) }, 201); }
        catch (e) { if (!(e instanceof AppError)) throw e; return json({ user: publicUser(account), emailError: e.message }, 201); }
      }
      if (route === 'POST /api/auth/login') {
        rateLimit(req, 'login', 25);
        demand(typeof input.email === 'string' && typeof input.password === 'string' && input.password.length <= 200, 'Enter your email and password.');
        const account = db.prepare('SELECT * FROM users WHERE email = ?').get(input.email.trim().toLowerCase());
        const matched = await passwordMatches(input.password, account?.password || await dummyPassword);
        demand(account && matched, 'The email or password is incorrect.', 401);
        cookie(createSession(db, account.id));
        return json({ user: publicUser(account) });
      }
      if (route === 'POST /api/auth/logout') {
        const token = req.headers.cookie?.split('; ').find(c => c.startsWith('erd_session='))?.slice(12);
        if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(hash(token));
        cookie(''); return json({ ok: true });
      }
      if (route === 'POST /api/auth/resend') {
        requireUser(); rateLimit(req, 'resend', 10); demand(!user.verified, 'Your email is already verified.');
        return json(await sendVerification(db, user, mail));
      }
      if (route === 'POST /api/auth/verify') {
        requireUser(); rateLimit(req, 'verify', 30); verifyEmail(db, user.id, input.code);
        return json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
      }
      if (route === 'PATCH /api/profile') {
        requireUser(); validateDetails(input);
        db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(input.name.trim(), input.phone.trim(), user.id);
        return json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
      }
      if (route === 'GET /api/bookings') { requireUser(); return json({ bookings: db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC').all(user.id) }); }
      if (route === 'POST /api/bookings') { requireUser(); return json({ booking: createBooking(db, user.id, input) }, 201); }
      if (req.method === 'POST' && /^\/api\/bookings\/[^/]+\/action$/.test(url.pathname)) {
        requireUser(); return json({ booking: changeBooking(db, user, url.pathname.split('/')[3], input.action) });
      }
      if (url.pathname.startsWith('/api/admin/')) { requireUser(); demand(isAdmin(user) && user.verified, 'Admin access is required.', 403); }
      if (route === 'GET /api/admin/dashboard') {
        return json({ bookings: db.prepare('SELECT b.*, u.name, u.email, u.phone, u.approvals FROM bookings b JOIN users u ON u.id = b.user_id ORDER BY b.starts_at DESC').all(), settings: settingsFor(db), services: db.prepare('SELECT * FROM services WHERE active = 1').all(), vacations: db.prepare('SELECT * FROM vacations ORDER BY start_date').all(), ...(isSuperAdmin(user) ? { admins: db.prepare("SELECT id,name,email,role FROM users WHERE role IN ('admin','super_admin') ORDER BY role DESC,name").all() } : {}) });
      }
      if (route === 'PUT /api/admin/settings') return json({ settings: updateSettings(db, input) });
      if (route === 'PUT /api/admin/team') return json(setAdmin(db, user, input.email, input.role));
      if (route === 'POST /api/admin/vacations') return json({ vacation: addVacation(db, input) }, 201);
      if (req.method === 'DELETE' && /^\/api\/admin\/vacations\/[^/]+$/.test(url.pathname)) {
        demand(db.prepare('DELETE FROM vacations WHERE id = ?').run(url.pathname.split('/')[4]).changes, 'Time off not found.', 404);
        return json({ ok: true });
      }
      if (route === 'POST /api/admin/services') return json({ service: saveService(db, null, input) }, 201);
      if (/^\/api\/admin\/services\/[^/]+$/.test(url.pathname)) {
        const id = url.pathname.split('/')[4];
        if (req.method === 'PUT') return json({ service: saveService(db, id, input) });
        if (req.method === 'DELETE') return json(removeService(db, id));
      }
      if (route === 'PUT /api/admin/prices') {
        demand(Array.isArray(input.services), 'Provide service prices.');
        transaction(db, () => {
          const all = db.prepare('SELECT id FROM services WHERE active = 1').all();
          demand(input.services.length === all.length && new Set(input.services.map(s => s.id)).size === all.length, 'Provide each service exactly once.');
          for (const s of input.services) {
            demand(all.some(a => a.id === s.id), 'Unknown service.');
            demand(Number.isInteger(s.price) && s.price >= 0 && s.price <= 1000000 && Number.isInteger(s.outside_price) && s.outside_price >= 0 && s.outside_price <= 1000000, 'Prices must be between 0 and 10,000.');
            db.prepare('UPDATE services SET price = ?, outside_price = ? WHERE id = ?').run(s.price, s.outside_price, s.id);
          }
        });
        return json({ services: db.prepare('SELECT * FROM services WHERE active = 1').all() });
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      if (!res.headersSent) json({ error: error instanceof AppError ? error.message : 'Something went wrong. Please try again.' }, error.status || 500);
      else res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const db = openStore();
  const server = createApp({ db });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.listen(port, host, () => console.log(`ERD Hair Design is ready at http://${host}:${port}`));
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 25000).unref();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
