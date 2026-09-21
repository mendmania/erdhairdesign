import { pages, pagePath, adminPath, legacyPath } from './routes.js?v=20260921-notifications';
import { h, t, getLanguage, setLanguage, locale, formatDate } from './i18n.js?v=20260921-notifications';
import { selectAppointments } from './admin-view.js?v=20260921-notifications';
try { setLanguage(localStorage.getItem('erd-language') || (navigator.language.startsWith('sq') ? 'sq' : 'en')); } catch {}
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
const icon = (name, cls = '') => h`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.sparkles}</svg>`;
const state = { services: [], settings: {}, user: null, step: 0, serviceId: null, category: 'All services', date: null, slot: null, slots: [], repeatWeeks: 0, notes: '', route: 'book', adminTab: 'appointments', adminFilter: 'today', adminQuery: '', adminDate: '', bookings: [], notifications: {items:[],unreadCount:0}, devCode: null };
const money = cents => new Intl.NumberFormat(locale(), { style: 'currency', currency: state.settings.currency || 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const isStaff = () => state.user?.verified && ['admin', 'super_admin'].includes(state.user.role);
const isOwner = () => isStaff() && state.user.role === 'super_admin';
const serviceName = s => getLanguage() === 'sq' && s.name_sq ? s.name_sq : s.name;
const serviceDescription = s => getLanguage() === 'sq' && s.description_sq ? s.description_sq : s.description;
const bookingName = b => getLanguage() === 'sq' && b.service_name_sq ? b.service_name_sq : b.service_name;
const service = () => state.services.find(s => s.id === state.serviceId);
const dateLabel = formatDate;
const dayAfter = (date, days) => { const d = new Date(h`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const duration = m => m >= 60 ? h`${Math.floor(m / 60)} hr${m % 60 ? h` ${m % 60} min` : ''}` : h`${m} min`;
let toastTimer, availabilityRequest = 0, modalReturnFocus, renderedRoute, renderedStep, renderedLanguage, accountMarkup, routeRequest = 0;
const motion = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
function focusBookingStep() { const title = $('#step-content h2'); title?.setAttribute('tabindex', '-1'); title?.focus({preventScroll:true}); $('#booking-panel')?.scrollIntoView({behavior:motion(),block:'start'}); }

async function api(path, method = 'GET', data) {
  const response = await fetch(h`/api${path}`, { method, headers: { 'Accept-Language': getLanguage(), ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(t(result.error || 'Something went wrong. Please try again.'));
  return result;
}
function toast(message) { $('#toast').textContent = t(message); $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5500); }
function updateNav() {
  document.documentElement.lang = getLanguage();
  document.title = getLanguage() === 'sq' ? 'ERD Hair Design — Pak kohë për ju' : 'ERD Hair Design — A little time for you';
  document.querySelectorAll('[data-i18n]').forEach(el => { el.dataset.i18nSource ||= el.innerHTML; const copy = h(el.dataset.i18nSource); if (el.innerHTML !== copy) el.innerHTML = copy; });
  document.querySelectorAll('[data-i18n-label]').forEach(el => el.setAttribute('aria-label', t(el.dataset.i18nLabel)));
  document.querySelectorAll('[data-nav]').forEach(a => { const current = a.dataset.nav === state.route; a.classList.toggle('active', current); current ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  const account = languageControl() + (state.user ? h`${isStaff() ? h`<a class="account-link workspace-link" href="/admin">Workspace ${notificationCount()}</a>` : ''}<a class="account-link" href="/appointments">${icon('calendar')}<span>My visits</span></a><button class="avatar" data-action="account" aria-label="Your account">${esc(state.user.name.slice(0, 1))}</button>` : h`<button class="button button-outline" data-action="login">Sign in <span aria-hidden="true">↗</span></button>`);
  if (account !== accountMarkup) { $('#account-nav').innerHTML = account; accountMarkup = account; }
}
function languageControl() { return `<label class="language-control"><span class="sr-only">${t('Language')}</span><select id="language-select" aria-label="${t('Language')}"><option value="en" ${getLanguage() === 'en' ? 'selected' : ''}>English</option><option value="sq" ${getLanguage() === 'sq' ? 'selected' : ''}>Shqip</option></select></label>`; }
function updateBooking(html, selectionOnly) {
  const template = document.createElement('template'); template.innerHTML = html;
  const fresh = template.content;
  const oldStep = $('#step-content');
  const sameStep = renderedStep === state.step;
  const openDetails = sameStep ? [...oldStep.querySelectorAll('details[open]')].map(el => el.className) : [];
  const dateScroll = oldStep.querySelector('.date-strip')?.scrollLeft || 0;
  const selectors = selectionOnly ? ['.visit-summary', '.selection-total'] : ['.stepper', '#step-content', '.booking-bottom', '.visit-summary', '.aside-note'];
  for (const selector of selectors) {
    const old = $(selector), next = fresh.querySelector(selector);
    if (selector === '#step-content' && sameStep) next.classList.remove('step-enter');
    if (old && next) { if (old.outerHTML !== next.outerHTML) old.replaceWith(next); }
    else if (old) old.remove();
    else if (next && selector === '.booking-bottom') $('#booking-panel').append(next);
  }
  if (selectionOnly) {
    document.querySelectorAll('.time-slot').forEach(el => { const selected = el.dataset.time === state.slot?.time; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', String(selected)); });
    const next = $('[data-action="next"]'); if (next) next.disabled = !state.slot || state.slotsLoading;
  } else if (sameStep) {
    for (const cls of openDetails) $('#step-content details.' + CSS.escape(cls))?.setAttribute('open', '');
    const dates = $('#step-content .date-strip'); if (dates) dates.scrollLeft = dateScroll;
  }
}
function render({ selectionOnly = false } = {}) {
  const focused = document.activeElement;
  const focusSelector = focused?.id ? '#' + CSS.escape(focused.id) : focused?.dataset.action ? Object.entries(focused.dataset)
    .filter(([key]) => key !== 'busy')
    .map(([key, value]) => h`[data-${key.replace(/[A-Z]/g, c => h`-${c.toLowerCase()}`)}="${CSS.escape(value)}"]`).join('') : null;
  updateNav();
  const main = $('#main');
  if (state.route === 'book') {
    if (renderedRoute === 'book' && renderedLanguage === getLanguage() && $('#booking-panel')) updateBooking(bookingPage(), selectionOnly);
    else main.innerHTML = bookingPage();
  }
  if (state.route === 'services') main.innerHTML = servicesPage();
  if (state.route === 'studio') main.innerHTML = studioPage();
  if (state.route === 'appointments') main.innerHTML = appointmentsPage();
  if (state.route === 'admin') {
    const template = document.createElement('template'); template.innerHTML = adminPage();
    const old = main.querySelector('.admin-page'), next = template.content.querySelector('.admin-page');
    if (old && next && renderedLanguage === getLanguage()) {
      const children = [...next.children];
      children.forEach((child, i) => { const previous = old.children[i]; if (previous?.outerHTML !== child.outerHTML) { if (previous) previous.replaceWith(child); else old.append(child); } });
      while (old.children.length > children.length) old.lastElementChild.remove();
    } else main.replaceChildren(template.content);
  }
  // Animate navigation, not every time or date selection.
  if (renderedRoute === state.route) main.querySelector('.page-enter')?.classList.remove('page-enter');
  if (renderedRoute === state.route && renderedStep === state.step) main.querySelector('.step-enter')?.classList.remove('step-enter');
  renderedRoute = state.route; renderedStep = state.step; renderedLanguage = getLanguage();
  if (!$('#modal').open && focusSelector) {
    const replacement = $(focusSelector);
    if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
  }
}
function heading(eyebrow, title, text) { return h`<div class="page-heading"><p class="eyebrow"><span class="small-line"></span>${eyebrow}</p><h1>${title}</h1><p class="heading-description">${text}</p></div>`; }
function bookingPage() {
  return h`<section class="booking-page page-enter">${heading(t('HAIR. CARE. YOU.'), h('Good hair.<br><em>Zero fuss.</em>'), h('Choose a service. Pick your time. We’ll take care of the rest.'))}
    <div class="booking-layout"><section class="booking-panel" id="booking-panel" aria-label="Book an appointment">
      <ol class="stepper">${[h('Service'), h('Time'), h('Details'), h('Book')].map((label, i) => h`<li class="${i === state.step ? 'current' : i < state.step ? 'done' : ''}"><button data-action="step" data-step="${i}" ${i >= state.step ? 'disabled' : ''} ${i === state.step ? 'aria-current="step"' : ''}><span class="step-number">${i < state.step ? icon('check') : i + 1}</span><span>${label}</span></button></li>`).join('')}</ol>
      <div class="step-body step-enter" id="step-content">${[serviceStep, timeStep, detailsStep, confirmStep][state.step]()}</div>
      ${state.step === 1 ? h`<div class="booking-bottom"><button class="button button-outline" data-action="step" data-step="0">← Back</button><div class="selection-total" aria-live="polite"><strong>${state.slot ? state.slot.time + ' · ' + money(state.slot.price) : h('Choose a time')}</strong><span>Pay at the salon</span></div><button class="button button-primary" data-action="next" ${!state.slot || state.slotsLoading ? 'disabled' : ''}>Continue ${icon('arrow')}</button></div>` : ''}
    </section>${summaryCard()}</div>
    <div class="booking-promises"><span>${icon('shield')} Verified accounts. Personal care.</span><span>${icon('clock')} Pay at the salon</span></div>
  </section>`;
}
function serviceStep() {
  const filtered = state.services.filter(s => state.services.length <= 6 || state.category === 'All services' || s.category === state.category);
  return h`<div class="section-title"><div><p class="eyebrow">01 / YOUR SERVICE</p><h2>Choose your service.</h2><p>Tap a service to see available times.</p></div></div>
    ${state.services.length > 6 ? h`<div class="category-tabs" role="group" aria-label="Filter services">${['All services', 'Cut & style', 'Color', 'Treatments'].map(c => h`<button class="${state.category === c ? 'selected' : ''}" data-action="category" data-value="${esc(c)}" aria-pressed="${state.category === c}">${t(c)}</button>`).join('')}</div>` : ''}
    <div class="service-grid">${filtered.map(s => serviceCard(s)).join('') || h('<p class="empty-slots">No services available here yet. Please check back soon.</p>')}</div>
    <p class="pricing-note">${icon('shield')} Sign in and verify your email before confirming your booking.</p>`;
}
function serviceCard(s, catalog = false) {
  return h`<button class="service-card ${state.serviceId === s.id && !catalog ? 'selected' : ''}" data-action="${catalog ? 'pick-service' : 'service'}" data-id="${s.id}">
    <span class="service-card-top"><span class="service-icon">${icon(s.icon)}</span>${icon('arrow')}</span>
    <h3>${esc(serviceName(s))}</h3><p>${esc(serviceDescription(s))}</p><span class="service-meta"><span>${icon('clock')}${duration(s.duration)}</span><strong>${money(s.price)}</strong></span>
  </button>`;
}
function summaryCard() {
  const s = service();
  return h`<aside class="booking-aside"><div class="studio-photo"><img class="salon-photo" src="https://images.unsplash.com/photo-1600948836101-f9ffda59d250?auto=format&fit=crop&w=900&q=85" alt="Warm, light-filled salon interior with mirrors and styling chairs"/><span class="photo-label">A GOOD PLACE TO FEEL GOOD</span><img class="photo-brand" src="/brand/logos/logo-mark-white.png" width="172" height="140" alt="" aria-hidden="true"/><div class="photo-caption">Come as you are.<br><em>Leave a little lighter.</em></div></div>
    <div class="visit-summary"><p class="eyebrow">YOUR LITTLE MOMENT</p><h3>${s ? esc(serviceName(s)) : h('Let’s make time for you.')}</h3>${s ? h`<div class="summary-line"><span>${icon('clock')} Time just for you</span><span>${duration(s.duration)}</span></div>${state.slot ? h`<div class="summary-line"><span>${icon('calendar')}${dateLabel(state.date, { month: 'short' })}</span><span>${state.slot.time}</span></div>` : h('<p class="summary-hint">Next, we’ll find your perfect time.</p>')}${state.repeatWeeks ? h`<div class="summary-line"><span>${icon('repeat')} Your routine</span><span>Every ${state.repeatWeeks} week${state.repeatWeeks > 1 ? 's' : ''}</span></div>` : ''}<div class="summary-total"><span>${state.slot?.outside ? h('Outside-hours price') : h('Your total')}</span><strong>${money(state.slot?.price ?? s.price)}</strong></div><p class="pay-note">Pay at the salon. A little less to think about.</p>` : h`<p>Choose your service and we’ll take care of the next steps. It’s that simple.</p><div class="summary-divider"></div><div class="empty-summary">${icon('scissors')} Your fresh start is a few clicks away.</div>`}</div>
    <div class="aside-note">${icon('shield')}<div><strong>A familiar face, a simpler booking.</strong><p>Your first ${state.settings.requiredApprovals} visits are reviewed by our team${state.settings.autoApprove ? h('. After that, booking gets even easier.') : h(', with personal approval for every appointment.')}</p></div></div>
  </aside>`;
}
function timeStep() {
  const regular = state.slots.filter(s => !s.outside), outside = state.slots.filter(s => s.outside);
  return h`<div class="section-title"><div><p class="eyebrow">02 / YOUR TIME</p><h2>Pick your time.</h2><p>${esc(serviceName(service()))} · ${duration(service().duration)}</p></div></div>
    <div class="date-heading"><strong>${dateLabel(state.date, { weekday: undefined, day: undefined, month: 'long', year: 'numeric' })}</strong><label class="date-picker-label">${icon('calendar')} Pick a date <input type="date" aria-label="Choose appointment date" id="date-picker" min="${state.today}" max="${dayAfter(state.today, 90)}" value="${state.date}"/></label></div>
    <div class="week-navigation"><button class="button button-outline button-small" data-action="week" data-direction="-1" ${state.date <= state.today ? 'disabled' : ''} aria-label="Previous week">←</button><span>Choose a day</span><button class="button button-outline button-small" data-action="week" data-direction="1" ${state.date >= dayAfter(state.today, 90) ? 'disabled' : ''} aria-label="Next week">→</button></div><div class="date-strip">${Array.from({ length: 7 }, (_, i) => { const d = dayAfter(state.date < dayAfter(state.today, 6) ? state.today : state.date, i); return h`<button data-action="date" data-date="${d}" class="date-pill ${d === state.date ? 'selected' : ''}" aria-pressed="${d === state.date}" ${d > dayAfter(state.today, 90) ? 'disabled' : ''}><span>${dateLabel(d, { day: undefined, month: undefined, weekday: 'short' })}</span><strong>${Number(d.slice(-2))}</strong></button>`; }).join('')}</div>
    ${state.slotsLoading ? h('<p class="availability-status" role="status">Loading available times…</p>') : state.slotsError ? h('<div class="availability-status" role="alert"><p>Could not load times.</p><button class="button button-outline" data-action="retry-slots">Try again</button></div>') : h`<p class="slot-heading">${icon('sun')} During salon hours <span>${money(service().price)}</span></p><div class="time-grid">${regular.some(s => s.available) ? regular.filter(s => s.available).map(slotButton).join('') : h`<p class="empty-slots">${state.closed ? h('The salon is taking time off on this date. Please choose another day.') : h('No regular-hour times on this day. Try another date.')}</p>`}</div>
    ${outside.some(s => s.available) ? h`<details class="outside-times" ${state.slot?.outside ? 'open' : ''}><summary><span>${icon('clock')} A little outside the usual hours</span><span>${money(service().outside_price)} <span class="chevron">⌄</span></span></summary><p>${state.settings.outsideApproval ? h('These visits need a quick approval from our team.') : h('Outside-hours visits use the booking approval rules.')} The price includes your outside-hours appointment.</p><div class="time-grid">${outside.filter(s => s.available).map(slotButton).join('')}</div></details>` : ''}
    `}
    <details class="booking-options" ${state.repeatWeeks ? 'open' : ''}><summary>Repeat this visit <span class="optional">Optional</span>${icon('repeat')}</summary><div class="repeat-option"><span class="repeat-icon">${icon('repeat')}</span><div><strong>Make it your regular thing</strong><p>One visit at a time. Your next is booked after you come in.</p></div><select id="repeat-weeks" aria-label="Repeat appointment">${[0, 1, 2, 4, 6, 8].map(w => h`<option value="${w}" ${w === state.repeatWeeks ? 'selected' : ''}>${w ? h`Every ${w} week${w > 1 ? 's' : ''}` : h('Just this once')}</option>`).join('')}</select></div></details><p class="timezone-note">All appointment times are in ${esc(state.settings.timezone)}.</p>`;
}
function slotButton(s) { return h`<button class="time-slot ${state.slot?.time === s.time ? 'selected' : ''}" data-action="time" data-time="${s.time}" ${!s.available ? 'disabled' : ''} aria-pressed="${state.slot?.time === s.time}">${s.time}${!s.available ? h('<span class="sr-only"> unavailable</span>') : ''}</button>`; }
function detailsStep() {
  return h`<div class="section-title"><div><p class="eyebrow">03 / YOUR DETAILS</p><h2>Your details.</h2><p>A few details, so we’re ready to welcome you.</p></div></div>
    ${!state.user ? h`<div class="account-gate"><span class="gate-icon">${icon('user')}</span><h3>Your good hair days start here.</h3><p>Create an account and verify your email to book.<br>Already part of the studio? Welcome back.</p><button class="button button-primary" data-action="register">Create an account ${icon('arrow')}</button><p class="signin-caption">Already have an account? <button class="text-button" data-action="login">Sign in</button></p><span class="gate-assurance">${icon('shield')} Your details stay private and secure.</span></div>` : !state.user.verified ? h`<div class="account-gate"><span class="gate-icon">${icon('mail')}</span><h3>One small step: verify your email.</h3><p>Confirm ${esc(state.user.email)} to book your visit.</p><button class="button button-primary" data-action="verify-open">Verify email ${icon('arrow')}</button></div>` : h`<form id="details-form" class="details-form"><div class="verified-banner">${icon('shield')} Email verified <span>${esc(state.user.email)}</span></div><div class="field-grid"><label>Full name<input name="name" autocomplete="name" value="${esc(state.detailsDraft?.name ?? state.user.name)}" required minlength="2" maxlength="100" placeholder="Your full name"/></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" value="${esc(state.detailsDraft?.phone ?? state.user.phone)}" required placeholder="+381 …"/></label></div><label>Anything we should know? <span class="optional">Optional</span><textarea name="notes" maxlength="1000" rows="2" placeholder="Your hair goals, preferences, or anything that helps us make your visit feel like you.">${esc(state.notes)}</textarea></label><p class="form-error" id="form-error" role="alert"></p><div class="form-footer"><button type="button" class="text-button" data-action="step" data-step="1">← Back</button><button class="button button-primary" type="submit">Review your visit ${icon('arrow')}</button></div></form>`}`;
}
function confirmStep() {
  const pending = !state.settings.autoApprove || state.user.approvals < state.settings.requiredApprovals || (state.slot.outside && state.settings.outsideApproval);
  return h`<div class="section-title"><div><p class="eyebrow">04 / REVIEW & BOOK</p><h2>Ready when you are.</h2><p>Check your details, then send your booking.</p></div></div>
    <div class="review-service"><span class="service-icon">${icon(service().icon)}</span><div><h3>${esc(serviceName(service()))}</h3><p>${duration(service().duration)} · ${state.slot.outside ? h('Outside salon hours') : h('During salon hours')}</p></div><strong>${money(state.slot.price)}</strong></div>
    <dl class="review-list"><div><dt>Your moment</dt><dd>${dateLabel(state.date)} at ${state.slot.time}</dd></div><div><dt>Booked for</dt><dd>${esc(state.user.name)}</dd></div><div><dt>Email</dt><dd>${esc(state.user.email)}</dd></div><div><dt>Phone</dt><dd>${esc(state.user.phone)}</dd></div><div><dt>Your routine</dt><dd>${state.repeatWeeks ? h`Every ${state.repeatWeeks} week${state.repeatWeeks > 1 ? 's' : ''}` : h('Just this once')}</dd></div>${state.notes ? h`<div><dt>A little note</dt><dd>${esc(state.notes)}</dd></div>` : ''}</dl>
    <div class="info-box">${icon(pending ? 'clock' : 'check')}<div><strong>${pending ? h('A quick check from our team.') : h('You’re ready for instant confirmation.')}</strong><p>${pending ? h('We’ll review your request. Check My visits for your confirmation before coming in.') : h('Your appointment will be confirmed as soon as you book.')} Payment is at the salon.</p></div></div>
    ${state.repeatWeeks ? h('<p class="fine-print">Your next visit is created after this one is completed, subject to availability and approval. If the price changes, the repeat pauses for you to book again. Cancelling a visit also stops its repeats.</p>') : ''}
    <div class="form-footer"><button class="text-button" data-action="step" data-step="2">← Back</button><button class="button button-primary" data-action="book">${pending ? h('Request appointment') : h('Confirm appointment')} ${icon('arrow')}</button></div>`;
}
function servicesPage() { return h`<section class="content-page page-enter">${heading(t('THOUGHTFUL HAIR, BEAUTIFULLY DONE'), h('Find your <em>fresh start.</em>'), h('Considered cuts, expressive color, and care that goes a little deeper.'))}<div class="catalog-grid">${state.services.map(s => serviceCard(s, true)).join('')}</div><div class="info-box">${icon('sun')}<div><strong>A little flexibility for your schedule.</strong><p>Outside-hours appointments are available by request, with the price shown before you book.</p></div></div></section>`; }
function studioPage() { return h`<section class="content-page page-enter">${heading(t('WELCOME TO ERD'), h('A space to feel <em>like you.</em>'), h('Good hair begins with a little care. And a little time to slow down.'))}<div class="studio-layout"><img class="studio-large" src="https://images.unsplash.com/photo-1600948836101-f9ffda59d250?auto=format&fit=crop&w=1200&q=85" alt="An inviting salon interior"/><div class="studio-story"><p class="eyebrow">LESS RUSH. MORE YOU.</p><h2>A good conversation.<br>A thoughtful cut.<br>A fresh perspective.</h2><p>We believe your appointment should feel as good as your hair looks. A chance to settle in, tell us what you have in mind, and leave feeling a little more yourself.</p><h3>Our usual hours</h3><div class="hours-list">${state.settings.shifts.map(s => h`<div><span>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(t)[s.day]}</span><span>${s.open ? h`${s.start} – ${s.end}` : h('Closed')}</span></div>`).join('')}</div><p class="fine-print">Times shown in ${esc(state.settings.timezone)}.${state.settings.allowOutside ? h(' Need something outside these hours? Explore available requests when booking.') : ''}</p><a class="button button-primary" href="/book">Make time for you ${icon('arrow')}</a></div></div></section>`; }
function appointmentsPage() {
  return h`<section class="content-page page-enter">${heading(t('YOUR TIME AT ERD'), h('A little something to <em>look forward to.</em>'), h('Your upcoming moment, and all the good hair days before it.'))}${!state.user ? h`<div class="empty-state">${icon('calendar')}<h2>Your visits live here.</h2><p>Sign in to see your appointments and manage your routine.</p><button class="button button-primary" data-action="login">Sign in ${icon('arrow')}</button></div>` : !state.bookings.length ? h`<div class="empty-state">${icon('calendar')}<h2>Your first good hair day is waiting.</h2><p>Choose a service, find your time, and we’ll take it from there.</p><a class="button button-primary" href="/book">Book your first visit ${icon('arrow')}</a></div>` : h`<div class="appointment-list">${state.bookings.map(b => appointmentCard(b)).join('')}</div>`}</section>`;
}
function appointmentCard(b, admin = false) {
  const active = ['pending', 'confirmed'].includes(b.status);
  return h`<article class="appointment-card"><div class="appointment-date"><strong>${Number(b.date.slice(-2))}</strong><span>${dateLabel(b.date, { weekday: undefined, day: undefined, month: 'short' })}</span></div><div class="appointment-info"><div class="appointment-title"><h3>${esc(bookingName(b))}</h3><span class="badge badge-${b.status}">${({ pending: h('Awaiting approval'), confirmed: h('Confirmed'), completed: h('Completed'), cancelled: h('Cancelled'), declined: h('Declined') })[b.status]}</span></div><p>${dateLabel(b.date)} · ${b.time} · ${duration(b.duration)} · ${money(b.price)}${b.outside ? h(' · Outside hours') : ''}</p>${admin ? h`<p><strong>${esc(b.name)}</strong> · ${esc(b.email)} · ${esc(b.phone)}</p><p class="fine-print">${b.approvals} previous manual approval${b.approvals === 1 ? '' : 's'}${b.notes ? h` · Note: ${esc(b.notes)}` : ''}</p>` : ''}${b.repeat_weeks ? h`<p class="repeat-caption">${icon('repeat')} Repeats every ${b.repeat_weeks} week${b.repeat_weeks > 1 ? 's' : ''}</p>` : ''}${b.recurrence_note ? h`<p class="recurrence-note">${esc(t(b.recurrence_note))}</p>` : ''}</div><div class="appointment-actions">${admin && b.status === 'pending' ? h`<button class="button button-primary button-small" data-action="booking-action" data-id="${b.id}" data-value="approve">Approve</button><button class="text-button danger" data-action="booking-action" data-id="${b.id}" data-value="decline">Decline</button>` : admin && b.status === 'confirmed' ? h`<button class="button button-outline button-small" data-action="booking-action" data-id="${b.id}" data-value="complete" ${b.ends_at > Date.now() ? 'disabled title="Available after the appointment ends"' : ''}>Mark complete</button>` : ''}${active ? h`<button class="text-button subtle" data-action="cancel-open" data-id="${b.id}">Cancel${b.repeat_weeks ? h(' & stop repeats') : h(' visit')}</button>` : ''}</div></article>`;
}
const adminViews = { today: 'Today', pending: 'Requests', complete: 'To complete', upcoming: 'Upcoming', history: 'History', all: 'All visits' };
function adminPage() {
  if (!isStaff()) return h`<section class="content-page">${heading(t('THE SALON WORKSPACE'), h('Salon <em>sign in.</em>'), state.user ? h`Signed in as ${esc(state.user.email)}. Administrator access is required.` : h('Sign in with your salon administrator account.'))}<button class="button button-primary" data-action="login">${state.user ? h('Use another account') : h('Admin sign in')} ${icon('arrow')}</button></section>`;
  const data = state.admin;
  if (!data) return h('<div class="initial-loading">Loading your salon…</div>');
  const today = state.today;
  const shift = data.settings.shifts[new Date(today + 'T12:00:00Z').getUTCDay()];
  const vacation = data.vacations.find(v => v.start_date <= today && v.end_date >= today);
  const counts = Object.fromEntries(['today', 'pending', 'complete', 'upcoming'].map(view => [view, selectAppointments(data.bookings, {view, today}).length]));
  return h`<section class="content-page admin-page page-enter"><header class="workspace-heading"><div><p class="eyebrow">SALON OPERATIONS</p><h1>Salon workspace</h1><p>${dateLabel(today, {year:'numeric'})} <span aria-hidden="true">·</span> ${vacation ? h`Time off: ${esc(vacation.label)}` : shift.open ? h`Open ${shift.start}–${shift.end}` : h('No regular shift today')}</p></div><div class="workspace-heading-actions"><span class="owner-badge">${isOwner() ? h('Super admin') : h('Administrator')}</span><button class="button button-outline button-small" data-action="refresh-admin">${icon('repeat')} Refresh</button></div></header>
    <div class="operations-stats">${[['today',h("Today's visits"),h('Your daily schedule')],['pending',h('Awaiting approval'),h('Review client requests')],['complete',h('Ready to complete'),h('Finish visits & renew repeats')],['upcoming',h('Upcoming'),h('All future active visits')]].map(([view,label,hint]) => h`<button class="operation-stat ${state.adminTab === 'appointments' && state.adminFilter === view ? 'selected' : ''}" data-action="admin-view" data-view="${view}"><span>${label}</span><strong>${counts[view]}</strong><small>${hint} ↗</small></button>`).join('')}</div>
    <nav class="admin-tabs" aria-label="Salon workspace sections">${['appointments', 'hours', 'vacations', 'prices', 'rules', 'notifications', ...(isOwner() ? ['team'] : [])].map(t => h`<button data-action="admin-tab" data-tab="${t}" aria-current="${state.adminTab === t ? 'page' : 'false'}" class="${state.adminTab === t ? 'selected' : ''}">${({ appointments: h('Appointments'), hours: h('Working hours'), vacations: h('Time off'), team: h('Administrators'), prices: h('Services & prices'), rules: h('Booking rules'), notifications: h('Notifications') })[t]}${t === 'notifications' ? notificationCount() : ''}</button>`).join('')}</nav>
    ${state.adminTab === 'appointments' ? adminAppointmentBook() : state.adminTab === 'notifications' ? notificationsPage() : state.adminTab === 'hours' ? hoursForm() : state.adminTab === 'vacations' ? vacationsForm() : state.adminTab === 'prices' ? pricesForm() : state.adminTab === 'team' && isOwner() ? teamForm() : rulesForm()}
    </section>`;
}
function adminAppointmentBook() {
  return h`<section class="operations-book" aria-label="Appointment book"><div class="admin-section-heading"><h2>Appointments</h2><button class="button button-primary" data-action="admin-reserve">Reserve for client +</button></div><div class="operations-filters" role="group" aria-label="Appointment views">${Object.entries(adminViews).map(([view,label]) => h`<button data-action="admin-view" data-view="${view}" aria-pressed="${state.adminFilter === view}" class="${state.adminFilter === view ? 'selected' : ''}">${t(label)}</button>`).join('')}</div><div class="operations-search"><label>Find a client or service<input id="admin-search" type="search" placeholder="Name, email, phone or service" value="${esc(state.adminQuery)}" autocomplete="off"/></label><label>On a specific date<input id="admin-date" type="date" value="${state.adminDate}"/></label><button class="text-button" data-action="admin-clear">Clear filters</button></div><div id="admin-results">${adminResults()}</div></section>`;
}
function adminResults() {
  const bookings = selectAppointments(state.admin.bookings.filter(b => !state.adminBookingId || b.id === state.adminBookingId), {view:state.adminFilter, today:state.today, query:state.adminQuery, date:state.adminDate});
  let date = '';
  return h`<p class="result-count" role="status">${bookings.length} ${bookings.length === 1 ? t('appointment') : t('appointments')} · ${t(adminViews[state.adminFilter])}</p>${bookings.length ? h`<div class="appointment-list">${bookings.map(b => { const heading = b.date !== date ? h`<h3 class="agenda-day">${b.date === state.today ? h('Today · ') : ''}${dateLabel(b.date, {year:'numeric'})}</h3>` : ''; date = b.date; return heading + adminAppointmentCard(b); }).join('')}</div>` : h`<div class="empty-state operations-empty">${icon('calendar')}<h3>${state.adminQuery || state.adminDate ? h('No matching appointments') : state.adminFilter === 'pending' ? h('All requests reviewed') : state.adminFilter === 'complete' ? h('Nothing waiting to be completed') : state.adminFilter === 'today' ? h('Your day is clear') : h('No appointments here')}</h3><p>${state.adminQuery || state.adminDate ? h('Try another search or clear the filters.') : h('Use the views above to check other appointments.')}</p><button class="button button-outline button-small" data-action="admin-view" data-view="all">View all appointments</button></div>`}`;
}
function adminAppointmentCard(b) {
  const expired = b.status === 'pending' && b.starts_at <= Date.now();
  const ready = b.status === 'confirmed' && b.ends_at <= Date.now();
  const active = ['pending','confirmed'].includes(b.status);
  const phone = String(b.phone || '').replace(/[^+0-9]/g, '');
  return h`<article class="operation-appointment"><div class="agenda-time"><strong>${b.time}</strong><span>${duration(b.duration)}</span></div><div class="agenda-detail"><div class="appointment-title"><h3>${esc(b.name)}</h3><span class="badge badge-${b.status}">${expired ? h('Expired request') : ready ? h('Ready to complete') : ({pending:h('Needs approval'),confirmed:h('Confirmed'),completed:h('Completed'),cancelled:h('Cancelled'),declined:h('Declined')})[b.status]}</span></div><p class="agenda-service">${esc(bookingName(b))} <strong>${money(b.price)}</strong>${b.outside ? h(' · Outside hours') : ''}</p><div class="agenda-contact">${phone ? h`<a href="tel:${esc(phone)}">${esc(b.phone)}</a>` : ''}${b.email ? h`<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ''}</div>${b.created_by ? h('<p class="fine-print">Booked by the salon</p>') : ''}${b.notes ? h`<p class="agenda-note"><strong>Client note:</strong> ${esc(b.notes)}</p>` : ''}${b.repeat_weeks ? h`<p class="repeat-caption">${icon('repeat')} Every ${b.repeat_weeks} week${b.repeat_weeks === 1 ? '' : 's'}</p>` : ''}${b.recurrence_note ? h`<p class="recurrence-note">${esc(t(b.recurrence_note))}</p>` : ''}${expired ? h('<p class="agenda-warning">This time has passed. Decline the request so the client can book again.</p>') : ''}${b.status === 'pending' && !expired ? h`<p class="fine-print">${b.approvals} manual approvals so far</p>` : ''}</div><div class="agenda-actions">${b.status === 'pending' ? h`${!expired ? h`<button class="button button-primary button-small" data-action="booking-action" data-id="${b.id}" data-value="approve">Approve ${icon('check')}</button>` : ''}<button class="text-button danger" data-action="admin-decline-open" data-id="${b.id}">Decline request</button>` : ready ? h`<button class="button button-primary button-small" data-action="${b.repeat_weeks ? 'admin-complete-open' : 'booking-action'}" data-id="${b.id}" data-value="complete">Complete visit ${icon('check')}</button>` : b.status === 'confirmed' ? h('<span class="fine-print">Complete after the visit ends</span>') : ''}${active ? h`<button class="text-button subtle" data-action="admin-cancel-open" data-id="${b.id}">Cancel visit</button>` : ''}</div></article>`;
}
async function adminReserveModal() {
  const { clients } = await api('/admin/clients');
  openModal(h`<h2 id="modal-title">Reserve for client</h2><p class="modal-description">Book a request received by phone or message. The appointment is confirmed immediately.</p>
    <form id="admin-reserve-form">
      <label>Client<select name="userId" id="reserve-client"><option value="">Guest (no account)</option>${clients.map(u => h`<option value="${esc(u.id)}">${esc(u.name)} · ${esc(u.phone)} · ${esc(u.email)}</option>`).join('')}</select></label>
      <fieldset id="reserve-guest" class="reserve-guest"><div class="field-grid"><label>Full name<input name="name" minlength="2" maxlength="100" autocomplete="off" required/></label><label>Phone number<input name="phone" type="tel" maxlength="30" autocomplete="off" required/></label></div></fieldset>
      <label>Service<select name="serviceId" id="reserve-service" required>${state.services.map(s => h`<option value="${esc(s.id)}">${esc(serviceName(s))} · ${duration(s.duration)}</option>`).join('')}</select></label>
      <div class="field-grid"><label>Date<input name="date" id="reserve-date" type="date" value="${state.today}" min="${state.today}" max="${dayAfter(state.today, 90)}" required/></label><label>Time<select name="time" id="reserve-time" required disabled><option value="">Choose a time</option></select></label></div>
      <p class="fine-print" id="reserve-status" role="status"></p><button class="text-button" type="button" data-action="reserve-retry" hidden>Try again</button>
      <p class="fine-print">All appointment times are in ${esc(state.settings.timezone)}.</p>
      <label>Notes (optional)<textarea name="notes" maxlength="1000" rows="2"></textarea></label>
      <p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" type="submit" disabled>Confirm reservation</button>
    </form>`);
  await loadReserveSlots();
}
async function loadReserveSlots(form = $('#admin-reserve-form')) {
  if (!form?.isConnected) return;
  const request = (form.slotRequest || 0) + 1; form.slotRequest = request;
  const time = $('#reserve-time'), status = $('#reserve-status'), submit = $('button[type="submit"]', form), retry = $('[data-action="reserve-retry"]', form);
  form.slots = []; time.disabled = true; submit.disabled = true; retry.hidden = true;
  time.innerHTML = h('<option value="">Choose a time</option>'); status.textContent = t('Loading available times…');
  try {
    const result = await api(`/availability?service=${encodeURIComponent(form.elements.serviceId.value)}&date=${encodeURIComponent(form.elements.date.value)}`);
    if (!form.isConnected || request !== form.slotRequest) return;
    form.slots = result.slots.filter(s => s.available);
    time.innerHTML += form.slots.map(s => h`<option value="${s.time}">${s.time} · ${money(s.price)}${s.outside ? h(' · Outside hours') : ''}</option>`).join('');
    time.disabled = !form.slots.length;
    status.textContent = t(result.closed ? 'The salon is taking time off on this date. Please choose another day.' : form.slots.length ? 'Choose a time to review the price and confirm.' : 'No available times. Choose another date or service.');
  } catch (error) {
    if (!form.isConnected || request !== form.slotRequest) return;
    status.textContent = error.message; retry.hidden = false;
  }
}
function notificationCount() {
  return h`<span class="notification-count" ${state.notifications.unreadCount ? '' : 'hidden'} aria-label="${esc(t('Unread notifications'))}: ${state.notifications.unreadCount}">${state.notifications.unreadCount}</span>`;
}
function notificationsPage() {
  const prefs = state.admin.notificationSettings;
  return h`<section class="notifications-page">
    ${isOwner() && prefs ? h`<form id="notification-settings-form" class="admin-form"><h2>Email notifications</h2>
      <p>Only the super admin can choose who receives emails for new reservations and cancellations.</p>
      <p>Select verified administrators below. The person making the change will not receive their own alert. Changes apply to future notifications; deselecting someone also stops their unsent emails.</p>
      ${!prefs.emailConfigured ? h('<p class="info-box">Email delivery is not configured. Notifications stay in the panel and selected emails wait until delivery is configured.</p>') : ''}
      <fieldset class="notification-recipients"><legend>Email recipients</legend>${prefs.recipients.map(u => h`<label class="notification-recipient"><input type="checkbox" id="notification-recipient-${esc(u.id)}" name="recipientIds" value="${esc(u.id)}" ${u.selected ? 'checked' : ''}/><span><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></span></label>`).join('')}</fieldset>
      <p class="fine-print">Leave everyone unselected to turn off booking emails. Add administrators in the Administrators section.</p>
      <label>Email language<select name="language"><option value="en" ${prefs.language === 'en' ? 'selected' : ''}>English</option><option value="sq" ${prefs.language === 'sq' ? 'selected' : ''}>Shqip</option></select></label>
      <div id="notification-delivery-status">${notificationDeliveryStatus(prefs)}</div>
      <p class="form-error" id="form-error" role="alert"></p><button type="submit" class="button button-primary">Save email recipients</button>
    </form>` : ''}
    <div class="notification-feed">${notificationFeed()}</div>
  </section>`;
}
function notificationDeliveryStatus(prefs) {
  return h`<p class="fine-print">Queued emails: ${prefs.pending}. Failed emails: ${prefs.failed}.</p>${prefs.failed ? h('<button type="button" class="text-button" data-action="notification-retry">Retry failed emails</button>') : ''}`;
}
function notificationFeed() {
  const {items,unreadCount} = state.notifications;
  return h`<div class="admin-section-heading"><div><h2>Your notifications ${notificationCount()}</h2><p>New reservations and cancellations. Showing the latest 50.</p></div><button class="button button-outline button-small" data-action="notifications-read" ${!unreadCount ? 'disabled' : ''}>Mark all as read</button></div>
    <div class="notification-list">${items.map(n => h`<article class="notification-item ${n.read_at ? '' : 'unread'}"><div><p class="eyebrow">${n.kind === 'cancelled' ? h('Reservation cancelled') : h('New reservation')}${!n.read_at ? h(' · Unread') : ''}</p><h3>${esc(n.name)}</h3><p>${esc(getLanguage() === 'sq' && n.serviceSq ? n.serviceSq : n.service)} · ${dateLabel(n.date)} · ${n.time}</p><p class="fine-print">${n.kind === 'cancelled' ? h('Cancelled') : n.status === 'pending' ? h('Needs approval') : h('Confirmed')}</p></div><button class="button button-outline button-small" data-action="notification-open" data-id="${n.id}" data-booking="${n.booking_id}">View reservation</button></article>`).join('') || h('<p class="empty-state">No notifications yet.</p>')}</div>`;
}
function updateNotificationDisplay() {
  updateNav();
  document.querySelectorAll('.notification-count').forEach(el => { el.textContent = state.notifications.unreadCount; el.hidden = !state.notifications.unreadCount; el.setAttribute('aria-label', t('Unread notifications') + ': ' + state.notifications.unreadCount); });
  const feed = $('.notification-feed'); if (feed) feed.innerHTML = notificationFeed();
}
async function refreshNotifications() {
  if (!isStaff() || document.hidden) return;
  const userId = state.user.id;
  try {
    const notifications = await api('/admin/notifications');
    if (!isStaff() || state.user.id !== userId) return;
    if (JSON.stringify(notifications) === JSON.stringify(state.notifications)) return;
    state.notifications = notifications;
    updateNotificationDisplay();
  } catch { /* Keep the last successful inbox during temporary network failures. */ }
}
function hoursForm() {
  const s = state.admin.settings;
  return h`<form id="hours-form" class="admin-form"><h2>Your working week</h2><p>Clients can book a full service within these shifts. Times are in ${esc(s.timezone)}. Existing appointments keep their agreed time and price.</p><div class="shift-tools"><button class="button button-outline button-small" type="button" data-action="copy-weekdays">Copy Monday to Tue–Fri</button><span>Then save to apply your changes.</span></div><div class="shift-grid">${s.shifts.map(day => h`<div class="shift-row"><label class="switch-label"><input type="checkbox" name="open-${day.day}" ${day.open ? 'checked' : ''}/><span>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(t)[day.day]}</span></label><input type="time" name="start-${day.day}" value="${day.start}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(t)[day.day]} start" required/><span>to</span><input type="time" name="end-${day.day}" value="${day.end}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(t)[day.day]} end" required/></div>`).join('')}</div><h3>A little outside the usual hours</h3><label class="switch-label"><input type="checkbox" name="allowOutside" ${s.allowOutside ? 'checked' : ''}/>Allow requests outside working shifts, including closed days</label><div class="field-grid"><label>Earliest request time<input type="time" name="outsideStart" value="${s.outsideStart}" required/></label><label>Latest finish time<input type="time" name="outsideEnd" value="${s.outsideEnd}" required/></label></div><p class="form-error" id="form-error" role="alert"></p><div class="admin-save-bar"><span>Changes apply when you save.</span><button class="button button-primary" type="submit">Save working hours ${icon('check')}</button></div></form>`;
}
function pricesForm() {
  return h`<div class="admin-form"><div class="admin-section-heading"><div><h2>Your service menu</h2><p>Add just what you offer. Prices are in ${esc(state.settings.currency)}; changes apply to new bookings.</p></div><button class="button button-primary" data-action="service-edit">Add service +</button></div><div class="admin-items">${state.admin.services.map(s => h`<article class="admin-item"><div><h3>${esc(serviceName(s))}</h3><p>${esc(t(s.category))} · ${duration(s.duration)}</p><p>${money(s.price)} in hours · ${money(s.outside_price)} outside hours</p></div><div class="admin-item-actions"><button class="button button-outline" data-action="service-edit" data-id="${s.id}" aria-label="Edit ${esc(serviceName(s))}">Edit</button><button class="text-button" data-action="service-remove-open" data-id="${s.id}" aria-label="Remove ${esc(serviceName(s))}">Remove</button></div></article>`).join('') || h('<p class="empty-slots">No services yet. Add your first service to open bookings.</p>')}</div></div>`;
}
function serviceEditor(id) {
  const s = state.admin.services.find(s => s.id === id) || {name: '', description: '', duration: 30, price: 2500, outside_price: 3500, category: 'Cut & style'};
  openModal(h`<p class="eyebrow">YOUR SERVICE MENU</p><h2 id="modal-title">${id ? h('Edit service') : h('A new service')}</h2><p class="modal-description">Existing appointments keep their details. Repeats pause if their price changes.</p><form id="service-form"><input type="hidden" name="serviceId" value="${id || ''}"/><label>Service name<input name="name" value="${esc(s.name)}" minlength="2" maxlength="100" required/></label><label>Service name (Albanian)<input name="name_sq" value="${esc(s.name_sq || '')}" maxlength="100"/></label><label>Description (Albanian)<textarea name="description_sq" rows="2" maxlength="300">${esc(s.description_sq || '')}</textarea></label><p class="fine-print">Optional; uses the original text when empty.</p><label>Short description<textarea name="description" rows="2" maxlength="300">${esc(s.description)}</textarea></label><div class="field-grid"><label>Category<select name="category">${['Cut & style', 'Color', 'Treatments'].map(c => h`<option value="${esc(c)}" ${c === s.category ? 'selected' : ''}>${esc(t(c))}</option>`).join('')}</select></label><label>Duration (minutes)<input name="duration" type="number" min="15" max="480" step="15" value="${s.duration}" required/></label></div><div class="field-grid"><label>In-hours price (${esc(state.settings.currency)})<input name="price" type="number" min="0" max="10000" step="0.01" value="${s.price / 100}" required/></label><label>Outside-hours price<input name="outside_price" type="number" min="0" max="10000" step="0.01" value="${s.outside_price / 100}" required/></label></div><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" type="submit">Save service ${icon('check')}</button></form>`);
}
function vacationsForm() {
  return h`<div class="admin-form"><h2>Make room for a break</h2><p>Block a holiday, vacation, or a single day off for the whole salon. Both dates are included. No appointments can be requested during time off, including outside hours.</p><form id="vacation-form"><label>Label<input name="label" maxlength="100" placeholder="Summer vacation"/></label><div class="field-grid"><label>First day off<input name="startDate" type="date" required/></label><label>Last day off<input name="endDate" type="date" required/></label></div><p class="fine-print">Resolve any active appointments in these dates before adding time off.</p><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary" type="submit">Add time off ${icon('check')}</button></form><div class="admin-items">${state.admin.vacations.map(v => h`<article class="admin-item"><div><h3>${esc(v.label)}</h3><p>${dateLabel(v.start_date, {year:'numeric'})}${v.start_date !== v.end_date ? h` – ${dateLabel(v.end_date, {year:'numeric'})}` : ''}</p></div><button class="text-button" data-action="vacation-remove-open" data-id="${v.id}" aria-label="Remove ${esc(v.label)}">Remove</button></article>`).join('') || h('<p class="empty-slots">No time off added yet.</p>')}</div></div>`;
}
function teamForm() {
  return h`<div class="admin-form"><h2>The people behind the salon</h2><p>Your super-admin account is protected. Only you can give or remove administrator access. Administrators manage appointments, the shared salon shifts, time off, services, and booking rules.</p><form id="team-form"><label>Registered email address<input name="email" type="email" maxlength="254" placeholder="name@example.com" required/></label><p class="fine-print">This person must register and verify their email first. After an access change, they need to sign in again.</p><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary" type="submit">Make administrator ${icon('shield')}</button></form><div class="admin-items">${state.admin.admins.map(u => h`<article class="admin-item"><div><h3>${esc(u.name)}</h3><p>${esc(u.email)}</p></div>${u.role === 'super_admin' ? h('<span class="owner-badge">Super admin · Protected</span>') : h`<button class="text-button" data-action="admin-remove-open" data-email="${esc(u.email)}">Remove admin access</button>`}</article>`).join('')}</div></div>`;
}
function rulesForm() { const s = state.admin.settings; return h`<form id="rules-form" class="admin-form"><h2>Booking, your way.</h2><p>A few simple rules keep your appointment book feeling manageable.</p><label class="rule-setting"><div><strong>Automatically approve returning clients</strong><p>After the required number of manual approvals, future appointments are confirmed instantly. Turn this off to review every request.</p></div><input type="checkbox" name="autoApprove" ${s.autoApprove ? 'checked' : ''}/></label><label class="rule-setting"><div><strong>Manual approvals before automatic booking</strong><p>Default: 2 approvals per client. Set to 0 to auto-approve from the first visit.</p></div><input type="number" name="requiredApprovals" min="0" max="20" value="${s.requiredApprovals}" required/></label><label class="rule-setting"><div><strong>Always review outside-hours requests</strong><p>Even regular clients need your approval for visits outside your working shifts.</p></div><input type="checkbox" name="outsideApproval" ${s.outsideApproval ? 'checked' : ''}/></label><div class="info-box">${icon('shield')}<div><strong>A simple foundation.</strong><p>Online booking requires a verified email and allows one active visit per account. Admins can also confirm bookings for clients by phone or message. Repeats create the next visit after completion and follow these same rules. Changes apply to new requests.</p></div></div><p class="form-error" id="form-error" role="alert"></p><button class="button button-primary">Save booking rules ${icon('check')}</button></form>`; }

function openModal(content) {
  const dialog = $('#modal');
  if (!dialog.open) modalReturnFocus = document.activeElement;
  dialog.innerHTML = h`<button class="modal-close" data-action="modal-close" aria-label="Close dialog">${icon('close')}</button>${content}`;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('input:not([type="hidden"]), .button', dialog)?.focus());
}
function closeModal() { $('#modal').close(); modalReturnFocus?.focus(); }
function authModal(mode = 'login') {
  state.authMode = mode;
  const create = mode === 'register';
  openModal(h`<img class="modal-mark" src="/brand/logos/logo-stacked-black.png" width="401" height="203" alt="ERD hair design"/><p class="eyebrow">${create ? t('MAKE YOURSELF AT HOME') : t('GOOD TO SEE YOU AGAIN')}</p><h2 id="modal-title">${create ? h('Your fresh start.') : h('Welcome back.')}</h2><p class="modal-description">${create ? h('A few details now. Good hair days ahead.') : h('Sign in and make a little time for yourself.')}</p><form id="auth-form">${create ? h('<label>Full name<input name="name" autocomplete="name" required minlength="2" maxlength="100" placeholder="Your full name"/></label><label>Phone number<input name="phone" type="tel" autocomplete="tel" required placeholder="Your phone number"/></label>') : ''}<label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com"/></label><label>Password<input name="password" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" required ${create ? 'minlength="12"' : ''} maxlength="200" placeholder="${create ? h('At least 12 characters') : h('Your password')}"/></label><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width">${create ? h('Create account') : h('Sign in')} ${icon('arrow')}</button></form><p class="modal-switch">${create ? h('Already part of the studio?') : h('Your first time here?')} <button class="text-button" data-action="${create ? 'login' : 'register'}">${create ? h('Sign in') : h('Create an account')}</button></p>`);
}
function verifyModal() {
  openModal(h`<span class="gate-icon">${icon('mail')}</span><p class="eyebrow">ONE LITTLE CHECK</p><h2 id="modal-title">Check your inbox.</h2><p class="modal-description">Enter the six-digit code for <strong>${esc(state.user.email)}</strong>. It’s valid for 10 minutes.</p>${state.devCode ? h`<div class="dev-email"><strong>Local preview · no email sent</strong><p>Your test verification code is <b>${esc(state.devCode)}</b>.</p></div>` : ''}<form id="verify-form"><label>Verification code<input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000"/></label><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width">Verify email ${icon('check')}</button></form><p class="modal-switch">Need a new code? <button class="text-button" data-action="resend">Send again</button></p>`);
}
async function loadSlots() {
  const request = ++availabilityRequest;
  state.slotsLoading = true; state.slotsError = false; state.slots = [];
  render();
  try {
    const result = await api(`/availability?service=${encodeURIComponent(state.serviceId)}&date=${state.date}`);
    if (request !== availabilityRequest) return;
    state.slots = result.slots;
    state.closed = Boolean(result.closed);
    if (state.slot) state.slot = state.slots.find(s => s.time === state.slot.time && s.available) || null;
  } catch (error) {
    if (request === availabilityRequest) { state.slot = null; state.slotsError = true; }
    throw error;
  } finally { if (request === availabilityRequest) { state.slotsLoading = false; if (state.route === 'book') render(); } }
}
async function route() {
  const request = ++routeRequest;
  const page = pages[pagePath(location.pathname)] || pages['/'];
  let session, admin, bookings, notifications;
  if (page.name === 'appointments' && state.user) bookings = (await api('/bookings')).bookings;
  if (page.name === 'admin') {
    session = await api('/bootstrap');
    if (session.user?.verified && ['admin', 'super_admin'].includes(session.user.role)) {
      admin = await api('/admin/dashboard');
      notifications = await api('/admin/notifications');
      if (page.adminTab === 'notifications' && session.user.role === 'super_admin') admin.notificationSettings = await api('/admin/notification-settings');
    }
  }
  if (request !== routeRequest) return false;
  state.route = page.name;
  state.adminBookingId = page.adminTab === 'appointments' ? new URLSearchParams(location.search).get('booking') : null;
  if (state.adminBookingId) { state.adminFilter = 'all'; state.adminQuery = ''; state.adminDate = ''; }
  if (notifications) state.notifications = notifications;
  if (bookings) state.bookings = bookings;
  if (session) { state.user = session.user; state.today = session.today; state.admin = admin || null; }
  if (page.adminTab) state.adminTab = page.adminTab;
  if (admin) { state.services = admin.services; state.settings = admin.settings; if (!service()) { state.step = 0; state.slot = null; } }
  render();
  return true;
}
function migrateHash() {
  const path = legacyPath(location.hash);
  if (path) history.replaceState(null, '', path + location.search);
  return Boolean(path);
}
async function navigate(path, {replace = false} = {}) {
  const previousPage = state.route;
  const url = new URL(path, location.origin);
  if (!pagePath(url.pathname) || url.origin !== location.origin) return;
  if (url.pathname + url.search !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search);
  if (await route()) {
    if (previousPage === 'admin' && state.route === 'admin') return;
    if (state.route === 'book' && state.step > 0) focusBookingStep();
    else window.scrollTo({top:0,behavior:motion()});
  }
}
async function afterAuth() {
  if (state.user && !state.user.verified) { verifyModal(); render(); return; }
  closeModal();
  if (state.authIntent === 'admin') { state.authIntent = null; await navigate('/admin'); return; }
  await route();
}
async function action(button) {
  const a = button.dataset.action;
  if (a === 'category') { state.category = button.dataset.value; render(); }
  if (a === 'service' || a === 'pick-service') {
    routeRequest++;
    state.serviceId = button.dataset.id; state.slot = null; state.step = 1; state.route = 'book';
    if (location.pathname !== '/book') history.pushState(null, '', '/book');
    render(); await loadSlots(); if (state.route === 'book' && state.step === 1) focusBookingStep();
  }
  if (a === 'next') { if (!state.slot || state.slotsLoading) return; state.step = 2; render(); focusBookingStep(); }
  if (a === 'step') { state.step = Number(button.dataset.step); render(); focusBookingStep(); if (state.step === 1) await loadSlots(); }
  if (a === 'date' || a === 'week') {
    state.date = a === 'date' ? button.dataset.date : [state.today, dayAfter(state.date, Number(button.dataset.direction) * 7), dayAfter(state.today, 90)].sort()[1];
    state.slot = null; await loadSlots();
  }
  if (a === 'retry-slots') await loadSlots();
  if (a === 'time') { if (state.slotsLoading) return; state.slot = state.slots.find(s => s.time === button.dataset.time && s.available); render({selectionOnly:true}); }
  if (a === 'login' || a === 'register') authModal(a);
  if (a === 'modal-close') closeModal();
  if (a === 'verify-open') verifyModal();
  if (a === 'resend') { const result = await api('/auth/resend', 'POST', {}); state.devCode = result.devCode; verifyModal(); toast(state.devCode ? h('A new local verification code is ready.') : h('A new code is on its way.')); }
  if (a === 'account') openModal(h`<p class="eyebrow">YOUR LITTLE CORNER</p><h2 id="modal-title">Hello, ${esc(state.user.name.split(' ')[0])}.</h2><p class="modal-description">${esc(state.user.email)} · ${state.user.verified ? h('Verified') : h('Not yet verified')}</p><div class="account-menu"><a class="button button-outline" href="/appointments" data-action="modal-close">${icon('calendar')} My visits</a>${!state.user.verified ? h('<button class="button button-outline" data-action="verify-open">Verify email</button>') : ''}${isStaff() ? h('<a class="button button-outline" href="/admin" data-action="modal-close">Salon workspace ↗</a>') : ''}<button class="text-button" data-action="logout">Sign out</button></div>`);
  if (a === 'logout') { await api('/auth/logout', 'POST', {}); state.user = null; state.detailsDraft = null; state.devCode = null; state.bookings = []; state.admin = null; state.notifications = {items:[],unreadCount:0}; if (state.step > 2) state.step = 2; closeModal(); await route(); toast(h('You’re signed out. See you soon.')); }
  if (a === 'admin-entry') { if (state.user) { await navigate('/admin'); } else { state.authIntent = 'admin'; authModal(); } }
  if (a === 'book') {
    const { booking } = await api('/bookings', 'POST', { serviceId: state.serviceId, date: state.date, time: state.slot.time, repeatWeeks: state.repeatWeeks, notes: state.notes, expectedPrice: state.slot.price });
    state.step = 0; state.serviceId = null; state.slot = null; state.repeatWeeks = 0; state.notes = '';
    await navigate('/appointments');
    openModal(h`<span class="success-circle">${icon('check')}</span><p class="eyebrow">A LITTLE TIME FOR YOU</p><h2 id="modal-title">${booking.status === 'pending' ? h('Your request is in.') : h('It’s a date.')}</h2><p class="modal-description">${booking.status === 'pending' ? h('Our team will review your appointment. You can follow its status in My visits.') : h('Your appointment is confirmed. We look forward to seeing you.')}</p><div class="success-detail"><strong>${esc(bookingName(booking))}</strong><span>${dateLabel(booking.date)} · ${booking.time}</span><span>${money(booking.price)} · Pay at the salon</span></div><button class="button button-primary full-width" data-action="modal-close">Lovely, thank you ${icon('check')}</button>`);
  }
  if (a === 'cancel-open') openModal(h`<p class="eyebrow">A CHANGE OF PLANS</p><h2 id="modal-title">Cancel this visit?</h2><p class="modal-description">We’ll free up your time for someone else. Any repeat schedule for this visit will stop, too.</p><button class="button button-primary full-width" data-action="booking-action" data-value="cancel" data-id="${button.dataset.id}">Yes, cancel my visit</button><button class="text-button full-width cancel-keep" data-action="modal-close">Keep my appointment</button>`);
  if (a === 'booking-action') { await api(h`/bookings/${button.dataset.id}/action`, 'POST', { action: button.dataset.value }); if ($('#modal').open) closeModal(); await route(); toast(h('Appointment updated.')); }
  if (a === 'notifications-read') { state.notifications = await api('/admin/notifications/read', 'POST', {throughId:state.notifications.items[0].id}); updateNotificationDisplay(); }
  if (a === 'notification-open') { state.notifications = await api('/admin/notifications/read', 'POST', {id:Number(button.dataset.id)}); await navigate(`/admin?booking=${encodeURIComponent(button.dataset.booking)}`); }
  if (a === 'notification-retry') { state.admin.notificationSettings = await api('/admin/notification-settings/retry', 'POST', {}); $('#notification-delivery-status').innerHTML = notificationDeliveryStatus(state.admin.notificationSettings); toast(h('Failed emails queued for retry.')); }
  if (a === 'admin-reserve') await adminReserveModal();
  if (a === 'reserve-retry') await loadReserveSlots();
  if (a === 'service-edit') serviceEditor(button.dataset.id);
  if (a === 'service-remove-open') openModal(h`<h2 id="modal-title">Remove this service?</h2><p class="modal-description">It will disappear from the booking menu. Existing appointments and history are kept. Future repeats for this service will pause.</p><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" data-action="service-remove" data-id="${button.dataset.id}">Remove service</button><button class="text-button full-width cancel-keep" data-action="modal-close">Keep service</button>`);
  if (a === 'service-remove') { await api(h`/admin/services/${button.dataset.id}`, 'DELETE', {}); closeModal(); await route(); toast(h('Service removed from the menu.')); }
  if (a === 'vacation-remove-open') openModal(h`<h2 id="modal-title">Remove this time off?</h2><p class="modal-description">These dates will be open for booking again, following your working hours and booking rules.</p><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" data-action="vacation-remove" data-id="${button.dataset.id}">Remove time off</button><button class="text-button full-width cancel-keep" data-action="modal-close">Keep time off</button>`);
  if (a === 'vacation-remove') { await api(h`/admin/vacations/${button.dataset.id}`, 'DELETE', {}); closeModal(); await route(); toast(h('Time off removed.')); }
  if (a === 'admin-remove-open') openModal(h`<h2 id="modal-title">Remove admin access?</h2><p class="modal-description">${esc(button.dataset.email)} will keep their client account and appointments. Their administrator access will end immediately.</p><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" data-action="admin-remove" data-email="${esc(button.dataset.email)}">Remove admin access</button><button class="text-button full-width cancel-keep" data-action="modal-close">Keep access</button>`);
  if (a === 'admin-remove') { await api('/admin/team', 'PUT', {email: button.dataset.email, role: 'client'}); closeModal(); await route(); toast(h('Administrator access removed.')); }
  if (a === 'admin-view') { state.adminTab = 'appointments'; state.adminFilter = button.dataset.view; state.adminQuery = ''; state.adminDate = ''; state.adminBookingId = null; if (location.search || location.pathname !== '/admin') await navigate('/admin'); else render(); }
  if (a === 'admin-clear') { state.adminQuery = ''; state.adminDate = ''; state.adminBookingId = null; history.replaceState(null, '', '/admin'); render(); }
  if (a === 'copy-weekdays') { const form = $('#hours-form'); for (let day = 2; day <= 5; day++) { form.elements[h`open-${day}`].checked = form.elements['open-1'].checked; form.elements[h`start-${day}`].value = form.elements['start-1'].value; form.elements[h`end-${day}`].value = form.elements['end-1'].value; } toast(h('Monday copied to Tuesday–Friday. Save working hours to apply.')); }
  if (['admin-decline-open','admin-cancel-open','admin-complete-open'].includes(a)) {
    const b = state.admin.bookings.find(b => b.id === button.dataset.id);
    const value = a === 'admin-decline-open' ? 'decline' : a === 'admin-cancel-open' ? 'cancel' : 'complete';
    openModal(h`<h2 id="modal-title">${value === 'complete' ? h('Complete this repeat visit?') : value === 'decline' ? h('Decline this request?') : h('Cancel this visit?')}</h2><p class="modal-description"><strong>${esc(b.name)}</strong><br>${esc(bookingName(b))} · ${dateLabel(b.date)} at ${b.time}</p><p class="modal-description">${value === 'complete' ? h('This finishes the visit and requests the next repeat, subject to availability and booking rules.') : b.user_id ? h('The time will be released and any repeat schedule will stop. The client can see the update in My visits.') : h('The time will be released. Let the client know about the cancellation.')}</p><p class="form-error" id="modal-error" role="alert"></p><button class="button button-primary full-width" data-action="booking-action" data-value="${value}" data-id="${b.id}">${value === 'complete' ? h('Complete & renew repeat') : value === 'decline' ? h('Decline request') : h('Cancel visit')}</button><button class="text-button full-width cancel-keep" data-action="modal-close">Go back</button>`);
  }
  if (a === 'admin-tab') await navigate(adminPath(button.dataset.tab));
  if (a === 'refresh-admin') { await route(); toast(h('Your appointment book is up to date.')); }
}
document.addEventListener('click', async event => {
  const link = event.target.closest('a[href]');
  if (link && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !link.hasAttribute('download') && !link.hasAttribute('data-reload') && (!link.target || link.target === '_self')) {
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin && pagePath(url.pathname) && !url.hash) {
      event.preventDefault();
      if ($('#modal').open) closeModal();
      try { await navigate(url.pathname + url.search); } catch (error) { toast(error.message); }
      return;
    }
  }
  if (link && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)) return;
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const anchor = button.tagName === 'A';
  if (!anchor) event.preventDefault();
  if (button.dataset.busy) return;
  button.dataset.busy = 'true'; button.setAttribute('aria-busy', 'true');
  try { await action(button); }
  catch (error) { const field = $('#modal').open ? $('#modal-error') : $('#form-error'); if (field) field.textContent = t(error.message); toast(error.message); }
  finally { delete button.dataset.busy; button.removeAttribute('aria-busy'); }
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'language-select') {
      const fields = [...document.querySelectorAll('#main input, #main textarea, #main select')].map(el => ({name:el.name,id:el.id,value:el.value,checked:el.checked}));
      setLanguage(event.target.value); try { localStorage.setItem('erd-language', getLanguage()); } catch {}
      render();
      for (const field of fields) { const el = field.id ? document.getElementById(field.id) : document.querySelector(`#main [name="${CSS.escape(field.name)}"]`); if (el) { el.value = field.value; if ('checked' in el) el.checked = field.checked; } }
      $('#language-select').focus({preventScroll:true});
    }
    if (event.target.id === 'reserve-client') { const guest = $('#reserve-guest'); guest.hidden = Boolean(event.target.value); guest.disabled = Boolean(event.target.value); }
    if (['reserve-service', 'reserve-date'].includes(event.target.id)) await loadReserveSlots();
    if (event.target.id === 'reserve-time') $('button[type="submit"]', event.target.form).disabled = !event.target.value;
    if (event.target.id === 'date-picker') { const date = event.target.value; if (date < state.today || date > dayAfter(state.today, 90)) throw new Error(h('Choose a date within the next 90 days.')); state.date = date; state.slot = null; await loadSlots(); render(); }
    if (event.target.id === 'repeat-weeks') { state.repeatWeeks = Number(event.target.value); render({selectionOnly:true}); $('#repeat-weeks').focus({preventScroll:true}); }
    if (event.target.id === 'admin-date') { state.adminBookingId = null; state.adminDate = event.target.value; $('#admin-results').innerHTML = adminResults(); }
  } catch (error) { toast(error.message); }
});
document.addEventListener('invalid', event => { const el = event.target; if (getLanguage() === 'sq' && el.setCustomValidity) el.setCustomValidity(t(el.validity.valueMissing ? 'Complete this field.' : el.type === 'email' ? 'Enter a valid email address.' : 'Check this value and try again.')); }, true);
document.addEventListener('input', event => { event.target.setCustomValidity?.(''); if (event.target.form?.id === 'details-form' && ['name', 'phone'].includes(event.target.name)) state.detailsDraft = {...state.detailsDraft, [event.target.name]:event.target.value}; if (event.target.name === 'notes' && event.target.form?.id === 'details-form') state.notes = event.target.value; if (event.target.id === 'admin-search') { state.adminBookingId = null; state.adminQuery = event.target.value; $('#admin-results').innerHTML = adminResults(); } });
document.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target, submit = $('button[type="submit"], button.button-primary', form);
  if (submit?.disabled || form.dataset.submitting) return;
  form.dataset.submitting = 'true';
  if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); }
  const data = Object.fromEntries(new FormData(form));
  const errorField = $('.form-error', form); if (errorField) errorField.textContent = '';
  try {
    if (form.id === 'auth-form') { const result = await api(h`/auth/${state.authMode}`, 'POST', data); state.user = result.user; state.detailsDraft = null; state.devCode = result.devCode; if (result.emailError) toast(result.emailError); await afterAuth(); }
    if (form.id === 'verify-form') { const result = await api('/auth/verify', 'POST', data); state.user = result.user; state.devCode = null; await afterAuth(); toast(h('Email verified. You’re ready to book.')); }
    if (form.id === 'details-form') { state.user = (await api('/profile', 'PATCH', data)).user; state.notes = data.notes; state.detailsDraft = null; state.step = 3; render(); focusBookingStep(); }
    if (form.id === 'hours-form' || form.id === 'rules-form') {
      const s = structuredClone(state.admin.settings);
      if (form.id === 'hours-form') { s.allowOutside = data.allowOutside === 'on'; s.outsideStart = data.outsideStart; s.outsideEnd = data.outsideEnd; s.shifts = s.shifts.map(d => ({ day: d.day, open: data[h`open-${d.day}`] === 'on', start: data[h`start-${d.day}`], end: data[h`end-${d.day}`] })); }
      else { s.autoApprove = data.autoApprove === 'on'; s.outsideApproval = data.outsideApproval === 'on'; s.requiredApprovals = Number(data.requiredApprovals); }
      state.settings = (await api('/admin/settings', 'PUT', s)).settings; await route(); toast(h('Your settings have been saved.'));
    }
    if (form.id === 'admin-reserve-form') {
      const slot = form.slots?.find(s => s.time === data.time);
      if (!slot) throw new Error(t('Choose an available time.'));
      try {
        await api('/admin/bookings', 'POST', {...data, expectedPrice: slot.price});
      } catch (error) { await loadReserveSlots(form); throw error; }
      closeModal(); state.adminFilter = 'all'; state.adminQuery = ''; state.adminDate = data.date;
      await navigate('/admin'); toast(h('Reservation confirmed.'));
    }
    if (form.id === 'notification-settings-form') {
      state.admin.notificationSettings = await api('/admin/notification-settings', 'PUT', {recipientIds:new FormData(form).getAll('recipientIds'),language:data.language});
      render(); toast(h('Email notification settings saved.'));
    }
    if (form.id === 'service-form') { await api(h`/admin/services${data.serviceId ? h`/${data.serviceId}` : ''}`, data.serviceId ? 'PUT' : 'POST', {...data, duration: Number(data.duration), price: Math.round(Number(data.price) * 100), outside_price: Math.round(Number(data.outside_price) * 100)}); closeModal(); await route(); toast(h('Service saved.')); }
    if (form.id === 'vacation-form') { await api('/admin/vacations', 'POST', data); await route(); toast(h('Time off added. These dates are closed for bookings.')); }
    if (form.id === 'team-form') { await api('/admin/team', 'PUT', {email: data.email, role: 'admin'}); await route(); toast(h('Administrator access granted. They can sign in again now.')); }
    if (form.id === 'prices-form') { state.services = (await api('/admin/prices', 'PUT', { services: state.admin.services.map(s => ({ id: s.id, price: Math.round(Number(data[h`price-${s.id}`]) * 100), outside_price: Math.round(Number(data[h`outside-${s.id}`]) * 100) })) })).services; await route(); toast(h('Your prices have been saved.')); }
  } catch (error) { const current = $('#modal').open ? $('#modal-error') : $('#form-error'); if (current) current.textContent = t(error.message); else toast(error.message); }
  finally { delete form.dataset.submitting; if (submit) { submit.disabled = form.id === 'admin-reserve-form' && !form.elements.time.value; submit.removeAttribute('aria-busy'); } }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeModal(); } });
window.addEventListener('popstate', () => { migrateHash(); route().catch(e => toast(e.message)); });
window.addEventListener('hashchange', () => { if (migrateHash()) route().catch(e => toast(e.message)); });
migrateHash();
$('#year').textContent = new Date().getFullYear();
try { Object.assign(state, await api('/bootstrap')); state.date = state.today; await route(); }
catch (error) { $('#main').innerHTML = h`<div class="empty-state"><h1>We’ll be right with you.</h1><p>${esc(error.message)}</p><a class="button button-primary" href="/" data-reload>Try again</a></div>`; }

setInterval(refreshNotifications, 30000);
document.addEventListener('visibilitychange', refreshNotifications);
refreshNotifications();
