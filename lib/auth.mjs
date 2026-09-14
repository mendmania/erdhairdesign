import { randomBytes, randomInt, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, demand } from './booking.mjs';

const scrypt = promisify(scryptCallback);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const publicUser = u => u ? { id: u.id, email: u.email, name: u.name, phone: u.phone, verified: !!u.verified, role: u.role, approvals: u.approvals } : null;
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const [salt, key] = stored.split(':');
  const candidate = await scrypt(password, salt, 64);
  return timingSafeEqual(Buffer.from(key, 'hex'), candidate);
}
export function validateDetails(input) {
  demand(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.trim().length <= 100, 'Enter your full name (2–100 characters).');
  demand(typeof input.phone === 'string' && /^[+\d\s().-]{6,30}$/.test(input.phone) && input.phone.replace(/\D/g, '').length >= 6, 'Enter a valid phone number.');
}
export function validateEmail(email) {
  demand(typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email address.');
  return email.trim().toLowerCase();
}
export async function register(db, input) {
  validateDetails(input);
  const email = validateEmail(input.email);
  demand(typeof input.password === 'string' && input.password.length >= 12 && input.password.length <= 200, 'Use a password between 12 and 200 characters.');
  const password = await passwordHash(input.password);
  try {
    db.prepare('INSERT INTO users (id,email,name,phone,password,created_at) VALUES (?,?,?,?,?,?)').run(randomUUID(), email, input.name.trim(), input.phone.trim(), password, Date.now());
  } catch (e) {
    if (e.message.includes('UNIQUE')) throw new AppError('An account already uses this email. Please sign in.', 409);
    throw e;
  }
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}
export function createSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), userId, Date.now() + 7 * 86400000);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return token;
}
export function sessionUser(db, req) {
  const token = req.headers.cookie?.split('; ').find(c => c.startsWith('erd_session='))?.slice(12);
  if (!token) return null;
  return db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id = users.id WHERE sessions.token = ? AND sessions.expires_at > ?').get(hash(token), Date.now()) || null;
}
export async function sendVerification(db, user, { production, apiKey, from, language = 'en' }) {
  const existing = db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  demand(!existing || Date.now() - existing.sent_at >= 60000, 'Please wait a minute before requesting another code.', 429);
  const code = String(randomInt(100000, 1000000));
  if (apiKey) {
    // Keep EMAIL_FROM compatible with both "Name <email>" and a plain address.
    const namedSender = typeof from === 'string' && from.trim().match(/^([^<>]+)\s*<([^<>]+)>$/);
    const sender = { name: namedSender ? namedSender[1].trim() : 'ERD Hair Design', email: namedSender ? namedSender[2].trim() : from?.trim() };
    demand(typeof sender.email === 'string' && sender.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender.email), 'Email delivery has not been configured with a valid sender.', 503);
    let response;
    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sender, to: [{ email: user.email }], subject: language === 'sq' ? 'Kodi juaj i verifikimit ERD' : 'Your ERD verification code', textContent: language === 'sq' ? `Kodi juaj i verifikimit për ERD Hair Design është ${code}. Kodi skadon pas 10 minutash. Nëse nuk e keni kërkuar, mund ta shpërfillni këtë email.` : `Your ERD Hair Design verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.` }), signal: AbortSignal.timeout(15000) });
    } catch { throw new AppError('We could not send your verification email. Please try again shortly.', 503); }
    demand(response.ok, 'We could not send your verification email. Please try again shortly.', 503);
  } else demand(!production, 'Email delivery has not been configured.', 503);
  db.prepare('INSERT INTO verifications VALUES (?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, sent_at=excluded.sent_at, attempts=0')
    .run(user.id, hash(`${user.id}:${code}`), Date.now() + 600000, Date.now());
  // Local development only. Never return or log a verification code in production.
  return !production && !apiKey ? { devCode: code } : {};
}
export function verifyEmail(db, userId, code) {
  demand(typeof code === 'string' && /^\d{6}$/.test(code), 'Enter the six-digit code.');
  const v = db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(userId);
  demand(v && v.expires_at > Date.now() && v.attempts < 5, 'This code has expired or had too many attempts. Request a new one.');
  db.prepare('UPDATE verifications SET attempts = attempts + 1 WHERE user_id = ?').run(userId);
  demand(timingSafeEqual(Buffer.from(v.code, 'hex'), Buffer.from(hash(`${userId}:${code}`), 'hex')), 'That code is not correct. Please try again.');
  db.prepare('UPDATE users SET verified = 1 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM verifications WHERE user_id = ?').run(userId);
}
