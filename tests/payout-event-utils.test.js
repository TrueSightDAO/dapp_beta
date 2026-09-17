/**
 * Unit tests for payout-event-utils.js
 * Run: node tests/payout-event-utils.test.js
 *
 * The load-bearing assertions:
 *   - one row per TRANSFER, tree ids carried as a LIST (dedup, stable order)
 *   - the Edgar payload NEVER carries a raw PIX key (no PII), and
 *     an unregistered recipient degrades to `unlinked_recipient` rather than failing
 *   - `status` distinguishes live capture from backfill reconstruction
 */
const assert = require('assert');
const u = require('../payout-event-utils.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// --- tree id list ----------------------------------------------------------
test('parseTreeIds splits on comma/space/semicolon', () => {
    assert.deepStrictEqual(u.parseTreeIds('a, b\nc  d;e'), ['a', 'b', 'c', 'd', 'e']);
});
test('parseTreeIds de-duplicates, first occurrence wins (stable order)', () => {
    assert.deepStrictEqual(u.parseTreeIds('t2 t1 t2'), ['t2', 't1']);
});
test('parseTreeIds blank -> [] (general disbursement is legal)', () => {
    assert.deepStrictEqual(u.parseTreeIds(''), []);
    assert.deepStrictEqual(u.parseTreeIds('   '), []);
});

// --- amount ----------------------------------------------------------------
test('parseAmount accepts a plain number', () => {
    assert.deepStrictEqual(u.parseAmount('50'), { valid: true, value: '50' });
});
test('parseAmount accepts pt-BR decimal comma', () => {
    assert.deepStrictEqual(u.parseAmount('50,00'), { valid: true, value: '50' });
});
test('parseAmount strips an R$ prefix and thousands commas', () => {
    assert.strictEqual(u.parseAmount('R$ 1.234,50').value, '1234.5');
});
test('parseAmount rejects zero, negative and non-numeric', () => {
    assert.strictEqual(u.parseAmount('0').valid, false);
    assert.strictEqual(u.parseAmount('-5').valid, false);
    assert.strictEqual(u.parseAmount('abc').valid, false);
    assert.strictEqual(u.parseAmount('').valid, false);
});

// --- date ------------------------------------------------------------------
test('isValidIso8601 accepts date and date-time forms', () => {
    assert.strictEqual(u.isValidIso8601('2026-09-12'), true);
    assert.strictEqual(u.isValidIso8601('2026-09-12T21:38:00Z'), true);
    assert.strictEqual(u.isValidIso8601('2026-09-12 21:38'), true);
});
test('isValidIso8601 rejects ambiguous / junk shapes', () => {
    assert.strictEqual(u.isValidIso8601('12/09/2026'), false);
    assert.strictEqual(u.isValidIso8601('2026-13-45'), false);
    assert.strictEqual(u.isValidIso8601(''), false);
});

// --- validate --------------------------------------------------------------
const GOOD = {
    amount: '50', currency: 'BRL', paidAt: '2026-09-12T21:38:00Z',
    bankRef: 'E6890081', bankRefType: 'PIX-E2E', recipientName: 'Paulo',
    programSlug: 'crf-anapu', status: 'backfill'
};
test('validate: a well-formed backfill passes', () => {
    assert.strictEqual(u.validate(GOOD).valid, true);
});
test('validate: bankRef is required (reconciliation anchor)', () => {
    const r = u.validate(Object.assign({}, GOOD, { bankRef: '' }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.join(' ').includes('Bank Ref'));
});
test('validate: an unknown currency is rejected', () => {
    assert.strictEqual(u.validate(Object.assign({}, GOOD, { currency: 'EUR' })).valid, false);
});
test('validate: an unknown status is rejected', () => {
    assert.strictEqual(u.validate(Object.assign({}, GOOD, { status: 'done' })).valid, false);
});

// --- payload shaping / PRIVACY --------------------------------------------
test('buildAttributes omits a blank pk hash as unlinked_recipient', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { recipientPkHash: '' }), {});
    const map = Object.fromEntries(attrs);
    assert.strictEqual(map['Recipient PK Hash'], u.UNLINKED_RECIPIENT);
});
test('buildAttributes carries the pk hash when supplied', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { recipientPkHash: 'abc123' }), {});
    const map = Object.fromEntries(attrs);
    assert.strictEqual(map['Recipient PK Hash'], 'abc123');
});
test('buildAttributes flags an empty tree list as unlinked', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { treeIds: '' }), {});
    assert.strictEqual(Object.fromEntries(attrs)['Tree Planting IDs'], u.UNLINKED_TREES);
});
test('buildAttributes joins multiple tree ids on one row', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { treeIds: 't1, t2' }), {});
    assert.strictEqual(Object.fromEntries(attrs)['Tree Planting IDs'], 't1, t2');
});
test('buildAttributes normalises the amount to a clean numeric string', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { amount: 'R$ 50,00' }), {});
    assert.strictEqual(Object.fromEntries(attrs)['Amount'], '50');
});
test('buildAttributes records the status verbatim (live | backfill)', () => {
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { status: 'live' }), {});
    assert.strictEqual(Object.fromEntries(attrs)['Status'], 'live');
});
test('PRIVACY: the payload contract has no raw-PIX field at all', () => {
    const labels = u.buildAttributes(GOOD, {}).map((p) => p[0]);
    assert.ok(!labels.some((l) => /pix/i.test(l)), 'no PIX label may appear: ' + labels.join(', '));
});
test('PRIVACY: a CPF-like string passed as recipient name is not silently kept as a pk hash', () => {
    // even if an operator pastes a CPF into the name field, it lands in Recipient,
    // never in the pk-hash slot unless explicitly given there.
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { recipientName: '111.444.777-35', recipientPkHash: '' }), {});
    const map = Object.fromEntries(attrs);
    assert.strictEqual(map['Recipient PK Hash'], u.UNLINKED_RECIPIENT);
});

console.log('\npayout-event-utils: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
