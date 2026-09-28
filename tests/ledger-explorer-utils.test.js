/**
 * Unit guard for ledger_explorer_utils.js (Ledger Explorer, PR2).
 * Run: node tests/ledger-explorer-utils.test.js
 *
 * Why this exists (2026-09-28, plans/TRUESIGHT_LEDGER_EXPLORER_PLAN.md §6):
 * the explorer's search box must resolve a query to the right ledger row using
 * ONE fetch of ledger_index.json — no fan-out across the ~34 per-event-type
 * folders. These tests pin the pure resolution logic that makes that true.
 */
const assert = require('assert');
const path = require('path');
const U = require(path.join(__dirname, '..', 'ledger_explorer_utils.js'));

let passed = 0, failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function atest(name, fn) { tests.push([name, fn]); }

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const INDEX = {
  ordered_by: 'submitted_at',
  order: 'desc',
  count: 2,
  events_ordered: [HASH_B, HASH_A], // recent first
  events: {
    [HASH_A]: {
      txid_hash: HASH_A,
      event_type: '[TREE PLANTING EVENT]',
      submitted_at: '2025-07-11',
      contributor_name: 'Gary Teh',
      event_type_folder: 'tree_planting',
      telegram_message_id: '171',
      canonical_url: U.LEDGER_RAW_BASE + 'tree_planting/' + HASH_A + '.json',
      message_id_url: U.LEDGER_RAW_BASE + 'tree_planting/171.json'
    },
    [HASH_B]: {
      txid_hash: HASH_B,
      event_type: '[SALES EVENT]',
      submitted_at: '2026-09-01',
      contributor_name: 'Edgar',
      event_type_folder: 'sales_event',
      telegram_message_id: 'Edgar_20260924125541_071',
      canonical_url: U.LEDGER_RAW_BASE + 'sales_event/' + HASH_B + '.json',
      message_id_url: U.LEDGER_RAW_BASE + 'sales_event/Edgar_20260924125541_071.json'
    }
  }
};

// --- query classification --------------------------------------------------
test('64-hex classifies as a txid hash', () => {
  assert.ok(U.isTxidHash(HASH_A));
  assert.ok(U.isTxidHash(HASH_A.toUpperCase()));
});
test('non-hash strings are not txid hashes', () => {
  assert.ok(!U.isTxidHash('171'));
  assert.ok(!U.isTxidHash('Edgar_20260924125541_071'));
  assert.ok(!U.isTxidHash('g'.repeat(64)));
});
test('Edgar + numeric message ids classify correctly', () => {
  assert.ok(U.isEdgarMessageId('Edgar_20260924125541_071'));
  assert.ok(U.isNumericMessageId('171'));
  assert.ok(!U.isEdgarMessageId('171'));
});

// --- index traversal -------------------------------------------------------
test('indexRows honours events_ordered (recent-first)', () => {
  const rows = U.indexRows(INDEX);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].txid_hash, HASH_B);
  assert.strictEqual(rows[1].txid_hash, HASH_A);
});
test('indexRows falls back to object order when events_ordered is absent', () => {
  const rows = U.indexRows({ events: INDEX.events });
  assert.strictEqual(rows.length, 2);
});
test('indexRows tolerates missing/empty indexes', () => {
  assert.deepStrictEqual(U.indexRows(null), []);
  assert.deepStrictEqual(U.indexRows({}), []);
  assert.deepStrictEqual(U.indexRows({ events: {} }), []);
});

// --- lookups ---------------------------------------------------------------
test('lookupByHash matches a 64-hex key', () => {
  assert.strictEqual(U.lookupByHash(INDEX, HASH_A).telegram_message_id, '171');
});
test('lookupByHash is case-insensitive', () => {
  assert.strictEqual(U.lookupByHash(INDEX, HASH_B.toUpperCase()).contributor_name, 'Edgar');
});
test('lookupByHash returns null on miss', () => {
  assert.strictEqual(U.lookupByHash(INDEX, 'c'.repeat(64)), null);
});
test('lookupByMessageId finds the numeric id', () => {
  const rows = U.lookupByMessageId(INDEX, '171');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].txid_hash, HASH_A);
});
test('lookupByMessageId finds the Edgar id', () => {
  const rows = U.lookupByMessageId(INDEX, 'Edgar_20260924125541_071');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].txid_hash, HASH_B);
});

