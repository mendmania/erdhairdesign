import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/store.mjs';
import { createBooking, createAdminBooking, changeBooking } from '../lib/booking.mjs';
import { setAdmin } from '../lib/admin.mjs';
import { OWNER_EMAIL } from '../lib/roles.mjs';
import { notificationPreferences, saveNotificationPreferences, notificationInbox, markNotificationsRead, retryNotificationEmails, createNotificationWorker, bookingEmail, sendBookingEmail } from '../lib/notifications.mjs';
const NOW=Date.parse('2030-01-06T12:00:00Z');
const input=(o={})=>({serviceId:'cut-style',date:'2030-01-07',time:'09:00',notes:'Private client notes',repeatWeeks:0,expectedPrice:4500,...o});
const config={apiKey:'test-key',from:'ERD <bookings@example.test>',appUrl:'https://salon.example.test'};
function seed(db) {
  const insert=db.prepare('INSERT INTO users (id,email,name,password,verified,role,created_at) VALUES (?,?,?,?,?,?,?)');
  insert.run('owner',OWNER_EMAIL,'Owner','unused',1,'client',NOW);
  insert.run('admin','admin@example.test','Barber','unused',1,'admin',NOW);
  insert.run('unverified','unverified@example.test','Unverified','unused',0,'admin',NOW);
  insert.run('client','client@example.test','Client <script>','unused',1,'client',NOW);
  return Object.fromEntries(['owner','admin','client'].map(id=>[id,db.prepare('SELECT * FROM users WHERE id=?').get(id)]));
}
function fixture(t) { const db=openStore(':memory:'); t.after(()=>db.close()); return {db,...seed(db)}; }
function select(db,owner,ids=['owner','admin'],language='en') { return saveNotificationPreferences(db,owner,{recipientIds:ids,language}); }
function jobs(db) { return db.prepare("SELECT n.*,e.payload,e.kind,e.booking_id,u.email FROM admin_notifications n JOIN booking_events e ON e.id=n.event_id JOIN users u ON u.id=n.user_id ORDER BY n.id").all(); }

test('all verified admins receive emails automatically and only the owner can change team language',t=>{
  const {db,owner,admin,client}=fixture(t);
  assert.ok(notificationPreferences(db,owner).recipients.every(u=>u.selected));
  assert.deepEqual(notificationPreferences(db,owner).recipients.map(u=>u.id).sort(),['admin','owner']);
  for (const actor of [null,admin,client]) {
    assert.throws(()=>notificationPreferences(db,actor),/Only the super admin/);
    assert.throws(()=>select(db,actor),/Only the super admin/);
    assert.throws(()=>retryNotificationEmails(db,actor),/Only the super admin/);
  }
  select(db,owner,[],'sq'); // Old clients cannot disable recipients.
  assert.ok(notificationPreferences(db,owner).recipients.every(u=>u.selected));
  assert.throws(()=>saveNotificationPreferences(db,owner,{language:'invalid'}),/email language/);
  assert.equal(notificationPreferences(db,owner).language,'sq');
});

test('booking events and unread inboxes persist atomically and exclude unverified staff and include the creator',t=>{
  const {db,owner,admin}=fixture(t); select(db,owner);
  const b=createBooking(db,'client',input(),NOW);
  assert.equal(notificationInbox(db,'owner').unreadCount,1);
  assert.equal(notificationInbox(db,'admin').items[0].booking_id,b.id);
  assert.equal(notificationInbox(db,'unverified').unreadCount,0);
  assert.equal(notificationInbox(db,'client').unreadCount,0);
  assert.ok(jobs(db).every(n=>n.email_status==='pending'));
  assert.throws(()=>createBooking(db,'client',input(),NOW),/active appointment/);
  assert.equal(db.prepare('SELECT count(*) n FROM booking_events').get().n,1);
  createAdminBooking(db,admin,input({name:'Guest',phone:'+38112345678',time:'10:00'}),NOW);
  assert.equal(notificationInbox(db,'admin').unreadCount,2);
  assert.equal(notificationInbox(db,'owner').unreadCount,2);
  changeBooking(db,admin,b.id,'cancel',NOW);
  assert.equal(notificationInbox(db,'admin').unreadCount,2);
  assert.equal(notificationInbox(db,'owner').items[0].kind,'cancelled');
  db.exec("CREATE TRIGGER reject_alert BEFORE INSERT ON booking_events BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>createBooking(db,'client',input({time:'12:00'}),NOW),/test failure/);
  assert.equal(db.prepare("SELECT count(*) n FROM bookings WHERE time='12:00'").get().n,0);
});

test('marking notifications read is per administrator and never clears later arrivals',t=>{
  const {db,owner,admin,client}=fixture(t);
  const b=createBooking(db,'client',input(),NOW);
  const initial=notificationInbox(db,owner.id).items[0];
  changeBooking(db,client,b.id,'cancel',NOW);
  markNotificationsRead(db,owner.id,{throughId:initial.id},NOW);
  assert.equal(notificationInbox(db,owner.id).unreadCount,1);
  assert.equal(notificationInbox(db,admin.id).unreadCount,2);
  const otherId=notificationInbox(db,admin.id).items[0].id;
  markNotificationsRead(db,owner.id,{id:otherId},NOW);
  assert.equal(notificationInbox(db,owner.id).unreadCount,1);
  assert.throws(()=>markNotificationsRead(db,owner.id,{throughId:'all'}),/valid notification/);
  assert.ok(jobs(db).every(n=>n.email_status==='pending'));
});

test('legacy recipient selections do not suppress emails; demotion stops queued admin emails',async t=>{
  const {db,owner}=fixture(t); select(db,owner);
  createBooking(db,'client',input(),NOW);
  select(db,owner,['admin']);
  assert.equal(jobs(db).find(n=>n.user_id==='owner').email_status,'pending');
  setAdmin(db,owner,'admin@example.test','client');
  assert.equal(jobs(db).find(n=>n.user_id==='admin').email_status,'skipped');
  setAdmin(db,owner,'admin@example.test','admin'); select(db,owner);
  let sent=0; const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async()=>{sent++;}});
  await worker.kick(); await worker.stop(); assert.equal(sent,1);
});

