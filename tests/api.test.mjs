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
  return { db, app, request, signUp, url };
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

test('brand assets have browser-safe MIME types and share previews use the configured origin', async t => {
  const { url } = await fixture(t, { appUrl: 'https://salon.example.test' });
  const html = await (await fetch(url)).text();
  assert.match(html, /content="https:\/\/salon\.example\.test\/brand\/social\/share-light-1200x630\.jpg"/);
  assert.ok(!html.includes('__APP_ORIGIN__'));
  for (const [path, type] of [
    ['/brand/logos/logo-horizontal-black.png', 'image/png'],
    ['/brand/icons/favicon.ico', 'image/x-icon'],
    ['/brand/social/share-light-1200x630.jpg', 'image/jpeg'],
    ['/site.webmanifest', 'application/manifest+json'],
  ]) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), type);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
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

test('super admin requires email verification and alone can grant or revoke administrators', async t => {
  const {db,request,signUp}=await fixture(t);
  const client=await signUp();await request('/api/auth/verify','POST',{code:client.body.devCode});
  const owner=await request('/api/auth/register','POST',{name:'Salon Owner',phone:'+38112345678',email:'mendmania@gmail.com',password:'owner-test-password'});
  assert.equal(owner.body.user.role,'client');
  assert.equal((await request('/api/admin/dashboard')).status,403);
  const verified=await request('/api/auth/verify','POST',{code:owner.body.devCode});
  assert.equal(verified.body.user.role,'super_admin');
  assert.equal((await request('/api/admin/dashboard')).body.admins[0].email,'mendmania@gmail.com');
  assert.equal((await request('/api/admin/team','PUT',{email:'mendmania@gmail.com',role:'client'})).status,403);
  assert.equal((await request('/api/admin/team','PUT',{email:'test@example.test',role:'super_admin'})).status,400);
  assert.equal((await request('/api/admin/team','PUT',{email:'missing@example.test',role:'admin'})).status,404);
  assert.equal((await request('/api/admin/team','PUT',{email:'test@example.test',role:'admin'})).status,200);
  assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(client.body.user.id).n,0);
  await request('/api/auth/login','POST',{email:'test@example.test',password:'a-test-password-only'});
  assert.equal((await request('/api/admin/dashboard')).body.admins,undefined);
  assert.equal((await request('/api/admin/team','PUT',{email:'mendmania@gmail.com',role:'client'})).status,403);
  const settings=(await request('/api/admin/dashboard')).body.settings;
  assert.equal((await request('/api/admin/settings','PUT',{...settings,allowOutside:false})).status,200);
  await request('/api/auth/login','POST',{email:'mendmania@gmail.com',password:'owner-test-password'});
  assert.equal((await request('/api/admin/team','PUT',{email:'test@example.test',role:'client'})).status,200);
  await request('/api/auth/login','POST',{email:'test@example.test',password:'a-test-password-only'});
  assert.equal((await request('/api/admin/dashboard')).status,403);
});
test('admin can manage service menu and time off through HTTP; clients cannot', async t => {
  const {db,request,signUp}=await fixture(t);const user=await signUp();
  await request('/api/auth/verify','POST',{code:user.body.devCode});
  const service={name:'Simple cut',description:'A fresh look.',duration:30,price:2500,outside_price:3500,category:'Cut & style'};
  const date=addDays((await request('/api/bootstrap')).body.today,2);
  const vacation={startDate:date,endDate:date,label:'Holiday'};
  assert.equal((await request('/api/admin/services','POST',service)).status,403);
  assert.equal((await request('/api/admin/vacations','POST',vacation)).status,403);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.body.user.id);
  const created=await request('/api/admin/services','POST',service);assert.equal(created.status,201);
  const id=created.body.service.id;
  assert.equal((await request(`/api/admin/services/${id}`,'PUT',{...service,price:2700})).body.service.price,2700);
  assert.ok((await request('/api/bootstrap')).body.services.some(s=>s.id===id));
  const off=await request('/api/admin/vacations','POST',vacation);assert.equal(off.status,201);
  assert.deepEqual((await request(`/api/availability?service=${id}&date=${date}`)).body.slots,[]);
  assert.equal((await request('/api/admin/dashboard')).body.vacations[0].label,'Holiday');
  assert.equal((await request(`/api/admin/vacations/${off.body.vacation.id}`,'DELETE',{})).status,200);
  assert.ok((await request(`/api/availability?service=${id}&date=${date}`)).body.slots.length);
  assert.equal((await request(`/api/admin/services/${id}`,'DELETE',{})).status,200);
  assert.ok(!(await request('/api/bootstrap')).body.services.some(s=>s.id===id));
  assert.equal((await request(`/api/availability?service=${id}&date=${date}`)).status,400);
  assert.equal((await request(`/api/admin/services/${id}`,'PUT',service)).status,404);
});

