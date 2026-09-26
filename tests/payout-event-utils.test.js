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

test('buildAttributes emits Attached Filename + private Destination when a receipt is attached', () => {
    const attrs = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, {
        receiptFileName: 'payout_20260925_abc123.pdf',
        receiptLocation: 'https://github.com/TrueSightDAO/payout-receipts-raw/blob/main/receipts/payout_20260925_abc123.pdf'
    }), {}));
    assert.strictEqual(attrs['Attached Filename'], 'payout_20260925_abc123.pdf');
    assert.ok(/payout-receipts-raw/.test(attrs['Destination Payout Receipt File Location']));
});

test('buildAttributes degrades to (none) when no receipt is attached', () => {
    const attrs = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, { receiptFileName: '', receiptLocation: '' }), {}));
    assert.strictEqual(attrs['Attached Filename'], '(none)');
    assert.strictEqual(attrs['Receipt URL'], '(none)');
});

test('buildAttributes keeps a pasted Receipt URL as the fallback (no attachment)', () => {
    const attrs = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, {
        receiptFileName: '', receiptLocation: '', receiptUrl: 'https://drive.example.com/r/1'
    }), {}));
    assert.strictEqual(attrs['Receipt URL'], 'https://drive.example.com/r/1');
});

test('PRIVACY: a receipt destination must never point at a PUBLIC repo', () => {
    // The receipt carries PII (name/CPF/PIX). Only the private receipts store is legal.
    const dest = Object.fromEntries(u.buildAttributes(Object.assign({}, GOOD, {
        receiptFileName: 'x.pdf',
        receiptLocation: 'https://github.com/TrueSightDAO/payout-receipts-raw/blob/main/receipts/x.pdf'
    }), {}))['Destination Payout Receipt File Location'];
    assert.ok(/payout-receipts-raw/.test(dest), 'must target the private receipts repo');
    assert.ok(!/\/\.github\//.test(dest) && !/store_interaction_attachments/.test(dest), 'never the public .github store');
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

// --- P2.3: registered-recipient review (dedupe to one row per pk_hash) -------
test('dedupeActiveRegistrations: collapses many rows for one pk_hash to ONE', () => {
    // The shape Gary actually sees on the live sheet: 1 RECORDED + 3 UPDATED.
    const rows = [
        { row: 2, status: 'RECORDED', submitted_date: '2026-09-24T16:07:18.237Z', pk_hash: 'pk-A', pix_key_masked: '***.***.***-19' },
        { row: 3, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:18.725Z', pk_hash: 'pk-A', pix_key_masked: '***.***.***-19' },
        { row: 4, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:19.461Z', pk_hash: 'pk-A', pix_key_masked: '***.***.***-19' },
        { row: 5, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:21.290Z', pk_hash: 'pk-A', pix_key_masked: '***.***.***-19' },
    ];
    const out = u.dedupeActiveRegistrations(rows);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].pk_hash, 'pk-A');
    assert.strictEqual(out[0].submitted_date, '2026-09-24T16:07:21.290Z'); // most recent wins
});
test('dedupeActiveRegistrations: an ACTIVE row beats a newer non-ACTIVE row', () => {
    const rows = [
        { status: 'UPDATED', submitted_date: '2026-09-25T00:00:00Z', pk_hash: 'pk-B' },
        { status: 'ACTIVE',  submitted_date: '2026-09-20T00:00:00Z', pk_hash: 'pk-B' },
    ];
    const out = u.dedupeActiveRegistrations(rows);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].status, 'ACTIVE');
});
test('dedupeActiveRegistrations: distinct pk_hashes each survive (stable first-seen order)', () => {
    const rows = [
        { status: 'RECORDED', submitted_date: '2026-09-24T16:07:18Z', pk_hash: 'pk-A' },
        { status: 'RECORDED', submitted_date: '2026-09-24T16:07:19Z', pk_hash: 'pk-C' },
        { status: 'RECORDED', submitted_date: '2026-09-24T16:07:20Z', pk_hash: 'pk-A' },
    ];
    const out = u.dedupeActiveRegistrations(rows);
    assert.deepStrictEqual(out.map(r => r.pk_hash), ['pk-A', 'pk-C']);
});
test('dedupeActiveRegistrations: blank/missing pk_hash rows are dropped (nothing to pay)', () => {
    const rows = [{ status: 'RECORDED', pk_hash: '' }, { status: 'error' }, { status: 'RECORDED', pk_hash: 'pk-Z' }];
    assert.deepStrictEqual(u.dedupeActiveRegistrations(rows).map(r => r.pk_hash), ['pk-Z']);
});
test('dedupeActiveRegistrations: undefined/empty input -> [] (never throws)', () => {
    assert.deepStrictEqual(u.dedupeActiveRegistrations(undefined), []);
    assert.deepStrictEqual(u.dedupeActiveRegistrations([]), []);
});
test('PRIVACY: dedupe parser has no pix_key (raw) accessor -- masked only', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'payout-event-utils.js'), 'utf8');
    const fn = src.slice(src.indexOf('function dedupeActiveRegistrations'), src.indexOf('var utils = {'));
    assert.ok(!/(^|[^_])\bpix_key\b(?!_)/.test(fn), 'dedupe parser must not read the raw pix_key field');
});


