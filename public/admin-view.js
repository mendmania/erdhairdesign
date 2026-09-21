// Keep operational queues consistent across summary cards and the appointment list.
export function selectAppointments(bookings, { view = 'today', today, now = Date.now(), query = '', date = '' }) {
  return bookings.filter(b => {
    const active = ['pending', 'confirmed'].includes(b.status);
    const matchesView = view === 'today' ? active && b.date === today
      : view === 'pending' ? b.status === 'pending'
      : view === 'complete' ? b.status === 'confirmed' && b.ends_at <= now
      : view === 'upcoming' ? active && b.starts_at > now
      : view === 'history' ? !active : true;
    return matchesView && (!date || b.date === date) && matchesClient(b, query);
  }).sort((a, b) => view === 'history' ? b.starts_at - a.starts_at : a.starts_at - b.starts_at);
}

// Ignore accents and phone formatting so contact details are easy to find.
export function matchesClient(client, query = '') {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const search = normalize(query.trim());
  if (!search) return true;
  if ([client.name, client.email, client.phone, client.service_name, client.service_name_sq].some(value => normalize(value).includes(search))) return true;
  const digits = search.replace(/\D/g, '');
  return /^[+\d\s().-]+$/.test(search) && digits.length >= 3 && String(client.phone || '').replace(/\D/g, '').includes(digits);
}
