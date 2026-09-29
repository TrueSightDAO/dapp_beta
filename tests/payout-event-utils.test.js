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
test('buildAttributes: no free-text Recipient line is emitted (redundant field removed)', () => {
    const labels = u.buildAttributes(Object.assign({}, GOOD, { recipientName: 'Paulo' }), {}).map((p) => p[0]);
    assert.ok(!labels.includes('Recipient'), 'the Recipient line must be gone: ' + labels.join(', '));
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
test('PRIVACY: a CPF-like string in a stray recipientName never reaches the payload', () => {
    // The name field is gone; even if a stale caller passes one, it must not surface.
    const attrs = u.buildAttributes(Object.assign({}, GOOD, { recipientName: '111.444.777-35', recipientPkHash: '' }), {});
    const map = Object.fromEntries(attrs);
    assert.strictEqual(map['Recipient PK Hash'], u.UNLINKED_RECIPIENT);
    const joined = JSON.stringify(attrs);
    assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(joined), 'no CPF-shaped value may appear');
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
    assert.strictEqual(u.OVERPAY_SAME_FIX_METERS, 0.15);
});
test('computeOverpayFlags: DISTINCT trees on the SAME fix ARE flagged (identical coord)', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.094581', longitude: '-52.094964' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.094581', longitude: '-52.094964' }
    ]);
    assert.strictEqual(f.T1.colocated, true);
    assert.strictEqual(f.T1.colocated_with[0].tree_id, 'T2');
    assert.strictEqual(f.T1.colocated_with[0].meters, 0);
});

test('computeOverpayFlags: distinct trees 0.22 m apart (different photos) are NOT a same-fix flag (Gary 2026-09-27)', () => {
    // The false positive Gary flagged: two DISTINCT submissions (different photo_hash,
    // different capture dates) that happen to sit 0.22 m apart must not read as one
    // stale fix. Real tree spacing is never sub-metre; a genuinely shared fix is 0 m.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', photo_hash: '8f3f0e428b4959cc', latitude: '-3.522920', longitude: '-51.574971', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', photo_hash: 'f43427d337abc3d3', latitude: '-3.522920', longitude: '-51.574973', request_txid: 'SIG2' }
    ]);
    assert.deepStrictEqual(f, {});
});

test('computeOverpayFlags: identical coords still flag at the tightened 0.15 m window', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.522803', longitude: '-51.574812', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.522803', longitude: '-51.574812', request_txid: 'SIG2' }
    ]);
    assert.strictEqual(f.T1.colocated, true);
});
test('computeOverpayFlags: distinct trees merely ~2 m apart are NOT flagged (dense planting)', () => {
    // 0.00002 deg latitude ~= 2.2 m -> well outside the sub-metre same-fix window.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.094581', longitude: '-52.094964' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.094601', longitude: '-52.094964' }
    ]);
    assert.deepStrictEqual(f, {});
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
test('computeOverpayFlags: near-identical photo_hash (same photo under a NEW url) => duplicate', () => {
    // Exact photo_url differs, but the perceptual hashes are 4 bits apart -> the SAME
    // physical photo re-ingested. This is the safety net the exact-url check misses.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', photo_hash: 'ffffffffffffffff', latitude: '1', longitude: '1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', photo_hash: 'fffffffffffffff0', latitude: '1', longitude: '1' }
    ]);
    assert.strictEqual(f.T1.duplicate, true);
    assert.ok(f.T1.duplicate_with.indexOf('T2') !== -1);
});

test('computeOverpayFlags: DIFFERENT photos (>=14 bits apart) are NOT duplicates', () => {
    // Live feed: the closest DISTINCT-photo pair is 14/64, so the <=8 gate (and 14
    // here) never merges two real trees.
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', photo_hash: '0000000000000000', latitude: '1', longitude: '1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', photo_hash: '0000000000003fff', latitude: '9', longitude: '9' }
    ]);
    assert.deepStrictEqual(f, {});
});

