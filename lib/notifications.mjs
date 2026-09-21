import { randomUUID } from 'node:crypto';
import { demand } from './booking.mjs';
import { isSuperAdmin } from './roles.mjs';
import { settingsFor, transaction } from './store.mjs';

// Called inside the booking transaction: the appointment and its alerts persist together.
export function queueBookingEvent(db, booking, kind, actorId, now) {
  const client = booking.user_id ? db.prepare('SELECT name FROM users WHERE id=?').get(booking.user_id) : null;
  const settings = settingsFor(db);
  const payload = { name: client?.name || booking.guest_name, service: booking.service_name,
    serviceSq: booking.service_name_sq, date: booking.date, time: booking.time,
    status: booking.status, timezone: settings.timezone };
  const eventId = randomUUID();
  db.prepare('INSERT INTO booking_events (id,booking_id,kind,payload,created_at) VALUES (?,?,?,?,?)')
    .run(eventId, booking.id, kind, JSON.stringify(payload), now);
  const { language } = db.prepare('SELECT language FROM notification_preferences WHERE id=1').get();
  const recipients = db.prepare(`SELECT u.id, r.user_id AS selected FROM users u
    LEFT JOIN notification_recipients r ON r.user_id=u.id
    WHERE u.verified=1 AND u.role IN ('admin','super_admin') AND u.id != ?`).all(actorId);
  const insert = db.prepare('INSERT INTO admin_notifications (email_key,event_id,user_id,email_status,language,next_attempt_at) VALUES (?,?,?,?,?,?)');
  for (const user of recipients) insert.run(randomUUID(), eventId, user.id, user.selected ? 'pending' : 'off', language, now);
}

export function notificationPreferences(db, actor) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage email notifications.', 403);
  return {
    language: db.prepare('SELECT language FROM notification_preferences WHERE id=1').get().language,
    recipients: db.prepare(`SELECT u.id,u.name,u.email, CASE WHEN r.user_id IS NULL THEN 0 ELSE 1 END AS selected
      FROM users u LEFT JOIN notification_recipients r ON r.user_id=u.id
      WHERE u.verified=1 AND u.role IN ('admin','super_admin') ORDER BY u.name,u.email`).all(),
    pending: db.prepare("SELECT count(*) n FROM admin_notifications WHERE email_status='pending'").get().n,
    failed: db.prepare("SELECT count(*) n FROM admin_notifications WHERE email_status='failed'").get().n,
  };
}

export function saveNotificationPreferences(db, actor, input) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage email notifications.', 403);
  demand(Array.isArray(input.recipientIds) && input.recipientIds.length <= 100 && input.recipientIds.every(id => typeof id === 'string') && new Set(input.recipientIds).size === input.recipientIds.length, 'Choose valid notification recipients.');
  demand(['en','sq'].includes(input.language), 'Choose an email language.');
  transaction(db, () => {
    for (const id of input.recipientIds) demand(db.prepare("SELECT id FROM users WHERE id=? AND verified=1 AND role IN ('admin','super_admin')").get(id), 'Only verified administrators can receive booking emails.');
    db.prepare('DELETE FROM notification_recipients').run();
    for (const id of input.recipientIds) db.prepare('INSERT INTO notification_recipients (user_id) VALUES (?)').run(id);
    db.prepare('UPDATE notification_preferences SET language=? WHERE id=1').run(input.language);
    // A removed recipient must not receive previously queued or retried email.
    db.prepare("UPDATE admin_notifications SET email_status='skipped' WHERE email_status IN ('pending','failed') AND user_id NOT IN (SELECT user_id FROM notification_recipients)").run();
  });
  return notificationPreferences(db, actor);
}

export function notificationInbox(db, userId) {
  const items = db.prepare(`SELECT n.id,n.read_at,e.booking_id,e.kind,e.payload,e.created_at
    FROM admin_notifications n JOIN booking_events e ON e.id=n.event_id
    WHERE n.user_id=? ORDER BY n.id DESC LIMIT 50`).all(userId)
    .map(({payload, ...item}) => ({...item, ...JSON.parse(payload)}));
  return { items, unreadCount: db.prepare('SELECT count(*) n FROM admin_notifications WHERE user_id=? AND read_at IS NULL').get(userId).n };
}

export function markNotificationsRead(db, userId, input, now = Date.now()) {
  const id = input.id ?? input.throughId;
  demand(Number.isSafeInteger(id) && id > 0 && !(input.id !== undefined && input.throughId !== undefined), 'Choose a valid notification.');
  // Bound to the last notification the browser saw; newer arrivals remain unread.
  db.prepare(`UPDATE admin_notifications SET read_at=? WHERE user_id=? AND id${input.id !== undefined ? '=' : '<='}? AND read_at IS NULL`).run(now, userId, id);
  return notificationInbox(db, userId);
}

