/**
 * Unit tests for expense-form-utils.js
 * Run: node tests/expense-form-utils.test.js
 */
const assert = require('assert');
const {
    extractLedgerFromResource,
    extractCleanCurrency,
    normalizeLedgerName,
    buildSubmitPayload,
    validateDescription,
    normalizeDescription,
    generateExpenseFileName,
    extractClipboardFile,
    hasAttachableFile,
    PASSTHROUGH_MIME_TYPES
} = require('../expense-form-utils.js');

// Minimal stand-ins for the browser objects the extractor touches.
function fakeFile(name, type) {
    return { name, type };
}
function clipboard({ files = [], items = [] }) {
    return { files, items };
}
function fileItem(file) {
    return { kind: 'file', getAsFile: () => file };
}
function stringItem(str) {
    return { kind: 'string', getAsString: () => str };
}

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        return true;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        return false;
    }
}

console.log('\nExpense Form Utils - Unit Tests\n');

let passed = 0;
let failed = 0;

// extractLedgerFromResource
console.log('extractLedgerFromResource:');
passed += test('[AGL15] USD → AGL15', () => assert.strictEqual(extractLedgerFromResource('[AGL15] USD'), 'AGL15'));
passed += test('[AGL10] EUR → AGL10', () => assert.strictEqual(extractLedgerFromResource('[AGL10] EUR'), 'AGL10'));
passed += test('USD → null', () => assert.strictEqual(extractLedgerFromResource('USD'), null));
passed += test('empty string → null', () => assert.strictEqual(extractLedgerFromResource(''), null));
passed += test('null → null', () => assert.strictEqual(extractLedgerFromResource(null), null));
passed += test('[AGL 10] USD → AGL 10', () => assert.strictEqual(extractLedgerFromResource('[AGL 10] USD'), 'AGL 10'));

// extractCleanCurrency - CRITICAL: prevents regression of Column I = [AGL15] USD
console.log('\nextractCleanCurrency (Column I = clean currency):');
passed += test('[AGL15] USD → USD', () => assert.strictEqual(extractCleanCurrency('[AGL15] USD'), 'USD'));
passed += test('[AGL10] EUR → EUR', () => assert.strictEqual(extractCleanCurrency('[AGL10] EUR'), 'EUR'));
passed += test('USD → USD', () => assert.strictEqual(extractCleanCurrency('USD'), 'USD'));
passed += test('plain currency unchanged', () => assert.strictEqual(extractCleanCurrency('EUR'), 'EUR'));
passed += test('empty string → empty', () => assert.strictEqual(extractCleanCurrency(''), ''));
passed += test('null → empty', () => assert.strictEqual(extractCleanCurrency(null), ''));
passed += test('whitespace trimmed', () => assert.strictEqual(extractCleanCurrency('[AGL15]  USD  '), 'USD'));

// normalizeLedgerName
console.log('\nnormalizeLedgerName:');
passed += test('AGL15 → agl15', () => assert.strictEqual(normalizeLedgerName('AGL15'), 'agl15'));
passed += test('AGL 15 → agl15', () => assert.strictEqual(normalizeLedgerName('AGL 15'), 'agl15'));
passed += test('AGL-15 → agl15', () => assert.strictEqual(normalizeLedgerName('AGL-15'), 'agl15'));
passed += test('empty → empty', () => assert.strictEqual(normalizeLedgerName(''), ''));

// buildSubmitPayload
console.log('\nbuildSubmitPayload (resourceName + targetLedger):');
let r = buildSubmitPayload('[AGL15] USD', '');
passed += test('raw [AGL15] USD, no ledger → USD, AGL15', () => {
    const p = buildSubmitPayload('[AGL15] USD', '');
    assert.strictEqual(p.resourceName, 'USD');
    assert.strictEqual(p.targetLedger, 'AGL15');
});
passed += test('raw [AGL15] USD, ledger AGL15 → USD, AGL15', () => {
    const p = buildSubmitPayload('[AGL15] USD', 'AGL15');
    assert.strictEqual(p.resourceName, 'USD');
    assert.strictEqual(p.targetLedger, 'AGL15');
});
passed += test('raw USD, ledger AGL10 → USD, AGL10', () => {
    const p = buildSubmitPayload('USD', 'AGL10');
    assert.strictEqual(p.resourceName, 'USD');
    assert.strictEqual(p.targetLedger, 'AGL10');
});
passed += test('raw USD, no ledger → USD, offchain', () => {
    const p = buildSubmitPayload('USD', '');
    assert.strictEqual(p.resourceName, 'USD');
    assert.strictEqual(p.targetLedger, 'offchain');
});
passed += test('raw USD, ledger offchain → USD, offchain', () => {
    const p = buildSubmitPayload('USD', 'offchain');
    assert.strictEqual(p.resourceName, 'USD');
    assert.strictEqual(p.targetLedger, 'offchain');
});