test('repeats create a notification for the next reservation without duplicating the original event',t=>{
  const {db,admin}=fixture(t);
  const b=createBooking(db,'client',input({repeatWeeks:2}),NOW);
  changeBooking(db,admin,b.id,'approve',NOW);
  changeBooking(db,admin,b.id,'complete',b.ends_at+1);
  assert.equal(db.prepare('SELECT count(*) n FROM booking_events').get().n,2);
  assert.equal(notificationInbox(db,'owner').items[0].date,'2030-01-21');
});

test('email failures retry with backoff, stop after eight attempts, and can be retried by the owner',async t=>{
  const {db,owner}=fixture(t); setAdmin(db,owner,'admin@example.test','client'); createBooking(db,'client',input(),NOW);
  let now=NOW,attempts=0,fail=true;
  const worker=createNotificationWorker(db,config,{now:()=>now,send:async()=>{attempts++;if(fail)throw new Error('secret provider details');}});
  await Promise.all([worker.kick(),worker.kick()]); assert.equal(attempts,1);
  assert.equal(jobs(db)[0].next_attempt_at,NOW+60000);
  await worker.kick(); assert.equal(attempts,1);
  for(let i=1;i<8;i++){now=jobs(db)[0].next_attempt_at;await worker.kick();}
  assert.equal(jobs(db)[0].email_status,'failed'); assert.equal(attempts,8);
  assert.doesNotMatch(jobs(db)[0].last_error,/secret/);
  retryNotificationEmails(db,owner,now); fail=false; await worker.kick();
  assert.equal(jobs(db)[0].email_status,'sent'); await worker.kick(); assert.equal(attempts,9);
  await worker.stop();
});

test('delivery rechecks recipients and skips stale creation emails while delivering cancellation',async t=>{
  const {db,owner,client}=fixture(t); select(db,owner);
  const b=createBooking(db,'client',input(),NOW); changeBooking(db,client,b.id,'cancel',NOW);
  db.exec("UPDATE users SET verified=0 WHERE id='admin'");
  const sent=[]; const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async job=>sent.push(job)});
  await worker.kick(); await worker.stop();
  assert.deepEqual(sent.map(j=>[j.user_id,j.kind]),[['owner','cancelled']]);
});

test('email is queued across a database restart and missing configuration never sends or consumes retries',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erd-notify-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'salon.sqlite');let db=openStore(path);const {owner}=seed(db);
  setAdmin(db,owner,'admin@example.test','client');createBooking(db,'client',input(),NOW);
  const key=jobs(db)[0].email_key;
  let sent=0; const off=createNotificationWorker(db,{...config,apiKey:''},{now:()=>NOW,send:async()=>sent++});
  await off.kick();await off.stop();assert.equal(jobs(db)[0].attempts,0);db.close();
  db=openStore(path);
  const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async job=>{assert.equal(job.email_key,key);sent++;}});
  await worker.kick();await worker.stop();assert.equal(sent,1);assert.equal(jobs(db)[0].email_status,'sent');db.close();
});