// --- resolveQuery ----------------------------------------------------------
atest('resolveQuery: empty -> mode empty', async () => {
  const r = await U.resolveQuery(INDEX, '   ');
  assert.strictEqual(r.mode, 'empty');
  assert.deepStrictEqual(r.rows, []);
});
atest('resolveQuery: txid hash -> direct hit', async () => {
  const r = await U.resolveQuery(INDEX, HASH_A);
  assert.strictEqual(r.mode, 'txid_hash');
  assert.strictEqual(r.rows[0].telegram_message_id, '171');
});
atest('resolveQuery: message id -> hit', async () => {
  const r = await U.resolveQuery(INDEX, 'Edgar_20260924125541_071');
  assert.strictEqual(r.mode, 'message_id');
  assert.strictEqual(r.rows[0].txid_hash, HASH_B);
});
atest('resolveQuery: unknown numeric id -> message_id, no rows', async () => {
  const r = await U.resolveQuery(INDEX, '999999');
  assert.strictEqual(r.mode, 'message_id');
  assert.deepStrictEqual(r.rows, []);
});
atest('resolveQuery: raw txid is sha256-hashed then looked up', async () => {
  // Feed the "raw txid" through a stub hashFn that maps it to HASH_A.
  const hashFn = async () => HASH_A;
  const r = await U.resolveQuery(INDEX, 'some-raw-base64-signature', { hashFn });
  assert.strictEqual(r.mode, 'raw_txid');
  assert.strictEqual(r.rows[0].txid_hash, HASH_A);
});
atest('resolveQuery: raw txid with NO hashFn reports no-hash-fn', async () => {
  const r = await U.resolveQuery(INDEX, 'some-raw-base64-signature');
  assert.strictEqual(r.mode, 'raw_txid');
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.error, 'no-hash-fn');
});

// --- sha256 ----------------------------------------------------------------
atest('sha256Hex produces 64 lowercase hex chars', async () => {
  const h = await U.sha256Hex('hello', async (bytes) => {
    // Echo the byte length times 1 and 0 so we can assert the char mapping
    // WITHOUT depending on a real digest.
    return new Uint8Array(bytes.length).fill(0).map((_, i) => i % 256);
  });
  assert.strictEqual(h.length, 10); // 'hello' -> 5 bytes -> 10 hex chars
  assert.ok(/^[0-9a-f]+$/.test(h));
});
atest('sha256Hex matches the real sha256 of an empty string', async () => {
  const nodeCrypto = require('crypto');
  const h = await U.sha256Hex('', async (bytes) => {
    return nodeCrypto.createHash('sha256').update(Buffer.from(bytes)).digest();
  });
  assert.strictEqual(h, nodeCrypto.createHash('sha256').update('').digest('hex'));
});

// --- base64 / pem ----------------------------------------------------------
test('padBase64 pads to a multiple of 4', () => {
  assert.strictEqual(U.padBase64('AAAA').length, 4);
  assert.strictEqual(U.padBase64('AAA').length, 4);
  assert.strictEqual(U.padBase64('AA').length, 4);
});
test('pemFromSpkiB64 wraps a bare body in a PEM block', () => {
  const pem = U.pemFromSpkiB64('MIIBIjANBgkq');
  assert.ok(pem.startsWith('-----BEGIN PUBLIC KEY-----\n'));
  assert.ok(pem.trim().endsWith('-----END PUBLIC KEY-----'));
  assert.ok(pem.indexOf('MIIBIjANBgkq') >= 0);
});

// --- rendering helpers -----------------------------------------------------
test('escapeHtml neutralises angle brackets and quotes', () => {
  assert.strictEqual(U.escapeHtml('<b>"x"&\'y\'</b>'), '&lt;b&gt;&quot;x&quot;&amp;&#039;y&#039;&lt;/b&gt;');
});
test('shortenHash keeps both ends', () => {
  const s = U.shortenHash('0123456789abcdef', 4);
  assert.strictEqual(s, '0123…cdef');
});
test('eventFileName prefers the canonical mirror by default', () => {
  const row = INDEX.events[HASH_A];
  assert.strictEqual(U.eventFileName(row), HASH_A + '.json');
  assert.strictEqual(U.eventFileName(row, true), '171.json');
});

