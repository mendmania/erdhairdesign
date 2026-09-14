import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAppointments } from '../public/admin-view.js';
const now = Date.parse('2030-01-07T12:00:00Z');
const options = {today:'2030-01-07',now};
const bookings = [
  {id:'done',date:'2030-01-06',starts_at:now-86400000,ends_at:now-82800000,status:'completed',name:'Anna',email:'anna@example.test',phone:'+381 123',service_name:'Cut'},
  {id:'past-request',date:'2030-01-06',starts_at:now-82800000,ends_at:now-79200000,status:'pending',name:'Expired'},
  {id:'finish',date:'2030-01-07',starts_at:now-3600000,ends_at:now,status:'confirmed',name:'Mira',email:'mira@example.test',phone:'+381 456',service_name:'Color'},
  {id:'today',date:'2030-01-07',starts_at:now+3600000,ends_at:now+7200000,status:'pending',name:'Ben',service_name:'Cut',service_name_sq:'Prerje'},
  {id:'future',date:'2030-01-08',starts_at:now+86400000,ends_at:now+90000000,status:'confirmed',name:'Mira',service_name:'Trim'},
  {id:'cancelled',date:'2030-01-07',starts_at:now+4000000,ends_at:now+6000000,status:'cancelled',name:'Cancelled'},
];
const ids = (view,extra={}) => selectAppointments(bookings,{...options,view,...extra}).map(b=>b.id);
test('operational queues distinguish today, future visits and completed-time work',()=>{
  assert.deepEqual(ids('today'),['finish','today']);
  assert.deepEqual(ids('upcoming'),['today','future']);
  assert.deepEqual(ids('complete'),['finish']);
  assert.deepEqual(ids('pending'),['past-request','today']);
});
test('history includes inactive visits newest first without mutating the source',()=>{
  const original=bookings.map(b=>b.id);
  assert.deepEqual(ids('history'),['cancelled','done']);
  assert.deepEqual(bookings.map(b=>b.id),original);
});
test('client and service search combines with the selected queue and date',()=>{
  assert.deepEqual(ids('all',{query:' MIRA ',date:'2030-01-08'}),['future']);
  assert.deepEqual(ids('all',{query:'@example.test'}),['done','finish']);
  assert.deepEqual(ids('all',{query:'+381 456'}),['finish']);
  assert.deepEqual(ids('today',{query:'cut'}),['today']);
  assert.deepEqual(ids('today',{query:'prerje'}),['today']);
  assert.deepEqual(ids('pending',{query:'Mira'}),[]);
});