// --- tree recipient map (governor-only read) --------------------------------
test('buildTreeRecipientMap: {data:{items}} -> tree_id->pk_hash', () => {
    const p = { status: 'success', data: { items: [
        { tree_id: 'Edgar_A', pk_hash: 'pk-1' }, { tree_id: 'Edgar_B', pk_hash: 'pk-2' } ] } };
    assert.deepStrictEqual(u.buildTreeRecipientMap(p), { Edgar_A: 'pk-1', Edgar_B: 'pk-2' });
});
test('buildTreeRecipientMap: malformed/blank input -> {} (never throws)', () => {
    assert.deepStrictEqual(u.buildTreeRecipientMap(null), {});
    assert.deepStrictEqual(u.buildTreeRecipientMap({}), {});
    assert.deepStrictEqual(u.buildTreeRecipientMap({ data: { items: null } }), {});
    assert.deepStrictEqual(u.buildTreeRecipientMap({ data: { items: [
        { tree_id: '', pk_hash: 'pk-x' }, { tree_id: 'Edgar_C', pk_hash: '' }, null ] } }), {});
});
test('buildTreeRecipientMap: first occurrence wins for a dup tree_id', () => {
    const p = { data: { items: [ { tree_id: 'E', pk_hash: 'pk-1' }, { tree_id: 'E', pk_hash: 'pk-2' } ] } };
    assert.deepStrictEqual(u.buildTreeRecipientMap(p), { E: 'pk-1' });
});
test('findPendingTree: matches telegram_message_id, falls back to tree_id, else null', () => {
    const rows = [ { telegram_message_id: 'Edgar_A', species: 'Cacau' }, { tree_id: 'Edgar_B' } ];
    assert.strictEqual(u.findPendingTree(rows, 'Edgar_A').species, 'Cacau');
    assert.strictEqual(u.findPendingTree(rows, 'Edgar_B').tree_id, 'Edgar_B');
    assert.strictEqual(u.findPendingTree(rows, 'nope'), null);
    assert.strictEqual(u.findPendingTree(null, 'Edgar_A'), null);
    assert.strictEqual(u.findPendingTree(rows, ''), null);
});
test('treeDetailFields: ordered, blank-stripped, no photo_url / no PII fields', () => {
    const f = u.treeDetailFields({ telegram_message_id: 'Edgar_A', species: 'Cacau',
        planting_date: '2026-09-01', latitude: '-3.1', longitude: '', submitted_name: 'Ana',
        photo_url: 'http://x/a.jpg' });
    assert.deepStrictEqual(f.map(x => x[0]),
        ['Tree ID', 'Species', 'Planting date', 'Latitude', 'Submitted by']);   // longitude blank dropped
    assert.ok(!JSON.stringify(f).includes('jjpg'), 'photo_url must not leak into detail fields');
    assert.deepStrictEqual(u.treeDetailFields(null), []);
});

