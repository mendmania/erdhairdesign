import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, settingsFor } from '../lib/store.mjs';
import { createAdminBooking, createBooking, changeBooking, availability, updateSettings } from '../lib/booking.mjs';
import { addVacation } from '../lib/admin.mjs';

const NOW = Date.parse('2030-01-06T12:00:00Z');
const input = overrides => ({ serviceId:'cut-style', date:'2030-01-07', time:'09:00', name:' Guest Client ', phone:'+38112345678', notes:' Phone request ', expectedPrice:4500, ...overrides });
function seed(db) {
  db.exec(`INSERT INTO users (id,email,name,password,verified,role,created_at) VALUES
    ('admin','admin@example.test','Barber','unused',1,'admin',0),
    ('client','client@example.test','Client','unused',0,'client',0)`);
  return db.prepare("SELECT * FROM users WHERE id='admin'").get();
}
function fixture(t) {
  const db = openStore(':memory:'); t.after(() => db.close());
  return {db, admin:seed(db)};
}
test('guest reservations confirm immediately without creating an account and block the whole service duration', t => {
  const {db,admin} = fixture(t);
  const b = createAdminBooking(db,admin,input(),NOW);
  assert.equal(b.status,'confirmed'); assert.equal(b.user_id,null);
  assert.equal(b.guest_name,'Guest Client'); assert.equal(b.guest_phone,'+38112345678');
  assert.equal(b.notes,'Phone request'); assert.equal(b.created_by,admin.id);
  assert.equal(b.manually_approved,1); assert.equal(b.repeat_weeks,0);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,2);
  assert.throws(() => createAdminBooking(db,admin,input({time:'09:30'}),NOW), /no longer available/);
  const slots=availability(db,'cut-style',b.date,NOW).slots;
  assert.equal(slots.find(s=>s.time==='09:30').available,false);
  assert.equal(slots.find(s=>s.time==='10:00').available,true);
  const adjacent=createAdminBooking(db,admin,input({time:'10:00'}),NOW);
  assert.throws(()=>changeBooking(db,{id:'client',role:'client'},b.id,'cancel',NOW), /another account/);
  changeBooking(db,admin,b.id,'cancel',NOW);
  assert.equal(availability(db,'cut-style',b.date,NOW).slots.find(s=>s.time==='09:00').available,true);
  assert.equal(changeBooking(db,admin,adjacent.id,'complete',adjacent.ends_at+1).status,'completed');
});
test('admin can reserve for an unverified registered client without changing verification or bypassing the active limit', t => {
  const {db,admin} = fixture(t);
  const b=createAdminBooking(db,admin,input({userId:'client'}),NOW);
  assert.equal(b.user_id,'client'); assert.equal(b.guest_name,''); assert.equal(b.status,'confirmed');
  const client=db.prepare("SELECT * FROM users WHERE id='client'").get();
  assert.equal(client.verified,0); assert.equal(client.approvals,1);
  assert.throws(()=>createAdminBooking(db,admin,input({userId:'client',date:'2030-01-08'}),NOW), /client already has an active/);
  assert.equal(db.prepare("SELECT approvals FROM users WHERE id='client'").get().approvals,1);
  changeBooking(db,admin,b.id,'cancel',NOW);
  assert.throws(()=>createBooking(db,'client',{...input(),repeatWeeks:0},NOW), /Verify your email/);
});
test('manual reservations validate actor, client details, price, hours, dates and vacations', t => {
  const {db,admin} = fixture(t);
  for (const actor of [null,{...admin,role:'client'},{...admin,verified:0}]) assert.throws(()=>createAdminBooking(db,actor,input(),NOW), /Admin access/);
  for (const [overrides,message] of [[{name:' '},/full name/],[{phone:'abc123'},/phone/],[{userId:12},/existing client/],[{userId:'missing'},/not found/],[{notes:'x'.repeat(1001)},/Notes/],[{expectedPrice:1},/price has changed/],[{date:'2029-12-01'},/next 90 days/],[{serviceId:'missing'},/available service/]]) {
    assert.throws(()=>createAdminBooking(db,admin,input(overrides),NOW),message);
  }
  updateSettings(db,{...settingsFor(db),allowOutside:false,autoApprove:false});
  assert.throws(()=>createAdminBooking(db,admin,input({time:'18:00'}),NOW),/no longer available/);
  addVacation(db,{startDate:'2030-01-08',endDate:'2030-01-08',label:'Closed'});
  assert.throws(()=>createAdminBooking(db,admin,input({date:'2030-01-08'}),NOW),/no longer available/);
  assert.equal(db.prepare('SELECT count(*) n FROM bookings').get().n,0);
  updateSettings(db,{...settingsFor(db),allowOutside:true});
  const b=createAdminBooking(db,admin,input({time:'18:00',expectedPrice:6000}),NOW);
  assert.equal(b.outside,1); assert.equal(b.price,6000); assert.equal(b.status,'confirmed');
});
test('legacy booking migration retains appointments, translations, constraints and indexes across restarts', t => {
  const dir=mkdtempSync(join(tmpdir(),'erd-manual-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'salon.sqlite'); let db=openStore(path);
  const admin=seed(db);
  db.exec("UPDATE users SET verified=1 WHERE id='client'");
  const b=createBooking(db,'client',{...input(),repeatWeeks:2},NOW);
  // Restore the previous release's schema, including its non-null account ID.
  db.exec('DROP TABLE admin_notifications; DROP TABLE booking_events;');
  const legacySchema=db.prepare("SELECT sql FROM sqlite_master WHERE name='bookings'").get().sql
    .replace('CREATE TABLE bookings','CREATE TABLE legacy_bookings')
    .replace('user_id TEXT REFERENCES','user_id TEXT NOT NULL REFERENCES')
    .replace(", guest_name TEXT NOT NULL DEFAULT ''",'')
    .replace(", guest_phone TEXT NOT NULL DEFAULT ''",'')
    .replace(', created_by TEXT REFERENCES users(id)','');
  const columns=db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name).filter(c=>!['guest_name','guest_phone','created_by'].includes(c)).join(',');
  db.exec(`${legacySchema}; INSERT INTO legacy_bookings (${columns}) SELECT ${columns} FROM bookings; DROP TABLE bookings; ALTER TABLE legacy_bookings RENAME TO bookings;`);
  db.close(); db=openStore(path);
  const migrated=db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  assert.deepEqual(migrated,b);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.ok(db.prepare('PRAGMA index_list(bookings)').all().some(i=>i.name==='one_active_booking' && i.unique));
  assert.ok(db.prepare('PRAGMA index_list(bookings)').all().some(i=>i.name==='booking_times'));
  assert.throws(()=>db.prepare('UPDATE bookings SET user_id=? WHERE id=?').run('missing',b.id),/FOREIGN KEY/);
  const guest=createAdminBooking(db,admin,input({time:'10:00'}),NOW);
  db.close(); db=openStore(path);
  assert.equal(db.prepare('SELECT guest_name FROM bookings WHERE id=?').get(guest.id).guest_name,'Guest Client');
  assert.equal(db.prepare('SELECT count(*) n FROM bookings').get().n,2);
  db.close();
});