test('Brevo emails contain the correct recipient, escaped appointment details, language and authenticated admin link',async t=>{
  const {db,owner}=fixture(t);select(db,owner,['owner'],'sq');const b=createBooking(db,'client',input(),NOW);
  const job=jobs(db)[0];let request;
  t.mock.method(globalThis,'fetch',async(url,options)=>{request={url,options,body:JSON.parse(options.body)};return new Response('{}',{status:201});});
  await sendBookingEmail(job,config);
  assert.equal(request.url,'https://api.brevo.com/v3/smtp/email');assert.equal(request.options.headers['api-key'],config.apiKey);
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(request.body.to,[{email:OWNER_EMAIL}]);assert.deepEqual(request.body.sender,{name:'ERD',email:'bookings@example.test'});
  assert.match(request.body.headers.idempotencyKey,/^[a-f0-9-]{36}$/);
  assert.match(request.body.htmlContent,/Konfirmo rezervimin/);
  assert.match(request.body.htmlContent,/display:block;padding:20px 16px/);
  assert.match(request.body.subject,/Rezervim i ri/);assert.match(request.body.textContent,/Kërkon miratim/);
  assert.match(request.body.textContent,/Prerje dhe stilim/);assert.match(request.body.htmlContent,/&lt;script&gt;/);
  assert.ok(request.body.textContent.includes(`https://salon.example.test/admin?booking=${b.id}`));
  assert.doesNotMatch(request.body.textContent,/Private client notes/);
  const en=bookingEmail({...job,language:'en',kind:'cancelled'},config.appUrl);
  assert.match(en.subject,/Reservation cancelled/);
  assert.doesNotMatch(en.htmlContent,/Confirm reservation/);
  const pending=bookingEmail({...job,language:'en'},config.appUrl);
  assert.match(pending.textContent,/Confirm reservation: https:\/\/salon.example.test\/admin\?booking=/);
  assert.match(pending.htmlContent,/Sign in as an administrator and choose Approve/);
  const approved=bookingEmail({...job,language:'en',booking_status:'confirmed'},config.appUrl);
  assert.doesNotMatch(approved.htmlContent,/Confirm reservation/);
  assert.match(approved.htmlContent,/View reservation/);
});

test('provider failures and duplicate acknowledgements are handled without leaking provider output',async t=>{
  const {db,owner}=fixture(t);setAdmin(db,owner,'admin@example.test','client');createBooking(db,'client',input(),NOW);const job=jobs(db)[0];
  const mock=t.mock.method(globalThis,'fetch',async()=>new Response('{"code":"unauthorized","message":"secret"}',{status:401}));
  await assert.rejects(sendBookingEmail(job,config),/provider did not accept/);
  mock.mock.mockImplementation(async()=>new Response('{"code":"duplicate_parameter"}',{status:400}));
  await sendBookingEmail(job,config);
  await assert.rejects(sendBookingEmail(job,{...config,from:'invalid'}),/not configured/);
});

test('stopping the worker aborts in-flight delivery and leaves the leased job recoverable',async t=>{
  const {db,owner}=fixture(t);setAdmin(db,owner,'admin@example.test','client');createBooking(db,'client',input(),NOW);
  let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const worker=createNotificationWorker(db,config,{now:()=>NOW,send:(_job,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true});started();
  })});
  const work=worker.kick();await ready;await worker.stop();await work;
  assert.equal(jobs(db)[0].email_status,'pending');assert.equal(jobs(db)[0].next_attempt_at,NOW+60000);
  const restarted=createNotificationWorker(db,config,{now:()=>NOW+60001,send:async()=>{}});
  await restarted.kick();await restarted.stop();assert.equal(jobs(db)[0].email_status,'sent');
});

function clientJobs(db) { return db.prepare('SELECT * FROM client_notifications ORDER BY id').all(); }

test('approval atomically queues one localized client confirmation and sends it to My visits',async t=>{
  const {db,admin}=fixture(t);
  const b=createBooking(db,'client',input({language:'sq'}),NOW);
  assert.equal(clientJobs(db).length,0);
  db.exec("CREATE TRIGGER reject_confirmation BEFORE INSERT ON client_notifications BEGIN SELECT RAISE(ABORT,'confirmation failure'); END;");
  assert.throws(()=>changeBooking(db,admin,b.id,'approve',NOW),/confirmation failure/);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(b.id).status,'pending');
  assert.equal(db.prepare("SELECT approvals FROM users WHERE id='client'").get().approvals,0);
  db.exec('DROP TRIGGER reject_confirmation');
  changeBooking(db,admin,b.id,'approve',NOW);
  assert.throws(()=>changeBooking(db,admin,b.id,'approve',NOW),/Only pending/);
  assert.equal(clientJobs(db).length,1);
  assert.equal(clientJobs(db)[0].language,'sq');
  const sent=[];
  const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async job=>sent.push(job)});
  await worker.kick();await worker.kick();await worker.stop();
  assert.equal(sent.length,3);
  const client=sent.find(j=>j.kind==='confirmed');
  assert.equal(client.email,'client@example.test');
  const mail=bookingEmail(client,config.appUrl);
  assert.match(mail.subject,/Rezervimi juaj është konfirmuar/);
  assert.match(mail.textContent,/Prerje dhe stilim/);
  assert.match(mail.textContent,/https:\/\/salon.example.test\/appointments/);
  assert.doesNotMatch(mail.textContent,/\/admin|Private client notes|completed/);
  assert.match(mail.htmlContent,/lang="sq"/);
  assert.match(mail.htmlContent,/Client &lt;script&gt;/);
  assert.doesNotMatch(mail.htmlContent,/<script>/);
  assert.equal(clientJobs(db)[0].email_status,'sent');
});

