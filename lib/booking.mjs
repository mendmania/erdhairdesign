import { queueBookingEvent, queueClientConfirmation, queueClientNotification } from './notifications.mjs';
import { isAdmin } from './roles.mjs';
import { randomUUID } from 'node:crypto';
import { settingsFor, transaction } from './store.mjs';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const demand = (condition, message, status) => { if (!condition) throw new AppError(message, status); };
export const minutes = value => Number(value.split(':')[0]) * 60 + Number(value.split(':')[1]);
export const clock = value => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
export const validTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function localDate(now, timezone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year', 'month', 'day'].map(k => p.find(i => i.type === k).value).join('-');
}
export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
// Resolve wall-clock appointments in the salon's timezone, independently of the server timezone.
export function timestamp(date, time, timezone) {
  const desired = Date.parse(`${date}T${time}:00Z`);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(p => [p.type, p.value]));
    const wall = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    const delta = desired - wall;
    if (delta === 0) return guess;
    guess += delta;
  }
  throw new AppError('This time is unavailable because the clocks change. Choose another time.');
}

export function availability(db, serviceId, date, now = Date.now()) {
  demand(typeof serviceId === 'string' && serviceId.length <= 100, 'Choose an available service.');
  const service = db.prepare('SELECT * FROM services WHERE id = ? AND active = 1').get(serviceId);
  demand(service, 'Choose an available service.');
  return serviceAvailability(db, service, date, now);
}

function serviceAvailability(db, service, date, now, excludeBookingId = '') {
  const settings = settingsFor(db);
  demand(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) === date, 'Choose a valid date.');
  const today = localDate(now, settings.timezone);
  demand(date >= today && date <= addDays(today, 90), 'Choose a date within the next 90 days.');
  const shift = settings.shifts[new Date(`${date}T12:00:00Z`).getUTCDay()];
  if (db.prepare('SELECT id FROM vacations WHERE start_date <= ? AND end_date >= ?').get(date, date)) return { slots: [], shift, timezone: settings.timezone, closed: true };
  const start = settings.allowOutside ? Math.min(minutes(settings.outsideStart), shift.open ? minutes(shift.start) : 1440) : (shift.open ? minutes(shift.start) : 0);
  const end = settings.allowOutside ? Math.max(minutes(settings.outsideEnd), shift.open ? minutes(shift.end) : 0) : (shift.open ? minutes(shift.end) : 0);
  const occupied = db.prepare("SELECT starts_at, ends_at FROM bookings WHERE date = ? AND id != ? AND status IN ('pending', 'confirmed')").all(date, excludeBookingId);
  const slots = [];
  for (let m = Math.ceil(start / 30) * 30; m + service.duration <= end; m += 30) {
    const outside = !shift.open || m < minutes(shift.start) || m + service.duration > minutes(shift.end);
    if (outside && (!settings.allowOutside || m < minutes(settings.outsideStart) || m + service.duration > minutes(settings.outsideEnd))) continue;
    let startsAt;
    try { startsAt = timestamp(date, clock(m), settings.timezone); } catch { continue; }
    const endsAt = startsAt + service.duration * 60000;
    if (startsAt <= now) continue;
    slots.push({ time: clock(m), outside, price: outside ? service.outside_price : service.price,
      available: !occupied.some(b => startsAt < b.ends_at && endsAt > b.starts_at), startsAt, endsAt });
  }
  return { slots, shift, timezone: settings.timezone };
}

