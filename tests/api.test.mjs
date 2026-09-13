import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openStore } from '../lib/store.mjs';
import { createApp } from '../server.mjs';
import { addDays } from '../lib/booking.mjs';

async function fixture(t, options = {}) {
  const db = openStore(':memory:');
  const app = createApp({ db, production: false, apiKey: '', appUrl: 'http://localhost:3000', trustProxy: false, ...options });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); db.close(); });
  const url = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  async function request(path, method = 'GET', data, headers = {}) {
    const res = await fetch(url + path, { method, headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: cookie, ...headers }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, headers: res.headers, body: await res.json() };
  }
  async function signUp() { return request('/api/auth/register', 'POST', { name: 'Test Client', phone: '+38112345678', email: 'test@example.test', password: 'a-test-password-only' }); }
  return { db, app, request, signUp };
}

test('registration, verification, booking, cancellation, login and logout work over HTTP', async t => {
  const { request, signUp } = await fixture(t);
  const signup = await signUp();
  assert.equal(signup.status, 201); assert.equal(signup.body.user.verified, false);
  assert.match(signup.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal(signup.body.devCode.length, 6); assert.equal(signup.body.user.password, undefined);
  const bootstrap = await request('/api/bootstrap'); assert.equal(bootstrap.body.user.email, 'test@example.test');
  const date = addDays(bootstrap.body.today, 1);
  const slots = (await request(`/api/availability?service=cut-style&date=${date}`)).body.slots;
  const slot = slots.find(s => s.available);
  const booking = { serviceId: 'cut-style', date, time: slot.time, repeatWeeks: 0, notes: 'A test appointment', expectedPrice: slot.price };
  assert.equal((await request('/api/bookings', 'POST', booking)).status, 403);
  assert.equal((await request('/api/auth/verify', 'POST', { code: signup.body.devCode })).body.user.verified, true);
  const created = await request('/api/bookings', 'POST', booking);
  assert.equal(created.status, 201); assert.equal(created.body.booking.status, 'pending');
  assert.equal((await request('/api/bookings', 'POST', booking)).status, 409);
  assert.equal((await request(`/api/bookings/${created.body.booking.id}/action`, 'POST', { action: 'approve' })).status, 403);
  assert.equal((await request(`/api/bookings/${created.body.booking.id}/action`, 'POST', { action: 'cancel' })).body.booking.status, 'cancelled');
  await request('/api/auth/logout', 'POST', {});
  assert.equal((await request('/api/bookings')).status, 401);
  assert.equal((await request('/api/auth/login', 'POST', { email: 'test@example.test', password: 'wrong-password' })).status, 401);
  assert.equal((await request('/api/auth/login', 'POST', { email: 'test@example.test', password: 'a-test-password-only' })).status, 200);
  assert.equal((await request('/api/bookings')).body.bookings.length, 1);
});
test('verification codes expire, are attempt-limited, and cannot be reused', async t => {
  const { db, request, signUp } = await fixture(t);
  const signup = await signUp();
  const wrong = signup.body.devCode === '123456' ? '234567' : '123456';
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/auth/verify', 'POST', { code: wrong })).status, 400);
  assert.match((await request('/api/auth/verify', 'POST', { code: signup.body.devCode })).body.error, /too many attempts/);
  assert.equal((await request('/api/auth/resend', 'POST', {})).status, 429);
  db.prepare('UPDATE verifications SET sent_at = 0').run();
  const resend = await request('/api/auth/resend', 'POST', {});
  db.prepare('UPDATE verifications SET expires_at = 0').run();
  assert.match((await request('/api/auth/verify', 'POST', { code: resend.body.devCode })).body.error, /expired/);
});
test('client cannot read admin data, elevate their role, or set verified status', async t => {
  const { request, signUp } = await fixture(t); await signUp();
  assert.equal((await request('/api/admin/dashboard')).status, 403);
  const profile = await request('/api/profile', 'PATCH', { name: 'New Name', phone: '+38112345678', role: 'admin', verified: true });
  assert.equal(profile.body.user.role, 'client'); assert.equal(profile.body.user.verified, false);
});
test('admin settings and price updates are validated and atomic', async t => {
  const { db, request, signUp } = await fixture(t); const signup = await signUp();
  await request('/api/auth/verify', 'POST', { code: signup.body.devCode });
  db.prepare("UPDATE users SET role = 'admin'").run();
  const dashboard = (await request('/api/admin/dashboard')).body;
  assert.equal(dashboard.settings.requiredApprovals, 2);
  assert.equal((await request('/api/admin/settings', 'PUT', { ...dashboard.settings, requiredApprovals: 0 })).body.settings.requiredApprovals, 0);
  const prices = dashboard.services.map(s => ({ id: s.id, price: s.price + 100, outside_price: s.outside_price + 100 }));
  prices[prices.length - 1].price = -1;
  assert.equal((await request('/api/admin/prices', 'PUT', { services: prices })).status, 400);
  assert.equal(db.prepare('SELECT price FROM services WHERE id = ?').get(prices[0].id).price, dashboard.services[0].price);
  prices[prices.length - 1].price = 2600;
  assert.equal((await request('/api/admin/prices', 'PUT', { services: prices })).status, 200);
});
test('cross-origin mutations are rejected and security headers are sent', async t => {
  const { request } = await fixture(t);
  const blocked = await request('/api/auth/login', 'POST', { email: 'test@example.test', password: 'example' }, { Origin: 'https://untrusted.example' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('x-frame-options'), 'DENY');
  assert.match(blocked.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request('/api/availability')).status, 400);
});
test('production fails closed without email credentials and HTTPS', t => {
  const db = openStore(':memory:'); t.after(() => db.close());
  assert.throws(() => createApp({ db, production: true, apiKey: '', from: '', appUrl: 'http://localhost:3000' }), /Production requires/);
});

test('health probes distinguish a live server from an unavailable database without exposing errors', async t => {
  const { db, request } = await fixture(t);
  assert.deepEqual((await request('/health/live')).body, { ok: true });
  assert.equal((await request('/health/ready')).status, 200);
  db.prepare('DELETE FROM settings').run();
  assert.equal((await request('/health/live')).status, 200);
  assert.deepEqual(await request('/health/ready').then(r => ({ status: r.status, body: r.body })), { status: 503, body: { error: 'Not ready.' } });
});

for (const trustProxy of [false, true]) {
  test(`forwarded client IPs ${trustProxy ? 'separate client rate limits behind the trusted edge' : 'cannot bypass rate limits by default'}`, async t => {
    const { request } = await fixture(t, { trustProxy });
    for (let i = 1; i <= 26; i++) {
      const res = await request('/api/auth/login', 'POST', {}, { 'X-Erd-Client-IP': `192.0.2.${i}` });
      assert.equal(res.status, trustProxy || i <= 25 ? 400 : 429);
    }
  });
}