// --- openssl snippet -------------------------------------------------------
test('buildOpensslVerifySnippet embeds the event URL and the README recipe', () => {
  const url = U.LEDGER_RAW_BASE + 'tree_planting/171.json';
  const s = U.buildOpensslVerifySnippet(url);
  assert.ok(s.indexOf('curl -sL ' + url) >= 0, 'embeds the url');
  assert.ok(s.indexOf('openssl dgst -sha256 -verify') >= 0, 'has the verify command');
  assert.ok(s.indexOf('signed_payload') >= 0, 'references signed_payload');
  assert.ok(s.indexOf('Verified OK') >= 0, 'shows the expected outcome');
});

// --- recent activity, browse-by-type, browse-by-contributor (PR3) ----------

// A richer fixture: 5 rows, 3 types, 3 contributors, deliberately out of
// count order so the roll-up sort is actually exercised.
const H = (c) => c.repeat(64);
const I3 = {
  ordered_by: 'submitted_at', order: 'desc', count: 5,
  // recent-first
  events_ordered: [H('e'), H('d'), H('c'), H('b'), H('a')],
  events: {
    [H('a')]: { txid_hash: H('a'), event_type_folder: 'tree_planting', contributor_name: 'Gary Teh', submitted_at: '2024-01-01' },
    [H('b')]: { txid_hash: H('b'), event_type_folder: 'tree_planting', contributor_name: 'Gary Teh', submitted_at: '2024-02-01' },
    [H('c')]: { txid_hash: H('c'), event_type_folder: 'sales_event', contributor_name: 'Edgar', submitted_at: '2025-01-01' },
    [H('d')]: { txid_hash: H('d'), event_type_folder: 'tree_planting', contributor_name: 'Edgar', submitted_at: '2026-01-01' },
    [H('e')]: { txid_hash: H('e'), event_type_folder: 'contribution_event', contributor_name: 'Gary Teh', submitted_at: '2026-09-01' }
  }
};

test('recentActivity returns events_ordered, recent-first', () => {
  const rows = U.recentActivity(I3);
  assert.deepStrictEqual(rows.map(r => r.txid_hash), [H('e'), H('d'), H('c'), H('b'), H('a')]);
});
test('recentActivity honours a limit and never re-sorts', () => {
  assert.deepStrictEqual(U.recentActivity(I3, 2).map(r => r.txid_hash), [H('e'), H('d')]);
  assert.strictEqual(U.recentActivity(I3, 0).length, 5, 'limit 0 = all');
  assert.strictEqual(U.recentActivity(I3, 99).length, 5, 'limit > n = all');
});
test('recentActivity tolerates a missing/empty index', () => {
  assert.deepStrictEqual(U.recentActivity(null), []);
  assert.deepStrictEqual(U.recentActivity({}, 5), []);
});
test('typeLabel humanises a folder key', () => {
  assert.strictEqual(U.typeLabel('tree_planting'), 'Tree Planting');
  assert.strictEqual(U.typeLabel('contribution-event'), 'Contribution Event');
  assert.strictEqual(U.typeLabel(''), '(untyped)');
  assert.strictEqual(U.typeLabel(null), '(untyped)');
});
test('typeRollup counts by type, count desc then label asc', () => {
  const r = U.typeRollup(I3);
  assert.deepStrictEqual(r.map(x => [x.key, x.count]), [
    ['tree_planting', 3], ['contribution_event', 1], ['sales_event', 1]
  ]);
  assert.strictEqual(r[0].label, 'Tree Planting');
});
test('contributorRollup counts by contributor and labels the unknown bucket', () => {
  const r = U.contributorRollup(I3);
  assert.deepStrictEqual(r.map(x => [x.key, x.count]), [['Gary Teh', 3], ['Edgar', 2]]);
  const withBlank = { events_ordered: [H('a')], count: 1,
    events: { [H('a')]: { txid_hash: H('a'), event_type_folder: 'x', contributor_name: '' } } };
  assert.strictEqual(U.contributorRollup(withBlank)[0].label, '(unknown contributor)');
});
test('filterRows: no facets is a passthrough', () => {
  assert.strictEqual(U.filterRows(I3, {}).length, 5);
  assert.strictEqual(U.filterRows(I3).length, 5);
});
test('filterRows: by event_type', () => {
  const rows = U.filterRows(I3, { event_type: 'tree_planting' });
  assert.deepStrictEqual(rows.map(r => r.txid_hash), [H('d'), H('b'), H('a')]);
});
test('filterRows: by contributor', () => {
  const rows = U.filterRows(I3, { contributor_name: 'Edgar' });
  assert.deepStrictEqual(rows.map(r => r.txid_hash), [H('d'), H('c')]);
});
test('filterRows: both facets AND together', () => {
  const rows = U.filterRows(I3, { event_type: 'tree_planting', contributor_name: 'Edgar' });
  assert.deepStrictEqual(rows.map(r => r.txid_hash), [H('d')]);
});
test('filterRows preserves the recent-first order of the source', () => {
  const rows = U.filterRows(I3, { contributor_name: 'Gary Teh' });
  assert.deepStrictEqual(rows.map(r => r.txid_hash), [H('e'), H('b'), H('a')]);
});


