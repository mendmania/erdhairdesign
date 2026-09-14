import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pages, pagePath, adminPath, legacyPath } from '../public/routes.js';

test('legacy links and admin sections resolve only to real clean pages', () => {
  for (const name of ['book', 'services', 'studio', 'appointments', 'admin']) {
    assert.equal(legacyPath('#' + name), '/' + name);
    assert.equal(pages[pagePath('/' + name)].name, name);
  }
  assert.equal(legacyPath('#main'), null); // Keep the accessibility skip link native.
  assert.equal(legacyPath('#unknown'), null);
  assert.equal(pagePath('/unknown'), null);
  assert.equal(pagePath('/__proto__'), null);
  assert.equal(pagePath('/admin/services/'), '/admin/services');
  assert.equal(adminPath('hours'), '/admin/working-hours');
  assert.equal(adminPath('vacations'), '/admin/time-off');
  assert.equal(adminPath('appointments'), '/admin');
});
