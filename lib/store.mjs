import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { OWNER_EMAIL } from './roles.mjs';
import { dirname } from 'node:path';

const bookingSchema = `CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), service_id TEXT NOT NULL REFERENCES services(id),
      service_name TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, duration INTEGER NOT NULL,
      price INTEGER NOT NULL, outside INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','confirmed','completed','cancelled','declined')),
      repeat_weeks INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      recurrence_note TEXT NOT NULL DEFAULT '', manually_approved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`;

export function openStore(path = process.env.DATABASE_PATH || './data/salon.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '', password TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'client',
      approvals INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verifications (
      user_id TEXT PRIMARY KEY REFERENCES users(id), code TEXT NOT NULL,
      expires_at INTEGER NOT NULL, sent_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      duration INTEGER NOT NULL, price INTEGER NOT NULL, outside_price INTEGER NOT NULL,
      category TEXT NOT NULL, icon TEXT NOT NULL
    );
    ${bookingSchema}
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking ON bookings(user_id) WHERE status IN ('pending','confirmed');
    CREATE INDEX IF NOT EXISTS booking_times ON bookings(starts_at, ends_at);
  `);
  if (!db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'active')) db.exec('ALTER TABLE services ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  const addTranslations = !db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'name_sq');
  if (addTranslations) db.exec("ALTER TABLE services ADD COLUMN name_sq TEXT NOT NULL DEFAULT ''; ALTER TABLE services ADD COLUMN description_sq TEXT NOT NULL DEFAULT '';");
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'service_name_sq')) db.exec("ALTER TABLE bookings ADD COLUMN service_name_sq TEXT NOT NULL DEFAULT '';");
  // Older databases required an account for every booking. Rebuild atomically,
  // preserving every column and the indexes before accepting guest reservations.
  if (db.prepare('PRAGMA table_info(bookings)').all().find(c => c.name === 'user_id').notnull) {
    transaction(db, () => {
      db.exec(bookingSchema.replace('IF NOT EXISTS bookings', 'bookings_with_guests'));
      db.exec("ALTER TABLE bookings_with_guests ADD COLUMN service_name_sq TEXT NOT NULL DEFAULT ''");
      const columns = db.prepare('PRAGMA table_info(bookings)').all().map(c => c.name).join(',');
      db.exec(`INSERT INTO bookings_with_guests (${columns}) SELECT ${columns} FROM bookings;
        DROP TABLE bookings;
        ALTER TABLE bookings_with_guests RENAME TO bookings;
        CREATE UNIQUE INDEX one_active_booking ON bookings(user_id) WHERE status IN ('pending','confirmed');
        CREATE INDEX booking_times ON bookings(starts_at, ends_at);`);
    });
  }
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'guest_name')) {
    transaction(db, () => db.exec(`
      ALTER TABLE bookings ADD COLUMN guest_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE bookings ADD COLUMN guest_phone TEXT NOT NULL DEFAULT '';
      ALTER TABLE bookings ADD COLUMN created_by TEXT REFERENCES users(id);
    `));
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_preferences (id INTEGER PRIMARY KEY CHECK(id=1), language TEXT NOT NULL DEFAULT 'sq');
    INSERT OR IGNORE INTO notification_preferences (id,language) VALUES (1,'sq');
    CREATE TABLE IF NOT EXISTS notification_recipients (user_id TEXT PRIMARY KEY REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS booking_events (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL REFERENCES bookings(id),
      kind TEXT NOT NULL CHECK(kind IN ('created','cancelled')), payload TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(booking_id,kind)
    );
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, email_key TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL REFERENCES booking_events(id),
      user_id TEXT NOT NULL REFERENCES users(id), read_at INTEGER,
      email_status TEXT NOT NULL CHECK(email_status IN ('off','pending','sent','skipped','failed')),
      language TEXT NOT NULL DEFAULT 'en', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT NOT NULL DEFAULT '',
      UNIQUE(event_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS notification_inbox ON admin_notifications(user_id,read_at,id);
    CREATE INDEX IF NOT EXISTS notification_outbox ON admin_notifications(email_status,next_attempt_at);
  `);
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'guest_email')) {
    db.exec("ALTER TABLE bookings ADD COLUMN guest_email TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'email_language')) {
    db.exec("ALTER TABLE bookings ADD COLUMN email_language TEXT NOT NULL DEFAULT 'en'");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS client_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email_key TEXT NOT NULL UNIQUE,
    booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id), user_id TEXT REFERENCES users(id),
    payload TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en',
    email_status TEXT NOT NULL CHECK(email_status IN ('pending','sent','skipped','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    sent_at INTEGER, last_error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS client_notification_outbox ON client_notifications(email_status,next_attempt_at);`);
  // Preserve pending jobs when upgrading the account-only confirmation outbox.
  if (db.prepare('PRAGMA table_info(client_notifications)').all().find(c => c.name === 'user_id').notnull) {
    transaction(db, () => {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='client_notifications'").get().sql
        .replace(/CREATE TABLE "?client_notifications"?/, 'CREATE TABLE client_notifications_guests')
        .replace('user_id TEXT NOT NULL REFERENCES', 'user_id TEXT REFERENCES');
      db.exec(`${schema}; INSERT INTO client_notifications_guests SELECT * FROM client_notifications;
        DROP TABLE client_notifications; ALTER TABLE client_notifications_guests RENAME TO client_notifications;
        CREATE INDEX client_notification_outbox ON client_notifications(email_status,next_attempt_at);`);
    });
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS vacations (id TEXT PRIMARY KEY, start_date TEXT NOT NULL, end_date TEXT NOT NULL, label TEXT NOT NULL DEFAULT 'Time off');
    CREATE TRIGGER IF NOT EXISTS protect_owner_delete BEFORE DELETE ON users
      WHEN lower(OLD.email) = '${OWNER_EMAIL}' BEGIN SELECT RAISE(ABORT, 'The super-admin account cannot be removed'); END;
    CREATE TRIGGER IF NOT EXISTS protect_owner_update BEFORE UPDATE ON users
      WHEN lower(OLD.email) = '${OWNER_EMAIL}' AND (NEW.email != OLD.email OR NEW.id != OLD.id OR (OLD.verified = 1 AND (NEW.role != 'super_admin' OR NEW.verified != 1)))
      BEGIN SELECT RAISE(ABORT, 'The super-admin account is protected'); END;
    CREATE TRIGGER IF NOT EXISTS reserve_super_role_insert BEFORE INSERT ON users
      WHEN NEW.role = 'super_admin' AND (lower(NEW.email) != '${OWNER_EMAIL}' OR NEW.verified != 1)
      BEGIN SELECT RAISE(ABORT, 'Reserved super-admin role'); END;
    CREATE TRIGGER IF NOT EXISTS reserve_super_role_update BEFORE UPDATE ON users
      WHEN NEW.role = 'super_admin' AND (lower(NEW.email) != '${OWNER_EMAIL}' OR NEW.verified != 1)
      BEGIN SELECT RAISE(ABORT, 'Reserved super-admin role'); END;
    CREATE TRIGGER IF NOT EXISTS grant_owner_insert AFTER INSERT ON users
      WHEN lower(NEW.email) = '${OWNER_EMAIL}' AND NEW.verified = 1 AND NEW.role != 'super_admin'
      BEGIN UPDATE users SET role = 'super_admin' WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS grant_owner_verification AFTER UPDATE OF verified ON users
      WHEN lower(NEW.email) = '${OWNER_EMAIL}' AND NEW.verified = 1 AND NEW.role != 'super_admin'
      BEGIN UPDATE users SET role = 'super_admin' WHERE id = NEW.id; END;
  `);
  db.prepare("UPDATE users SET role = 'super_admin' WHERE lower(email) = ? AND verified = 1 AND role != 'super_admin'").run(OWNER_EMAIL);
  const settings = {
    autoApprove: true, requiredApprovals: 2, outsideApproval: true, allowOutside: true,
    outsideStart: '07:00', outsideEnd: '21:00', currency: 'EUR',
    timezone: process.env.SALON_TIMEZONE || 'Europe/Belgrade',
    shifts: [
      { day: 0, open: false, start: '09:00', end: '17:00' },
      { day: 1, open: true, start: '09:00', end: '18:00' },
      { day: 2, open: true, start: '09:00', end: '18:00' },
      { day: 3, open: true, start: '09:00', end: '18:00' },
      { day: 4, open: true, start: '09:00', end: '18:00' },
      { day: 5, open: true, start: '09:00', end: '18:00' },
      { day: 6, open: true, start: '09:00', end: '16:00' },
    ],
  };
  db.prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)').run(JSON.stringify(settings));
  const insert = db.prepare('INSERT OR IGNORE INTO services (id,name,description,duration,price,outside_price,category,icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  [
    ['cut-style', 'Cut & style', 'A fresh shape, a beautiful finish. Entirely you.', 60, 4500, 6000, 'Cut & style', 'scissors'],
    ['blow-dry', 'Signature blow-dry', 'Effortless volume, movement, and a little polish.', 45, 3000, 4000, 'Cut & style', 'wind'],
    ['color', 'Full color', 'Rich, dimensional color, made for your complexion.', 120, 8500, 11000, 'Color', 'drop'],
    ['balayage', 'Balayage', 'Softly blended, sun-kissed color that grows with you.', 180, 14000, 17500, 'Color', 'sparkles'],
    ['treatment', 'Repair & restore', 'Deep nourishment. Softer, stronger, happier hair.', 45, 3500, 5000, 'Treatments', 'leaf'],
    ['mens-cut', 'Men’s cut', 'A considered cut with a clean, tailored finish.', 30, 2500, 3500, 'Cut & style', 'comb'],
  ].forEach(row => insert.run(...row));
  if (addTranslations) {
    const translations = [
      ['cut-style','Cut & style','Prerje dhe stilim','Një formë e re dhe një stil i bukur, vetëm për ju.'],
      ['blow-dry','Signature blow-dry','Tharje dhe stilim','Volum, lëvizje dhe një pamje e kuruar.'],
      ['color','Full color','Ngjyrosje e plotë','Ngjyrë e pasur dhe me dimension, e përshtatur për ju.'],
      ['balayage','Balayage','Balayage','Nuanca të buta e natyrale që rriten bukur me flokët tuaj.'],
      ['treatment','Repair & restore','Trajtim riparues','Ushqim i thellë për flokë më të butë dhe më të fortë.'],
      ['mens-cut','Men’s cut','Prerje për meshkuj','Prerje e kujdesshme me një stil të pastër dhe personal.'],
    ];
    const starterDescriptions = {
      'cut-style':'A fresh shape, a beautiful finish. Entirely you.',
      'blow-dry':'Effortless volume, movement, and a little polish.',
      color:'Rich, dimensional color, made for your complexion.',
      balayage:'Softly blended, sun-kissed color that grows with you.',
      treatment:'Deep nourishment. Softer, stronger, happier hair.',
      'mens-cut':'A considered cut with a clean, tailored finish.',
    };
    for (const [id,name,nameSq,descriptionSq] of translations) db.prepare("UPDATE services SET name_sq=?,description_sq=? WHERE id=? AND name=? AND description=?").run(nameSq,descriptionSq,id,name,starterDescriptions[id]);
  }
  return db;
}

export function settingsFor(db) {
  return JSON.parse(db.prepare('SELECT value FROM settings WHERE id = 1').get().value);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
