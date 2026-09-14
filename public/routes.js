// Shared by the server and browser: only real pages receive the website shell.
export const pages = {
  '/': { name: 'book' },
  '/book': { name: 'book' },
  '/services': { name: 'services' },
  '/studio': { name: 'studio' },
  '/appointments': { name: 'appointments' },
  '/admin': { name: 'admin', adminTab: 'appointments' },
  '/admin/working-hours': { name: 'admin', adminTab: 'hours' },
  '/admin/time-off': { name: 'admin', adminTab: 'vacations' },
  '/admin/services': { name: 'admin', adminTab: 'prices' },
  '/admin/booking-rules': { name: 'admin', adminTab: 'rules' },
  '/admin/team': { name: 'admin', adminTab: 'team' },
};
export const pagePath = pathname => {
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return Object.hasOwn(pages, path) ? path : null;
};
export const adminPath = tab => Object.keys(pages).find(path => pages[path].adminTab === tab) || '/admin';
export const legacyPath = hash => ['book', 'services', 'studio', 'appointments', 'admin'].includes(hash.slice(1)) ? '/' + hash.slice(1) : null;