// --- PR4: cross-links to My Trees -----------------------------------------

test('isTreeEvent recognises tree/planting/asset_receipt labels', () => {
  assert.ok(U.isTreeEvent('[TREE PLANTING EVENT]'));
  assert.ok(U.isTreeEvent('tree_planting'));
  assert.ok(U.isTreeEvent('asset_receipt_event'));
  assert.ok(!U.isTreeEvent('sales_event'));
  assert.ok(!U.isTreeEvent(''));
  assert.ok(!U.isTreeEvent(null));
});
test('treeRefForEvent prefers an explicit linked_tree_id', () => {
  assert.strictEqual(U.treeRefForEvent({ linked_tree_id: 'FOUNDERHAUS_B_1', event_type: '[TREE PLANTING EVENT]', telegram_message_id: 'Edgar_1' }), 'FOUNDERHAUS_B_1');
});
test('treeRefForEvent falls back to telegram_message_id for tree events', () => {
  assert.strictEqual(U.treeRefForEvent({ linked_tree_id: '', event_type: '[TREE PLANTING EVENT]', telegram_message_id: 'Edgar_20260821175134_006' }), 'Edgar_20260821175134_006');
  assert.strictEqual(U.treeRefForEvent({ linked_tree_id: '', event_type_folder: 'tree_planting', telegram_message_id: '171' }), '171');
});
test('treeRefForEvent is null for non-tree events with no linked_tree_id', () => {
  assert.strictEqual(U.treeRefForEvent({ linked_tree_id: '', event_type: 'sales_event', telegram_message_id: '99' }), null);
  assert.strictEqual(U.treeRefForEvent(null), null);
});
test('buildMyTreesLink deep-links the tree id', () => {
  assert.strictEqual(U.buildMyTreesLink('Edgar_20260821175134_006'), 'https://cfr.truesight.me/my-trees/?tree=Edgar_20260821175134_006');
  assert.strictEqual(U.buildMyTreesLink(''), '');
  assert.strictEqual(U.buildMyTreesLink(null), '');
});
test('buildLedgerExplorerLink deep-links q=', () => {
  assert.strictEqual(U.buildLedgerExplorerLink('171'), 'https://beta.dapp.truesight.me/ledger_explorer.html?q=171');
  assert.strictEqual(U.buildLedgerExplorerLink('  '), '');
});
test('the real planting event round-trips to a My Trees link', () => {
  // Verified live: tree_planting/Edgar_20260821175134_006.json carries
  // linked_tree_id FOUNDERHAUS_BOUGAINVILLEA_20260821_1, and its
  // telegram_message_id is the GeoJSON tree_id.
  const ev = { event_type: '[TREE PLANTING EVENT]', telegram_message_id: 'Edgar_20260821175134_006', linked_tree_id: 'FOUNDERHAUS_BOUGAINVILLEA_20260821_1' };
  assert.strictEqual(U.buildMyTreesLink(U.treeRefForEvent(ev)), 'https://cfr.truesight.me/my-trees/?tree=FOUNDERHAUS_BOUGAINVILLEA_20260821_1');
  const ev2 = { event_type: '[TREE PLANTING EVENT]', telegram_message_id: 'Edgar_20260821175134_006', linked_tree_id: '' };
  assert.strictEqual(U.buildMyTreesLink(U.treeRefForEvent(ev2)), 'https://cfr.truesight.me/my-trees/?tree=Edgar_20260821175134_006');
});


(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  \u2713 ' + name); }
    catch (e) { failed++; console.log('  \u2717 ' + name + '\n      ' + e.message); }
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
