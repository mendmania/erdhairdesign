import { emailLayout } from './email-templates.mjs';
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
  const recipients = db.prepare(`SELECT id FROM users
    WHERE verified=1 AND role IN ('admin','super_admin') AND (? = 'created' OR id != ?)`).all(kind, actorId);
  const insert = db.prepare('INSERT INTO admin_notifications (email_key,event_id,user_id,email_status,language,next_attempt_at) VALUES (?,?,?,?,?,?)');
  for (const user of recipients) insert.run(randomUUID(), eventId, user.id, 'pending', language, now);
}

export function queueClientConfirmation(db, booking, now) {
  if (!booking.user_id && !booking.guest_email) return;
  const client = booking.user_id ? db.prepare('SELECT name FROM users WHERE id=?').get(booking.user_id) : null;
  const payload = { guest: !booking.user_id, name: client?.name || booking.guest_name, service: booking.service_name, serviceSq: booking.service_name_sq,
    date: booking.date, time: booking.time, status: 'confirmed', timezone: settingsFor(db).timezone };
  db.prepare(`INSERT INTO client_notifications (email_key,booking_id,user_id,payload,language,email_status,next_attempt_at)
    VALUES (?,?,?,?,?,'pending',?) ON CONFLICT(booking_id) DO NOTHING`)
    .run(randomUUID(), booking.id, booking.user_id, JSON.stringify(payload), booking.email_language, now);
}

export function notificationPreferences(db, actor) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage email notifications.', 403);
  const count = status => ['admin_notifications','client_notifications'].reduce((n, table) =>
    n + db.prepare(`SELECT count(*) n FROM ${table} WHERE email_status=?`).get(status).n, 0);
  return {
    language: db.prepare('SELECT language FROM notification_preferences WHERE id=1').get().language,
    recipients: db.prepare(`SELECT id,name,email,1 AS selected FROM users
      WHERE verified=1 AND role IN ('admin','super_admin') ORDER BY name,email`).all(),
    pending: count('pending'), failed: count('failed'),
  };
}

export function saveNotificationPreferences(db, actor, input) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage email notifications.', 403);
  demand(['en','sq'].includes(input.language), 'Choose an email language.');
  // Recipient selection is retired: every verified admin always receives new reservations.
  db.prepare('UPDATE notification_preferences SET language=? WHERE id=1').run(input.language);
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
  transaction(db, () => {
    for (const table of ['admin_notifications','client_notifications']) {
      db.prepare(`UPDATE ${table} SET email_status='pending', attempts=0, next_attempt_at=?, last_error='' WHERE email_status='failed'`).run(now);
    }
  });
  return notificationPreferences(db, actor);
}