test('manual, automatic and repeated confirmations email account clients; phone-only guests have no client email',t=>{
  const {db,admin}=fixture(t);
  const guest=createAdminBooking(db,admin,input({name:'Guest',phone:'+38112345678',time:'11:00'}),NOW);
  assert.equal(guest.status,'confirmed');assert.equal(clientJobs(db).length,0);
  const manual=createAdminBooking(db,admin,input({userId:'client',language:'sq'}),NOW);
  assert.equal(clientJobs(db)[0].booking_id,manual.id);
  changeBooking(db,admin,manual.id,'complete',manual.ends_at+1);
  db.exec("UPDATE users SET approvals=2 WHERE id='client'");
  const automatic=createBooking(db,'client',input({date:'2030-01-08',repeatWeeks:2,language:'sq'}),NOW);
  assert.equal(automatic.status,'confirmed');assert.equal(clientJobs(db).length,2);
  changeBooking(db,admin,automatic.id,'complete',automatic.ends_at+1);
  assert.equal(clientJobs(db).length,3);
  assert.ok(clientJobs(db).every(j=>j.language==='sq'));
  assert.equal(JSON.parse(clientJobs(db)[2].payload).date,'2030-01-22');
});

test('cancelled confirmations are skipped and completing a visit does not queue a second client email',async t=>{
  const {db,admin,client}=fixture(t);
  const b=createBooking(db,'client',input(),NOW);
  changeBooking(db,admin,b.id,'approve',NOW);
  changeBooking(db,client,b.id,'cancel',NOW);
  const next=createAdminBooking(db,admin,input({userId:'client',time:'10:00'}),NOW);
  changeBooking(db,admin,next.id,'complete',next.ends_at+1);
  assert.equal(clientJobs(db).length,2);
  const sent=[];const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async j=>sent.push(j)});
  await worker.kick();await worker.stop();
  assert.ok(clientJobs(db).every(j=>j.email_status==='skipped'));
  assert.ok(sent.every(j=>j.kind!=='confirmed'));
});

test('client delivery survives restarts, retries with a stable key, and appears in owner queue counts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erd-client-email-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'salon.sqlite');let db=openStore(path);const {owner,admin}=seed(db);
  const b=createBooking(db,'client',input(),NOW);changeBooking(db,admin,b.id,'approve',NOW);
  let now=NOW, fail=true;const keys=[];
  const send=async j=>{if(j.kind==='confirmed'){keys.push(j.email_key);if(fail)throw new Error('private provider output');}};
  let worker=createNotificationWorker(db,config,{now:()=>now,send});
  await worker.kick();await worker.stop();
  assert.equal(notificationPreferences(db,owner).pending,1);
  const key=clientJobs(db)[0].email_key;db.close();db=openStore(path);
  worker=createNotificationWorker(db,config,{now:()=>now,send});
  await worker.kick();assert.equal(keys.length,1);
  for(let i=1;i<8;i++){now=clientJobs(db)[0].next_attempt_at;await worker.kick();}
  assert.equal(clientJobs(db)[0].email_status,'failed');
  assert.equal(notificationPreferences(db,owner).failed,1);
  assert.doesNotMatch(clientJobs(db)[0].last_error,/private/);
  retryNotificationEmails(db,owner,now);fail=false;
  await worker.kick();await worker.stop();
  assert.equal(clientJobs(db)[0].email_status,'sent');
  assert.equal(notificationPreferences(db,owner).pending,0);
  assert.equal(notificationPreferences(db,owner).failed,0);
  assert.equal(keys.length,9);assert.ok(keys.every(k=>k===key));db.close();
});

test('newly promoted administrators receive future reservations without selecting recipients',t=>{
  const {db,owner}=fixture(t);
  db.exec("INSERT INTO users(id,email,name,password,verified,created_at) VALUES('new','new@example.test','New admin','unused',1,0)");
  setAdmin(db,owner,'new@example.test','admin');
  createBooking(db,'client',input(),NOW);
  assert.deepEqual(jobs(db).map(j=>j.user_id).sort(),['admin','new','owner']);
});
