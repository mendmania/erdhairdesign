import { randomUUID } from 'node:crypto';
import { demand } from './booking.mjs';
import { transaction } from './store.mjs';
import { OWNER_EMAIL, isSuperAdmin } from './roles.mjs';

export function setAdmin(db, actor, email, role) {
  demand(isSuperAdmin(actor), 'Only the super admin can manage administrators.', 403);
  demand(typeof email === 'string' && email.length <= 254, 'Enter the registered email address.');
  email = email.trim().toLowerCase();
  demand(email !== OWNER_EMAIL, 'The super-admin account cannot be removed or demoted.', 403);
  demand(['admin', 'client'].includes(role), 'Choose admin or client access.');
  return transaction(db, () => {
    const user = db.prepare('SELECT id,verified FROM users WHERE email = ?').get(email);
    demand(user, 'This person must register an account first.', 404);
    demand(user.verified, 'This person must verify their email first.');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    return { ok: true };
  });
}
const validDate = date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date+'T12:00:00Z')) && new Date(date+'T12:00:00Z').toISOString().slice(0,10) === date;
export function addVacation(db, input) {
  demand(validDate(input.startDate) && validDate(input.endDate) && input.startDate <= input.endDate, 'Choose valid dates, with the end on or after the start.');
  demand(typeof input.label === 'string' && input.label.trim().length <= 100, 'Use a time-off label of at most 100 characters.');
  return transaction(db, () => {
    demand(!db.prepare('SELECT id FROM vacations WHERE start_date <= ? AND end_date >= ?').get(input.endDate, input.startDate), 'This overlaps an existing time-off period.', 409);
    const conflicts = db.prepare("SELECT count(*) AS n FROM bookings WHERE date BETWEEN ? AND ? AND status IN ('pending','confirmed')").get(input.startDate, input.endDate).n;
    demand(!conflicts, `${conflicts} active appointment(s) fall in this period. Resolve them in Appointments before adding time off.`, 409);
    demand(db.prepare('SELECT count(*) AS n FROM vacations').get().n < 200, 'Remove old time-off periods before adding more.');
    const id = randomUUID();
    db.prepare('INSERT INTO vacations VALUES (?,?,?,?)').run(id,input.startDate,input.endDate,input.label.trim() || 'Time off');
    return db.prepare('SELECT * FROM vacations WHERE id = ?').get(id);
  });
}
export function saveService(db, id, input) {
  demand(typeof input.name === 'string' && input.name.trim().length >= 2 && input.name.trim().length <= 100, 'Service name must be 2–100 characters.');
  demand(typeof input.description === 'string' && input.description.trim().length <= 300, 'Description must be 300 characters or fewer.');
  demand(Number.isInteger(input.duration) && input.duration >= 15 && input.duration <= 480 && input.duration % 15 === 0, 'Duration must be 15–480 minutes, in 15-minute steps.');
  for (const price of [input.price,input.outside_price]) demand(Number.isInteger(price) && price >= 0 && price <= 1000000, 'Prices must be between 0 and 10,000.');
  demand(['Cut & style','Color','Treatments'].includes(input.category), 'Choose a service category.');
  for (const [key, limit] of [['name_sq',100],['description_sq',300]]) demand(input[key] === undefined || (typeof input[key] === 'string' && input[key].trim().length <= limit), 'Albanian service text is too long or invalid.');
  return transaction(db, () => {
    if (id) demand(db.prepare('SELECT id FROM services WHERE id = ? AND active = 1').get(id), 'Service not found.', 404);
    else demand(db.prepare('SELECT count(*) AS n FROM services WHERE active = 1').get().n < 30, 'Keep the menu to 30 services or fewer.');
    const icon = ({'Cut & style':'scissors',Color:'drop',Treatments:'leaf'})[input.category];
    const values = [input.name.trim(), input.description.trim(), input.duration, input.price, input.outside_price, input.category, icon];
    if (id) db.prepare('UPDATE services SET name=?,description=?,duration=?,price=?,outside_price=?,category=?,icon=? WHERE id=?').run(...values,id);
    else { id=randomUUID();db.prepare('INSERT INTO services (name,description,duration,price,outside_price,category,icon,id) VALUES (?,?,?,?,?,?,?,?)').run(...values,id); }
    if (input.name_sq !== undefined) db.prepare('UPDATE services SET name_sq=? WHERE id=?').run(input.name_sq.trim(),id);
    if (input.description_sq !== undefined) db.prepare('UPDATE services SET description_sq=? WHERE id=?').run(input.description_sq.trim(),id);
    return db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  });
}
export function removeService(db, id) {
  demand(db.prepare('UPDATE services SET active = 0 WHERE id = ? AND active = 1').run(id).changes, 'Service not found.', 404);
  return { ok: true };
}