// validateDescription
console.log('\nvalidateDescription:');
passed += test('valid description', () => assert.strictEqual(validateDescription('Office supplies'), true));
passed += test('accepts newline (multiline now allowed)', () => assert.strictEqual(validateDescription('Line1\nLine2'), true));
passed += test('accepts carriage return (multiline now allowed)', () => assert.strictEqual(validateDescription('Line1\rLine2'), true));
passed += test('empty → false', () => assert.strictEqual(validateDescription(''), false));
passed += test('whitespace-only → false', () => assert.strictEqual(validateDescription('   \n  '), false));

// generateExpenseFileName
console.log('\ngenerateExpenseFileName:');
const fn = generateExpenseFileName('receipt.pdf', 'Gary Teh');
passed += test('contains expense prefix', () => assert.ok(fn.startsWith('expense_')));
passed += test('contains contributor', () => assert.ok(fn.includes('gary_teh')));
passed += test('contains filename', () => assert.ok(fn.includes('receipt.pdf') || fn.includes('receipt_pdf')));
passed += test('sanitizes special chars', () => {
    const f = generateExpenseFileName('file (1).pdf', 'Test User');
    assert.ok(!f.includes(' ') && !f.includes('(') && !f.includes(')'));
});

// extractClipboardFile
console.log('\nextractClipboardFile:');
passed += test('prefers .files when present', () => {
    const f = fakeFile('a.png', 'image/png');
    assert.strictEqual(extractClipboardFile(clipboard({ files: [f] })), f);
});
passed += test('falls back to .items kind=file (mobile Safari behaviour)', () => {
    const f = fakeFile('b.png', 'image/png');
    assert.strictEqual(extractClipboardFile(clipboard({ items: [fileItem(f)] })), f);
});
passed += test('skips string items and finds the file among them', () => {
    const f = fakeFile('c.pdf', 'application/pdf');
    const cd = clipboard({ items: [stringItem('hello'), fileItem(f)] });
    assert.strictEqual(extractClipboardFile(cd), f);
});
passed += test('null clipboardData -> null', () =>
    assert.strictEqual(extractClipboardFile(null), null));
passed += test('undefined clipboardData -> null', () =>
    assert.strictEqual(extractClipboardFile(undefined), null));
passed += test('plain text clipboard -> null (no file to attach)', () =>
    assert.strictEqual(extractClipboardFile(clipboard({ items: [stringItem('just text')] })), null));
passed += test('empty clipboard -> null', () =>
    assert.strictEqual(extractClipboardFile(clipboard({})), null));
passed += test('item whose getAsFile() returns null -> null', () =>
    assert.strictEqual(extractClipboardFile(clipboard({ items: [{ kind: 'file', getAsFile: () => null }] })), null));

// hasAttachableFile
console.log('\nhasAttachableFile:');
passed += test('png is attachable', () =>
    assert.strictEqual(hasAttachableFile(clipboard({ files: [fakeFile('a.png', 'image/png')] })), true));
passed += test('pdf is attachable', () =>
    assert.strictEqual(hasAttachableFile(clipboard({ files: [fakeFile('a.pdf', 'application/pdf')] })), true));
passed += test('gif is attachable', () =>
    assert.strictEqual(hasAttachableFile(clipboard({ files: [fakeFile('a.gif', 'image/gif')] })), true));
passed += test('text/plain file is NOT attachable', () =>
    assert.strictEqual(hasAttachableFile(clipboard({ files: [fakeFile('a.txt', 'text/plain')] })), false));
passed += test('no file -> false', () =>
    assert.strictEqual(hasAttachableFile(clipboard({})), false));
passed += test('accepts an explicit allowedTypes override', () =>
    assert.strictEqual(hasAttachableFile(clipboard({ files: [fakeFile('a.txt', 'text/plain')] }), ['text/plain']), true));

// PASSTHROUGH_MIME_TYPES
console.log('\nPASSTHROUGH_MIME_TYPES:');
passed += test('is the four types the expense form accepts', () =>
    assert.deepStrictEqual(PASSTHROUGH_MIME_TYPES, ['image/png', 'image/jpeg', 'image/gif', 'application/pdf']));

// normalizeDescription
console.log('\nnormalizeDescription:');
passed += test('single line unchanged', () => assert.strictEqual(normalizeDescription('Office supplies'), 'Office supplies'));
passed += test('joins logical lines with a pipe', () => assert.strictEqual(normalizeDescription('Line1\nLine2'), 'Line1 | Line2'));
passed += test('CRLF normalised', () => assert.strictEqual(normalizeDescription('A\r\nB'), 'A | B'));
passed += test('blank lines dropped', () => assert.strictEqual(normalizeDescription('A\n\n\nB'), 'A | B'));
passed += test('no leading newline before the next field marker', () => assert.ok(!/\n/.test(normalizeDescription('A\n- not a new field'))));
passed += test('line starting with dash stays inline', () => assert.strictEqual(normalizeDescription('A\n- B'), 'A | - B'));
passed += test('trims surrounding whitespace', () => assert.strictEqual(normalizeDescription('  A  \n  B  '), 'A | B'));
passed += test('null -> empty', () => assert.strictEqual(normalizeDescription(null), ''));

console.log('\n---');
console.log(`Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
