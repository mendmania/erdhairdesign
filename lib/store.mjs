import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { OWNER_EMAIL } from './roles.mjs';
import { dirname } from 'node:path';

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
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), service_id TEXT NOT NULL REFERENCES services(id),
      service_name TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL,
      starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, duration INTEGER NOT NULL,
      price INTEGER NOT NULL, outside INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','confirmed','completed','cancelled','declined')),
      repeat_weeks INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
      recurrence_note TEXT NOT NULL DEFAULT '', manually_approved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking ON bookings(user_id) WHERE status IN ('pending','confirmed');
    CREATE INDEX IF NOT EXISTS booking_times ON bookings(starts_at, ends_at);
  `);
  if (!db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'active')) db.exec('ALTER TABLE services ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  const addTranslations = !db.prepare('PRAGMA table_info(services)').all().some(c => c.name === 'name_sq');
  if (addTranslations) db.exec("ALTER TABLE services ADD COLUMN name_sq TEXT NOT NULL DEFAULT ''; ALTER TABLE services ADD COLUMN description_sq TEXT NOT NULL DEFAULT '';");
  if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'service_name_sq')) db.exec("ALTER TABLE bookings ADD COLUMN service_name_sq TEXT NOT NULL DEFAULT '';");
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
