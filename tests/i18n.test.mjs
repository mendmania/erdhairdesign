import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h,t,setLanguage,getLanguage,formatDate } from '../public/i18n.js';
import { openStore } from '../lib/store.mjs';
import { saveService } from '../lib/admin.mjs';
import { createBooking } from '../lib/booking.mjs';

test('English and Albanian labels switch in both directions with a safe fallback',()=>{
  setLanguage('sq');assert.equal(t('Sign in'),'Hyni');assert.equal(h('<button>Sign in</button>'),'<button>Hyni</button>');
  assert.match(formatDate('2030-09-14'),/shtator/);
  setLanguage('en');assert.equal(h('<button>Sign in</button>'),'<button>Sign in</button>');
  setLanguage('unsupported');assert.equal(getLanguage(),'en');assert.equal(t('Custom salon text'),'Custom salon text');
});
test('localization preserves opaque user values, canonical form values, and escaped markup',()=>{
  setLanguage('sq');
  assert.equal(h`<p>Hello, ${'Sign in'}.</p>`,'<p>Përshëndetje, Sign in.</p>');
  assert.equal(h`<p>Hello, ${'&lt;script&gt;'}.</p>`,'<p>Përshëndetje, &lt;script&gt;.</p>');
  assert.equal(h`<input name="category" value="${'Color'}" aria-label="Category"/>`,'<input name="category" value="Color" aria-label="Kategoria"/>');
  assert.equal(h`<span>Every ${2} week${'s'}</span>`,'<span>Çdo 2 javë</span>');
  assert.equal(h`<span>${'Keep {0} and \uE0009\uE001 unchanged'}</span>`,'<span>Keep {0} and \uE0009\uE001 unchanged</span>');
  setLanguage('en');
});
test('validation and recurring appointment messages are translated without changing stored messages',()=>{
  setLanguage('sq');
  assert.equal(t('The email or password is incorrect.'),'Emaili ose fjalëkalimi nuk është i saktë.');
  assert.match(t('2 active appointment(s) fall in this period. Resolve them in Appointments before adding time off.'),/^2 termine aktive/);
  assert.match(t('Repeat paused: Choose an available service.'),/^Përsëritja u ndal: Zgjidhni/);
  setLanguage('en');
});
test('services retain both languages and appointments snapshot the Albanian name', t=>{
  const db=openStore(':memory:');t.after(()=>db.close());
  const service=db.prepare("SELECT * FROM services WHERE id='cut-style'").get();
  assert.equal(service.name_sq,'Prerje dhe stilim');
  saveService(db,service.id,{...service,name_sq:'Prerje e shkurtër',description_sq:'Përshkrim në shqip'});
  const now=Date.parse('2030-01-06T12:00:00Z');
  db.prepare('INSERT INTO users(id,email,name,password,verified,created_at) VALUES(?,?,?,?,?,?)').run('u','u@example.test','Test Client','unused',1,now);
  const b=createBooking(db,'u',{serviceId:service.id,date:'2030-01-07',time:'09:00',repeatWeeks:0,notes:'User text',expectedPrice:4500},now);
  assert.equal(b.service_name,service.name);assert.equal(b.service_name_sq,'Prerje e shkurtër');
  saveService(db,service.id,{...service,name_sq:'Emër i ndryshuar'});
  assert.equal(db.prepare('SELECT service_name_sq FROM bookings WHERE id=?').get(b.id).service_name_sq,'Prerje e shkurtër');
  assert.throws(()=>saveService(db,service.id,{...service,name_sq:'x'.repeat(101)}),/Albanian/);
});