test('overpayWarningsFor: filters to entered ids, input order preserved', () => {
    const flags = { T2: { tree_id: 'T2', duplicate: true, duplicate_with: ['T1'] } };
    const out = u.overpayWarningsFor(flags, ['T9', 'T2']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].tree_id, 'T2');
});
// --- PR3: Request Transaction ID is the duplicate key (Gary 2026-09-26, thread 35944)
test('computeOverpayFlags: rows sharing a Request Transaction ID are duplicates (txid is the key)', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '1', longitude: '1', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '1', longitude: '1', request_txid: 'SIG1' }
    ]);
    assert.strictEqual(f.T1.duplicate, true);
    assert.strictEqual(f.T2.duplicate, true);
    assert.strictEqual(f.T1.duplicate_txid, 'SIG1');
    assert.deepStrictEqual(f.T1.duplicate_with, ['T2']);
});

test('computeOverpayFlags: DISTINCT txids on one GPS fix are NOT duplicates (the noise Gary flagged)', () => {
    // Same coordinate, different signed submissions -> co-located advisory only, never "duplicate".
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '-3.5229198', longitude: '-51.5749711', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '-3.5229198', longitude: '-51.5749711', request_txid: 'SIG2' }
    ]);
    assert.notStrictEqual(f.T1.duplicate, true);
    assert.notStrictEqual(f.T2.duplicate, true);
    assert.strictEqual(f.T1.colocated, true);  // same GPS fix -> still flagged
});

test('computeOverpayFlags: a same-txid pair is a duplicate, NOT a co-located pair (distinct trees)', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '1', longitude: '1', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/a.jpg', latitude: '1', longitude: '1', request_txid: 'SIG1' }
    ]);
    assert.strictEqual(f.T1.duplicate, true);
    assert.strictEqual(f.T1.colocated, false);
    assert.deepStrictEqual(f.T1.colocated_with, []);
});

test('computeOverpayFlags: a co-located partner is listed ONCE even if the feed repeats its row', () => {
    const f = u.computeOverpayFlags([
        { tree_id: 'T1', photo_url: 'http://x/a.jpg', latitude: '1', longitude: '1', request_txid: 'SIG1' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '1', longitude: '1', request_txid: 'SIG2' },
        { tree_id: 'T2', photo_url: 'http://x/b.jpg', latitude: '1', longitude: '1', request_txid: 'SIG2' }
    ]);
    const partners = f.T1.colocated_with.map((c) => c.tree_id);
    assert.deepStrictEqual(partners, ['T2']);
});

test('overpayReasonBits: duplicate names the shared Request Transaction ID', () => {
    assert.deepStrictEqual(
        u.overpayReasonBits({ duplicate: true, duplicate_with: ['T2'], duplicate_txid: 'SIG1', colocated: false, colocated_with: [] }),
        ['duplicate (same Request Transaction ID as T2)']);
});