export function bookingEmail(job, appUrl) {
  const p = JSON.parse(job.payload), sq = job.language === 'sq', client = job.kind === 'confirmed';
  const needsApproval = job.kind === 'created' && (job.booking_status || p.status) === 'pending';
  const title = client ? (sq ? 'Rezervimi juaj është konfirmuar.' : 'Your reservation is confirmed.')
    : job.kind === 'cancelled' ? (sq ? 'Termini u anulua' : 'Reservation cancelled') : (sq ? 'Rezervim i ri' : 'New reservation');
  const status = job.kind === 'cancelled' ? (sq ? 'Anuluar' : 'Cancelled') : (job.booking_status || p.status) === 'pending' ? (sq ? 'Kërkon miratim' : 'Needs approval') : (sq ? 'Konfirmuar' : 'Confirmed');
  const link = new URL(client ? (p.guest ? '/studio' : '/appointments') : '/admin', appUrl);
  if (!client) link.searchParams.set('booking', job.booking_id);
  const label = client ? (p.guest ? (sq ? 'Studioja jonë' : 'Our studio') : (sq ? 'Terminet e mia' : 'My visits')) : needsApproval ? (sq ? 'Konfirmo rezervimin' : 'Confirm reservation') : (sq ? 'Shiko rezervimin' : 'View reservation');
  const intro = client ? (sq ? `${p.name}, termini juaj është rezervuar. Me kënaqësi ju presim në ERD Hair Design.` : `${p.name}, your appointment is secured. We look forward to welcoming you to ERD Hair Design.`)
    : job.kind === 'cancelled' ? (sq ? 'Një rezervim është anuluar. Kalendari i sallonit është përditësuar.' : 'A reservation has been cancelled. Your salon calendar is up to date.')
    : needsApproval ? (sq ? 'Një klient po pret konfirmimin tuaj. Kontrolloni të dhënat më poshtë dhe hapni rezervimin për ta miratuar.' : 'A client is waiting for your confirmation. Review the details below, then open the reservation to approve it.')
    : (sq ? 'Një rezervim i ri është shtuar në kalendarin e sallonit.' : 'A new reservation has been added to your salon calendar.');
  const details = [[sq ? 'Klienti' : 'Client', p.name], [sq ? 'Shërbimi' : 'Service', sq && p.serviceSq ? p.serviceSq : p.service],
    [sq ? 'Data' : 'Date', p.date], [sq ? 'Ora' : 'Time', p.time], [sq ? 'Statusi' : 'Status', status]];
  const footer = client && p.guest ? (sq ? 'Për të ndryshuar ose anuluar rezervimin, kontaktoni sallonin.' : 'To change or cancel your reservation, please contact the salon.') : client ? (sq ? 'Për të parë ose anuluar rezervimin, hyni në llogarinë tuaj dhe hapni Terminet e mia.' : 'To view or cancel your reservation, sign in to your account and open My visits.')
    : (sq ? 'Ky është një njoftim për ekipin e ERD. Hyni në llogarinë tuaj të administratorit për të menaxhuar rezervimin.' : 'This is an ERD team notification. Sign in to your admin account to manage the reservation.');
  const actionHint = needsApproval ? (sq ? 'Hyni si administrator dhe zgjidhni Mirato. Klienti do të marrë emailin e konfirmimit.' : 'Sign in as an administrator and choose Approve. The client will receive a confirmation email.') : '';
  return { subject: `${title} · ${p.date} ${p.time} · ERD Hair Design`,
    textContent: [title, intro, ...details.map(([label,value]) => `${label}: ${value}`), `${label}: ${link.href}`, actionHint, footer].filter(Boolean).join('\n'),
    htmlContent: emailLayout({language:job.language, title, intro, details, action:{label,url:link.href,prominent:needsApproval,hint:actionHint}, footer}) };
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
        // Both outboxes share ordering, leases, retries and provider idempotency.
        const row = db.prepare(`SELECT n.id,n.email_key,n.user_id,n.language,n.attempts,n.next_attempt_at,
          e.kind,e.booking_id,e.payload,u.email,u.verified,u.role,b.status AS booking_status,
          'admin_notifications' AS queue FROM admin_notifications n JOIN booking_events e ON e.id=n.event_id
          JOIN users u ON u.id=n.user_id JOIN bookings b ON b.id=e.booking_id
          WHERE n.email_status='pending' AND n.next_attempt_at<=?
          UNION ALL
          SELECT n.id,n.email_key,n.user_id,n.language,n.attempts,n.next_attempt_at,
          'confirmed' AS kind,n.booking_id,n.payload,COALESCE(u.email,b.guest_email) AS email,u.verified,u.role,b.status AS booking_status,
          'client_notifications' AS queue FROM client_notifications n
          LEFT JOIN users u ON u.id=n.user_id JOIN bookings b ON b.id=n.booking_id
          WHERE n.email_status='pending' AND n.next_attempt_at<=?
          ORDER BY 6,1 LIMIT 1`).get(now(),now());
        if (!row) return null;
        const client = row.queue === 'client_notifications';
        const eligible = client ? row.booking_status === 'confirmed'
          : row.verified && ['admin','super_admin'].includes(row.role) && (row.kind !== 'created' || ['pending','confirmed'].includes(row.booking_status));
        if (!eligible) {
          db.prepare(`UPDATE ${row.queue} SET email_status='skipped' WHERE id=?`).run(row.id);
          return { skipped:true };
        }
        // A lease survives process crashes; retries use a stable provider idempotency key.
        db.prepare(`UPDATE ${row.queue} SET attempts=attempts+1,next_attempt_at=? WHERE id=?`).run(now()+60000,row.id);
        return {...row, attempts:row.attempts+1};
      });
      if (!job) break;
      if (job.skipped) continue;
      try {
        await send(job, {...config, signal:controller.signal});
        if (stopped) return;
        db.prepare(`UPDATE ${job.queue} SET email_status='sent',sent_at=?,last_error='' WHERE id=?`).run(now(),job.id);
      } catch {
        if (stopped) return;
        db.prepare(`UPDATE ${job.queue} SET email_status=?,next_attempt_at=?,last_error=? WHERE id=? AND email_status='pending'`)
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
