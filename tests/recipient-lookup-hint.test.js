/**
 * Unit guard for the recipient-lookup loading hint on report_payout_event.html
 * Run: node tests/recipient-lookup-hint.test.js
 *
 * Why this exists (2026-09-28, Gary's "recipient PK hash still not populating"):
 * getTreeRecipientMap and getPendingPayoutRegistrations are served by the SAME
 * Apps Script deployment, so the platform SERIALISES them and the map can answer
 * several seconds late. The field used to render blank with placeholder
 * "Leave blank if not yet registered" -- indistinguishable from "no registration
 * found" -- so the operator concluded the page was broken. The page now shows an
 * honest "Looking up recipient..." state and a distinct "not found" state.
 *
 * STRUCTURAL guard: asserts the wiring exists and is correctly ordered in the
 * source. Behavioural proof lives in tests/report_payout_event.spec.ts.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'report_payout_event.html'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  \u2713 ' + name); }
  catch (e) { failed++; console.log('  \u2717 ' + name + '\n      ' + e.message); }
}
function count(needle) { return SRC.split(needle).length - 1; }

test('a #recipientLookupStatus hint element exists next to recipientPkHash', () => {
  assert.strictEqual(count('id="recipientLookupStatus"'), 1, 'expected exactly one hint element');
  assert.ok(/id="recipientLookupStatus"\s+class="hint"/.test(SRC), 'hint element must carry class="hint"');
});

test('the module tracks whether the map fetch has settled', () => {
  assert.ok(/let _treeRecipientMapLoaded = false;/.test(SRC), 'missing _treeRecipientMapLoaded declaration');
});

test('updateRecipientLookupHint() is defined and wired from selectTreeById', () => {
  assert.ok(/function updateRecipientLookupHint\(\)/.test(SRC), 'missing function definition');
  assert.ok(count('updateRecipientLookupHint()') >= 5, 'expected def + >=4 call sites, found ' + count('updateRecipientLookupHint()'));
  assert.ok(/maybeAutoFillRecipient\(id \? \[id\] : \[\]\);\s*\n\s*updateRecipientLookupHint\(\);/.test(SRC),
    'selectTreeById must call updateRecipientLookupHint after maybeAutoFillRecipient');
});

test('both the success and give-up paths mark the map loaded and refresh the hint', () => {
  assert.ok(count('_treeRecipientMapLoaded = true;') >= 3,
    'expected success + !ok give-up + catch give-up paths to set loaded, found ' + count('_treeRecipientMapLoaded = true;'));
});

test('the two honest states are present (loading vs not-found)', () => {
  assert.ok(SRC.includes('Looking up recipient\\u2026'), 'missing loading copy');
  assert.ok(SRC.includes('No payout registration found for this tree'), 'missing not-found copy');
  assert.ok(/el\.className = 'hint loading';/.test(SRC), 'loading state must reuse .hint.loading');
});

test('a selected tree with NO registration CLEARS an auto-filled pk_hash (never rides along)', () => {
  // The clear branch: only an auto-filled value is emptied; a typed one is kept.
  assert.ok(/pkEl\.value = '';\s*\n\s*_autoFilledPk = '';/.test(SRC),
    'maybeAutoFillRecipient must clear the field when the map has no entry');
  assert.ok(/if \(cur !== '' && cur !== _autoFilledPk\) return;/.test(SRC),
    'operator-typed values must be protected before the fill/clear logic');
});

console.log('\n' + (failed ? '\u274c' : '\u2705') + ' recipient-lookup-hint: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