test('overpayReasonBits: a long same-fix chain is capped to the nearest few + a count', () => {
    const cw = [];
    for (let i = 0; i < 16; i++) cw.push({ tree_id: 'X' + i, meters: 0 });
    const bits = u.overpayReasonBits({ duplicate: false, colocated: true, colocated_with: cw });
    assert.strictEqual(bits.length, 1);
    assert.ok(bits[0].startsWith('same GPS fix as X0 (0 m), X1 (0 m), X2 (0 m)'), bits[0]);
    assert.ok(bits[0].endsWith('and 13 more'), bits[0]);
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

// --- display identity: txid-first, transport-id fallback ---------------------
test('shortTxid: first 8 chars of the Request Transaction ID, else ""', () => {
    assert.strictEqual(u.shortTxid({ request_txid: 'ABCDEFGH1234567' }), 'ABCDEFGH');
    assert.strictEqual(u.shortTxid({ request_txid: '' }), '');
    assert.strictEqual(u.shortTxid({}), '');
    assert.strictEqual(u.shortTxid(null), '');
});
test('treeDisplayId: prefers tx:<8>; falls back to telegram_message_id / tree_id', () => {
    assert.strictEqual(u.treeDisplayId({ request_txid: 'ABCDEFGH1234567', telegram_message_id: 'Edgar_1_2' }), 'tx:ABCDEFGH');
    assert.strictEqual(u.treeDisplayId({ telegram_message_id: 'Edgar_1_2' }), 'Edgar_1_2');
    assert.strictEqual(u.treeDisplayId({ tree_id: 'Edgar_9_9' }), 'Edgar_9_9');
    assert.strictEqual(u.treeDisplayId({}), '');
    assert.strictEqual(u.treeDisplayId(null), '');
});
test('treeDisplayId: two rows sharing one txid render the SAME label (they are the dup pair)', () => {
    const a = u.treeDisplayId({ request_txid: 'SAMETXID999', telegram_message_id: 'Edgar_1' });
    const b = u.treeDisplayId({ request_txid: 'SAMETXID999', telegram_message_id: 'Edgar_2' });
    assert.strictEqual(a, b);
    assert.strictEqual(a, 'tx:SAMETXID');
});
test('overpayReasonBits: labelFor renders partner ids in display form, keys unchanged', () => {
    const f = { duplicate: false, colocated: true, colocated_with: [{ tree_id: 'P1', meters: 0.4 }] };
    const bits = u.overpayReasonBits(f, { labelFor: (x) => 'tx:' + x });
    assert.deepStrictEqual(bits, ['same GPS fix as tx:P1 (0.4 m)']);
    assert.deepStrictEqual(u.overpayReasonBits(f), ['same GPS fix as P1 (0.4 m)']);
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
    ['same GPS fix as Y (0.4 m)']);
  assert.deepStrictEqual(
    u.overpayReasonBits({ duplicate: true, duplicate_with: [], colocated: true, colocated_with: [{ tree_id: 'Z', meters: 0 }] }),
    ['duplicate', 'same GPS fix as Z (0 m)']);
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

test('programSlugsByHost maps host->slug from the registry (SSOT)', () => {
const reg = { hosts: { 'cfr.truesight.me': 'crf-anapu', 'BETA.cfr.truesight.me': 'crf-anapu', 'x.truesight.me': 'x-prog' } };
assert.deepStrictEqual(u.programSlugsByHost(reg), {
  'cfr.truesight.me': 'crf-anapu',
  'beta.cfr.truesight.me': 'crf-anapu',
  'x.truesight.me': 'x-prog',
});
assert.deepStrictEqual(u.programSlugsByHost(null), {});
  });

test('programForTree: explicit slug wins; else resolves the source host via the map', () => {
const map = { 'cfr.truesight.me': 'crf-anapu' };
assert.strictEqual(u.programForTree({ program_slug: 'x-prog', submission_source: 'https://cfr.truesight.me/' }, map), 'x-prog');
assert.strictEqual(u.programForTree({ submission_source: 'https://cfr.truesight.me/plant' }, map), 'crf-anapu');
assert.strictEqual(u.programForTree({ submission_source: 'https://beta.cfr.truesight.me/x' }, map), 'crf-anapu');
// Unattributable rows resolve to '' (the page keeps them visible).
assert.strictEqual(u.programForTree({}, map), '');
assert.strictEqual(u.programForTree({ submission_source: 'https://sunmint.truesight.me/' }, map), '');
  });

test('treesForProgram: STRICT -- only rows whose program EQUALS the chosen one', () => {
  const map = { 'cfr.truesight.me': 'crf-anapu' };
  const trees = [
    { telegram_message_id: 'A', program: 'crf-anapu' },
    { telegram_message_id: 'B', program: 'zeta-program' },
    { telegram_message_id: 'C' },                       // unattributed
    { telegram_message_id: 'D', submission_source: 'https://cfr.truesight.me/' },
  ];
  // hasProgramData=true -> strict narrowing; unattributed + other programs hidden.
  assert.deepStrictEqual(
    u.treesForProgram(trees, 'crf-anapu', map, true).map((t) => t.telegram_message_id),
    ['A', 'D']
  );
  // A different program keeps only its own.
  assert.deepStrictEqual(
    u.treesForProgram(trees, 'zeta-program', map, true).map((t) => t.telegram_message_id),
    ['B']
  );
  // Blank program = general disbursement = every tree.
  assert.deepStrictEqual(u.treesForProgram(trees, '', map, true), trees);
});

test('treesForProgram: cannot narrow while the feed has no attribution (honest passthrough)', () => {
  const map = { 'cfr.truesight.me': 'crf-anapu' };
  const trees = [{ telegram_message_id: 'A' }, { telegram_message_id: 'B' }];  // no program/submission_source
  assert.deepStrictEqual(
    u.treesForProgram(trees, 'crf-anapu', map, false).map((t) => t.telegram_message_id),
    ['A', 'B']
  );
  // Even when hasProgramData is inferred (not passed), an unattributed feed passes through.
  assert.deepStrictEqual(
    u.treesForProgram(trees, 'crf-anapu', map).map((t) => t.telegram_message_id),
    ['A', 'B']
  );
  assert.deepStrictEqual(u.treesForProgram(null, 'crf-anapu', map, true), []);
});

test('programFilterNotApplied: true only when a program is chosen but the feed has no attribution', () => {
  const withData = [{ telegram_message_id: 'A', program: 'crf-anapu' }];
  const noData = [{ telegram_message_id: 'A' }];
  assert.strictEqual(u.programFilterNotApplied('crf-anapu', noData, false), true);
  assert.strictEqual(u.programFilterNotApplied('crf-anapu', withData, true), false);
  assert.strictEqual(u.programFilterNotApplied('', noData, false), false);   // blank program
  assert.strictEqual(u.programFilterNotApplied('crf-anapu', [], false), false);  // empty feed
});

test('submissionSourceHost: URL or bare host -> lowercased host', () => {
assert.strictEqual(u.submissionSourceHost('https://cfr.truesight.me/x'), 'cfr.truesight.me');
assert.strictEqual(u.submissionSourceHost('https://cfr.truesight.me:443/x'), 'cfr.truesight.me');
assert.strictEqual(u.submissionSourceHost('cfr.truesight.me'), 'cfr.truesight.me');
assert.strictEqual(u.submissionSourceHost(''), '');
  });

// --- [TREE PLANTING REJECT EVENT] payload (mark-tree-invalid) --------------
test('buildTreeRejectAttributes: exact monitor-page labels + (unlinked) QR sentinel', () => {
    const a = u.buildTreeRejectAttributes('Edgar_20260903083532_007', '', 'Gary Teh', '');
    assert.deepStrictEqual(Object.keys(a), ['QR Code', 'SunMint Submission Message ID', 'Updated by', 'Reason']);
    assert.strictEqual(a['QR Code'], '(unlinked)');
    assert.strictEqual(a['SunMint Submission Message ID'], 'Edgar_20260903083532_007');
    assert.strictEqual(a['Updated by'], 'Gary Teh');
    assert.strictEqual(a['Reason'], 'Not a valid tree');
});
test('buildTreeRejectAttributes: passes a real QR through and honours a custom reason', () => {
    const a = u.buildTreeRejectAttributes('Edgar_T1', '2024OSCAR_20260121_12', 'Gary', 'duplicate row');
    assert.strictEqual(a['QR Code'], '2024OSCAR_20260121_12');
    assert.strictEqual(a['Reason'], 'duplicate row');
});
test('buildTreeRejectAttributes: carries NO recipient material (no PIX/CPF/pk_hash)', () => {
    const a = u.buildTreeRejectAttributes('Edgar_T1', '', 'Gary', '');
    const blob = JSON.stringify(a);
    assert.strictEqual(/pix|cpf|pk_hash|pix_key/i.test(blob), false);
});
test('TREE_REJECT_EVENT_NAME matches the GAS consumer marker', () => {
    assert.strictEqual(u.TREE_REJECT_EVENT_NAME, 'TREE PLANTING REJECT EVENT');
});

// --- overpayConflictPartners (the SELECTION's collision set) -----------------
test('overpayConflictPartners: an unflagged tree has no partners', () => {
    const flags = u.computeOverpayFlags([
        { tree_id: 'A', latitude: '-3.1', longitude: '-52.1' },
        { tree_id: 'B', latitude: '-3.2', longitude: '-52.2' }
    ]);
    assert.deepStrictEqual(u.overpayConflictPartners(flags, 'A'), []);
});
test('overpayConflictPartners: missing flags / unknown id -> [] (never throws)', () => {
    assert.deepStrictEqual(u.overpayConflictPartners(null, 'A'), []);
    assert.deepStrictEqual(u.overpayConflictPartners({}, 'A'), []);
    assert.deepStrictEqual(u.overpayConflictPartners(undefined, ''), []);
});
test('overpayConflictPartners: returns the co-located partner, nearest first', () => {
    // A-B on the same fix (0 m); C ~0.11 m away (still inside the tightened 0.15 m
    // same-fix window) -> A's partners ordered nearest first: [B, C].
    const flags = u.computeOverpayFlags([
        { tree_id: 'A', latitude: '-3.100000', longitude: '-52.100000' },
        { tree_id: 'B', latitude: '-3.100000', longitude: '-52.100000' },
        { tree_id: 'C', latitude: '-3.100001', longitude: '-52.100000' } // ~0.11 m
    ]);
    const p = u.overpayConflictPartners(flags, 'A');
    assert.deepStrictEqual(p, ['B', 'C']);
});
test('overpayConflictPartners: duplicate partners are appended and de-duplicated', () => {
    // A and B share a photo (duplicate) and are also co-located -> listed ONCE.
    const flags = u.computeOverpayFlags([
        { tree_id: 'A', photo_url: 'http://x/same.jpg', latitude: '-3.1', longitude: '-52.1' },
        { tree_id: 'B', photo_url: 'http://x/same.jpg', latitude: '-3.1', longitude: '-52.1' }
    ]);
    assert.deepStrictEqual(u.overpayConflictPartners(flags, 'A'), ['B']);
});
test('overpayConflictPartners: caps the comparison list (default 3)', () => {
    const rows = [{ tree_id: 'A', latitude: '-3.1', longitude: '-52.1' }];
    for (let i = 0; i < 5; i++) rows.push({ tree_id: 'P' + i, latitude: '-3.1', longitude: '-52.1' });
    const flags = u.computeOverpayFlags(rows);
    assert.strictEqual(u.overpayConflictPartners(flags, 'A').length, 3);
    assert.strictEqual(u.overpayConflictPartners(flags, 'A', 2).length, 2);
});
test('overpayConflictPartners: reads NO PII in its output', () => {
    const flags = u.computeOverpayFlags([
        { tree_id: 'A', latitude: '-3.1', longitude: '-52.1' },
        { tree_id: 'B', latitude: '-3.1', longitude: '-52.1' }
    ]);
    const blob = JSON.stringify(u.overpayConflictPartners(flags, 'A'));
    assert.strictEqual(/pix|cpf|pk_hash|publicKey/i.test(blob), false);
});

test('buildRecipientMapFromFeed: maps feed items carrying inline recipient_pk_hash', () => {
    const m = u.buildRecipientMapFromFeed([
        { telegram_message_id: 'A', recipient_pk_hash: 'pk-aaa' },
        { telegram_message_id: 'B', recipient_pk_hash: 'pk-bbb' },
        { tree_id: 'C', recipient_pk_hash: 'pk-ccc' }
    ]);
    assert.deepStrictEqual(m, { A: 'pk-aaa', B: 'pk-bbb', C: 'pk-ccc' });
});

test('buildRecipientMapFromFeed: skips blank/absent values and first-wins on duplicate ids', () => {
    const m = u.buildRecipientMapFromFeed([
        { telegram_message_id: 'A' },
        { telegram_message_id: 'B', recipient_pk_hash: '' },
        { telegram_message_id: 'A', recipient_pk_hash: 'pk-first' },
        { telegram_message_id: 'A', recipient_pk_hash: 'pk-second' },
        null, undefined
    ]);
    assert.deepStrictEqual(m, { A: 'pk-first' });
});

test('buildRecipientMapFromFeed: tolerant of a non-list input', () => {
    assert.deepStrictEqual(u.buildRecipientMapFromFeed(null), {});
    assert.deepStrictEqual(u.buildRecipientMapFromFeed(undefined), {});
});

// --- payee-viewable my-trees link (Gary 2026-09-29) -----------------------
test('payeeMyTreesUrl: PREFERS the short tx handle (?tx=<8>) when the row has a txid', () => {
    // The signed Request Transaction ID's first 8 chars -- the DAO's canonical,
    // re-post-stable identity -- is the link handle (Gary 2026-09-29).
    assert.strictEqual(
        u.payeeMyTreesUrl({ telegram_message_id: 'Edgar_1', request_txid: 'YgyO2UUE9IQ8zzz', program: 'crf-anapu' }),
        'https://cfr.truesight.me/my-trees/?tx=YgyO2UUE');
    // Program attribution still picks the host when using ?tx=.
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'Edgar_2', request_txid: 'AbCdEfGh1234', program: '' }),
        'https://beta.sunmint.truesight.me/my-trees/?tx=AbCdEfGh');
    // ...and a caller-supplied viewers map still overrides the host under ?tx=.
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'X', request_txid: 'ZZZZZZZZscore', program: 'new-prog' },
            {}, { 'new-prog': 'https://new.example' }),
        'https://new.example/my-trees/?tx=ZZZZZZZZ');
});
test('payeeMyTreesUrl: a SHORT/whitespace txid still yields a usable handle', () => {
    // Defensive: a txid shorter than 8 chars (or padded) must not fabricate chars.
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'E', request_txid: '  abc  ' , program: 'crf-anapu' }),
        'https://cfr.truesight.me/my-trees/?tx=abc');
});
test('payeeMyTreesUrl: falls back to ?tree=<id> when the row has NO txid', () => {
    assert.strictEqual(
        u.payeeMyTreesUrl({ telegram_message_id: 'Edgar_N', program: 'crf-anapu' }),
        'https://cfr.truesight.me/my-trees/?tree=Edgar_N');
});
test('payeeMyTreesUrl: program picks the viewer host (crf vs SunMint beta)', () => {
    assert.strictEqual(
        u.payeeMyTreesUrl({ telegram_message_id: 'Edgar_1', program: 'crf-anapu' }),
        'https://cfr.truesight.me/my-trees/?tree=Edgar_1');
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'Edgar_2', program: '' }),
        'https://beta.sunmint.truesight.me/my-trees/?tree=Edgar_2');
});
test('payeeMyTreesUrl: resolves the program from submission_source (host map)', () => {
    const hm = { 'cfr.truesight.me': 'crf-anapu' };
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'Edgar_3', submission_source: 'https://cfr.truesight.me/' }, hm),
        'https://cfr.truesight.me/my-trees/?tree=Edgar_3');
    // unattributable source -> default SunMint beta
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'Edgar_4', submission_source: 'https://example.org/' }, hm),
        'https://beta.sunmint.truesight.me/my-trees/?tree=Edgar_4');
});
test('payeeMyTreesUrl: URL-encodes the tree id', () => {
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'a b/c', program: '' }),
        'https://beta.sunmint.truesight.me/my-trees/?tree=a%20b%2Fc');
});
test('payeeMyTreesUrl: prefers telegram_message_id, blank id -> ""', () => {
    assert.strictEqual(
        u.payeeMyTreesUrl({ telegram_message_id: 'E_MSG', tree_id: 'E_TREE', program: '' }),
        'https://beta.sunmint.truesight.me/my-trees/?tree=E_MSG');
    assert.strictEqual(u.payeeMyTreesUrl({ program: 'crf-anapu' }), '');
    assert.strictEqual(u.payeeMyTreesUrl(null), '');
});
test('payeeMyTreesUrl: a caller-supplied viewers map overrides a program host', () => {
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'X', program: 'new-prog' }, {}, { 'new-prog': 'https://new.example' }),
        'https://new.example/my-trees/?tree=X');
    // partial override still keeps the known crf mapping (no regression to default)
    assert.strictEqual(
        u.payeeMyTreesUrl({ tree_id: 'X', program: 'crf-anapu' }, {}, { 'new-prog': 'https://new.example' }),
        'https://cfr.truesight.me/my-trees/?tree=X');
});
test('payeeViewerBase: unknown program -> SunMint beta default', () => {
    assert.strictEqual(u.payeeViewerBase(''), u.PAYEE_VIEWER_DEFAULT);
    assert.strictEqual(u.payeeViewerBase('mystery'), 'https://beta.sunmint.truesight.me');
});