function insertBooking(db, user, input, now, manual = null, guest = null) {
  demand(manual || guest || user?.verified, 'Verify your email before booking.', 403);
  if (user) demand(!db.prepare("SELECT id FROM bookings WHERE user_id = ? AND status IN ('pending','confirmed')").get(user.id), manual ? 'This client already has an active appointment. Cancel it before booking another.' : 'You already have an active appointment. Cancel it before booking another.', 409);
  demand([0, 1, 2, 4, 6, 8].includes(input.repeatWeeks), 'Choose a valid repeat interval.');
  demand(typeof input.notes === 'string' && input.notes.length <= 1000, 'Notes must be 1,000 characters or fewer.');
  const slot = availability(db, input.serviceId, input.date, now).slots.find(s => s.time === input.time);
  demand(slot?.available, 'That time is no longer available. Please choose another.', 409);
  demand(Number.isInteger(input.expectedPrice) && input.expectedPrice === slot.price, 'The price has changed. Return to date & time to review the current price.', 409);
  const settings = settingsFor(db);
  const status = manual || (!guest && settings.autoApprove && user.approvals >= settings.requiredApprovals && (!slot.outside || !settings.outsideApproval)) ? 'confirmed' : 'pending';
  const service = db.prepare('SELECT * FROM services WHERE id = ?').get(input.serviceId);
  const id = randomUUID();
  db.prepare(`INSERT INTO bookings (id,user_id,service_id,service_name,date,time,starts_at,ends_at,duration,price,outside,status,repeat_weeks,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user?.id ?? null, service.id, service.name, input.date, input.time, slot.startsAt, slot.endsAt, service.duration, slot.price, Number(slot.outside), status, input.repeatWeeks, input.notes.trim(), now);
  db.prepare('UPDATE bookings SET service_name_sq=?,email_language=? WHERE id=?').run(service.name_sq || '', input.language === 'en' ? 'en' : 'sq', id);
  if (guest) db.prepare('UPDATE bookings SET guest_name=?,guest_email=?,guest_phone=? WHERE id=?').run(guest.name,guest.email,guest.phone,id);
  if (manual) {
    db.prepare('UPDATE bookings SET created_by=?, manually_approved=1 WHERE id=?').run(manual.actorId, id);
    if (user) db.prepare('UPDATE users SET approvals = approvals + 1 WHERE id = ?').run(user.id);
  }
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  queueBookingEvent(db, booking, 'created', manual?.actorId || user?.id || '', now);
  if (booking.status === 'confirmed') queueClientConfirmation(db, booking, now);
  else queueClientNotification(db, booking, 'requested', now);
  return booking;
}

export function createBooking(db, userId, input, now = Date.now()) {
  return transaction(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    demand(user, 'Please sign in.', 401);
    return insertBooking(db, user, input, now);
  });
}

function guestDetails(input, emailRequired = false) {
  demand(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.trim().length <= 100, 'Enter your full name (2–100 characters).');
  demand(input.phone === undefined || typeof input.phone === 'string', 'Enter a valid phone number.');
  demand(input.email === undefined || typeof input.email === 'string', 'Enter a valid email address.');
  const phone = (input.phone || '').trim(), email = (input.email || '').trim().toLowerCase();
  demand(!phone || (/^[+\d\s().-]{6,30}$/.test(phone) && phone.replace(/\D/g, '').length >= 6), 'Enter a valid phone number.');
  demand((!emailRequired && !email) || (email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)), 'Enter a valid email address.');
  return {name:input.name.trim(), email, phone};
}

export function createGuestBooking(db, input, now = Date.now()) {
  return transaction(db, () => {
    const guest = guestDetails(input, true);
    demand(input.repeatWeeks === undefined || input.repeatWeeks === 0, 'Sign in to book repeating visits.');
    demand(!db.prepare("SELECT id FROM bookings WHERE guest_email=? AND status IN ('pending','confirmed')").get(guest.email), 'You already have an active appointment. Cancel it before booking another.', 409);
    return insertBooking(db, null, {...input, notes:input.notes ?? '', repeatWeeks:0}, now, null, guest);
  });
}

export function createAdminBooking(db, actor, input, now = Date.now()) {
  demand(isAdmin(actor) && actor.verified, 'Admin access is required.', 403);
  return transaction(db, () => {
    demand(input.userId === undefined || input.userId === null || typeof input.userId === 'string', 'Choose an existing client or enter guest details.');
    let user = null, guest = null;
    if (input.userId) {
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(input.userId);
      demand(user, 'Client not found.', 404);
    } else guest = guestDetails(input);
    return insertBooking(db, user, { ...input, notes:input.notes ?? '', repeatWeeks: 0 }, now, { actorId: actor.id }, guest);
  });
}

function reschedulableBooking(db, actor, id, now) {
  demand(isAdmin(actor) && actor.verified, 'Admin access is required.', 403);
  const booking = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  demand(booking, 'Appointment not found.', 404);
  demand(['pending','confirmed'].includes(booking.status), 'This appointment is no longer active.', 409);
  demand(booking.starts_at > now, 'This appointment has already started and cannot be rescheduled.', 409);
  return booking;
}

export function rescheduleAvailability(db, actor, id, date, now = Date.now()) {
  const booking = reschedulableBooking(db, actor, id, now);
  // Existing visits retain their agreed duration and price, even if the menu changes.
  const slots = serviceAvailability(db, {...booking, outside_price:booking.price}, date, now, booking.id);
  return {...slots, scheduleVersion:booking.schedule_version, status:booking.status};
}

export function rescheduleBooking(db, actor, id, input, now = Date.now()) {
  return transaction(db, () => {
    const booking = reschedulableBooking(db, actor, id, now);
    demand(Number.isSafeInteger(input.expectedVersion) && input.expectedVersion === booking.schedule_version && input.expectedStatus === booking.status,
      'This appointment changed. Close this dialog and refresh the schedule before trying again.', 409);
    demand(input.date !== booking.date || input.time !== booking.time, 'Choose a different date or time.');
    const slot = rescheduleAvailability(db, actor, id, input.date, now).slots.find(s => s.time === input.time);
    demand(slot?.available, 'That time is no longer available. Please choose another.', 409);
    db.prepare(`UPDATE bookings SET date=?,time=?,starts_at=?,ends_at=?,outside=?,schedule_version=schedule_version+1 WHERE id=?`)
      .run(input.date,input.time,slot.startsAt,slot.endsAt,Number(slot.outside),id);
    const updated = db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    db.prepare(`INSERT INTO booking_reschedules (booking_id,actor_id,previous_date,previous_time,date,time,schedule_version,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id,actor.id,booking.date,booking.time,updated.date,updated.time,updated.schedule_version,now);
    queueClientNotification(db, updated, 'rescheduled', now, booking);
    return updated;
  });
}

