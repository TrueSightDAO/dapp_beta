/**
 * Payout event form utilities — isomorphic (browser + Node).
 * Used by report_payout_event.html and tested in tests/payout-event-utils.test.js
 *
 * A [PAYOUT EVENT] records an OUTBOUND compensation transfer (e.g. a PIX payment
 * for tree planting). Design contract (CRF_ANAPU_SUNMINT_COHORT_PROPOSAL.md
 * §12.2 / §12.3):
 *
 *   1. One row per TRANSFER — `tree_planting_id` is carried as a LIST because a
 *      single transfer may cover N trees (the alternate one-row-per-tree shape is
 *      rejected: it would duplicate the bank_ref and the amount).
 *   2. The raw recipient PIX key NEVER travels in the Edgar payload. Edgar's intake
 *      is republished as a PUBLIC raw chatlog, so the event carries either a
 *      `recipient_pk_hash` (resolved SINK-SIDE against the private payout register)
 *      or an explicit `unlinked_recipient` marker. This module therefore validates
 *      and derives — it never receives, stores or echoes PII.
 *   3. `status` distinguishes a live capture (`live`) from a reconstructed
 *      backfill (`backfill`), so an auditor can always tell the two apart.
 *
 * This module is pure: no DOM, no network. All shaping is unit-tested.
 */
