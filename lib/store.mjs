import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
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
  const insert = db.prepare('INSERT OR IGNORE INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  [
    ['cut-style', 'Cut & style', 'A fresh shape, a beautiful finish. Entirely you.', 60, 4500, 6000, 'Cut & style', 'scissors'],
    ['blow-dry', 'Signature blow-dry', 'Effortless volume, movement, and a little polish.', 45, 3000, 4000, 'Cut & style', 'wind'],
    ['color', 'Full color', 'Rich, dimensional color, made for your complexion.', 120, 8500, 11000, 'Color', 'drop'],
    ['balayage', 'Balayage', 'Softly blended, sun-kissed color that grows with you.', 180, 14000, 17500, 'Color', 'sparkles'],
    ['treatment', 'Repair & restore', 'Deep nourishment. Softer, stronger, happier hair.', 45, 3500, 5000, 'Treatments', 'leaf'],
    ['mens-cut', 'Men’s cut', 'A considered cut with a clean, tailored finish.', 30, 2500, 3500, 'Cut & style', 'comb'],
  ].forEach(row => insert.run(...row));
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