test('maskedKeyByPkHash: maps pk_hash -> masked type+key, first wins', () => {
  const m = u.maskedKeyByPkHash([
    { pk_hash: 'pk-A', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
    { pk_hash: 'pk-A', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
    { pk_hash: 'pk-B', pix_key_type: 'EMAIL', pix_key_masked: 'g***@e***.com' },
    { pk_hash: '', pix_key_type: 'X', pix_key_masked: 'y' },
  ]);
  assert.strictEqual(m['pk-A'].pix_key_masked, '***.***.***-19');
  assert.strictEqual(m['pk-B'].pix_key_type, 'EMAIL');
  assert.strictEqual(Object.keys(m).length, 2);
});
test('maskedKeyByPkHash: malformed input -> {} (never throws)', () => {
  assert.deepStrictEqual(u.maskedKeyByPkHash(null), {});
  assert.deepStrictEqual(u.maskedKeyByPkHash(undefined), {});
});
test('PRIVACY: maskedKeyByPkHash never emits a raw pix_key/pix field', () => {
  const m = u.maskedKeyByPkHash([{ pk_hash: 'pk-A', pix_key: 'RAW-SECRET', pix_key_masked: '***' }]);
  const json = JSON.stringify(m);
  assert.ok(!/RAW-SECRET/.test(json), 'raw pix_key must not survive');
  assert.ok(!/\bpix_key\b/.test(json), 'pix_key field name must not appear');
});

test('deriveStatus: same UTC day (or future) -> live; earlier day -> backfill', () => {
  const now = '2026-09-26T08:00:00Z';
  assert.strictEqual(u.deriveStatus('2026-09-26T07:59:00Z', now), 'live');
  assert.strictEqual(u.deriveStatus('2026-09-26T23:00:00Z', now), 'live');
  assert.strictEqual(u.deriveStatus('2026-09-27T00:00:00Z', now), 'live');
  assert.strictEqual(u.deriveStatus('2026-09-25T23:59:59Z', now), 'backfill');
  assert.strictEqual(u.deriveStatus('2026-09-12T21:38:00Z', now), 'backfill');
});
test('deriveStatus: blank/garbage -> live (validation rejects it upstream)', () => {
  assert.strictEqual(u.deriveStatus('', '2026-09-26T08:00:00Z'), 'live');
  assert.strictEqual(u.deriveStatus('not-a-date', '2026-09-26T08:00:00Z'), 'live');
});

test('overpayReasonBits: names the duplicate counterpart and the co-located distance', () => {
  assert.deepStrictEqual(
    u.overpayReasonBits({ duplicate: true, duplicate_with: ['X'], colocated: false, colocated_with: [] }),
    ['duplicate (same record as X)']);
  assert.deepStrictEqual(
    u.overpayReasonBits({ duplicate: false, colocated: true, colocated_with: [{ tree_id: 'Y', meters: 0.4 }] }),
    ['co-located with Y (0.4 m)']);
  assert.deepStrictEqual(
    u.overpayReasonBits({ duplicate: true, duplicate_with: [], colocated: true, colocated_with: [{ tree_id: 'Z', meters: 0 }] }),
    ['duplicate', 'co-located with Z (0 m)']);
  assert.deepStrictEqual(u.overpayReasonBits(null), []);
});

test('programsFromRegistry: dedups + sorts slugs, tolerates gaps', function () {
  assert.deepStrictEqual(u.programsFromRegistry({ hosts: { 'cfr.truesight.me': 'crf-anapu', 'beta.cfr.truesight.me': 'crf-anapu', 'x.example': 'zeta-program' } }), ['crf-anapu', 'zeta-program']);
  assert.deepStrictEqual(u.programsFromRegistry({}), []);
  assert.deepStrictEqual(u.programsFromRegistry(null), []);
  assert.deepStrictEqual(u.programsFromRegistry({ hosts: { 'a.b': '', 'c.d': '  ' } }), []);
});

test('feedHasProgramData: true only when a tree carries attribution', function () {
  assert.strictEqual(u.feedHasProgramData([{ telegram_message_id: 'X' }]), false);
  assert.strictEqual(u.feedHasProgramData([{ telegram_message_id: 'X', program_slug: 'crf-anapu' }]), true);
  assert.strictEqual(u.feedHasProgramData([{ submission_source: 'cfr.truesight.me' }]), true);
  assert.strictEqual(u.feedHasProgramData([]), false);
  assert.strictEqual(u.feedHasProgramData(null), false);
});

console.log('\npayout-event-utils: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
