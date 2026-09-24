import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,settingsFor} from '../lib/store.mjs';
import {createGuestBooking,createAdminBooking,createBooking,changeBooking,availability,updateSettings} from '../lib/booking.mjs';
import {createNotificationWorker,bookingEmail} from '../lib/notifications.mjs';
const NOW=Date.parse('2030-01-06T12:00:00Z');
const input=(o={})=>({name:'Guest Client',email:'guest@example.test',serviceId:'cut-style',date:'2030-01-07',time:'09:00',expectedPrice:4500,...o});
function fixture(t,path=':memory:') {
  const db=openStore(path);t.after(()=>db.close());
  db.exec("INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES('admin','admin@example.test','Admin','unused',1,'admin',0)");
  return {db,admin:db.prepare("SELECT * FROM users WHERE id='admin'").get()};
}

test('guest requests require no account or phone, always await approval and reserve the full duration',t=>{
  const {db}=fixture(t);
  updateSettings(db,{...settingsFor(db),requiredApprovals:0});
  const b=createGuestBooking(db,input({email:' Guest@Example.test ',name:' Guest Client '}),NOW);
  assert.equal(b.user_id,null);assert.equal(b.guest_email,'guest@example.test');assert.equal(b.guest_phone,'');
  assert.equal(b.status,'pending');assert.equal(b.repeat_weeks,0);assert.equal(b.created_by,null);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,1);
  assert.equal(db.prepare("SELECT count(*) n FROM client_notifications WHERE kind='requested'").get().n,1);
  assert.equal(db.prepare('SELECT email_status FROM admin_notifications').get().email_status,'pending');
  assert.equal(availability(db,'cut-style',b.date,NOW).slots.find(s=>s.time==='09:30').available,false);
  assert.throws(()=>createGuestBooking(db,input({time:'10:00'}),NOW),/active appointment/);
  assert.throws(()=>createGuestBooking(db,input({email:'other@example.test',time:'09:30'}),NOW),/no longer available/);
});

test('guest validation rejects missing names/emails, invalid optional contacts, repeats and tampered prices',t=>{
  const {db}=fixture(t);
  for (const overrides of [{name:''},{email:''},{email:'bad'},{email:'x'.repeat(255)},{phone:42},{phone:'letters'},{repeatWeeks:2},{expectedPrice:1}]) {
    assert.throws(()=>createGuestBooking(db,input(overrides),NOW));
  }
  assert.equal(db.prepare('SELECT count(*) n FROM bookings').get().n,0);
  const b=createGuestBooking(db,input({userId:'admin',status:'confirmed',created_by:'admin',phone:' +38312345678 '}),NOW);
  assert.equal(b.user_id,null);assert.equal(b.status,'pending');assert.equal(b.created_by,null);assert.equal(b.guest_phone,'+38312345678');
});

test('guest bookings never attach to a registered account with the same email',t=>{
  const {db}=fixture(t);
  const b=createGuestBooking(db,input({email:'admin@example.test'}),NOW);
  assert.equal(b.user_id,null);
  assert.throws(()=>changeBooking(db,{id:'different',role:'client'},b.id,'cancel',NOW),/another account/);
});

test('guest approval emails the supplied address in the chosen language without linking to an account page',async t=>{
  const {db,admin}=fixture(t);
  const b=createGuestBooking(db,input({language:'sq'}),NOW);
  changeBooking(db,admin,b.id,'approve',NOW);
  const sent=[];const worker=createNotificationWorker(db,{apiKey:'test',from:'salon@example.test'},{now:()=>NOW,send:async job=>sent.push(job)});
  await worker.kick();await worker.stop();
  const job=sent.find(j=>j.kind==='confirmed');
  assert.equal(job.email,'guest@example.test');assert.equal(job.user_id,null);assert.equal(job.language,'sq');
  const email=bookingEmail(job,'https://salon.example.test');
  assert.match(email.subject,/konfirmuar/);assert.match(email.textContent,/kontaktoni sallonin/);
  assert.match(email.textContent,/\/studio/);assert.doesNotMatch(email.textContent,/\/appointments|\/admin|Europe\/Belgrade/);
  assert.equal(db.prepare("SELECT email_status FROM client_notifications WHERE kind='confirmed'").get().email_status,'sent');
});

test('admins can book with only a name and appointment details; optional email enables guest confirmation',t=>{
  const {db,admin}=fixture(t);
  const b=createAdminBooking(db,admin,input({email:undefined}),NOW);
  assert.equal(b.status,'confirmed');assert.equal(b.guest_phone,'');assert.equal(b.guest_email,'');
  assert.equal(db.prepare('SELECT count(*) n FROM client_notifications').get().n,0);
  createAdminBooking(db,admin,input({time:'10:00'}),NOW);
  assert.equal(db.prepare('SELECT count(*) n FROM client_notifications').get().n,1);
  assert.throws(()=>createAdminBooking(db,admin,input({time:'11:00',email:'bad'}),NOW),/email/);
});

test('cancelled guest confirmations are skipped and released slots can be booked again',async t=>{
  const {db,admin}=fixture(t);
  const b=createGuestBooking(db,input(),NOW);
  changeBooking(db,admin,b.id,'approve',NOW);changeBooking(db,admin,b.id,'cancel',NOW);
  const sent=[];const worker=createNotificationWorker(db,{apiKey:'test',from:'salon@example.test'},{now:()=>NOW,send:async job=>sent.push(job)});
  await worker.kick();await worker.stop();assert.ok(sent.every(j=>j.kind!=='confirmed'));
  assert.equal(db.prepare("SELECT email_status FROM client_notifications WHERE kind='confirmed'").get().email_status,'skipped');
  assert.equal(createGuestBooking(db,input(),NOW).status,'pending');
});

test('upgrading an account-only email outbox preserves queued jobs and accepts guest confirmations',t=>{
  const dir=mkdtempSync(join(tmpdir(),'erd-guest-migration-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'salon.sqlite');let db=openStore(path);
  db.exec("INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES('admin','admin@example.test','Admin','unused',1,'admin',0)");
  const admin=db.prepare("SELECT * FROM users WHERE id='admin'").get();
  const b=createBooking(db,'admin',{...input(),repeatWeeks:0,notes:''},NOW);changeBooking(db,admin,b.id,'approve',NOW);
  const original=db.prepare('SELECT * FROM client_notifications').get();
  const schema=db.prepare("SELECT sql FROM sqlite_master WHERE name='client_notifications'").get().sql
    .replace('CREATE TABLE client_notifications','CREATE TABLE old_client_notifications').replace('user_id TEXT REFERENCES','user_id TEXT NOT NULL REFERENCES');
  db.exec(`${schema}; INSERT INTO old_client_notifications SELECT * FROM client_notifications; DROP TABLE client_notifications; ALTER TABLE old_client_notifications RENAME TO client_notifications;`);
  db.close();db=openStore(path);
  assert.deepEqual(db.prepare('SELECT * FROM client_notifications').get(),original);
  createAdminBooking(db,admin,input({time:'10:00'}),NOW);
  assert.equal(db.prepare('SELECT count(*) n FROM client_notifications').get().n,3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();db=openStore(path);assert.equal(db.prepare('SELECT count(*) n FROM client_notifications').get().n,3);db.close();
});
