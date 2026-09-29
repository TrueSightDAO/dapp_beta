// Regression guard for the shared navigation menu (menu.js).
// Locks in the Ledger Explorer entry + the beta/prod host mapping — the
// explorer page is hosted on dapp_beta and referenced cross-host from cfr/sunmint.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const menuSrc = fs.readFileSync(path.join(root, 'menu.js'), 'utf8');

const sandbox = { window: {}, document: { addEventListener() {} } };
vm.runInNewContext(menuSrc, sandbox);
const items = sandbox.window.menuItems;

assert.ok(Array.isArray(items), 'menuItems should be an array');
assert.ok(items.length > 0, 'menuItems should not be empty');

const explorer = items.find(function (i) { return i.title === 'Ledger Explorer'; });
assert.ok(explorer, 'menuItems should include a "Ledger Explorer" entry');
assert.strictEqual(explorer.url, './ledger_explorer.html', 'Ledger Explorer url');
assert.strictEqual(explorer.section, 'Identity & Governance', 'Ledger Explorer section');

// The page the menu points at must actually exist.
assert.ok(
  fs.existsSync(path.join(root, 'ledger_explorer.html')),
  'ledger_explorer.html should exist next to menu.js'
);

// Host mapping used by cross-site links: dapp_beta (beta) vs dapp (prod).
// Beta is the dapp_beta host; prod is served from truesight.me/dapp (see dapp_footer_links.js).
// Guard the convention so a future editor does not invent a third host.
const footer = fs.readFileSync(path.join(root, 'js', 'dapp_footer_links.js'), 'utf8');
assert.ok(/dapp\/blob\/main\//.test(footer), 'prod dapp host convention (dapp/blob/main) should hold');

console.log('menu-nav.test.js: OK (' + items.length + ' items, Ledger Explorer present)');
