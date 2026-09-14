const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shapes = {
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>', check: '<path d="m5 12 4 4L19 6"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4M14 10l-2 2"/>',
  wind: '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M4 16h4a3 3 0 1 1-3 3"/>',
  drop: '<path d="M12 3s-7 8-7 12a7 7 0 0 0 14 0c0-4-7-12-7-12Z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
  sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
  leaf: '<path d="M20 3C10 2 3 7 4 14c1 6 9 8 13 2 3-4 3-8 3-13Z"/><path d="M3 22 15 9"/>',
  comb: '<path d="m5 19 14-14 3 3L8 22ZM7 17l-4-4m7 1-4-4m7 1L9 7m7 1-4-4m7 1-4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18m-14 4h2m3 0h2m3 0h1"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-5"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.sparkles}</svg>`;
const state = { services: [], settings: {}, user: null, step: 0, serviceId: null, category: 'All services', date: null, slot: null, slots: [], repeatWeeks: 0, notes: '', route: 'book', adminTab: 'appointments', adminFilter: 'active', bookings: [], devCode: null };
const money = cents => new Intl.NumberFormat('en', { style: 'currency', currency: state.settings.currency || 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const service = () => state.services.find(s => s.id === state.serviceId);
const dateLabel = (date, options = {}) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'long', ...options }).format(new Date(`${date}T12:00:00`));
const dayAfter = (date, days) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const duration = m => m >= 60 ? `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
let toastTimer, availabilityRequest = 0, modalReturnFocus;

async function api(path, method = 'GET', data) {
  const response = await fetch(`/api${path}`, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
  return result;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5500); }
function updateNav() {
  document.querySelectorAll('[data-nav]').forEach(a => { const current = a.dataset.nav === state.route; a.classList.toggle('active', current); current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  $('#account-nav').innerHTML = state.user ? `<a class="account-link" href="#appointments">${icon('calendar')}<span>My visits</span></a><button class="avatar" data-action="account" aria-label="Your account">${esc(state.user.name.slice(0, 1))}</button>` : `<button class="button button-outline" data-action="login">Sign in <span aria-hidden="true">↗</span></button>`;
}
function render() {
  const focused = document.activeElement;
  const focusSelector = focused?.dataset.action ? Object.entries(focused.dataset)
    .filter(([key]) => key !== 'busy')
    .map(([key, value]) => `[data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}="${CSS.escape(value)}"]`).join('') : null;
  updateNav();
  const main = $('#main');
  if (state.route === 'book') main.innerHTML = bookingPage();
  if (state.route === 'services') main.innerHTML = servicesPage();
  if (state.route === 'studio') main.innerHTML = studioPage();
  if (state.route === 'appointments') main.innerHTML = appointmentsPage();
  if (state.route === 'admin') main.innerHTML = adminPage();
  if (!$('#modal').open && focusSelector) {
    const replacement = $(focusSelector);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
}
function heading(eyebrow, title, text) { return `<div class="page-heading"><p class="eyebrow"><span class="small-line"></span>${eyebrow}</p><h1>${title}</h1><p class="heading-description">${text}</p></div>`; }
function bookingPage() {
  return `<section class="booking-page page-enter">${heading('A LITTLE TIME, JUST FOR YOU', 'Your next good <em>hair day.</em>', 'A fresh cut. A new color. A moment to yourself. Let’s make it happen.')}
    <div class="booking-layout"><section class="booking-panel" aria-label="Book an appointment">
      <ol class="stepper">${['Your service', 'Date & time', 'Your details', 'Confirm'].map((label, i) => `<li class="${i === state.step ? 'current' : i < state.step ? 'done' : ''}"><button data-action="step" data-step="${i}" ${i >= state.step ? 'disabled' : ''} ${i === state.step ? 'aria-current="step"' : ''}><span class="step-number">${i < state.step ? icon('check') : i + 1}</span><span>${label}</span></button></li>`).join('')}</ol>
      <div class="step-body step-enter" id="step-content">${[serviceStep, timeStep, detailsStep, confirmStep][state.step]()}</div>
      ${state.step < 2 ? `<div class="booking-bottom"><span class="subtle">${state.step === 0 ? `${icon('clock')} A little self-care, in a few simple steps` : `${icon('shield')} Your time is held when you book`}</span><button class="button button-primary" data-action="next" ${state.step === 0 ? (!service() ? 'disabled' : '') : (!state.slot ? 'disabled' : '')}>${state.step === 0 ? 'Choose date & time' : 'Your details'} ${icon('arrow')}</button></div>` : ''}
    </section>${summaryCard()}</div>
    <div class="booking-promises"><span>${icon('leaf')} Thoughtful care, always</span><span>${icon('shield')} A secure, personal experience</span><span>${icon('repeat')} Your routine, made easy</span></div>
  </section>`;
}
function serviceStep() {
  const filtered = state.services.filter(s => state.category === 'All services' || s.category === state.category);
  return `<div class="section-title"><div><p class="eyebrow">01 / THE GOOD PART</p><h2>What brings you in?</h2><p>Choose a little something for your hair.</p></div><span class="small-label">Made for you ${icon('sparkles')}</span></div>
    <div class="category-tabs" role="group" aria-label="Filter services">${['All services', 'Cut & style', 'Color', 'Treatments'].map(c => `<button class="${state.category === c ? 'selected' : ''}" data-action="category" data-value="${esc(c)}" aria-pressed="${state.category === c}">${c}</button>`).join('')}</div>
    <div class="service-grid">${filtered.map(s => serviceCard(s)).join('')}</div>
    <p class="pricing-note">${icon('sun')} Need a time outside our usual hours? We have options for that, too.</p>`;
}
function serviceCard(s, catalog = false) {
  return `<button class="service-card ${state.serviceId === s.id && !catalog ? 'selected' : ''}" data-action="${catalog ? 'pick-service' : 'service'}" data-id="${s.id}" ${catalog ? '' : `aria-pressed="${state.serviceId === s.id}"`}>
    <span class="service-card-top"><span class="service-icon">${icon(s.icon)}</span>${catalog ? icon('arrow') : `<span class="radio-circle">${state.serviceId === s.id ? icon('check') : ''}</span>`}</span>
    <h3>${esc(s.name)}</h3><p>${esc(s.description)}</p><span class="service-meta"><span>${icon('clock')}${duration(s.duration)}</span><strong>${money(s.price)}</strong></span>
  </button>`;
}
function summaryCard() {
  const s = service();
  return `<aside class="booking-aside"><div class="studio-photo"><img class="salon-photo" src="https://images.unsplash.com/photo-1600948836101-f9ffda59d250?auto=format&fit=crop&w=900&q=85" alt="Warm, light-filled salon interior with mirrors and styling chairs"/><span class="photo-label">A GOOD PLACE TO FEEL GOOD</span><img class="photo-brand" src="/brand/logos/logo-mark-white.png" width="172" height="140" alt="" aria-hidden="true"/><div class="photo-caption">Come as you are.<br><em>Leave a little lighter.</em></div></div>
    <div class="visit-summary"><p class="eyebrow">YOUR LITTLE MOMENT</p><h3>${s ? esc(s.name) : 'Let’s make time for you.'}</h3>${s ? `<div class="summary-line"><span>${icon('clock')} Time just for you</span><span>${duration(s.duration)}</span></div>${state.slot ? `<div class="summary-line"><span>${icon('calendar')}${dateLabel(state.date, { month: 'short' })}</span><span>${state.slot.time}</span></div>` : '<p class="summary-hint">Next, we’ll find your perfect time.</p>'}${state.repeatWeeks ? `<div class="summary-line"><span>${icon('repeat')} Your routine</span><span>Every ${state.repeatWeeks} week${state.repeatWeeks > 1 ? 's' : ''}</span></div>` : ''}<div class="summary-total"><span>${state.slot?.outside ? 'Outside-hours price' : 'Your total'}</span><strong>${money(state.slot?.price ?? s.price)}</strong></div><p class="pay-note">Pay at the salon. A little less to think about.</p>` : `<p>Choose your service and we’ll take care of the next steps. It’s that simple.</p><div class="summary-divider"></div><div class="empty-summary">${icon('scissors')} Your fresh start is a few clicks away.</div>`}</div>
    <div class="aside-note">${icon('shield')}<div><strong>A familiar face, a simpler booking.</strong><p>Your first ${state.settings.requiredApprovals} visits are reviewed by our team${state.settings.autoApprove ? '. After that, booking gets even easier.' : ', with personal approval for every appointment.'}</p></div></div>
  </aside>`;
}
function timeStep() {
  const regular = state.slots.filter(s => !s.outside), outside = state.slots.filter(s => s.outside);
  return `<div class="section-title"><div><p class="eyebrow">02 / MAKE SOME SPACE</p><h2>When works for you?</h2><p>Find a moment that fits into your day.</p></div></div>
    <div class="date-heading"><strong>${dateLabel(state.date, { weekday: undefined, day: undefined, month: 'long', year: 'numeric' })}</strong><label class="date-picker-label">${icon('calendar')} Pick a date <input type="date" aria-label="Choose appointment date" id="date-picker" min="${state.today}" max="${dayAfter(state.today, 90)}" value="${state.date}"/></label></div>
    <div class="date-strip">${Array.from({ length: 7 }, (_, i) => { const d = dayAfter(state.date < dayAfter(state.today, 6) ? state.today : state.date, i); return `<button data-action="date" data-date="${d}" class="date-pill ${d === state.date ? 'selected' : ''}" aria-pressed="${d === state.date}" ${d > dayAfter(state.today, 90) ? 'disabled' : ''}><span>${dateLabel(d, { day: undefined, month: undefined, weekday: 'short' })}</span><strong>${Number(d.slice(-2))}</strong></button>`; }).join('')}</div>
    <p class="slot-heading">${icon('sun')} During salon hours <span>${money(service().price)}</span></p><div class="time-grid">${regular.length ? regular.map(slotButton).join('') : '<p class="empty-slots">No regular-hour times on this day. Try another date.</p>'}</div>
    ${outside.length ? `<details class="outside-times" ${state.slot?.outside ? 'open' : ''}><summary><span>${icon('clock')} A little outside the usual hours</span><span>${money(service().outside_price)} <span class="chevron">⌄</span></span></summary><p>${state.settings.outsideApproval ? 'These visits need a quick approval from our team.' : 'Outside-hours visits use the booking approval rules.'} The price includes your outside-hours appointment.</p><div class="time-grid">${outside.map(slotButton).join('')}</div></details>` : ''}
    <div class="repeat-option"><span class="repeat-icon">${icon('repeat')}</span><div><strong>Make it your regular thing</strong><p>One visit at a time. Your next is booked after you come in.</p></div><select id="repeat-weeks" aria-label="Repeat appointment">${[0, 1, 2, 4, 6, 8].map(w => `<option value="${w}" ${w === state.repeatWeeks ? 'selected' : ''}>${w ? `Every ${w} week${w > 1 ? 's' : ''}` : 'Just this once'}</option>`).join('')}</select></div><p class="timezone-note">All appointment times are in ${esc(state.settings.timezone)}.</p>`;
}
function slotButton(s) { return `<button class="time-slot ${state.slot?.time === s.time ? 'selected' : ''}" data-action="time" data-time="${s.time}" ${!s.available ? 'disabled' : ''} aria-pressed="${state.slot?.time === s.time}">${s.time}${!s.available ? '<span class="sr-only"> unavailable</span>' : ''}</button>`; }
function detailsStep() {
  return `<div class="section-title"><div><p class="eyebrow">03 / NICE TO MEET YOU</p><h2>Let’s make it personal.</h2><p>A few details, so we’re ready to welcome you.</p></div></div>
    ${!state.user ? `<div class="account-gate"><span class="gate-icon">${icon('user')}</span><h3>Your good hair days start here.</h3><p>Create an account and verify your email to book.<br>Already part of the studio? Welcome back.</p><button class="button button-primary" data-action="register">Create an account ${icon('arrow')}</button><p class="signin-caption">Already have an account? <button class="text-button" data-action="login">Sign in</button></p><span class="gate-assurance">${icon('shield')} Your details stay private and secure.</span></div>` : !state.user.verified ? `<div class="account-gate"><span class="gate-icon">${icon('mail')}</span><h3>One small step: verify your email.</h3><p>Confirm ${esc(state.user.email)} to book your visit.</p><button class="button button-primary" data-action="verify-open">Verify email ${icon('arrow')}</button></div>` : `<form id="details-form" class="details-form"><div class="verified-banner">${icon('shield')} Email verified <span>${esc(state.user.email)}</span></div><div class="field-grid"><label>Full name<input name="name" autocomplete="name" value="${esc(state.user.name)}" required minlength="2" maxlength="100" placeholder="Your full name"/></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" value="${esc(state.user.phone)}" required placeholder="+381 …"/></label></div><label>Anything we should know? <span class="optional">Optional</span><textarea name="notes" maxlength="1000" rows="4" placeholder="Your hair goals, preferences, or anything that helps us make your visit feel like you.">${esc(state.notes)}</textarea></label><p class="form-error" id="form-error" role="alert"></p><div class="form-footer"><button type="button" class="text-button" data-action="step" data-step="1">← Back</button><button class="button button-primary" type="submit">Review your visit ${icon('arrow')}</button></div></form>`}`;
}
function confirmStep() {
  const pending = !state.settings.autoApprove || state.user.approvals < state.settings.requiredApprovals || (state.slot.outside && state.settings.outsideApproval);
  return `<div class="section-title"><div><p class="eyebrow">04 / SEE YOU SOON</p><h2>A little time, all yours.</h2><p>One last look, and you’re on your way.</p></div></div>
    <div class="review-service"><span class="service-icon">${icon(service().icon)}</span><div><h3>${esc(service().name)}</h3><p>${duration(service().duration)} · ${state.slot.outside ? 'Outside salon hours' : 'During salon hours'}</p></div><strong>${money(state.slot.price)}</strong></div>
    <dl class="review-list"><div><dt>Your moment</dt><dd>${dateLabel(state.date)} at ${state.slot.time}</dd></div><div><dt>Booked for</dt><dd>${esc(state.user.name)}</dd></div><div><dt>Email</dt><dd>${esc(state.user.email)}</dd></div><div><dt>Phone</dt><dd>${esc(state.user.phone)}</dd></div><div><dt>Your routine</dt><dd>${state.repeatWeeks ? `Every ${state.repeatWeeks} week${state.repeatWeeks > 1 ? 's' : ''}` : 'Just this once'}</dd></div>${state.notes ? `<div><dt>A little note</dt><dd>${esc(state.notes)}</dd></div>` : ''}</dl>
    <div class="info-box">${icon(pending ? 'clock' : 'check')}<div><strong>${pending ? 'A quick check from our team.' : 'You’re ready for instant confirmation.'}</strong><p>${pending ? 'We’ll review your request. Check My visits for your confirmation before coming in.' : 'Your appointment will be confirmed as soon as you book.'} Payment is at the salon.</p></div></div>
    ${state.repeatWeeks ? '<p class="fine-print">Your next visit is created after this one is completed, subject to availability and approval. If the price changes, the repeat pauses for you to book again. Cancelling a visit also stops its repeats.</p>' : ''}
    <div class="form-footer"><button class="text-button" data-action="step" data-step="2">← Back</button><button class="button button-primary" data-action="book">${pending ? 'Request appointment' : 'Confirm appointment'} ${icon('arrow')}</button></div>`;
}
function servicesPage() { return `<section class="content-page page-enter">${heading('THOUGHTFUL HAIR, BEAUTIFULLY DONE', 'Find your <em>fresh start.</em>', 'Considered cuts, expressive color, and care that goes a little deeper.')}<div class="catalog-grid">${state.services.map(s => serviceCard(s, true)).join('')}</div><div class="info-box">${icon('sun')}<div><strong>A little flexibility for your schedule.</strong><p>Outside-hours appointments are available by request, with the price shown before you book.</p></div></div></section>`; }
function studioPage() { return `<section class="content-page page-enter">${heading('WELCOME TO ERD', 'A space to feel <em>like you.</em>', 'Good hair begins with a little care. And a little time to slow down.')}<div class="studio-layout"><img class="studio-large" src="https://images.unsplash.com/photo-1600948836101-f9ffda59d250?auto=format&fit=crop&w=1200&q=85" alt="An inviting salon interior"/><div class="studio-story"><p class="eyebrow">LESS RUSH. MORE YOU.</p><h2>A good conversation.<br>A thoughtful cut.<br>A fresh perspective.</h2><p>We believe your appointment should feel as good as your hair looks. A chance to settle in, tell us what you have in mind, and leave feeling a little more yourself.</p><h3>Our usual hours</h3><div class="hours-list">${state.settings.shifts.map(s => `<div><span>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.day]}</span><span>${s.open ? `${s.start} – ${s.end}` : 'Closed'}</span></div>`).join('')}</div><p class="fine-print">Times shown in ${esc(state.settings.timezone)}.${state.settings.allowOutside ? ' Need something outside these hours? Explore available requests when booking.' : ''}</p><a class="button button-primary" href="#book">Make time for you ${icon('arrow')}</a></div></div></section>`; }
function appointmentsPage() {
  return `<section class="content-page page-enter">${heading('YOUR TIME AT ERD', 'A little something to <em>look forward to.</em>', 'Your upcoming moment, and all the good hair days before it.')}${!state.user ? `<div class="empty-state">${icon('calendar')}<h2>Your visits live here.</h2><p>Sign in to see your appointments and manage your routine.</p><button class="button button-primary" data-action="login">Sign in ${icon('arrow')}</button></div>` : !state.bookings.length ? `<div class="empty-state">${icon('calendar')}<h2>Your first good hair day is waiting.</h2><p>Choose a service, find your time, and we’ll take it from there.</p><a class="button button-primary" href="#book">Book your first visit ${icon('arrow')}</a></div>` : `<div class="appointment-list">${state.bookings.map(b => appointmentCard(b)).join('')}</div>`}</section>`;
}
function appointmentCard(b, admin = false) {
  const active = ['pending', 'confirmed'].includes(b.status);
  return `<article class="appointment-card"><div class="appointment-date"><strong>${Number(b.date.slice(-2))}</strong><span>${dateLabel(b.date, { weekday: undefined, day: undefined, month: 'short' })}</span></div><div class="appointment-info"><div class="appointment-title"><h3>${esc(b.service_name)}</h3><span class="badge badge-${b.status}">${({ pending: 'Awaiting approval', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', declined: 'Declined' })[b.status]}</span></div><p>${dateLabel(b.date)} · ${b.time} · ${duration(b.duration)} · ${money(b.price)}${b.outside ? ' · Outside hours' : ''}</p>${admin ? `<p><strong>${esc(b.name)}</strong> · ${esc(b.email)} · ${esc(b.phone)}</p><p class="fine-print">${b.approvals} previous manual approval${b.approvals === 1 ? '' : 's'}${b.notes ? ` · Note: ${esc(b.notes)}` : ''}</p>` : ''}${b.repeat_weeks ? `<p class="repeat-caption">${icon('repeat')} Repeats every ${b.repeat_weeks} week${b.repeat_weeks > 1 ? 's' : ''}</p>` : ''}${b.recurrence_note ? `<p class="recurrence-note">${esc(b.recurrence_note)}</p>` : ''}</div><div class="appointment-actions">${admin && b.status === 'pending' ? `<button class="button button-primary button-small" data-action="booking-action" data-id="${b.id}" data-value="approve">Approve</button><button class="text-button danger" data-action="booking-action" data-id="${b.id}" data-value="decline">Decline</button>` : admin && b.status === 'confirmed' ? `<button class="button button-outline button-small" data-action="booking-action" data-id="${b.id}" data-value="complete" ${b.ends_at > Date.now() ? 'disabled title="Available after the appointment ends"' : ''}>Mark complete</button>` : ''}${active ? `<button class="text-button subtle" data-action="cancel-open" data-id="${b.id}">Cancel${b.repeat_weeks ? ' & stop repeats' : ' visit'}</button>` : ''}</div></article>`;
}
function adminPage() {
  if (state.user?.role !== 'admin') return `<section class="content-page">${heading('THE SALON WORKSPACE', 'A little behind <em>the scenes.</em>', 'Sign in with your salon administrator account to manage appointments.')}<button class="button button-primary" data-action="login">Admin sign in ${icon('arrow')}</button></section>`;
  const data = state.admin;
  if (!data) return '<div class="initial-loading">Loading your salon…</div>';
  const pending = data.bookings.filter(b => b.status === 'pending').length;
  const confirmed = data.bookings.filter(b => b.status === 'confirmed').length;
  return `<section class="content-page admin-page page-enter">${heading('THE SALON WORKSPACE', 'Behind the <em>good hair days.</em>', 'A clear view of your appointments. A little less admin.')}<div class="admin-stats"><div><span>Awaiting your approval</span><strong>${pending}<small> requests</small></strong></div><div><span>Upcoming appointments</span><strong>${confirmed}<small> confirmed</small></strong></div><div><span>Automatic approval</span><strong class="stat-text">${data.settings.autoApprove ? `After ${data.settings.requiredApprovals} approvals` : 'Turned off'}</strong></div></div>
    <div class="admin-tabs">${['appointments', 'hours', 'prices', 'rules'].map(t => `<button data-action="admin-tab" data-tab="${t}" class="${state.adminTab === t ? 'selected' : ''}">${({ appointments: 'Appointments', hours: 'Working hours', prices: 'Services & prices', rules: 'Booking rules' })[t]}</button>`).join('')}</div>
    ${state.adminTab === 'appointments' ? `<div class="admin-filter"><h2>Your appointment book</h2><select id="admin-filter" aria-label="Filter appointments">${['active', 'pending', 'confirmed', 'all'].map(f => `<option value="${f}" ${state.adminFilter === f ? 'selected' : ''}>${({ active: 'Active visits', pending: 'Awaiting approval', confirmed: 'Confirmed', all: 'All visits' })[f]}</option>`).join('')}</select><button class="text-button" data-action="refresh-admin">Refresh ↻</button></div><div class="appointment-list">${(() => { const bookings = data.bookings.filter(b => state.adminFilter === 'all' || (state.adminFilter === 'active' ? ['pending', 'confirmed'].includes(b.status) : b.status === state.adminFilter)).sort((a,b) => a.starts_at - b.starts_at); return bookings.length ? bookings.map(b => appointmentCard(b, true)).join('') : '<div class="empty-state"><h3>A little breathing room.</h3><p>No appointments here at the moment.</p></div>'; })()}</div>` : state.adminTab === 'hours' ? hoursForm() : state.adminTab === 'prices' ? pricesForm() : rulesForm()}
    </section>`;
}
function hoursForm() {
  const s = state.admin.settings;
  return `<form id="hours-form" class="admin-form"><h2>Your working week</h2><p>Clients can book a full service within these shifts. Times are in ${esc(s.timezone)}. Existing appointments keep their agreed time and price.</p><div class="shift-grid">${s.shifts.map(day => `<div class="shift-row"><label class="switch-label"><input type="checkbox" name="open-${day.day}" ${day.open ? 'checked' : ''}/><span>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day.day]}</span></label><input type="time" name="start-${day.day}" value="${day.start}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day.day]} start" required/><span>to</span><input type="time" name="end-${day.day}" value="${day.end}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day.day]} end" required/></div>`).join('')}</div><h3>A little outside the usual hours</h3><label class="switch-label"><input type="checkbox" name="allowOutside" ${s.allowOutside ? 'checked' : ''}/>Allow requests outside working shifts, including closed days</label><div class="field-grid"><label>Earliest request time<input type="time" name="outsideStart" value="${s.outsideStart}" required/></label><label>Latest finish time<input type="time" name="outsideEnd" value="${s.outsideEnd}" required/></label></div><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary">Save working hours ${icon('check')}</button></form>`;
}
function pricesForm() { return `<form id="prices-form" class="admin-form"><h2>Thoughtful services. Clear prices.</h2><p>Prices are in ${state.settings.currency}. New prices apply to new bookings. Repeats pause if their price changes.</p><div class="price-table"><div class="price-table-head"><span>Service</span><span>In hours</span><span>Outside hours</span></div>${state.admin.services.map(s => `<div class="price-row"><div><strong>${esc(s.name)}</strong><span>${duration(s.duration)}</span></div><label class="price-input"><span>€</span><input name="price-${s.id}" type="number" min="0" max="10000" step="0.01" value="${s.price / 100}" aria-label="${esc(s.name)} regular price" required/></label><label class="price-input"><span>€</span><input name="outside-${s.id}" type="number" min="0" max="10000" step="0.01" value="${s.outside_price / 100}" aria-label="${esc(s.name)} outside-hours price" required/></label></div>`).join('')}</div><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary">Save prices ${icon('check')}</button></form>`; }
function rulesForm() { const s = state.admin.settings; return `<form id="rules-form" class="admin-form"><h2>Booking, your way.</h2><p>A few simple rules keep your appointment book feeling manageable.</p><label class="rule-setting"><div><strong>Automatically approve returning clients</strong><p>After the required number of manual approvals, future appointments are confirmed instantly. Turn this off to review every request.</p></div><input type="checkbox" name="autoApprove" ${s.autoApprove ? 'checked' : ''}/></label><label class="rule-setting"><div><strong>Manual approvals before automatic booking</strong><p>Default: 2 approvals per client. Set to 0 to auto-approve from the first visit.</p></div><input type="number" name="requiredApprovals" min="0" max="20" value="${s.requiredApprovals}" required/></label><label class="rule-setting"><div><strong>Always review outside-hours requests</strong><p>Even regular clients need your approval for visits outside your working shifts.</p></div><input type="checkbox" name="outsideApproval" ${s.outsideApproval ? 'checked' : ''}/></label><div class="info-box">${icon('shield')}<div><strong>A simple foundation.</strong><p>Every client needs a verified email and can have one active visit. Repeats create the next visit after completion and follow these same rules. Changes apply to new requests.</p></div></div><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary">Save booking rules ${icon('check')}</button></form>`; }