test('selectionUrlParam: tx:<handle> when a signed txid exists, else the canonical id', () => {
    assert.deepStrictEqual(
        u.selectionUrlParam({ request_txid: 'CxSlFq7RuxycxGqIylxz+woi', telegram_message_id: 'Edgar_1_2' }, 'Edgar_1_2'),
        { key: 'tx', value: 'CxSlFq7R' });
    assert.deepStrictEqual(
        u.selectionUrlParam({ telegram_message_id: 'Edgar_1_2' }, 'Edgar_1_2'),
        { key: 'tree_id', value: 'Edgar_1_2' });
    assert.deepStrictEqual(u.selectionUrlParam({}, 'X'), { key: 'tree_id', value: 'X' });
    assert.strictEqual(u.selectionUrlParam({}, ''), null);
    assert.strictEqual(u.selectionUrlParam(null, ''), null);
});

test('resolveTxHandle: matches request_txid by prefix/substring, tolerates the tx: label', () => {
    const feed = [
        { telegram_message_id: 'Edgar_A', request_txid: 'CxSlFq7RuxycxGqIylxz' },
        { telegram_message_id: 'Edgar_B', request_txid: 'HdRM45+q9x81dxQoWhzw' },
    ];
    assert.strictEqual(u.resolveTxHandle(feed, 'CxSlFq7R'), 'Edgar_A');
    assert.strictEqual(u.resolveTxHandle(feed, 'tx:CxSlFq7R'), 'Edgar_A');
    assert.strictEqual(u.resolveTxHandle(feed, 'HdRM45'), 'Edgar_B');
    assert.strictEqual(u.resolveTxHandle(feed, 'nope'), '');
    assert.strictEqual(u.resolveTxHandle(feed, ''), '');
    assert.strictEqual(u.resolveTxHandle(null, 'Cx'), '');
});