(function (global) {
    'use strict';

    var EVENT_NAME = 'PAYOUT EVENT';
    var CURRENCIES = ['BRL', 'USD'];
    var BANK_REF_TYPES = ['PIX-E2E', 'PIX-TXID', 'WIRE-REF', 'OTHER'];
    var STATUSES = ['live', 'backfill'];
    var UNLINKED_RECIPIENT = 'unlinked_recipient';
    var UNLINKED_TREES = 'unlinked';

    function _s(v) { return v == null ? '' : String(v); }
    function trim(v) { return _s(v).trim(); }

    /**
     * Split a pasted list of tree ids on commas / semicolons / whitespace,
     * trim, drop empties and de-duplicate (stable order — first occurrence wins).
     * A single transfer covering many trees is the normal case, so a blank
     * string is legal and yields [] (the event is then flagged `unlinked`).
     */
    function parseTreeIds(raw) {
        var out = [];
        _s(raw).split(/[\s,;]+/).forEach(function (t) {
            t = t.trim();
            if (t && out.indexOf(t) === -1) out.push(t);
        });
        return out;
    }

    /**
     * Normalise an amount string. Accepts plain numbers and the pt-BR decimal
     * comma ("50,00"). Returns { valid, value } where value is a clean numeric
     * string ("50", "12.5") suitable for the ledger payload.
     */
    function parseAmount(raw) {
        var s = trim(raw).replace(/\s/g, '').replace(/^R\$/i, '');
        if (!s) return { valid: false, reason: 'Amount is required.' };
        var lastComma = s.lastIndexOf(',');
        var lastDot = s.lastIndexOf('.');
        if (lastComma !== -1 && lastDot !== -1) {
            // Both present: the LATER one is the decimal separator.
            // pt-BR "1.234,50" -> drop dots, comma -> dot.
            // en-US "1,234.50" -> drop commas, keep dot.
            if (lastComma > lastDot) {
                s = s.replace(/\./g, '').replace(',', '.');
            } else {
                s = s.replace(/,/g, '');
            }
        } else if (lastComma !== -1) {
            // Only comma(s): pt-BR decimal comma.
            s = s.replace(/,/g, '.');
            var extra = s.indexOf('.', s.indexOf('.') + 1);
            if (extra !== -1) { s = s.slice(0, extra) + s.slice(extra + 1); }
        }
        var n = Number(s);
        if (!isFinite(n) || n <= 0) {
            return { valid: false, reason: 'Amount must be a positive number.' };
        }
        return { valid: true, value: String(n) };
    }

    /**
     * ISO 8601 date or date-time, timezone optional. Deliberately strict about
     * the shape (a bare "12/09/2026" must NOT pass) while accepting the Date
     * constructor's own range checks.
     */
    function isValidIso8601(raw) {
        var t = trim(raw);
        if (!t) return false;
        var shape = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
        if (!shape.test(t)) return false;
        return !isNaN(new Date(t).getTime());
    }

    /**
     * Validate a payout-entry form. Returns { valid, errors[], amount }.
     * `bankRef` (the transfer E2E id) is required: it is the reconciliation
     * anchor that lets the sink match this row to the bank statement.
     */
    function validate(f) {
        f = f || {};
        var errors = [];
        var amount = parseAmount(f.amount);
        if (!amount.valid) { errors.push(amount.reason); }
        if (CURRENCIES.indexOf(trim(f.currency)) === -1) {
            errors.push('Currency must be one of: ' + CURRENCIES.join(', ') + '.');
        }
        if (!isValidIso8601(f.paidAt)) {
            errors.push('Paid At must be an ISO 8601 date/time (e.g. 2026-09-12T21:38:00Z).');
        }
        if (!trim(f.bankRef)) {
            errors.push('Bank Ref (the transfer E2E id) is required — it is the reconciliation anchor.');
        }
        if (BANK_REF_TYPES.indexOf(trim(f.bankRefType)) === -1) {
            errors.push('Bank Ref Type must be one of: ' + BANK_REF_TYPES.join(', ') + '.');
        }
        if (!trim(f.recipientName)) { errors.push('Recipient name is required.'); }
        if (!trim(f.programSlug)) { errors.push('Program is required.'); }
        if (STATUSES.indexOf(trim(f.status)) === -1) {
            errors.push('Status must be one of: ' + STATUSES.join(', ') + '.');
        }
        return { valid: errors.length === 0, errors: errors, amount: amount.valid ? amount.value : null };
    }

    /**
     * Ordered [label, value] pairs for the Edgar payload. Order is part of the
     * contract (the payload is signed verbatim, so the label order is fixed).
     * No PII: the recipient is carried as a display name + an optional pk hash.
     */
    function buildAttributes(f, opts) {
        opts = opts || {};
        var amount = parseAmount(f.amount);
        var treeIds = parseTreeIds(f.treeIds);
        return [
            ['Program', trim(f.programSlug)],
            ['Amount', amount.valid ? amount.value : trim(f.amount)],
            ['Currency', trim(f.currency) || 'BRL'],
            ['Paid At', trim(f.paidAt)],
            ['Bank Ref Type', trim(f.bankRefType) || 'PIX-E2E'],
            ['Bank Ref', trim(f.bankRef)],
            ['Recipient', trim(f.recipientName)],
            ['Recipient PK Hash', trim(f.recipientPkHash) || UNLINKED_RECIPIENT],
            ['Tree Planting IDs', treeIds.length ? treeIds.join(', ') : UNLINKED_TREES],
            ['Status', trim(f.status) || 'live'],
            ['Receipt URL', trim(f.receiptUrl) || '(none)'],
            ['Submission Source', trim(opts.source) || trim(f.submissionSource) || '(unknown)']
        ];
    }

    var utils = {
        EVENT_NAME: EVENT_NAME,
        CURRENCIES: CURRENCIES,
        BANK_REF_TYPES: BANK_REF_TYPES,
        STATUSES: STATUSES,
        UNLINKED_RECIPIENT: UNLINKED_RECIPIENT,
        UNLINKED_TREES: UNLINKED_TREES,
        parseTreeIds: parseTreeIds,
        parseAmount: parseAmount,
        isValidIso8601: isValidIso8601,
        validate: validate,
        buildAttributes: buildAttributes
    };

    global.PayoutEventUtils = utils;
    if (typeof module !== 'undefined' && module.exports) { module.exports = utils; }
})(typeof window !== 'undefined' ? window : this);