test('clean page URLs load directly while unknown pages and API authorization stay intact', async t => {
  const { url, request } = await fixture(t);
  for (const path of ['/', '/book', '/services', '/studio', '/appointments', '/admin', '/admin/working-hours', '/admin/time-off', '/admin/services', '/admin/booking-rules', '/admin/team']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /src="\/app\.js\?v=/);
  }
  for (const path of ['/services/', '/admin/working-hours/']) {
    const response = await fetch(url + path + '?lang=sq', { redirect: 'manual' });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), path.slice(0, -1) + '?lang=sq');
  }
  for (const path of ['/not-a-page', '/missing.js', '/admin/missing', '/api/missing']) assert.equal((await fetch(url + path)).status, 404, path);
  assert.equal((await request('/api/admin/dashboard')).status, 401);
});

test('manual booking endpoints require verified staff and show guest and account reservations in the right calendars', async t => {
  const {db,request,signUp}=await fixture(t);
  const guest={name:'Phone Client',phone:'+38112345678',serviceId:'mens-cut',notes:'Booked by phone'};
  assert.equal((await request('/api/admin/clients')).status,401);
  assert.equal((await request('/api/admin/bookings','POST',guest)).status,401);
  const signup=await signUp();
  assert.equal((await request('/api/admin/clients')).status,403);
  assert.equal((await request('/api/admin/bookings','POST',guest)).status,403);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(signup.body.user.id);
  assert.equal((await request('/api/admin/bookings','POST',guest)).status,403);
  await request('/api/auth/verify','POST',{code:signup.body.devCode});
  const clients=await request('/api/admin/clients');
  assert.equal(clients.status,200);
  assert.deepEqual(Object.keys(clients.body.clients[0]).sort(),['email','id','name','phone']);
  const date=addDays((await request('/api/bootstrap')).body.today,1);
  const slots=(await request(`/api/availability?service=mens-cut&date=${date}`)).body.slots;
  const input={...guest,date,time:slots[0].time,expectedPrice:slots[0].price};
  const created=await request('/api/admin/bookings','POST',input);
  assert.equal(created.status,201); assert.equal(created.body.booking.status,'confirmed');
  assert.equal((await request('/api/admin/bookings','POST',input)).status,409);
  const row=(await request('/api/admin/dashboard')).body.bookings[0];
  assert.equal(row.name,guest.name); assert.equal(row.phone,guest.phone); assert.equal(row.email,'');
  assert.equal((await request('/api/bookings')).body.bookings.length,0);
  const account=await request('/api/admin/bookings','POST',{...input,userId:signup.body.user.id,time:slots[1].time,expectedPrice:slots[1].price});
  assert.equal(account.status,201);
  assert.equal((await request('/api/bookings')).body.bookings[0].id,account.body.booking.id);
  assert.equal((await request('/api/admin/dashboard')).body.bookings.length,2);
  const cancelled=await request(`/api/bookings/${created.body.booking.id}/action`,'POST',{action:'cancel'});
  assert.equal(cancelled.body.booking.status,'cancelled');
  assert.equal((await request(`/api/availability?service=mens-cut&date=${date}`)).body.slots[0].available,true);
});

