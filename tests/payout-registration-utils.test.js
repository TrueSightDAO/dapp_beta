/**
 * Unit tests for payout-registration-utils.js
 * Run: node tests/payout-registration-utils.test.js
 *
 * The privacy-critical assertions are:
 *   - a raw PIX key NEVER appears in buildRedactedSummary() output
 *   - maskPixKey() never leaks more than the trailing 1-4 chars
 */
const assert = require('assert');
const u = require('../payout-registration-utils.js');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

// --- CPF -------------------------------------------------------------------
test('isValidCpf accepts a valid CPF (dotted)', () => {
    assert.strictEqual(u.isValidCpf('111.444.777-35'), true);
});
test('isValidCpf rejects bad check digits', () => {
    assert.strictEqual(u.isValidCpf('111.444.777-36'), false);
});
test('isValidCpf rejects all-same-digit', () => {
    assert.strictEqual(u.isValidCpf('11111111111'), false);
});
test('isValidCpf rejects wrong length', () => {
    assert.strictEqual(u.isValidCpf('123456789'), false);
});

// --- CNPJ ------------------------------------------------------------------
test('isValidCnpj accepts a valid CNPJ', () => {
    assert.strictEqual(u.isValidCnpj('11.222.333/0001-81'), true);
});
test('isValidCnpj rejects bad check digits', () => {
    assert.strictEqual(u.isValidCnpj('11.222.333/0001-82'), false);
});

// --- email / phone / EVP ---------------------------------------------------
test('isValidEmail basic', () => {
    assert.strictEqual(u.isValidEmail('maria@example.com'), true);
    assert.strictEqual(u.isValidEmail('nope'), false);
});
test('isValidPhone requires country-code signal', () => {
    assert.strictEqual(u.isValidPhone('+55 11 99999-8888'), true);
    assert.strictEqual(u.isValidPhone('999998888'), false);      // bare 9 -> ambiguous
    assert.strictEqual(u.isValidPhone('5511999998888'), true);   // 13 digits
});
test('isEvp recognises a 32-hex random key', () => {
    assert.strictEqual(u.isEvp('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.strictEqual(u.isEvp('deadbeefdeadbeefdeadbeefdeadbeef'), true);
    assert.strictEqual(u.isEvp('not-a-key'), false);
});

// --- detection -------------------------------------------------------------
test('detectPixKeyType classifies each shape', () => {
    assert.strictEqual(u.detectPixKeyType('111.444.777-35'), 'CPF');
    assert.strictEqual(u.detectPixKeyType('11.222.333/0001-81'), 'CNPJ');
    assert.strictEqual(u.detectPixKeyType('a@b.com'), 'EMAIL');
    assert.strictEqual(u.detectPixKeyType('+5511999998888'), 'PHONE');
    assert.strictEqual(u.detectPixKeyType('deadbeefdeadbeefdeadbeefdeadbeef'), 'EVP');
});

// --- validation ------------------------------------------------------------
test('validatePixKey returns {valid,type,reason}', () => {
    const ok = u.validatePixKey('111.444.777-35');
    assert.strictEqual(ok.valid, true);
    assert.strictEqual(ok.type, 'CPF');
    const bad = u.validatePixKey('111.444.777-36');
    assert.strictEqual(bad.valid, false);
    assert.ok(bad.reason);
});
test('validatePixKey flags empty', () => {
    assert.strictEqual(u.validatePixKey('').valid, false);
});

// --- masking (privacy) -----------------------------------------------------
test('maskPixKey CPF leaks only last 2 digits', () => {
    const m = u.maskPixKey('111.444.777-35');
    assert.strictEqual(m, '***.***.***-35');
    assert.ok(!m.includes('444'));
});
test('maskPixKey email keeps only 1st char + domain', () => {
    const m = u.maskPixKey('maria@example.com');
    assert.strictEqual(m, 'm***@example.com');
    assert.ok(!m.includes('aria'));
});
test('maskPixKey phone leaks only last 4', () => {
    assert.strictEqual(u.maskPixKey('+5511999998888'), '****8888');
});

// --- payload split (the core contract) -------------------------------------
test('buildPayoutRegistrationPayload carries the RAW key (private sink only)', () => {
    const p = u.buildPayoutRegistrationPayload({
        studentName: 'Maria', studentEmail: 'M@X.com', pkHash: 'abc',
        programSlug: 'crf-anapu', pixKey: '111.444.777-35',
        submissionSource: 'https://cfr.truesight.me/payout_registration.html'
    });
    assert.strictEqual(p.pix_key, '111.444.777-35');
    assert.strictEqual(p.pix_key_type, 'CPF');
    assert.strictEqual(p.student_email, 'm@x.com');  // lower-cased
    assert.strictEqual(p.has_key, true);
    assert.strictEqual(p.relationship, 'self');      // default
});

test('buildPayoutRegistrationPayload honours a no-key student', () => {
    const p = u.buildPayoutRegistrationPayload({
        studentName: 'Joao', pixKey: '', noKeyChannel: 'guardian bank transfer'
    });
    assert.strictEqual(p.has_key, false);
    assert.strictEqual(p.no_key_channel, 'guardian bank transfer');
});

test('PRIVACY: redacted summary NEVER contains the raw key', () => {
    const raw = '111.444.777-35';
    const s = u.buildRedactedSummary({
        studentName: 'Maria', programSlug: 'crf-anapu', pixKey: raw
    });
    assert.ok(!s.includes(raw), 'raw CPF leaked into summary!');
    assert.ok(!s.includes('444'), 'middle digits leaked!');
    assert.ok(s.includes('***.***.***-35'));
    assert.ok(s.includes('[PAYOUT REGISTRATION]'));
});

test('PRIVACY: redacted summary of an email key never leaks the local part', () => {
    const s = u.buildRedactedSummary({ studentName: 'A', pixKey: 'maria@example.com' });
    assert.ok(!s.includes('maria'));
    assert.ok(s.includes('m***@example.com'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
