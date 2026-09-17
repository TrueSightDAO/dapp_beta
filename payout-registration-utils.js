/**
 * Payout Registration form utility functions - isomorphic (browser + Node).
 * Used by payout_registration.html and tested in
 * tests/payout-registration-utils.test.js
 *
 * ---------------------------------------------------------------------------
 * PRIVACY CONTRACT (CRF Anapu support agreement §9 / Brazil LGPD).
 *
 * A PIX key is frequently a CPF or CNPJ, i.e. a Brazilian national tax id.
 * Anything submitted to Edgar (`/dao/submit_contribution`) lands in the
 * Telegram Chat Logs intake and is republished as a PUBLIC raw chatlog
 * (truesight.me/submissions/raw-telegram-chatlogs). A raw PIX key therefore
 * MUST NEVER travel inside an Edgar-signed payload.
 *
 * This module only ever:
 *   1. validates a PIX key locally,
 *   2. classifies its type (CPF | CNPJ | EMAIL | PHONE | EVP),
 *   3. MASKS it for on-screen display / echo.
 *
 * The raw key travels ONLY to the dedicated PRIVATE sink
 * (PAYOUT_SINK_URL in payout_registration.html) and is never echoed in full.
 * ---------------------------------------------------------------------------
 */
(function (global) {
    'use strict';

    function _str(v) { return v == null ? '' : String(v); }
    function digitsOnly(v) { return _str(v).replace(/\D/g, ''); }

    // --- CPF ---------------------------------------------------------------
    // 11 digits + two check digits. All-same-digit strings are rejected
    // (they pass the arithmetic but are never valid in practice).
    function isValidCpf(value) {
        var d = digitsOnly(value);
        if (d.length !== 11) return false;
        if (/^(\d)\1{10}$/.test(d)) return false;
        var sum = 0, i;
        for (i = 0; i < 9; i++) sum += parseInt(d.charAt(i), 10) * (10 - i);
        var r = (sum * 10) % 11;
        if (r === 10) r = 0;
        if (r !== parseInt(d.charAt(9), 10)) return false;
        sum = 0;
        for (i = 0; i < 10; i++) sum += parseInt(d.charAt(i), 10) * (11 - i);
        r = (sum * 10) % 11;
        if (r === 10) r = 0;
        return r === parseInt(d.charAt(10), 10);
    }

    // --- CNPJ --------------------------------------------------------------
    function isValidCnpj(value) {
        var d = digitsOnly(value);
        if (d.length !== 14) return false;
        if (/^(\d)\1{13}$/.test(d)) return false;
        var w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        var w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        function dv(digits, weights) {
            var s = 0;
            for (var i = 0; i < weights.length; i++) s += parseInt(digits.charAt(i), 10) * weights[i];
            var r = s % 11;
            return r < 2 ? 0 : 11 - r;
        }
        if (dv(d, w1) !== parseInt(d.charAt(12), 10)) return false;
        return dv(d, w2) === parseInt(d.charAt(13), 10);
    }

    // --- email -------------------------------------------------------------
    function isValidEmail(v) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_str(v).trim());
    }

    // --- phone (E.164; Brazil default) -------------------------------------
    // A bare 10-11 digit string is indistinguishable from a CPF, so require an
    // explicit country-code signal ('+' prefix, or >= 12 digits).
    function isValidPhone(v) {
        var raw = _str(v).trim();
        var s = raw.replace(/[\s().-]/g, '');
        if (!/^\+?\d{10,15}$/.test(s)) return false;
        return s.charAt(0) === '+' || s.replace(/\D/g, '').length >= 12;
    }

    // --- EVP (PIX "chave aleatória") ---------------------------------------
    function isEvp(v) {
        var s = _str(v).trim().toLowerCase();
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
            || /^[0-9a-f]{32}$/.test(s);
    }

    var TYPES = ['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'];

    /** Best-effort type classification (shape-based fallback for bad checksums). */
    function detectPixKeyType(value) {
        var s = _str(value).trim();
        if (!s) return '';
        if (isValidCpf(s)) return 'CPF';
        if (isValidCnpj(s)) return 'CNPJ';
        if (isValidEmail(s)) return 'EMAIL';
        if (isEvp(s)) return 'EVP';
        if (isValidPhone(s)) return 'PHONE';
        var d = digitsOnly(s);
        if (d.length === 11) return 'CPF';
        if (d.length === 14) return 'CNPJ';
        return '';
    }

    /** Full validation -> { valid, type, reason }. */
    function validatePixKey(value) {
        var s = _str(value).trim();
        if (!s) return { valid: false, type: '', reason: 'PIX key is empty.' };
        if (isValidCpf(s)) return { valid: true, type: 'CPF' };
        if (isValidCnpj(s)) return { valid: true, type: 'CNPJ' };
        if (isValidEmail(s)) return { valid: true, type: 'EMAIL' };
        if (isEvp(s)) return { valid: true, type: 'EVP' };
        if (isValidPhone(s)) return { valid: true, type: 'PHONE' };
        var d = digitsOnly(s);
        if (d.length === 11) return { valid: false, type: 'CPF', reason: 'CPF check digits do not match.' };
        if (d.length === 14) return { valid: false, type: 'CNPJ', reason: 'CNPJ check digits do not match.' };
        return { valid: false, type: '', reason: 'Not a recognised PIX key (CPF, CNPJ, email, phone or random key).' };
    }

    /** Mask a PIX key for safe display. Never returns more than the last 1-4 chars. */
    function maskPixKey(value, type) {
        var s = _str(value).trim();
        if (!s) return '';
        type = type || detectPixKeyType(s);
        if (type === 'CPF') { var a = digitsOnly(s); return '***.***.***-' + a.slice(-2); }
        if (type === 'CNPJ') { var b = digitsOnly(s); return '**.***.***/****-' + b.slice(-2); }
        if (type === 'EMAIL') { var at = s.indexOf('@'); return s.charAt(0) + '***' + (at >= 0 ? s.slice(at) : ''); }
        if (type === 'EVP') { return s.slice(0, 4) + '…' + s.slice(-4); }
        if (type === 'PHONE') { return '****' + s.slice(-4); }
        return '****' + s.slice(-4);
    }

    /**
     * The object written to the PRIVATE sink. This is the ONLY place a raw
     * pix_key is carried -- it must never be passed to Edgar.
     */
    function buildPayoutRegistrationPayload(fields) {
        fields = fields || {};
        var key = _str(fields.pixKey).trim();
        return {
            student_name: _str(fields.studentName).trim(),
            student_email: _str(fields.studentEmail).trim().toLowerCase(),
            pk_hash: _str(fields.pkHash).trim(),
            program_slug: _str(fields.programSlug).trim(),
            pix_key_type: fields.pixKeyType || detectPixKeyType(key),
            pix_key: key,
            account_holder: _str(fields.accountHolder).trim(),
            relationship: _str(fields.relationship).trim() || 'self',
            has_key: Boolean(key),
            no_key_channel: _str(fields.noKeyChannel).trim(),
            submission_source: _str(fields.submissionSource).trim()
        };
    }

    /**
     * A public-safe, redacted summary. Deliberately carries NO raw key, so it
     * is safe to display, forward to a governor, or (if ever) attach to any
     * public-facing record.
     */
    function buildRedactedSummary(fields) {
        fields = fields || {};
        var t = fields.pixKeyType || detectPixKeyType(fields.pixKey);
        var key = _str(fields.pixKey).trim();
        return [
            '[PAYOUT REGISTRATION]',
            '- Student: ' + _str(fields.studentName).trim(),
            '- Program: ' + _str(fields.programSlug).trim(),
            '- PIX key type: ' + (t || '(none)'),
            '- PIX key: ' + (key ? maskPixKey(key, t) : (fields.noKeyChannel ? '(none - ' + _str(fields.noKeyChannel).trim() + ')' : '(not provided)')),
            '- Account holder relationship: ' + (_str(fields.relationship).trim() || 'self'),
            '--------'
        ].join('\n');
    }

    var utils = {
        TYPES: TYPES,
        isValidCpf: isValidCpf,
        isValidCnpj: isValidCnpj,
        isValidEmail: isValidEmail,
        isValidPhone: isValidPhone,
        isEvp: isEvp,
        detectPixKeyType: detectPixKeyType,
        validatePixKey: validatePixKey,
        maskPixKey: maskPixKey,
        buildPayoutRegistrationPayload: buildPayoutRegistrationPayload,
        buildRedactedSummary: buildRedactedSummary
    };

    global.PayoutRegistrationUtils = utils;
    if (typeof module !== 'undefined' && module.exports) module.exports = utils;
})(typeof window !== 'undefined' ? window : this);