test('only the super admin can configure email language while all admins receive reservations', async t => {
  const {db,request,url}=await fixture(t);
  const {createSession}=await import('../lib/auth.mjs');
  db.exec(`INSERT INTO users (id,email,name,password,verified,role,created_at) VALUES
    ('owner','mendmania@gmail.com','Owner','unused',1,'client',0),
    ('staff','staff@example.test','Barber','unused',1,'admin',0),
    ('customer','customer@example.test','Customer','unused',1,'client',0),
    ('unverified','unverified@example.test','Unverified','unused',0,'admin',0)`);
  const call=(id,path,method='GET',data)=>request(path,method,data,{Cookie:`erd_session=${createSession(db,id)}`});
  assert.equal((await request('/api/admin/notifications')).status,401);
  for(const id of ['customer','unverified']) {
    assert.equal((await call(id,'/api/admin/notifications')).status,403);
    assert.equal((await call(id,'/api/admin/notifications/read','POST',{throughId:1})).status,403);
  }
  for(const id of ['staff','customer','unverified']) {
    assert.equal((await call(id,'/api/admin/notification-settings')).status,403);
    assert.equal((await call(id,'/api/admin/notification-settings','PUT',{recipientIds:[id],language:'en'})).status,403);
    assert.equal((await call(id,'/api/admin/notification-settings/retry','POST',{})).status,403);
  }
  const prefs=await call('owner','/api/admin/notification-settings','PUT',{recipientIds:['owner','staff'],language:'sq'});
  assert.equal(prefs.status,200);assert.equal(prefs.body.recipients.length,2);assert.equal(prefs.body.emailConfigured,false);
  assert.equal((await call('owner','/api/admin/notification-settings','PUT',{language:'invalid'})).status,400);
  // The general settings endpoint must not provide a route around owner-only email language controls.
  const bootstrap=(await request('/api/bootstrap')).body;
  assert.equal(bootstrap.settings.notificationRecipients,undefined);
  assert.equal((await call('staff','/api/admin/settings','PUT',{...bootstrap.settings,recipientIds:['customer'],notificationRecipients:['customer']})).status,200);
  assert.equal((await call('owner','/api/admin/notification-settings')).body.language,'sq');
  const date=addDays(bootstrap.today,1);
  const slot=(await request(`/api/availability?service=mens-cut&date=${date}`)).body.slots[0];
  const manual=await call('staff','/api/admin/bookings','POST',{name:'Guest',phone:'+38112345678',serviceId:'mens-cut',date,time:slot.time,expectedPrice:slot.price,notes:''});
  assert.equal(manual.status,201);
  const ownerInbox=(await call('owner','/api/admin/notifications')).body;
  assert.equal(ownerInbox.unreadCount,1);assert.equal(ownerInbox.items[0].booking_id,manual.body.booking.id);
  assert.equal((await call('staff','/api/admin/notifications')).body.unreadCount,1);
  assert.equal((await call('staff','/api/admin/notifications/read','POST',{id:ownerInbox.items[0].id})).status,200);
  assert.equal((await call('owner','/api/admin/notifications')).body.unreadCount,1);
  assert.equal((await call('owner','/api/admin/notifications/read','POST',{id:ownerInbox.items[0].id})).body.unreadCount,0);
  const pending=(await call('owner','/api/admin/notification-settings')).body.pending;
  assert.equal(pending,2);
  await call('owner','/api/admin/notification-settings','PUT',{recipientIds:[],language:'en'});
  assert.equal((await call('owner','/api/admin/notification-settings')).body.pending,2);
  assert.equal((await fetch(url+'/admin/notifications')).status,200);
});


test('release identity is public, exact and never cached', async t => {
  const revision = 'a'.repeat(40);
  const { request } = await fixture(t, { revision, release: '123-2' });
  const result = await request('/api/version');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { revision, release: '123-2' });
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const unknown = await fixture(t, { revision: 'invalid-value', release: 'invalid' });
  assert.deepEqual((await unknown.request('/api/version')).body, { revision: null, release: null });
});


test('other admins cannot see the protected owner in account lists, even before owner verification', async t => {
  const { db, request } = await fixture(t);
  const { createSession } = await import('../lib/auth.mjs');
  db.exec(`INSERT INTO users (id,email,name,password,verified,role,created_at) VALUES
    ('owner','MendMania@gmail.com','Owner','unused',0,'client',0),
    ('staff','staff@example.test','Barber','unused',1,'admin',0),
    ('customer','customer@example.test','Customer','unused',1,'client',0)`);
  const call = (id, path) => request(path, 'GET', undefined, { Cookie: `erd_session=${createSession(db, id)}` });
  for (const verified of [0, 1]) {
    if (verified) db.prepare('UPDATE users SET verified=1 WHERE id=?').run('owner');
    const clients = await call('staff', '/api/admin/clients');
    assert.equal(clients.status, 200);
    assert.deepEqual(clients.body.clients.map(client => client.id).sort(), ['customer', 'staff']);
    assert.ok(!JSON.stringify(clients.body).toLowerCase().includes('mendmania@gmail.com'));
    assert.equal((await call('staff', '/api/admin/dashboard')).body.admins, undefined);
    assert.equal((await call('staff', '/api/admin/notification-settings')).status, 403);
  }
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get('owner').role, 'super_admin');
  assert.deepEqual((await call('owner', '/api/admin/clients')).body.clients.map(client => client.id).sort(), ['customer', 'owner', 'staff']);
  assert.ok((await call('owner', '/api/admin/dashboard')).body.admins.some(admin => admin.id === 'owner'));
});

