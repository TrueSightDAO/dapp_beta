/**
 * Unit tests for scripts/currencies_cache.js
 * Run: node tests/currencies-cache.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'currencies_cache.js'), 'utf8');

let passed = 0;
let failed = 0;

function loadCache(fetchImpl) {
    const win = { fetch: fetchImpl };
    const sandbox = { window: win, console: console };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return win.CurrenciesCache;
}

function jsonResp(data) { return { ok: true, status: 200, json: async () => data }; }
function errResp(status) { return { ok: false, status: status, json: async () => ({}) }; }

// vm.runInContext builds arrays in another realm, so their Array prototype is not
// reference-equal -- compare structurally instead of with deepStrictEqual.
function eq(actual, expected) {
    assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected));
}

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \u2717 ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

async function run() {
    console.log('\nCurrencies Cache - Unit Tests\n');

    const treasury = { items: [{ currency: 'A' }, { currency: 'C' }, { currency: 'A' }] };
    const catalog = { currencies: ['A', 'B', 'NEW'] };

    let cache = loadCache(async (url) =>
        url.includes('currencies.json') ? jsonResp(catalog) : jsonResp(treasury));
    let got = await cache.fetchCurrencies();
    await test('unions catalog + snapshot, deduped + sorted', () => eq(got, ['A', 'B', 'C', 'NEW']));

    cache = loadCache(async (url) =>
        url.includes('currencies.json') ? errResp(500) : jsonResp(treasury));
    got = await cache.fetchCurrencies();
    await test('catalog failure -> snapshot only', () => eq(got, ['A', 'C']));

    cache = loadCache(async (url) => {
        if (url.includes('currencies.json')) return jsonResp(catalog);
        throw new Error('network');
    });
    got = await cache.fetchCurrencies();
    await test('snapshot failure -> catalog only', () => eq(got, ['A', 'B', 'NEW']));

    cache = loadCache(async () => { throw new Error('network'); });
    let rejected = false;
    try { await cache.fetchCurrencies(); } catch (e) { rejected = true; }
    await test('both sources fail -> rejects', () => assert.strictEqual(rejected, true));

    cache = loadCache(async (url) =>
        url.includes('currencies.json') ? jsonResp(['X', 'Y']) : jsonResp({ items: [] }));
    got = await cache.fetchCurrencies();
    await test('accepts bare-array catalog payload', () => eq(got, ['X', 'Y']));

    cache = loadCache(async (url) =>
        url.includes('currencies.json') ? errResp(404) : jsonResp(treasury));
    const snap = await cache.fetchSnapshot();
    await test('fetchSnapshot still returns snapshot JSON',
        () => assert.strictEqual(snap.items.length, 3));

    console.log('\n---');
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

run();