function openModal(content) {
  const dialog = $('#modal');
  if (!dialog.open) modalReturnFocus = document.activeElement;
  dialog.innerHTML = `<button class="modal-close" data-action="modal-close" aria-label="Close dialog">${icon('close')}</button>${content}`;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('input, .button', dialog)?.focus());
}
function closeModal() { $('#modal').close(); modalReturnFocus?.focus(); }
function authModal(mode = 'login') {
  state.authMode = mode;
  const create = mode === 'register';
  openModal(`<img class="modal-mark" src="/brand/logos/logo-stacked-black.png" width="401" height="203" alt="ERD hair design"/><p class="eyebrow">${create ? 'MAKE YOURSELF AT HOME' : 'GOOD TO SEE YOU AGAIN'}</p><h2 id="modal-title">${create ? 'Your fresh start.' : 'Welcome back.'}</h2><p class="modal-description">${create ? 'A few details now. Good hair days ahead.' : 'Sign in and make a little time for yourself.'}</p><form id="auth-form">${create ? '<label>Full name<input name="name" autocomplete="name" required minlength="2" maxlength="100" placeholder="Your full name"/></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" required placeholder="Your phone number"/></label>' : ''}<label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"/></label><label>Password<input name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required ${create ? 'minlength="12"' : ''} maxlength="200" placeholder="${create ? 'At least 12 characters' : 'Your password'}"/></label><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width">${create ? 'Create account' : 'Sign in'} ${icon('arrow')}</button></form><p class="modal-switch">${create ? 'Already part of the studio?' : 'Your first time here?'} <button class="text-button" data-action="${create ? 'login' : 'register'}">${create ? 'Sign in' : 'Create an account'}</button></p>`);
}
function verifyModal() {
  openModal(`<span class="gate-icon">${icon('mail')}</span><p class="eyebrow">ONE LITTLE CHECK</p><h2 id="modal-title">Check your inbox.</h2><p class="modal-description">Enter the six-digit code for <strong>${esc(state.user.email)}</strong>. It’s valid for 10 minutes.</p>${state.devCode ? `<div class="dev-email"><strong>Local preview · no email sent</strong><p>Your test verification code is <b>${esc(state.devCode)}</b>.</p></div>` : ''}<form id="verify-form"><label>Verification code<input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000"/></label><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width">Verify email ${icon('check')}</button></form><p class="modal-switch">Need a new code? <button class="text-button" data-action="resend">Send again</button></p>`);
}
async function loadSlots() {
  const request = ++availabilityRequest;
  const result = await api(`/availability?service=${encodeURIComponent(state.serviceId)}&date=${state.date}`);
  if (request !== availabilityRequest) return;
  state.slots = result.slots;
  if (state.slot) state.slot = state.slots.find(s => s.time === state.slot.time && s.available) || null;
}
async function route() {
  state.route = ['book', 'services', 'studio', 'appointments', 'admin'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'book';
  if (state.route === 'appointments' && state.user) state.bookings = (await api('/bookings')).bookings;
  if (state.route === 'admin' && state.user?.role === 'admin') state.admin = await api('/admin/dashboard');
  render();
}
async function afterAuth() {
  if (state.user && !state.user.verified) { verifyModal(); render(); return; }
  closeModal();
  if (state.authIntent === 'admin') { state.authIntent = null; location.hash = 'admin'; }
  await route();
}
async function action(button) {
  const a = button.dataset.action;
  if (a === 'category') { state.category = button.dataset.value; render(); }
  if (a === 'service' || a === 'pick-service') { state.serviceId = button.dataset.id; state.slot = null; state.step = 0; if (a === 'pick-service') { location.hash = 'book'; } render(); }
  if (a === 'next') { if (state.step === 0) await loadSlots(); state.step++; render(); $('#step-content').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  if (a === 'step') { state.step = Number(button.dataset.step); if (state.step === 1) await loadSlots(); render(); }
  if (a === 'date') { state.date = button.dataset.date; state.slot = null; await loadSlots(); render(); }
  if (a === 'time') { state.slot = state.slots.find(s => s.time === button.dataset.time); render(); }
  if (a === 'login' || a === 'register') authModal(a);
  if (a === 'modal-close') closeModal();
  if (a === 'verify-open') verifyModal();
  if (a === 'resend') { const result = await api('/auth/resend', 'POST', {}); state.devCode = result.devCode; verifyModal(); toast(state.devCode ? 'A new local verification code is ready.' : 'A new code is on its way.'); }
  if (a === 'account') openModal(`<p class="eyebrow">YOUR LITTLE CORNER</p><h2 id="modal-title">Hello, ${esc(state.user.name.split(' ')[0])}.</h2><p class="modal-description">${esc(state.user.email)} · ${state.user.verified ? 'Verified' : 'Not yet verified'}</p><div class="account-menu"><a class="button button-outline" href="#appointments" data-action="modal-close">${icon('calendar')} My visits</a>${!state.user.verified ? '<button class="button button-outline" data-action="verify-open">Verify email</button>' : ''}${state.user.role === 'admin' ? '<a class="button button-outline" href="#admin" data-action="modal-close">Salon workspace ↗</a>' : ''}<button class="text-button" data-action="logout">Sign out</button></div>`);
  if (a === 'logout') { await api('/auth/logout', 'POST', {}); state.user = null; state.devCode = null; state.bookings = []; state.admin = null; if (state.step > 2) state.step = 2; closeModal(); await route(); toast('You’re signed out. See you soon.'); }
  if (a === 'admin-entry') { if (state.user?.role === 'admin') location.hash = 'admin'; else { state.authIntent = 'admin'; authModal(); } }
  if (a === 'book') {
    const { booking } = await api('/bookings', 'POST', { serviceId: state.serviceId, date: state.date, time: state.slot.time, repeatWeeks: state.repeatWeeks, notes: state.notes, expectedPrice: state.slot.price });
    state.step = 0; state.serviceId = null; state.slot = null; state.repeatWeeks = 0; state.notes = '';
    location.hash = 'appointments';
    openModal(`<span class="success-circle">${icon('check')}</span><p class="eyebrow">A LITTLE TIME FOR YOU</p><h2 id="modal-title">${booking.status === 'pending' ? 'Your request is in.' : 'It’s a date.'}</h2><p class="modal-description">${booking.status === 'pending' ? 'Our team will review your appointment. You can follow its status in My visits.' : 'Your appointment is confirmed. We look forward to seeing you.'}</p><div class="success-detail"><strong>${esc(booking.service_name)}</strong><span>${dateLabel(booking.date)} · ${booking.time}</span><span>${money(booking.price)} · Pay at the salon</span></div><button class="button button-primary full-width" data-action="modal-close">Lovely, thank you ${icon('check')}</button>`);
  }
  if (a === 'cancel-open') openModal(`<p class="eyebrow">A CHANGE OF PLANS</p><h2 id="modal-title">Cancel this visit?</h2><p class="modal-description">We’ll free up your time for someone else. Any repeat schedule for this visit will stop, too.</p><button class="button button-primary full-width" data-action="booking-action" data-value="cancel" data-id="${button.dataset.id}">Yes, cancel my visit</button><button class="text-button full-width cancel-keep" data-action="modal-close">Keep my appointment</button>`);
  if (a === 'booking-action') { await api(`/bookings/${button.dataset.id}/action`, 'POST', { action: button.dataset.value }); if ($('#modal').open) closeModal(); await route(); toast('Appointment updated.'); }
  if (a === 'admin-tab') { state.adminTab = button.dataset.tab; render(); }
  if (a === 'refresh-admin') { await route(); toast('Your appointment book is up to date.'); }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const anchor = button.tagName === 'A';
  if (!anchor) event.preventDefault();
  if (button.dataset.busy) return;
  button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true');
  try { await action(button); }
  catch (error) { const field = $('#modal').open ? $('#modal-error') : $('#form-error'); if (field) field.textContent = error.message; toast(error.message); }
  finally { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'date-picker') { const date = event.target.value; if (date < state.today || date > dayAfter(state.today, 90)) throw new Error('Choose a date within the next 90 days.'); state.date = date; state.slot = null; await loadSlots(); render(); }
    if (event.target.id === 'repeat-weeks') { state.repeatWeeks = Number(event.target.value); render(); }
    if (event.target.id === 'admin-filter') { state.adminFilter = event.target.value; render(); }
  } catch (error) { toast(error.message); }
});
document.addEventListener('input', event => { if (event.target.name === 'notes') state.notes = event.target.value; });
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, submit = $('button[type="submit"], button.button-primary', form);
  if (submit?.disabled) return;
  if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
  const data = Object.fromEntries(new FormData(form));
  const errorField = $('.form-error', form); if (errorField) errorField.textContent = '';
  try {
    if (form.id === 'auth-form') { const result = await api(`/auth/${state.authMode}`, 'POST', data); state.user = result.user; state.devCode = result.devCode; if (result.emailError) toast(result.emailError); await afterAuth(); }
    if (form.id === 'verify-form') { const result = await api('/auth/verify', 'POST', data); state.user = result.user; state.devCode = null; await afterAuth(); toast('Email verified. You’re ready to book.'); }
    if (form.id === 'details-form') { state.user = (await api('/profile', 'PATCH', data)).user; state.notes = data.notes; state.step = 3; render(); }
    if (form.id === 'hours-form' || form.id === 'rules-form') {
      const s = structuredClone(state.admin.settings);
      if (form.id === 'hours-form') { s.allowOutside = data.allowOutside === 'on'; s.outsideStart = data.outsideStart; s.outsideEnd = data.outsideEnd; s.shifts = s.shifts.map(d => ({ day: d.day, open: data[`open-${d.day}`] === 'on', start: data[`start-${d.day}`], end: data[`end-${d.day}`] })); }
      else { s.autoApprove = data.autoApprove === 'on'; s.outsideApproval = data.outsideApproval === 'on'; s.requiredApprovals = Number(data.requiredApprovals); }
      state.settings = (await api('/admin/settings', 'PUT', s)).settings; await route(); toast('Your settings have been saved.');
    }
    if (form.id === 'prices-form') { state.services = (await api('/admin/prices', 'PUT', { services: state.admin.services.map(s => ({ id: s.id, price: Math.round(Number(data[`price-${s.id}`]) * 100), outside_price: Math.round(Number(data[`outside-${s.id}`]) * 100) })) })).services; await route(); toast('Your prices have been saved.'); }
  } catch (error) { const current = $('#modal').open ? $('#modal-error') : $('#form-error'); if (current) current.textContent = error.message; else toast(error.message); }
  finally { if (submit) { submit.disabled = false; submit.removeAttribute('aria-busy'); } }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
window.addEventListener('hashchange', () => { route().catch(e => toast(e.message)); window.scrollTo({ top: 0, behavior: 'smooth' }); });
$('#year').textContent = new Date().getFullYear();
try { Object.assign(state, await api('/bootstrap')); state.date = state.today; await route(); }
catch (error) { $('#main').innerHTML = `<div class="empty-state"><h1>We’ll be right with you.</h1><p>${esc(error.message)}</p><a class="button button-primary" href="/">Try again</a></div>`; }
