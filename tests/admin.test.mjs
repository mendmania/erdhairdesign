import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../lib/store.mjs';
import { OWNER_EMAIL } from '../lib/roles.mjs';
import { addVacation, saveService, removeService, setAdmin } from '../lib/admin.mjs';
import { availability, createBooking, changeBooking } from '../lib/booking.mjs';
const NOW = Date.parse('2030-01-06T12:00:00Z');
const serviceInput = { name: 'Quick trim', description: 'A tidy finish.', duration: 30, price: 2000, outside_price: 3000, category: 'Cut & style' };
const bookingInput = { serviceId: 'cut-style', date: '2030-01-07', time: '09:00', repeatWeeks: 1, notes: '', expectedPrice: 4500 };
function fixture(t) {
  const db = openStore(':memory:'); t.after(() => db.close());
  const insert = db.prepare('INSERT INTO users (id,email,name,password,verified,created_at) VALUES (?,?,?,?,?,?)');
  insert.run('owner', OWNER_EMAIL, 'Owner', 'unused', 1, NOW);
  insert.run('client', 'client@example.test', 'Client', 'unused', 1, NOW);
  return {db, owner: db.prepare('SELECT * FROM users WHERE id = ?').get('owner')};
}
test('verified owner is protected from deletion, demotion and identity changes', t => {
  const { db, owner } = fixture(t);
  assert.equal(owner.role, 'super_admin');
  for (const sql of ["DELETE FROM users WHERE id='owner'", "UPDATE users SET role='client' WHERE id='owner'", "UPDATE users SET role='admin' WHERE id='owner'", "UPDATE users SET verified=0 WHERE id='owner'", "UPDATE users SET email='other@example.test' WHERE id='owner'", "UPDATE users SET id='changed' WHERE id='owner'"]) assert.throws(() => db.exec(sql), /super-admin/);
  assert.throws(() => db.exec("UPDATE users SET role='super_admin' WHERE id='client'"), /Reserved/);
  assert.throws(() => setAdmin(db, owner, OWNER_EMAIL, 'client'), /cannot be removed or demoted/);
  assert.throws(() => setAdmin(db, {role:'admin'}, 'client@example.test', 'admin'), /Only the super admin/);
  setAdmin(db, owner, ' CLIENT@example.test ', 'admin');
  assert.equal(db.prepare("SELECT role FROM users WHERE id='client'").get().role, 'admin');
  setAdmin(db, owner, 'client@example.test', 'client');
  assert.equal(db.prepare("SELECT role FROM users WHERE id='client'").get().role, 'client');
});
test('legacy database migration preserves users and services and promotes only a verified owner', t => {
  const dir = mkdtempSync(join(tmpdir(), 'erd-admin-')); t.after(() => rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE users (id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',password TEXT NOT NULL,verified INTEGER NOT NULL DEFAULT 0,role TEXT NOT NULL DEFAULT 'client',approvals INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE services (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,duration INTEGER NOT NULL,price INTEGER NOT NULL,outside_price INTEGER NOT NULL,category TEXT NOT NULL,icon TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO users (id,email,name,password,verified,created_at) VALUES (?,?,?,?,?,?)').run('owner',OWNER_EMAIL,'Legacy owner','unused',1,NOW);
  legacy.exec("INSERT INTO services VALUES ('cut-style','My existing cut','Keep me',60,1234,2345,'Cut & style','scissors')"); legacy.close();
  let db=openStore(path);
  assert.equal(db.prepare("SELECT role FROM users WHERE id='owner'").get().role,'super_admin');
  assert.equal(db.prepare("SELECT price FROM services WHERE id='cut-style'").get().price,1234);
  removeService(db,'cut-style');db.close();db=openStore(path);
  assert.equal(db.prepare("SELECT active FROM services WHERE id='cut-style'").get().active,0);
  assert.equal(db.prepare("SELECT count(*) n FROM users").get().n,1);db.close();
});
test('vacation ranges are inclusive, block outside-hours requests and reject invalid/overlapping dates', t => {
  const {db} = fixture(t);
  addVacation(db,{startDate:'2030-01-07',endDate:'2030-01-09',label:'Winter break'});
  for (const date of ['2030-01-07','2030-01-08','2030-01-09']) {
    const result=availability(db,'cut-style',date,NOW);assert.equal(result.closed,true);assert.deepEqual(result.slots,[]);
    for (const time of ['09:00','19:00']) assert.throws(() => createBooking(db,'client',{...bookingInput,date,time},NOW),/no longer available/);
  }
  assert.ok(availability(db,'cut-style','2030-01-10',NOW).slots.length);
  for (const [startDate,endDate] of [['2030-02-30','2030-03-01'],['2030-01-09','2030-01-08'],['bad','bad']]) assert.throws(() => addVacation(db,{startDate,endDate,label:''}),/valid dates/);
  assert.throws(() => addVacation(db,{startDate:'2030-01-09',endDate:'2030-01-10',label:''}),/overlaps/);
});
test('time off never silently cancels pending or confirmed appointments', t => {
  const {db,owner} = fixture(t);const b=createBooking(db,'client',bookingInput,NOW);
  const vacation={startDate:b.date,endDate:b.date,label:'Day off'};
  assert.throws(() => addVacation(db,vacation),/1 active appointment/);
  changeBooking(db,owner,b.id,'approve',NOW);
  assert.throws(() => addVacation(db,vacation),/1 active appointment/);
  assert.equal(db.prepare('SELECT status FROM bookings WHERE id=?').get(b.id).status,'confirmed');
  changeBooking(db,owner,b.id,'cancel',NOW);addVacation(db,vacation);
});
test('service edits and removal preserve agreed appointments and pause renewal', t => {
  const {db,owner} = fixture(t);const b=createBooking(db,'client',bookingInput,NOW);
  saveService(db,'cut-style',serviceInput);
  const original=db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  assert.equal(original.service_name,b.service_name);assert.equal(original.duration,60);assert.equal(original.price,4500);
  removeService(db,'cut-style');
  assert.throws(() => availability(db,'cut-style',b.date,NOW),/available service/);
  changeBooking(db,owner,b.id,'approve',NOW);
  const completed=changeBooking(db,owner,b.id,'complete',b.ends_at+1);
  assert.equal(completed.status,'completed');assert.match(completed.recurrence_note,/Repeat paused/);
  assert.equal(db.prepare('SELECT count(*) n FROM bookings').get().n,1);
  const s=saveService(db,null,serviceInput);assert.equal(s.active,1);assert.equal(s.price,2000);
  for (const invalid of [{name:''},{duration:31},{duration:0},{price:-1},{outside_price:1.1},{category:'bad'}]) assert.throws(() => saveService(db,s.id,{...serviceInput,...invalid}));
  assert.equal(db.prepare('SELECT price FROM services WHERE id=?').get(s.id).price,2000);
});
test('vacation on the next recurring date pauses the repeat after completion', t => {
  const {db,owner}=fixture(t);const b=createBooking(db,'client',bookingInput,NOW);
  addVacation(db,{startDate:'2030-01-14',endDate:'2030-01-14',label:'Closed'});
  changeBooking(db,owner,b.id,'approve',NOW);
  assert.match(changeBooking(db,owner,b.id,'complete',b.ends_at+1).recurrence_note,/Repeat paused/);
  assert.equal(db.prepare("SELECT count(*) n FROM bookings WHERE status IN ('pending','confirmed')").get().n,0);
});
