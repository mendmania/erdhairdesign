import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../lib/store.mjs';
import {createGuestBooking,createAdminBooking,changeBooking,rescheduleBooking} from '../lib/booking.mjs';
import {createNotificationWorker,bookingEmail,queueClientNotification} from '../lib/notifications.mjs';
const NOW=Date.parse('2030-01-06T12:00:00Z');
const input=(overrides={})=>({name:'Guest <script>',email:'guest@example.test',serviceId:'cut-style',date:'2030-01-07',time:'09:00',expectedPrice:4500,notes:'Private client notes',...overrides});
const config={apiKey:'test',from:'salon@example.test',appUrl:'https://salon.example.test'};
function seed(db) {
  db.exec("INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES('admin','admin@example.test','Admin','unused',1,'admin',0)");
  return db.prepare("SELECT * FROM users WHERE id='admin'").get();
}
function fixture(t) {const db=openStore(':memory:');t.after(()=>db.close());return {db,admin:seed(db)};}
async function deliver(db) {
  const sent=[];const worker=createNotificationWorker(db,config,{now:()=>NOW,send:async job=>sent.push(job)});
  await worker.kick();await worker.stop();return sent.filter(job=>job.queue==='client_notifications');
}
test('guest receipt clearly awaits approval; decline and cancellation messages provide a rebooking link in both languages',async t=>{
  for(const language of ['en','sq']) {
    const {db,admin}=fixture(t);
    const b=createGuestBooking(db,input({language}),NOW);
    const receipts=await deliver(db);assert.deepEqual(receipts.map(j=>j.kind),['requested']);
    const receipt=bookingEmail(receipts[0],config.appUrl);
    assert.match(receipt.textContent,language==='en'?/not a confirmation/:/nuk është konfirmim/);
    assert.match(receipt.htmlContent,/Guest &lt;script&gt;/);assert.doesNotMatch(receipt.htmlContent,/<script>|Private client notes|\/admin/);
    changeBooking(db,admin,b.id,'decline',NOW);
    const declines=await deliver(db);assert.deepEqual(declines.map(j=>j.kind),['declined']);
    const declined=bookingEmail(declines[0],config.appUrl);
    assert.match(declined.subject,language==='en'?/declined/:/refuzua/);assert.match(declined.textContent,/https:\/\/salon.example.test\/book/);
    const next=createAdminBooking(db,admin,input({language}),NOW);await deliver(db);
    changeBooking(db,admin,next.id,'cancel',NOW);
    const cancellations=await deliver(db);assert.deepEqual(cancellations.map(j=>j.kind),['cancelled']);
    const cancelled=bookingEmail(cancellations[0],config.appUrl);
    assert.match(cancelled.subject,language==='en'?/cancelled/:/anuluar/);assert.match(cancelled.textContent,/https:\/\/salon.example.test\/book/);
  }
});
test('repeated moves invalidate obsolete emails and deliver only the latest time with a stable event key',async t=>{
  const {db,admin}=fixture(t);const b=createAdminBooking(db,admin,input({language:'en'}),NOW);
  const first=rescheduleBooking(db,admin,b.id,{date:b.date,time:'10:00',expectedVersion:0,expectedStatus:b.status},NOW);
  const latest=rescheduleBooking(db,admin,b.id,{date:b.date,time:'11:00',expectedVersion:1,expectedStatus:b.status},NOW);
  queueClientNotification(db,latest,'rescheduled',NOW,first);
  assert.equal(db.prepare("SELECT count(*) n FROM client_notifications WHERE kind='rescheduled'").get().n,2);
  const sent=await deliver(db);assert.deepEqual(sent.map(j=>j.kind),['rescheduled']);
  const mail=bookingEmail(sent[0],config.appUrl);
  assert.match(mail.textContent,/Previous time: 2030-01-07 · 10:00/);assert.match(mail.textContent,/Time: 11:00/);
  assert.equal(db.prepare("SELECT email_status FROM client_notifications WHERE kind='confirmed'").get().email_status,'skipped');
  assert.equal(db.prepare("SELECT email_status FROM client_notifications WHERE kind='rescheduled' AND schedule_version=1").get().email_status,'skipped');
  assert.deepEqual(await deliver(db),[]);
});
test('a moved pending request stays unconfirmed; subsequent approval sends the new time',async t=>{
  const {db,admin}=fixture(t);const b=createGuestBooking(db,input({language:'en'}),NOW);
  rescheduleBooking(db,admin,b.id,{date:b.date,time:'10:00',expectedVersion:0,expectedStatus:b.status},NOW);
  const sent=await deliver(db);assert.deepEqual(sent.map(j=>j.kind),['rescheduled']);
  assert.match(bookingEmail(sent[0],config.appUrl).textContent,/still needs approval/);
  changeBooking(db,admin,b.id,'approve',NOW);
  const confirmed=await deliver(db);assert.deepEqual(confirmed.map(j=>j.kind),['confirmed']);
  assert.match(bookingEmail(confirmed[0],config.appUrl).textContent,/Time: 10:00/);
});
test('phone-only guests are not emailed and a failed decline notification rolls back the action',t=>{
  const {db,admin}=fixture(t);const guest=createAdminBooking(db,admin,input({email:undefined}),NOW);
  rescheduleBooking(db,admin,guest.id,{date:guest.date,time:'10:00',expectedVersion:0,expectedStatus:guest.status},NOW);
  changeBooking(db,admin,guest.id,'cancel',NOW);
  assert.equal(db.prepare('SELECT count(*) n FROM client_notifications').get().n,0);
  const pending=createGuestBooking(db,input(),NOW);
  db.exec("CREATE TRIGGER reject_decline BEFORE INSERT ON client_notifications WHEN NEW.kind='declined' BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
  assert.throws(()=>changeBooking(db,admin,pending.id,'decline',NOW),/outbox unavailable/);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(pending.id).status,'pending');
});
test('upgrading the original confirmation-only outbox preserves jobs, keys and retries across restarts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'erd-updates-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'salon.sqlite');let db=openStore(path);const admin=seed(db);
  const b=createAdminBooking(db,admin,input(),NOW);
  db.exec("UPDATE client_notifications SET attempts=3,last_error='Retry later',next_attempt_at=123");
  const original=db.prepare('SELECT * FROM client_notifications').get();
  // Reconstruct the exact pre-update outbox (one confirmation per booking).
  db.exec(`CREATE TABLE legacy_client_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email_key TEXT NOT NULL UNIQUE,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id), user_id TEXT REFERENCES users(id),
    payload TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en',
    email_status TEXT NOT NULL CHECK(email_status IN ('pending','sent','skipped','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    sent_at INTEGER, last_error TEXT NOT NULL DEFAULT ''
  );`);
  const columns=db.prepare('PRAGMA table_info(legacy_client_notifications)').all().map(c=>c.name).join(',');
  db.exec(`INSERT INTO legacy_client_notifications (${columns}) SELECT ${columns} FROM client_notifications;
    DROP TABLE client_notifications; ALTER TABLE legacy_client_notifications RENAME TO client_notifications;
    DROP TABLE booking_reschedules; ALTER TABLE bookings DROP COLUMN schedule_version;`);
  db.close();db=openStore(path);
  assert.deepEqual(db.prepare('SELECT * FROM client_notifications').get(),original);
  assert.equal(db.prepare('SELECT schedule_version FROM bookings WHERE id=?').get(b.id).schedule_version,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();db=openStore(path);
  assert.deepEqual(db.prepare('SELECT * FROM client_notifications').get(),original);
  const sent=await deliver(db);assert.equal(sent[0].email_key,original.email_key);
  changeBooking(db,admin,b.id,'cancel',NOW);
  assert.deepEqual((await deliver(db)).map(j=>j.kind),['cancelled']);db.close();
});
