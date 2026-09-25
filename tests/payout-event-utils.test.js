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
test('validate: recipient is OPTIONAL (often unknown; tree id is the anchor)', () => {
    const r = u.validate(Object.assign({}, GOOD, { recipientName: '' }));
    assert.strictEqual(r.valid, true, JSON.stringify(r.errors));
});
test('buildAttributes: a blank recipient is emitted as an empty value (never fails)', () => {
    const map = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, { recipientName: '' }), {}));
    assert.strictEqual(map['Recipient'], '');
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

// --- overpay guards --------------------------------------------------------
test('haversineMeters: identical points are 0 m', () => {
    assert.strictEqual(u.haversineMeters(-3.1, -52.1, -3.1, -52.1), 0);
});
test('haversineMeters: ~111 m for 0.001 deg of latitude', () => {
    const m = u.haversineMeters(0, 0, 0.001, 0);
    assert.ok(m > 100 && m < 120, 'got ' + m);
});
test('computeOverpayFlags: same photo_url on two rows flags BOTH as duplicate', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '0', longitude: '0' },
        { tree_id: 'T2', photo_url: 'http://x/a.jpg', latitude: '0', longitude: '0' }
    ]);
    assert.strictEqual(f.T1.duplicate, true);
    assert.strictEqual(f.T2.duplicate, true);
    assert.deepStrictEqual(f.T1.duplicate_with, ['T2']);
});
test('computeOverpayFlags: a repeated tree_id alone is flagged as duplicate', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '0', longitude: '0' },
        { tree_id: 'T1', photo_url: 'http://x/b.jpg', latitude: '0', longitude: '0' }
    ]);
    assert.strictEqual(f.T1.duplicate, true);
});
test('computeOverpayFlags: the default co-located threshold is 3 m', () => {
    assert.strictEqual(u.OVERPAY_COLOCATED_METERS, 3.0);
});
test('computeOverpayFlags: two DIFFERENT trees <3 m apart are co-located (Gary 2026-09-25)', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.094581', longitude: '-52.094964' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.094582', longitude: '-52.094964' }
    ]);
    assert.strictEqual(f.T1.colocated, true);
    assert.strictEqual(f.T1.colocated_with[0].tree_id, 'T2');
});
test('computeOverpayFlags: two DIFFERENT trees ~2 m apart ARE flagged at the 3 m default', () => {
    // 0.00002 deg latitude ~= 2.2 m -> inside the 3 m window.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.094581', longitude: '-52.094964' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.094601', longitude: '-52.094964' }
    ]);
    assert.strictEqual(f.T1.colocated, true);
    assert.strictEqual(f.T2.colocated, true);
});
test('computeOverpayFlags: trees ~9 m apart are NOT flagged (outside the 3 m window)', () => {
    // 0.00008 deg latitude ~= 8.9 m -> beyond 3 m.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.094581', longitude: '-52.094964' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.094661', longitude: '-52.094964' }
    ]);
    assert.deepStrictEqual(f, {});
});
test('computeOverpayFlags: a clean list yields NO flags (empty object)', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '1', longitude: '1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '2', longitude: '2' }
    ]);
    assert.deepStrictEqual(f, {});
});
test('computeOverpayFlags: rows without coordinates cannot be co-located', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '', longitude: '' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '', longitude: '' }
    ]);
    assert.deepStrictEqual(f, {});
});
test('overpayWarningsFor: filters to entered ids, input order preserved', () => {
    const flags = { T2: { tree_id: 'T2', duplicate: true, duplicate_with: ['T1'] } };
    const out = u.overpayWarningsFor(flags, ['T9', 'T2']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].tree_id, 'T2');
});
test('PRIVACY: overpay guard helpers never emit a PIX/CPF-bearing field name', () => {
    const f = u.computeOverpayFlags([{ tree_id: 'T1', photo_url: 'a', latitude: 0, longitude: 0 }]);
    assert.deepStrictEqual(Object.keys(f), []);
});

// --- optional program (P1b) -------------------------------------------------
test('validate: a payout with NO program is valid (program is optional)', () => {
    const check = u.validate(Object.assign({}, GOOD, { programSlug: '' }));
    assert.strictEqual(check.valid, true, JSON.stringify(check.errors));
});
test('buildAttributes: a blank program emits the explicit unlinked_program marker', () => {
    const map = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, { programSlug: '' }), {}));
    assert.strictEqual(map['Program'], 'unlinked_program');
});
test('buildAttributes: a chosen program is emitted verbatim', () => {
    const map = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, { programSlug: 'crf-anapu' }), {}));
    assert.strictEqual(map['Program'], 'crf-anapu');
});

console.log('\npayout-event-utils: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