export function retryNotificationEmails(db, actor, now = Date.now()) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage email notifications.', 403);
  db.prepare("UPDATE admin_notifications SET email_status='pending', attempts=0, next_attempt_at=?, last_error='' WHERE email_status='failed'").run(now);
  return notificationPreferences(db, actor);
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bookingEmail(job, appUrl) {
  const p = JSON.parse(job.payload), sq = job.language === 'sq';
  const title = job.kind === 'cancelled' ? (sq ? 'Termini u anulua' : 'Reservation cancelled') : (sq ? 'Rezervim i ri' : 'New reservation');
  const status = job.kind === 'cancelled' ? (sq ? 'Anuluar' : 'Cancelled') : (job.booking_status || p.status) === 'pending' ? (sq ? 'Kërkon miratim' : 'Needs approval') : (sq ? 'Konfirmuar' : 'Confirmed');
  const link = new URL('/admin', appUrl); link.searchParams.set('booking', job.booking_id);
  const label = sq ? 'Shiko rezervimin' : 'View reservation';
  const lines = [title, `${sq ? 'Klienti' : 'Client'}: ${p.name}`, `${sq ? 'Shërbimi' : 'Service'}: ${sq && p.serviceSq ? p.serviceSq : p.service}`,
    `${p.date} · ${p.time} (${p.timezone})`, status];
  return { subject: `${title} · ${p.date} ${p.time} · ERD Hair Design`,
    textContent: [...lines, `${label}: ${link.href}`].join('\n'),
    htmlContent: `<h1>${escapeHtml(title)}</h1>${lines.slice(1).map(line => `<p>${escapeHtml(line)}</p>`).join('')}<p><a href="${escapeHtml(link.href)}">${label}</a></p>` };
}

export async function sendBookingEmail(job, { apiKey, from, appUrl, signal }) {
  const named = typeof from === 'string' && from.trim().match(/^([^<>]+)\s*<([^<>]+)>$/);
  const sender = { name: named ? named[1].trim() : 'ERD Hair Design', email: named ? named[2].trim() : from?.trim() };
  if (!apiKey || !sender.email || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender.email)) throw new Error('Email delivery is not configured.');
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: {'api-key':apiKey, 'Content-Type':'application/json', Accept:'application/json'},
    body: JSON.stringify({sender, to:[{email:job.email}], ...bookingEmail(job, appUrl), headers:{idempotencyKey:job.email_key}}),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // Brevo has already accepted the original request when a retry hits its deduplication window.
    if (body.code === 'duplicate_parameter') return;
    throw new Error('Email provider did not accept the notification.');
  }
}

export function createNotificationWorker(db, config, { send = sendBookingEmail, now = Date.now } = {}) {
  let running = null, timer, stopped = false;
  const controller = new AbortController();
  async function drain() {
    // Local development keeps real recipients safe and leaves email queued until configured.
    if (stopped || !config.apiKey || !config.from) return;
    for (let i = 0; i < 20 && !stopped; i++) {
      const job = transaction(db, () => {
        const row = db.prepare(`SELECT n.*,e.kind,e.booking_id,e.payload,u.email,u.verified,u.role,b.status AS booking_status,
          r.user_id AS selected FROM admin_notifications n JOIN booking_events e ON e.id=n.event_id
          JOIN users u ON u.id=n.user_id JOIN bookings b ON b.id=e.booking_id
          LEFT JOIN notification_recipients r ON r.user_id=u.id
          WHERE n.email_status='pending' AND n.next_attempt_at<=? ORDER BY n.id LIMIT 1`).get(now());
        if (!row) return null;
        if (!row.selected || !row.verified || !['admin','super_admin'].includes(row.role) || (row.kind === 'created' && !['pending','confirmed'].includes(row.booking_status))) {
          db.prepare("UPDATE admin_notifications SET email_status='skipped' WHERE id=?").run(row.id);
          return { skipped:true };
        }
        // A lease survives process crashes; retries use a stable provider idempotency key.
        db.prepare('UPDATE admin_notifications SET attempts=attempts+1,next_attempt_at=? WHERE id=?').run(now()+60000,row.id);
        return {...row, attempts:row.attempts+1};
      });
      if (!job) break;
      if (job.skipped) continue;
      try {
        await send(job, {...config, signal:controller.signal});
        if (stopped) return;
        db.prepare("UPDATE admin_notifications SET email_status='sent',sent_at=?,last_error='' WHERE id=?").run(now(),job.id);
      } catch {
        if (stopped) return;
        db.prepare("UPDATE admin_notifications SET email_status=?,next_attempt_at=?,last_error=? WHERE id=? AND email_status='pending'")
          .run(job.attempts >= 8 ? 'failed' : 'pending', now()+Math.min(3600000,60000*2**(job.attempts-1)), 'Email delivery failed. Check the email configuration and retry.', job.id);
      }
    }
  }
  function kick() {
    if (!stopped && !running) running = Promise.resolve().then(drain).catch(() => console.error('Notification worker could not process its queue.')).finally(() => { running = null; });
    return running || Promise.resolve();
  }
  return {
    kick,
    start() { if (!timer && !stopped) { timer = setInterval(kick,30000); timer.unref(); kick(); } },
    stop() { stopped = true; clearInterval(timer); controller.abort(); return running || Promise.resolve(); },
  };
}