// --- Farm/Plot spatial filter (PAYOUT_FARM_PLOT_FILTER_PLAN PR1) -----------
const _PLOTS = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { plot_id: 'PL-002', farm_id: 'fazenda-bom-sucesso' },
      geometry: { type: 'Polygon', coordinates: [[[-52.60, -3.30], [-52.59, -3.30], [-52.59, -3.29], [-52.60, -3.29], [-52.60, -3.30]]] } },
    { type: 'Feature', properties: { plot_id: 'PL-005', farm_id: 'fazenda-bom-sucesso' },
      geometry: { type: 'Polygon', coordinates: [[[-52.70, -3.40], [-52.69, -3.40], [-52.69, -3.39], [-52.70, -3.39], [-52.70, -3.40]]] } },
    { type: 'Feature', properties: { plot_id: 'RM-P1', farm_id: 'rancho-maranta' },
      geometry: { type: 'Polygon', coordinates: [[[-52.58, -3.295], [-52.57, -3.295], [-52.57, -3.29], [-52.58, -3.29], [-52.58, -3.295]]] } },
]};
test('treePlotMatch: a tree inside PL-002 resolves to its plot + farm', () => {
    assert.deepStrictEqual(u.treePlotMatch({ latitude: '-3.295', longitude: '-52.595' }, _PLOTS),
        { plot_id: 'PL-002', farm_id: 'fazenda-bom-sucesso' });
});
test('treePlotMatch: a tree outside every plot is a graceful empty match', () => {
    assert.deepStrictEqual(u.treePlotMatch({ latitude: '-3.0', longitude: '-52.0' }, _PLOTS),
        { plot_id: '', farm_id: '' });
});
test('treePlotMatch: a tree with no/blank coordinates never matches', () => {
    assert.deepStrictEqual(u.treePlotMatch({ latitude: '', longitude: '' }, _PLOTS), { plot_id: '', farm_id: '' });
    assert.deepStrictEqual(u.treePlotMatch({}, _PLOTS), { plot_id: '', farm_id: '' });
    assert.deepStrictEqual(u.treePlotMatch(null, _PLOTS), { plot_id: '', farm_id: '' });
});
test('treePlotMatch: no plot geometry -> graceful empty', () => {
    assert.deepStrictEqual(u.treePlotMatch({ latitude: '-3.295', longitude: '-52.595' }, null), { plot_id: '', farm_id: '' });
});
test('treePlotMatch: a MultiPolygon feature matches on any of its parts', () => {
    const mp = { features: [{ properties: { plot_id: 'MP-1', farm_id: 'multi' }, geometry: { type: 'MultiPolygon', coordinates: [
        [[[-1, -1], [-1, -0.9], [-0.9, -0.9], [-0.9, -1], [-1, -1]]],
        [[[-52.60, -3.30], [-52.59, -3.30], [-52.59, -3.29], [-52.60, -3.29], [-52.60, -3.30]]]
    ] } }] };
    assert.deepStrictEqual(u.treePlotMatch({ latitude: '-3.295', longitude: '-52.595' }, mp), { plot_id: 'MP-1', farm_id: 'multi' });
});
test('farmsWithPlots: unique farm ids in geojson order', () => {
    assert.deepStrictEqual(u.farmsWithPlots(_PLOTS), ['fazenda-bom-sucesso', 'rancho-maranta']);
});
test('plotsForFarm: only that farm\'s plots, order preserved', () => {
    assert.deepStrictEqual(u.plotsForFarm(_PLOTS, 'fazenda-bom-sucesso'), ['PL-002', 'PL-005']);
    assert.deepStrictEqual(u.plotsForFarm(_PLOTS, 'rancho-maranta'), ['RM-P1']);
    assert.deepStrictEqual(u.plotsForFarm(_PLOTS, ''), []);
});
test('farmsById: keys by farm_id, first one wins', () => {
    const by = u.farmsById({ farms: [{ farm_id: 'a', name: 'A' }, { farm_id: 'a', name: 'A2' }, { name: 'no-id' }] });
    assert.strictEqual(by.a.name, 'A');
    assert.strictEqual(Object.keys(by).length, 1);
});
test('treesForFarmPlot: blank facets keep every tree (backward compatible)', () => {
    const trees = [{ latitude: '-3.295', longitude: '-52.595' }, { latitude: '-3.0', longitude: '-52.0' }];
    assert.strictEqual(u.treesForFarmPlot(trees, '', '', _PLOTS).length, 2);
});
test('treesForFarmPlot: a chosen farm hides off-plot trees and other farms', () => {
    const trees = [
        { telegram_message_id: 'in', latitude: '-3.295', longitude: '-52.595' },
        { telegram_message_id: 'off', latitude: '-3.0', longitude: '-52.0' },
        { telegram_message_id: 'other-farm', latitude: '-3.292', longitude: '-52.575' },
    ];
    assert.deepStrictEqual(u.treesForFarmPlot(trees, 'fazenda-bom-sucesso', '', _PLOTS).map(t => t.telegram_message_id), ['in']);
});
test('treesForFarmPlot: a chosen plot narrows within the farm', () => {
    const trees = [
        { telegram_message_id: 'p2', latitude: '-3.295', longitude: '-52.595' },
        { telegram_message_id: 'p5', latitude: '-3.395', longitude: '-52.695' },
    ];
    assert.deepStrictEqual(u.treesForFarmPlot(trees, 'fazenda-bom-sucesso', 'PL-005', _PLOTS).map(t => t.telegram_message_id), ['p5']);
});
test('treesForFarmPlot: plot facet alone still applies (farm blank)', () => {
    const trees = [{ telegram_message_id: 'p2', latitude: '-3.295', longitude: '-52.595' }];
    assert.deepStrictEqual(u.treesForFarmPlot(trees, '', 'PL-002', _PLOTS).map(t => t.telegram_message_id), ['p2']);
});
test('treesForFarmPlot: no plot geometry loaded -> cannot narrow, keep all', () => {
    const trees = [{ latitude: '-3.0', longitude: '-52.0' }];
    assert.strictEqual(u.treesForFarmPlot(trees, 'fazenda-bom-sucesso', '', null).length, 1);
});
test('farmPlotFilterNotApplied: true when a facet is set but no tree is locatable', () => {
    const off = [{ latitude: '-3.0', longitude: '-52.0' }];
    assert.strictEqual(u.farmPlotFilterNotApplied('fazenda-bom-sucesso', '', off, _PLOTS), true);
    assert.strictEqual(u.farmPlotFilterNotApplied('', '', off, _PLOTS), false);
    assert.strictEqual(u.farmPlotFilterNotApplied('fazenda-bom-sucesso', '', [], _PLOTS), false);
    assert.strictEqual(u.farmPlotFilterNotApplied('fazenda-bom-sucesso', '', off, null), true);
    const on = [{ latitude: '-3.295', longitude: '-52.595' }];
    assert.strictEqual(u.farmPlotFilterNotApplied('fazenda-bom-sucesso', '', on, _PLOTS), false);
});

console.log('\npayout-event-utils: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
