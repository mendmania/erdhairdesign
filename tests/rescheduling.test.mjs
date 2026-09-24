import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openStore, settingsFor} from '../lib/store.mjs';
import {createAdminBooking, createBooking, changeBooking, availability, rescheduleAvailability, rescheduleBooking, updateSettings, addDays, localDate} from '../lib/booking.mjs';
import {createApp} from '../server.mjs';
import {createSession} from '../lib/auth.mjs';
const NOW = Date.parse('2030-01-06T12:00:00Z');
const input = (overrides={}) => ({name:'Guest',email:'guest@example.test',serviceId:'cut-style',date:'2030-01-07',time:'09:00',expectedPrice:4500,notes:'Keep these notes',repeatWeeks:0,...overrides});
const move = (booking, overrides={}) => ({date:booking.date,time:'09:30',expectedVersion:booking.schedule_version,expectedStatus:booking.status,...overrides});
function fixture(t) {
  const db=openStore(':memory:'); t.after(()=>db.close());
  db.exec(`INSERT INTO users(id,email,name,password,verified,role,created_at) VALUES
    ('admin','admin@example.test','Admin','unused',1,'admin',0),
    ('client','client@example.test','Client','unused',1,'client',0)`);
  return {db,admin:db.prepare("SELECT * FROM users WHERE id='admin'").get(),client:db.prepare("SELECT * FROM users WHERE id='client'").get()};
}
test('rescheduling ignores only its own slot, preserves the agreed details and records the actor', t=>{
  const {db,admin}=fixture(t);
  const b=createAdminBooking(db,admin,input(),NOW);
  createAdminBooking(db,admin,input({name:'Other guest',email:'other@example.test',time:'11:00'}),NOW);
  db.exec("UPDATE services SET duration=120,price=9999,active=0 WHERE id='cut-style'");
  const slots=rescheduleAvailability(db,admin,b.id,b.date,NOW).slots;
  assert.equal(slots.find(s=>s.time==='09:30').available,true);
  assert.equal(slots.find(s=>s.time==='10:30').available,false);
  const updated=rescheduleBooking(db,admin,b.id,move(b),NOW);
  assert.equal(updated.id,b.id); assert.equal(updated.time,'09:30'); assert.equal(updated.schedule_version,1);
  for (const key of ['price','duration','notes','status','created_at','guest_email','manually_approved']) assert.equal(updated[key],b[key]);
  const history=db.prepare('SELECT * FROM booking_reschedules').get();
  assert.equal(history.actor_id,admin.id); assert.equal(history.previous_time,'09:00'); assert.equal(history.time,'09:30');
  const job=db.prepare("SELECT * FROM client_notifications WHERE kind='rescheduled'").get();
  assert.equal(JSON.parse(job.payload).previousTime,'09:00'); assert.equal(JSON.parse(job.payload).time,'09:30');
});
test('conflicts and failed notification writes preserve the original booking and history atomically',t=>{
  const {db,admin}=fixture(t); const b=createAdminBooking(db,admin,input(),NOW);
  createAdminBooking(db,admin,input({time:'10:00',email:'other@example.test'}),NOW);
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b),NOW),/no longer available/);
  db.exec("CREATE TRIGGER reject_move_email BEFORE INSERT ON client_notifications WHEN NEW.kind='rescheduled' BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END;");
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b,{time:'12:00'}),NOW),/outbox unavailable/);
  assert.deepEqual(db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id),b);
  assert.equal(db.prepare('SELECT count(*) n FROM booking_reschedules').get().n,0);
  assert.equal(availability(db,'cut-style',b.date,NOW).slots.find(s=>s.time==='09:00').available,false);
});
test('stale versions, concurrent approvals, started and terminal appointments cannot be moved',t=>{
  const {db,admin}=fixture(t); const b=createBooking(db,'client',input(),NOW);
  changeBooking(db,admin,b.id,'approve',NOW);
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b),NOW),/appointment changed/);
  const current=db.prepare('SELECT * FROM bookings WHERE id=?').get(b.id);
  const updated=rescheduleBooking(db,admin,b.id,move(current),NOW);
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(current,{time:'12:00'}),NOW),/appointment changed/);
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(updated,{expectedVersion:'1'}),NOW),/appointment changed/);
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(updated,{time:'12:00'}),updated.starts_at),/already started/);
  changeBooking(db,admin,b.id,'cancel',NOW);
  assert.throws(()=>rescheduleAvailability(db,admin,b.id,b.date,NOW),/no longer active/);
});
test('moves enforce staff access, valid dates, hours and time off, while preserving price outside hours',t=>{
  const {db,admin,client}=fixture(t); const b=createAdminBooking(db,admin,input(),NOW);
  for (const actor of [null,client,{...admin,verified:0}]) {
    assert.throws(()=>rescheduleAvailability(db,actor,b.id,b.date,NOW),/Admin access/);
    assert.throws(()=>rescheduleBooking(db,actor,b.id,move(b),NOW),/Admin access/);
  }
  for (const overrides of [{date:'2030-02-30'},{date:'2031-01-07'},{date:'2029-01-07'},{time:'09:15'},{time:'09:00'}]) assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b,overrides),NOW));
  db.exec("INSERT INTO vacations VALUES('off','2030-01-08','2030-01-08','Holiday')");
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b,{date:'2030-01-08'}),NOW),/no longer available/);
  updateSettings(db,{...settingsFor(db),allowOutside:false});
  assert.throws(()=>rescheduleBooking(db,admin,b.id,move(b,{time:'18:00'}),NOW),/no longer available/);
  updateSettings(db,{...settingsFor(db),allowOutside:true});
  const updated=rescheduleBooking(db,admin,b.id,move(b,{time:'18:00'}),NOW);
  assert.equal(updated.price,4500); assert.equal(updated.outside,1);
});
test('pending repeat bookings keep approval status, and renew from the changed weekday and time',t=>{
  const {db,admin}=fixture(t); const b=createBooking(db,'client',input({repeatWeeks:2}),NOW);
  const moved=rescheduleBooking(db,admin,b.id,move(b,{date:'2030-01-08',time:'10:00'}),NOW);
  assert.equal(moved.status,'pending'); assert.equal(moved.repeat_weeks,2);
  assert.equal(db.prepare("SELECT approvals FROM users WHERE id='client'").get().approvals,0);
  changeBooking(db,admin,b.id,'approve',NOW); changeBooking(db,admin,b.id,'complete',moved.ends_at+1);
  const next=db.prepare('SELECT * FROM bookings WHERE id!=?').get(b.id);
  assert.equal(next.date,'2030-01-22'); assert.equal(next.time,'10:00');
});
test('rescheduling APIs require verified staff and reject forged origins and stale saves',async t=>{
  const {db,admin,client}=fixture(t);
  const now=Date.now(), date=addDays(localDate(now,settingsFor(db).timezone),1);
  const slot=availability(db,'cut-style',date,now).slots.find(s=>s.available);
  const b=createAdminBooking(db,admin,input({date,time:slot.time,expectedPrice:slot.price}),now);
  const app=createApp({db,production:false,apiKey:'',from:'',appUrl:'http://localhost:3000'});
  app.listen(0,'127.0.0.1'); await once(app,'listening');
  t.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));});
  const url=`http://127.0.0.1:${app.address().port}/api/admin/bookings/${b.id}`;
  const adminCookie=`erd_session=${createSession(db,admin.id)}`,clientCookie=`erd_session=${createSession(db,client.id)}`;
  assert.equal((await fetch(`${url}/availability?date=${date}`)).status,401);
  assert.equal((await fetch(`${url}/availability?date=${date}`,{headers:{cookie:clientCookie}})).status,403);
  const result=await (await fetch(`${url}/availability?date=${date}`,{headers:{cookie:adminCookie}})).json();
  assert.equal(result.scheduleVersion,0);
  const candidate=result.slots.find(s=>s.available && s.time!==b.time);
  const request={method:'POST',headers:{cookie:adminCookie,'content-type':'application/json'},body:JSON.stringify(move(b,{date,time:candidate.time}))};
  assert.equal((await fetch(`${url}/reschedule`,{...request,headers:{...request.headers,origin:'https://other.example'}})).status,403);
  assert.equal((await fetch(`${url}/reschedule`,{...request,headers:{...request.headers,cookie:clientCookie}})).status,403);
  const response=await fetch(`${url}/reschedule`,request); assert.equal(response.status,200);
  assert.equal((await response.json()).booking.time,candidate.time);
  assert.equal((await fetch(`${url}/reschedule`,request)).status,409);
});
