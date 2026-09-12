/**
 * Unit tests for asset-receipt-form-utils.js
 * Run: node tests/asset-receipt-form-utils.test.js
 */
const assert = require('assert');
const {
    isFormValid,
    buttonLabel,
    emptyFormState,
    SUBMIT_LABEL,
    SUBMIT_ANOTHER_LABEL,
    DEFAULT_AMOUNT
} = require('../asset-receipt-form-utils.js');

function test(name, fn) {
    try {
        fn();
        console.log(`  \u2713 ${name}`);
        return true;
    } catch (err) {
        console.error(`  \u2717 ${name}`);
        console.error(`    ${err.message}`);
        return false;
    }
}

console.log('\nAsset Receipt Form Utils - Unit Tests\n');

let passed = 0;
let failed = 0;

const VALID = {
    fundHandler: 'Gary Teh',
    currency: 'Ceremonial Cacao',
    amount: '2',
    description: 'Receipt for 2 units'
};

console.log('isFormValid:');
passed += test('all fields present -> true', () => assert.strictEqual(isFormValid(VALID), true));
passed += test('empty object -> false', () => assert.strictEqual(isFormValid({}), false));
passed += test('null -> false', () => assert.strictEqual(isFormValid(null), false));
passed += test('missing fundHandler -> false', () => assert.strictEqual(isFormValid({ ...VALID, fundHandler: '' }), false));
passed += test('missing currency -> false', () => assert.strictEqual(isFormValid({ ...VALID, currency: '' }), false));
passed += test('missing description -> false', () => assert.strictEqual(isFormValid({ ...VALID, description: '' }), false));
passed += test('whitespace-only description -> false', () => assert.strictEqual(isFormValid({ ...VALID, description: '   ' }), false));
passed += test('amount "0" -> false', () => assert.strictEqual(isFormValid({ ...VALID, amount: '0' }), false));
passed += test('amount "-1" -> false', () => assert.strictEqual(isFormValid({ ...VALID, amount: '-1' }), false));
passed += test('amount "abc" -> false', () => assert.strictEqual(isFormValid({ ...VALID, amount: 'abc' }), false));
passed += test('amount "" -> false', () => assert.strictEqual(isFormValid({ ...VALID, amount: '' }), false));
passed += test('amount "1" -> true', () => assert.strictEqual(isFormValid({ ...VALID, amount: '1' }), true));
passed += test('amount 2 (number) -> true', () => assert.strictEqual(isFormValid({ ...VALID, amount: 2 }), true));
passed += test('returns a real boolean', () => assert.strictEqual(typeof isFormValid(VALID), 'boolean'));

console.log('buttonLabel:');
passed += test('before submission -> "Submit Asset Receipt Report"', () =>
    assert.strictEqual(buttonLabel(false), SUBMIT_LABEL));
passed += test('after submission -> "Submit another one"', () =>
    assert.strictEqual(buttonLabel(true), SUBMIT_ANOTHER_LABEL));
passed += test('SUBMIT_ANOTHER_LABEL text is exact', () =>
    assert.strictEqual(SUBMIT_ANOTHER_LABEL, 'Submit another one'));

console.log('emptyFormState:');
passed += test('text fields cleared, amount back to markup default', () => {
    const s = emptyFormState();
    assert.strictEqual(s.fundHandler, '');
    assert.strictEqual(s.currency, '');
    assert.strictEqual(s.description, '');
    assert.strictEqual(s.amount, DEFAULT_AMOUNT);
    assert.strictEqual(s.amount, '1');
});

console.log(`\nPassed: ${passed}  Failed: ${failed}\n`);
if (failed > 0) process.exit(1);
