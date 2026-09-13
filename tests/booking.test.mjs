import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, settingsFor } from '../lib/store.mjs';
import { availability, createBooking, changeBooking, updateSettings, timestamp } from '../lib/booking.mjs';

const NOW = Date.parse('2030-01-06T12:00:00Z');
const input = (overrides = {}) => ({ serviceId: 'cut-style', date: '2030-01-07', time: '09:00', repeatWeeks: 0, notes: '', expectedPrice: 4500, ...overrides });
function fixture(t) {
  const db = openStore(':memory:'); t.after(() => db.close());
  const add = db.prepare('INSERT INTO users (id,email,name,phone,password,verified,role,created_at) VALUES (?,?,?,?,?,?,?,?)');
  add.run('client', 'client@example.test', 'Test Client', '+3811234567', 'unused', 1, 'client', NOW);
  add.run('other', 'other@example.test', 'Other Client', '+3811234567', 'unused', 1, 'client', NOW);
  add.run('admin', 'admin@example.test', 'Test Admin', '+3811234567', 'unused', 1, 'admin', NOW);
  return { db, admin: { id: 'admin', role: 'admin' }, client: { id: 'client', role: 'client' } };
}

test('unverified clients cannot book', t => {
  const { db } = fixture(t); db.prepare('UPDATE users SET verified = 0 WHERE id = ?').run('client');
  assert.throws(() => createBooking(db, 'client', input(), NOW), /Verify your email/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM bookings').get().n, 0);
});
test('first two manual approvals unlock automatic approval for the third appointment', t => {
  const { db, admin } = fixture(t);
  let now = NOW;
  for (const date of ['2030-01-07', '2030-01-08']) {
    const b = createBooking(db, 'client', input({ date }), now);
    assert.equal(b.status, 'pending');
    assert.equal(changeBooking(db, admin, b.id, 'approve', now).status, 'confirmed');
    now = b.ends_at + 1;
    changeBooking(db, admin, b.id, 'complete', now);
  }
  assert.equal(db.prepare('SELECT approvals FROM users WHERE id = ?').get('client').approvals, 2);
  assert.equal(createBooking(db, 'client', input({ date: '2030-01-09' }), now).status, 'confirmed');
});
test('only one active appointment is allowed, even on a different date', t => {
  const { db } = fixture(t); createBooking(db, 'client', input(), NOW);
  assert.throws(() => createBooking(db, 'client', input({ date: '2030-01-08' }), NOW), /already have an active/);
});
test('overlapping appointments are rejected but adjacent appointments are allowed', t => {
  const { db } = fixture(t); createBooking(db, 'client', input(), NOW);
  assert.throws(() => createBooking(db, 'other', input({ time: '09:30' }), NOW), /no longer available/);
  assert.equal(createBooking(db, 'other', input({ time: '10:00' }), NOW).time, '10:00');
});
test('server checks the entire duration against a shift and charges outside-hours prices', t => {
  const { db } = fixture(t);
  const data = availability(db, 'cut-style', '2030-01-07', NOW);
  assert.equal(data.slots.find(s => s.time === '17:00').outside, false);
  assert.equal(data.slots.find(s => s.time === '17:30').outside, true);
  const b = createBooking(db, 'client', input({ time: '18:00', expectedPrice: 6000 }), NOW);
  assert.equal(b.price, 6000); assert.equal(b.outside, 1); assert.equal(b.status, 'pending');
});
test('new or forged prices require renewed client acceptance', t => {
  const { db } = fixture(t);
  assert.throws(() => createBooking(db, 'client', input({ expectedPrice: 1 }), NOW), /price has changed/);
  db.prepare('UPDATE services SET price = 5000 WHERE id = ?').run('cut-style');
  assert.throws(() => createBooking(db, 'client', input(), NOW), /price has changed/);
  assert.equal(createBooking(db, 'client', input({ expectedPrice: 5000 }), NOW).price, 5000);
});
test('admin can disable auto approval, skip the first two approvals, and require outside-hour approval', t => {
  const { db, client } = fixture(t);
  updateSettings(db, { ...settingsFor(db), requiredApprovals: 0 });
  const b = createBooking(db, 'client', input(), NOW); assert.equal(b.status, 'confirmed');
  changeBooking(db, client, b.id, 'cancel', NOW);
  const outside = createBooking(db, 'client', input({ time: '18:00', expectedPrice: 6000 }), NOW); assert.equal(outside.status, 'pending');
  changeBooking(db, client, outside.id, 'cancel', NOW);
  updateSettings(db, { ...settingsFor(db), autoApprove: false });
  assert.equal(createBooking(db, 'client', input(), NOW).status, 'pending');
});
test('closed days have no slots when outside requests are disabled', t => {
  const { db } = fixture(t);
  updateSettings(db, { ...settingsFor(db), allowOutside: false });
  assert.deepEqual(availability(db, 'cut-style', '2030-01-13', NOW).slots, []);
  assert.ok(availability(db, 'cut-style', '2030-01-07', NOW).slots.every(s => !s.outside));
});
test('cancellation releases the slot and stops the repeat', t => {
  const { db, client } = fixture(t);
  const b = createBooking(db, 'client', input({ repeatWeeks: 2 }), NOW);
  const cancelled = changeBooking(db, client, b.id, 'cancel', NOW);
  assert.equal(cancelled.repeat_weeks, 0); assert.equal(cancelled.status, 'cancelled');
  assert.equal(createBooking(db, 'other', input(), NOW).status, 'pending');
});
test('repeat completion creates exactly one next appointment and applies approval rules again', t => {
  const { db, admin } = fixture(t);
  const b = createBooking(db, 'client', input({ repeatWeeks: 2 }), NOW);
  changeBooking(db, admin, b.id, 'approve', NOW);
  changeBooking(db, admin, b.id, 'complete', b.ends_at + 1);
  const active = db.prepare("SELECT * FROM bookings WHERE user_id = 'client' AND status IN ('pending','confirmed')").all();
  assert.equal(active.length, 1); assert.equal(active[0].date, '2030-01-21'); assert.equal(active[0].status, 'pending');
  assert.throws(() => changeBooking(db, admin, b.id, 'complete', b.ends_at + 1), /no longer active/);
});
test('repeat collisions pause renewal without rolling back a completed visit', t => {
  const { db, admin } = fixture(t);
  const b = createBooking(db, 'client', input({ repeatWeeks: 2 }), NOW);
  changeBooking(db, admin, b.id, 'approve', NOW);
  createBooking(db, 'other', input({ date: '2030-01-21' }), NOW);
  const completed = changeBooking(db, admin, b.id, 'complete', b.ends_at + 1);
  assert.equal(completed.status, 'completed'); assert.match(completed.recurrence_note, /Repeat paused/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM bookings WHERE user_id = 'client' AND status IN ('pending','confirmed')").get().n, 0);
});
test('repeat price changes pause renewal to protect agreed prices', t => {
  const { db, admin } = fixture(t);
  const b = createBooking(db, 'client', input({ repeatWeeks: 2 }), NOW);
  changeBooking(db, admin, b.id, 'approve', NOW);
  db.prepare('UPDATE services SET price = 5000 WHERE id = ?').run('cut-style');
  assert.match(changeBooking(db, admin, b.id, 'complete', b.ends_at + 1).recurrence_note, /price or working hours changed/);
});
test('permissions and appointment state transitions are enforced', t => {
  const { db, admin, client } = fixture(t);
  const b = createBooking(db, 'client', input(), NOW);
  assert.throws(() => changeBooking(db, client, b.id, 'approve', NOW), /Admin access/);
  assert.throws(() => changeBooking(db, { id: 'other', role: 'client' }, b.id, 'cancel', NOW), /another account/);
  assert.throws(() => changeBooking(db, admin, b.id, 'complete', NOW), /Only confirmed/);
  changeBooking(db, admin, b.id, 'approve', NOW);
  assert.throws(() => changeBooking(db, admin, b.id, 'approve', NOW), /Only pending/);
  assert.throws(() => changeBooking(db, admin, b.id, 'complete', NOW), /after its end time/);
});
test('invalid dates, past slots, excessive horizons, and invalid shifts are rejected', t => {
  const { db } = fixture(t);
  assert.throws(() => availability(db, 'cut-style', '2030-02-30', NOW), /valid date/);
  assert.throws(() => availability(db, 'cut-style', '2029-12-01', NOW), /next 90 days/);
  assert.throws(() => availability(db, 'cut-style', '2031-01-01', NOW), /next 90 days/);
  assert.throws(() => availability(db, undefined, '2030-01-07', NOW), /available service/);
  const settings = settingsFor(db); settings.shifts[1].end = '08:00';
  assert.throws(() => updateSettings(db, settings), /valid start and end/);
});
test('salon times remain correct across daylight-saving changes', () => {
  assert.equal(new Date(timestamp('2030-01-07', '09:00', 'Europe/Belgrade')).toISOString(), '2030-01-07T08:00:00.000Z');
  assert.equal(new Date(timestamp('2030-07-08', '09:00', 'Europe/Belgrade')).toISOString(), '2030-07-08T07:00:00.000Z');
  assert.throws(() => timestamp('2030-03-31', '02:30', 'Europe/Belgrade'), /clocks change/);
});
