import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/store.mjs';
import { hash, sendVerification, verifyEmail } from '../lib/auth.mjs';

function fixture(t) {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const user = { id: 'email-test', email: 'client@example.test' };
  db.prepare('INSERT INTO users (id, email, name, password, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, user.email, 'Test Client', 'unused', Date.now());
  return { db, user };
}
const config = { production: true, apiKey: 'test-api-key-only', from: 'ERD Hair Design <bookings@example.test>' };

test('Brevo receives the API key, sender, recipient and usable verification code without exposing it to the client', async t => {
  const { db, user } = fixture(t);
  let deliveredCode;
  const send = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['api-key'], config.apiKey);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(options.body);
    assert.deepEqual(payload.sender, { name: 'ERD Hair Design', email: 'bookings@example.test' });
    assert.deepEqual(payload.to, [{ email: user.email }]);
    assert.equal(payload.subject, 'Your ERD verification code');
    deliveredCode = payload.textContent.match(/code is (\d{6})/)[1];
    assert.match(payload.textContent, /10 minutes/);
    return new Response(JSON.stringify({ messageId: 'test-message' }), { status: 201 });
  });
  assert.deepEqual(await sendVerification(db, user, config), {});
  assert.equal(send.mock.callCount(), 1);
  assert.equal(db.prepare('SELECT code FROM verifications WHERE user_id = ?').get(user.id).code, hash(`${user.id}:${deliveredCode}`));
  verifyEmail(db, user.id, deliveredCode);
  assert.equal(db.prepare('SELECT verified FROM users WHERE id = ?').get(user.id).verified, 1);
});

test('a plain sender address is supported and configured development sends through Brevo', async t => {
  const { db, user } = fixture(t);
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body).sender, { name: 'ERD Hair Design', email: 'bookings@example.test' });
    return new Response('{}', { status: 201 });
  });
  assert.deepEqual(await sendVerification(db, user, { ...config, production: false, from: 'bookings@example.test' }), {});
});

test('Brevo rejection preserves an existing code and does not start a new cooldown', async t => {
  const { db, user } = fixture(t);
  db.prepare('INSERT INTO verifications VALUES (?, ?, ?, ?, 0)').run(user.id, hash('previous-code'), Date.now() + 600000, 0);
  const previous = db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'private provider detail' }), { status: 401 }));
  await assert.rejects(sendVerification(db, user, config), { status: 503, message: 'We could not send your verification email. Please try again shortly.' });
  assert.deepEqual(db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id), previous);
});

test('network failures are recoverable without leaking credentials or generating a valid code', async t => {
  const { db, user } = fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('private network detail'); });
  await assert.rejects(sendVerification(db, user, config), { status: 503, message: 'We could not send your verification email. Please try again shortly.' });
  assert.equal(db.prepare('SELECT * FROM verifications WHERE user_id = ?').get(user.id), undefined);
});

test('an invalid sender is rejected before any provider request', async t => {
  const { db, user } = fixture(t);
  const send = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(sendVerification(db, user, { ...config, from: 'not-an-email' }), { status: 503 });
  assert.equal(send.mock.callCount(), 0);
});

test('only unconfigured local development returns a test code', async t => {
  const { db, user } = fixture(t);
  const send = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  await assert.rejects(sendVerification(db, user, { production: true, apiKey: '' }), { status: 503 });
  const result = await sendVerification(db, user, { production: false, apiKey: '' });
  assert.match(result.devCode, /^\d{6}$/);
  assert.equal(send.mock.callCount(), 0);
});
