// Keep operational queues consistent across summary cards and the appointment list.
export function selectAppointments(bookings, { view = 'today', today, now = Date.now(), query = '', date = '' }) {
  const search = query.trim().toLowerCase();
  return bookings.filter(b => {
    const active = ['pending', 'confirmed'].includes(b.status);
    const matchesView = view === 'today' ? active && b.date === today
      : view === 'pending' ? b.status === 'pending'
      : view === 'complete' ? b.status === 'confirmed' && b.ends_at <= now
      : view === 'upcoming' ? active && b.starts_at > now
      : view === 'history' ? !active : true;
    return matchesView && (!date || b.date === date) && (!search || [b.name, b.email, b.phone, b.service_name, b.service_name_sq].some(value => String(value || '').toLowerCase().includes(search)));
  }).sort((a, b) => view === 'history' ? b.starts_at - a.starts_at : a.starts_at - b.starts_at);
}