test('HTTP reservations retain client language and approval queues a confirmation without affecting visit completion',async t=>{
  const {db,request}=await fixture(t);
  const {createSession}=await import('../lib/auth.mjs');
  db.exec(`INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES
    ('client','client@example.test','Client','unused',1,'client',0),
    ('admin','admin@example.test','Admin','unused',1,'admin',0)`);
  const headers=id=>({Cookie:`erd_session=${createSession(db,id)}`});
  const date=addDays((await request('/api/bootstrap')).body.today,1);
  const slot=(await request(`/api/availability?service=mens-cut&date=${date}`)).body.slots[0];
  const created=await request('/api/bookings','POST',{serviceId:'mens-cut',date,time:slot.time,expectedPrice:slot.price,notes:'',repeatWeeks:0},{...headers('client'),'Accept-Language':'sq'});
  assert.equal(created.status,201);
  assert.equal(created.body.booking.email_language,'sq');
  assert.equal(db.prepare("SELECT count(*) n FROM client_notifications WHERE kind='confirmed'").get().n,0);
  const path=`/api/bookings/${created.body.booking.id}/action`;
  assert.equal((await request(path,'POST',{action:'approve'},headers('client'))).status,403);
  const approved=await request(path,'POST',{action:'approve'},headers('admin'));
  assert.equal(approved.status,200);assert.equal(approved.body.booking.status,'confirmed');
  const job=db.prepare("SELECT * FROM client_notifications WHERE kind='confirmed'").get();
  assert.equal(job.user_id,'client');assert.equal(job.language,'sq');assert.equal(job.email_status,'pending');
  assert.equal((await request(path,'POST',{action:'approve'},headers('admin'))).status,409);
  assert.equal(db.prepare("SELECT count(*) n FROM client_notifications WHERE kind='confirmed'").get().n,1);
});

test('guests can request a booking over HTTP without an account and admins see their contact details',async t=>{
  const {db,request}=await fixture(t);
  const {createSession}=await import('../lib/auth.mjs');
  const date=addDays((await request('/api/bootstrap')).body.today,1);
  const slot=(await request(`/api/availability?service=mens-cut&date=${date}`)).body.slots[0];
  const body={name:'Guest Client',email:'guest@example.test',serviceId:'mens-cut',date,time:slot.time,expectedPrice:slot.price};
  const result=await request('/api/bookings/guest','POST',body,{'Accept-Language':'sq'});
  assert.equal(result.status,201);assert.equal(result.body.booking.status,'pending');assert.equal(result.body.booking.email_language,'sq');
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,0);
  assert.equal((await request('/api/bookings')).status,401);
  assert.equal((await request(`/api/bookings/${result.body.booking.id}/action`,'POST',{action:'approve'})).status,401);
  db.exec("INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES('admin','admin@example.test','Admin','unused',1,'admin',0)");
  const headers={Cookie:`erd_session=${createSession(db,'admin')}`};
  const dashboard=await request('/api/admin/dashboard','GET',undefined,headers);
  assert.equal(dashboard.body.bookings[0].email,'guest@example.test');assert.equal(dashboard.body.bookings[0].phone,'');
  assert.equal((await request(`/api/bookings/${result.body.booking.id}/action`,'POST',{action:'approve'},headers)).status,200);
  assert.equal(db.prepare('SELECT user_id FROM client_notifications').get().user_id,null);
});

test('public guest booking endpoint rate limits requests',async t=>{
  const {request}=await fixture(t);
  for(let i=0;i<10;i++) assert.equal((await request('/api/bookings/guest','POST',{})).status,400);
  assert.equal((await request('/api/bookings/guest','POST',{})).status,429);
});

test('registration accepts Name123 and six-character passwords, rejects shorter ones, and supports login',async t=>{
  const {request}=await fixture(t);
  const account={name:'Test Client',email:'short@example.test',phone:'+38312345678',password:'Name123'};
  assert.equal((await request('/api/auth/register','POST',{...account,password:'12345'})).status,400);
  assert.equal((await request('/api/auth/register','POST',account)).status,201);
  await request('/api/auth/logout','POST',{});
  assert.equal((await request('/api/auth/login','POST',{email:account.email,password:account.password})).status,200);
  assert.equal((await request('/api/auth/register','POST',{...account,email:'six@example.test',password:'abcdef'})).status,201);
});
