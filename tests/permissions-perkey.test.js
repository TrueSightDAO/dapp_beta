/**
 * Unit tests for scripts/permissions.js — PR5 step 2 per-key point-lookup.
 * Run: node tests/permissions-perkey.test.js
 *
 * Verifies Permissions.check resolves the signed-in RSA via the content-addressed
 * per-key file (public_keys/<sha256>.json) and falls back to the dao_members.json
 * monolith scan only on missing/error, with a known-inactive key being an
 * authoritative deny (no fallback).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'permissions.js'), 'utf8');

let passed = 0;
let failed = 0;

function sha256hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }
function jsonResp(data, status) {
  return { ok: (status || 200) < 400, status: status || 200, json: async () => data };
}

const MANIFEST = { actions: { define_currency: { required_roles: ['governor'] } } };
const PK = 'MIIB-EXAMPLE-KEY';
const PERKEY_URL = 'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/public_keys/' + sha256hex(PK) + '.json';

// Build a sandbox window with a routed fetch stub + WebCrypto, and (optionally)
// a DaoMembersCache stub so the monolith fallback path can be exercised.
function load(opts) {
  opts = opts || {};
  const calls = { monolith: 0, perkey: 0 };
  const win = {
    fetch: async function (url) {
      if (url.indexOf('permissions.json') >= 0) return jsonResp(MANIFEST);
      if (url.indexOf('public_keys/') >= 0) {
        calls.perkey++;
        var r = (opts.perKeyRouter || function () {
          if (opts.perKey === '404') return jsonResp({}, 404);
          if (opts.perKey === 'error') return jsonResp({}, 500);
          if (opts.perKey === 'network') throw new Error('network');
          return jsonResp(opts.perKeyJson);
        })(url);
        return r;
      }
      if (url.indexOf('dao_members.json') >= 0) {
        calls.monolith++;
        return jsonResp(opts.monolith || { contributors: [] });
      }
      return jsonResp({}, 404);
    },
    crypto: { subtle: {
      digest: async function (alg, data) {
        return crypto.createHash('sha256').update(Buffer.from(data)).digest();
      }
    } },
  };
  // Inject a DaoMembersCache stub matching dao_members_cache.js semantics.
  if (opts.installMonolith !== false) {
    win.DaoMembersCache = {
      findByPublicKey: async function (pk) {
        var cs = (opts.monolith && opts.monolith.contributors) || [];
        for (var i = 0; i < cs.length; i++) {
          var ks = cs[i].public_keys || [];
          for (var j = 0; j < ks.length; j++) {
            if (ks[j].public_key === pk) return { contributor: cs[i], key: ks[j] };
          }
        }
        return { contributor: null, key: null };
      }
    };
    // count stub invocations too (stub bypasses fetch)
    const _fk = win.DaoMembersCache.findByPublicKey;
    win.DaoMembersCache.findByPublicKey = function (pk) { calls.monolith++; return _fk(pk); };
  }
  const sandbox = { window: win, console: console, TextEncoder: TextEncoder };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { perm: win.Permissions, calls: calls };
}

async function test(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); passed++; }
  catch (e) { console.error('  \u2717 ' + name); console.error('    ' + e.message); failed++; }
}

async function run() {
  console.log('\nPermissions per-key point-lookup - Unit Tests\n');

  await test('per-key ACTIVE governor grants governor-only action (no monolith read)', async () => {
    const h = load({ perKeyJson: { status: 'ACTIVE', contributor: 'Gary Teh', roles: ['governor', 'member'] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.contributor.name, 'Gary Teh');
    assert.strictEqual(h.calls.monolith, 0, 'monolith must NOT be read on per-key hit');
    assert.strictEqual(h.calls.perkey, 1);
  });

  await test('per-key non-ACTIVE key = authoritative deny, no monolith fallback', async () => {
    const h = load({ perKeyJson: { status: 'REVOKED', contributor: 'X', roles: ['governor'] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(h.calls.monolith, 0, 'no fallback on authoritative deny');
    assert.match(r.reason, /not a registered DAO contributor/);
  });

  await test('per-key ACTIVE member denied a governor-only action', async () => {
    const h = load({ perKeyJson: { status: 'ACTIVE', contributor: 'M', roles: ['member'] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, false);
    assert.deepStrictEqual(r.missing_roles, ['governor']);
  });

  await test('per-key 404 falls back to monolith scan (governor)', async () => {
    const h = load({
      perKey: '404',
      monolith: { contributors: [{ name: 'G', roles: ['governor', 'member'],
        public_keys: [{ public_key: PK, status: 'ACTIVE' }] }] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, true, 'monolith fallback grants');
    assert.strictEqual(r.contributor.name, 'G');
    assert.strictEqual(h.calls.monolith, 1, 'fallback read the monolith once');
  });

  await test('per-key network error falls back to monolith (member denied)', async () => {
    const h = load({
      perKey: 'network',
      monolith: { contributors: [{ name: 'M', roles: ['member'],
        public_keys: [{ public_key: PK, status: 'ACTIVE' }] }] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, false);
    assert.deepStrictEqual(r.missing_roles, ['governor']);
    assert.strictEqual(h.calls.monolith, 1);
  });

  await test('monolith-only mode (per-key 404 + absent author) still denies cleanly', async () => {
    const h = load({ perKey: '404', monolith: { contributors: [] } });
    const r = await h.perm.check('define_currency', PK);
    assert.strictEqual(r.allowed, false);
    assert.match(r.reason, /not a registered DAO contributor/);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) process.exit(1);
}

run();
