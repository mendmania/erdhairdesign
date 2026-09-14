import { albanian } from './locales/sq.js';
let language = 'en';
export const getLanguage = () => language;
export const locale = () => language === 'sq' ? 'sq-AL' : 'en-GB';
export function setLanguage(value) { language = value === 'sq' ? 'sq' : 'en'; }
export function t(source) {
  if (language !== 'sq') return source;
  const trimmed = source.trim();
  const conflict = trimmed.match(/^(\d+) active appointment\(s\) fall in this period\. Resolve them in Appointments before adding time off\.$/);
  if (conflict) return `${conflict[1]} termine aktive janë në këtë periudhë. Zgjidhini te Terminet para se të shtoni pushimin.`;
  if (/^Invalid (autoApprove|outsideApproval|allowOutside)\.$/.test(trimmed)) return 'Cilësim i pavlefshëm i rezervimit.';
  if (trimmed.startsWith('Repeat paused: ')) return 'Përsëritja u ndal: ' + t(trimmed.slice(15));
  const next = trimmed.match(/^Next visit booked for ([\d-]+) at ([\d:]+)\.$/);
  if (next) return `Termini tjetër u rezervua për ${next[1]} në orën ${next[2]}.`;

  return Object.hasOwn(albanian, trimmed) ? source.replace(trimmed, albanian[trimmed]) : source;
}
// Only template literals are translated. Interpolated customer content stays opaque.
// Numbered placeholders allow Albanian to reorder dynamic values safely.
export function h(strings, ...values) {
  const source = typeof strings === 'string' ? strings : strings.reduce((s, part, i) => s + part + (i < values.length ? `\uE000${i}\uE001` : ''), '');
  const translate = (part, attribute = false) => {
    const tokens = [];
    const key = part.trim().replace(/\uE000\d+\uE001/g, token => `{${tokens.push(token) - 1}}`);
    if (language !== 'sq' || !Object.hasOwn(albanian, key)) return part;
    let translated = albanian[key];
    translated = translated.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    if (attribute) translated = translated.replace(/"/g, '&quot;');
    translated = translated.replace(/\{(\d+)\}/g, (_, i) => tokens[Number(i)] ?? '');
    return part.replace(part.trim(), translated);
  };
  const result = source.split(/(<[^>]*>)/g).map(part => part.startsWith('<')
    ? part.replace(/\b(aria-label|placeholder|title|alt)="([^"]*)"/g, (_, name, value) => `${name}="${translate(value, true)}"`)
    : translate(part)).join('');
  return result.replace(/\uE000(\d+)\uE001/g, (_, i) => String(values[Number(i)] ?? ''));
}

export function formatDate(date, options = {}) {
  const value = new Date(`${date}T12:00:00`);
  const settings = {weekday:'short',day:'numeric',month:'long',...options};
  const formatter = new Intl.DateTimeFormat(locale(), settings);
  if (language !== 'sq' || formatter.resolvedOptions().locale.startsWith('sq')) return formatter.format(value);
  // Some embedded browsers ship only a subset of ICU locales.
  const months = ['janar','shkurt','mars','prill','maj','qershor','korrik','gusht','shtator','tetor','nëntor','dhjetor'];
  const shortMonths = ['jan','shk','mar','pri','maj','qer','korr','gush','sht','tet','nën','dhj'];
  const weekdays = ['e diel','e hënë','e martë','e mërkurë','e enjte','e premte','e shtunë'];
  const shortDays = ['die','hën','mar','mër','enj','pre','sht'];
  return formatter.formatToParts(value).map(part => part.type === 'weekday' ? (settings.weekday === 'long' ? weekdays : shortDays)[value.getDay()] : part.type === 'month' && ['long','short'].includes(settings.month) ? (settings.month === 'long' ? months : shortMonths)[value.getMonth()] : part.value).join('');
}