export function changeBooking(db, actor, id, action, now = Date.now()) {
  return transaction(db, () => {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    demand(booking, 'Appointment not found.', 404);
    demand(isAdmin(actor) || actor.id === booking.user_id, 'This appointment belongs to another account.', 403);
    demand(['pending', 'confirmed'].includes(booking.status), 'This appointment is no longer active.', 409);
    if (action === 'cancel') {
      db.prepare("UPDATE bookings SET status = 'cancelled', repeat_weeks = 0 WHERE id = ?").run(id);
    } else {
      demand(isAdmin(actor), 'Admin access is required.', 403);
      if (action === 'approve') {
        demand(booking.status === 'pending', 'Only pending appointments can be approved.', 409);
        demand(booking.starts_at > now, 'This appointment has passed. Decline it so the client can book again.', 409);
        db.prepare("UPDATE bookings SET status = 'confirmed', manually_approved = 1 WHERE id = ?").run(id);
        db.prepare('UPDATE users SET approvals = approvals + 1 WHERE id = ?').run(booking.user_id);
      } else if (action === 'decline') {
        demand(booking.status === 'pending', 'Only pending requests can be declined.', 409);
        db.prepare("UPDATE bookings SET status = 'declined', repeat_weeks = 0 WHERE id = ?").run(id);
      } else if (action === 'complete') {
        demand(booking.status === 'confirmed', 'Only confirmed appointments can be completed.', 409);
        demand(booking.ends_at <= now, 'An appointment can be completed after its end time.', 409);
        db.prepare("UPDATE bookings SET status = 'completed' WHERE id = ?").run(id);
        if (booking.repeat_weeks) {
          let date = addDays(booking.date, booking.repeat_weeks * 7);
          while (timestamp(date, booking.time, settingsFor(db).timezone) <= now) date = addDays(date, booking.repeat_weeks * 7);
          const user = db.prepare('SELECT * FROM users WHERE id = ?').get(booking.user_id);
          // Stop renewal when the price changes; a client must explicitly accept a new price.
          const service = db.prepare('SELECT * FROM services WHERE id = ?').get(booking.service_id);
          try {
            const candidate = availability(db, service.id, date, now).slots.find(s => s.time === booking.time);
            demand(candidate?.price === booking.price, 'The price or working hours changed. Please make a new booking.');
            const next = insertBooking(db, user, { serviceId: service.id, date, time: booking.time, repeatWeeks: booking.repeat_weeks, language: booking.email_language, notes: booking.notes, expectedPrice: booking.price }, now);
            db.prepare('UPDATE bookings SET recurrence_note = ? WHERE id = ?').run(`Next visit booked for ${next.date} at ${next.time}.`, id);
          } catch (error) {
            if (!(error instanceof AppError)) throw error;
            db.prepare('UPDATE bookings SET recurrence_note = ? WHERE id = ?').run(`Repeat paused: ${error.message}`, id);
          }
        }
      } else throw new AppError('Unknown appointment action.');
    }
    const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    if (action === 'approve') queueClientConfirmation(db, updated, now);
    if (action === 'cancel') queueBookingEvent(db, updated, 'cancelled', actor.id, now);
    if (action === 'cancel' || action === 'decline') queueClientNotification(db, updated, action === 'cancel' ? 'cancelled' : 'declined', now);
    return updated;
  });
}

export function updateSettings(db, input) {
  const current = settingsFor(db);
  for (const key of ['autoApprove', 'outsideApproval', 'allowOutside']) demand(typeof input[key] === 'boolean', `Invalid ${key}.`);
  demand(Number.isInteger(input.requiredApprovals) && input.requiredApprovals >= 0 && input.requiredApprovals <= 20, 'Required approvals must be between 0 and 20.');
  demand(validTime(input.outsideStart) && validTime(input.outsideEnd) && input.outsideStart < input.outsideEnd, 'Set a valid outside-hours request window.');
  demand(Array.isArray(input.shifts) && input.shifts.length === 7, 'Set a shift for each day.');
  const shifts = input.shifts.map((s, day) => {
    demand(s.day === day && typeof s.open === 'boolean' && validTime(s.start) && validTime(s.end) && s.start < s.end, 'Every shift must have a valid start and end time.');
    return { day, open: s.open, start: s.start, end: s.end };
  });
  const settings = { ...current, autoApprove: input.autoApprove, outsideApproval: input.outsideApproval, allowOutside: input.allowOutside,
    requiredApprovals: input.requiredApprovals, outsideStart: input.outsideStart, outsideEnd: input.outsideEnd, shifts };
  db.prepare('UPDATE settings SET value = ? WHERE id = 1').run(JSON.stringify(settings));
  return settings;
}
