/**
 * Unit tests for routes.js mode selection + probe behaviour.
 * Run: node tests/routes-mode.test.js
 *
 * Regression guard for the payout-page blank-recipient bug (2026-09):
 *   - the async script.google.com probe must NOT call window.location.reload()
 *     (a mid-session reload aborts the page's in-flight GAS fetches, which is
 *     exactly why report_payout_event.html's getTreeRecipientMap never landed)
 *   - an explicit ?route= URL override must WIN and must NOT trigger the probe
 *   - a page may pin itself out of the probe with window.ROUTES_NO_PROBE = true
 *   - on probe failure the mode is persisted to localStorage and a soft
 *     'routes:proxy-suggested' event is raised, so the Edgar proxy engages on the
 *     NEXT navigation without ever disturbing the current page.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'routes.js'), 'utf8');

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function memStore(init) {
  const m = Object.assign({}, init || {});
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: (k) => { delete m[k]; },
    _dump: () => Object.assign({}, m),
  };
}

// Execute routes.js in a browser-shaped vm sandbox. Returns the state the test
// needs to assert on (Routes table, recorded reloads/events/fetch calls).
function loadRoutes(opts) {
  opts = opts || {};
  const reloads = [];
  const events = [];
  const fetchCalls = [];
  const ls = opts.localStorage || memStore();
  const ss = opts.sessionStorage || memStore();
  const hostname = opts.hostname || 'beta.dapp.truesight.me';
  const search = opts.search || '';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext('this.window = this;', sandbox); // window === global (as in a browser)
  sandbox.location = { search, hostname, href: 'https://' + hostname + '/' + search, reload: () => reloads.push(1) };
  sandbox.localStorage = ls;
  sandbox.sessionStorage = ss;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.AbortController = class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } };
  sandbox.setTimeout = () => 0;   // never let the abort timer fire mid-test
  sandbox.clearTimeout = () => {};
  sandbox.console = { warn: () => {}, log: () => {}, error: () => {} };
  sandbox.CustomEvent = class { constructor(type) { this.type = type; } };
  sandbox.dispatchEvent = (ev) => events.push(ev && ev.type);
  sandbox.fetch = (url, o) => {
    fetchCalls.push({ url: String(url), opts: o });
    return opts.fetchImpl ? opts.fetchImpl(url, o) : Promise.resolve({ ok: true });
  };
  if (opts.ROUTES_NO_PROBE !== undefined) sandbox.ROUTES_NO_PROBE = opts.ROUTES_NO_PROBE;
  vm.runInContext(SRC, sandbox);
  return { Routes: sandbox.Routes, window: sandbox, reloads, events, fetchCalls, ls, ss };
}

const flush = () => new Promise((r) => setImmediate(r));

// --- mode selection --------------------------------------------------------
test('no stored mode -> direct, probe fires once', () => {
  const r = loadRoutes({ fetchImpl: () => Promise.resolve({}) });
  assert.strictEqual(r.Routes.mode, 'direct');
  assert.strictEqual(r.fetchCalls.length, 1, 'probe should fire exactly once');
  assert.ok(r.fetchCalls[0].url.indexOf('script.google.com') >= 0, 'probe hits direct GAS');
});

test('?route=proxy -> proxy mode, persisted, probe SKIPPED', () => {
  const r = loadRoutes({ search: '?route=proxy', fetchImpl: () => Promise.reject(new Error('blocked')) });
  assert.strictEqual(r.Routes.mode, 'proxy');
  assert.strictEqual(r.ls._dump().routesMode, 'proxy');
  assert.strictEqual(r.fetchCalls.length, 0, 'explicit override must not probe');
  assert.strictEqual(r.reloads.length, 0);
});

test('?route=direct wins over stored proxy, probe SKIPPED', () => {
  const r = loadRoutes({ search: '?route=direct', localStorage: memStore({ routesMode: 'proxy' }), fetchImpl: () => Promise.reject(new Error('blocked')) });
  assert.strictEqual(r.Routes.mode, 'direct');
  assert.strictEqual(r.ls._dump().routesMode, 'direct');
  assert.strictEqual(r.fetchCalls.length, 0, 'explicit override is never re-probed');
  assert.strictEqual(r.reloads.length, 0);
});

test('stored routesMode=proxy honored, probe skipped', () => {
  const r = loadRoutes({ localStorage: memStore({ routesMode: 'proxy' }), fetchImpl: () => Promise.reject(new Error('x')) });
  assert.strictEqual(r.Routes.mode, 'proxy');
  assert.strictEqual(r.fetchCalls.length, 0);
});

// --- the regression: probe must not reload --------------------------------
test('probe FAILURE -> persist proxy + soft event, NO reload', async () => {
  const r = loadRoutes({ fetchImpl: () => Promise.reject(new Error('script.google.com blocked')) });
  assert.strictEqual(r.Routes.mode, 'direct', 'mode unchanged for THIS page load');
  await flush(); await flush();
  assert.strictEqual(r.ls._dump().routesMode, 'proxy', 'proxy persisted for next navigation');
  assert.strictEqual(r.reloads.length, 0, 'MUST NOT reload (a reload aborts in-flight fetches)');
  assert.ok(r.events.indexOf('routes:proxy-suggested') >= 0, 'soft event raised');
});

test('probe SUCCESS -> no flip, no reload, no event', async () => {
  const r = loadRoutes({ fetchImpl: () => Promise.resolve({ ok: true }) });
  await flush(); await flush();
  assert.strictEqual(r.ls._dump().routesMode, undefined);
  assert.strictEqual(r.reloads.length, 0);
  assert.strictEqual(r.events.length, 0);
});

// --- opt-out / dev paths ---------------------------------------------------
test('window.ROUTES_NO_PROBE=true -> probe skipped entirely', () => {
  const r = loadRoutes({ ROUTES_NO_PROBE: true, fetchImpl: () => Promise.reject(new Error('would-block')) });
  assert.strictEqual(r.Routes.mode, 'direct');
  assert.strictEqual(r.fetchCalls.length, 0, 'pinned page never probes');
  assert.strictEqual(r.reloads.length, 0);
});

test('localhost -> probe skipped (developer mode)', () => {
  const r = loadRoutes({ hostname: 'localhost', fetchImpl: () => Promise.reject(new Error('x')) });
  assert.strictEqual(r.fetchCalls.length, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
