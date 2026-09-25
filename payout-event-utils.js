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
    var UNLINKED_PROGRAM = 'unlinked_program';

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
     * `recipientName` is OPTIONAL: the recipient is frequently unknown, in which
     * case the tree id(s) are the sole linkage (Gary, 2026-09-25).
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
            ['Program', trim(f.programSlug) || UNLINKED_PROGRAM],
            ['Amount', amount.valid ? amount.value : trim(f.amount)],
            ['Currency', trim(f.currency) || 'BRL'],
            ['Paid At', trim(f.paidAt)],
            ['Bank Ref Type', trim(f.bankRefType) || 'PIX-E2E'],
            ['Bank Ref', trim(f.bankRef)],
            ['Recipient', trim(f.recipientName)],
            ['Recipient PK Hash', trim(f.recipientPkHash) || UNLINKED_RECIPIENT],
            ['Tree Planting IDs', treeIds.length ? treeIds.join(', ') : UNLINKED_TREES],
            ['Status', trim(f.status) || 'live'],
            ['Attached Filename', trim(f.receiptFileName) || '(none)'],
            ['Destination Payout Receipt File Location', trim(f.receiptLocation) || '(none)'],
            ['Receipt URL', trim(f.receiptLocation) || trim(f.receiptUrl) || '(none)'],
            ['Submission Source', trim(opts.source) || trim(f.submissionSource) || '(unknown)']
        ];
    }

    // Gary (2026-09-25): flag a DIFFERENT tree within 3 m. (Was 1 m.)
    var OVERPAY_COLOCATED_METERS = 3.0;

    /** Coerce a possibly-stringy coordinate to a finite number, else null. */
    function _num(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = Number(v);
        return isFinite(n) ? n : null;
    }

    /** Great-circle distance in metres between two lat/lng pairs (haversine). */
    function haversineMeters(lat1, lng1, lat2, lng2) {
        var R = 6371000.0, toRad = Math.PI / 180;
        var dLat = (lat2 - lat1) * toRad;
        var dLng = (lng2 - lng1) * toRad;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    /**
     * Overpay guards over a set of pending tree rows. Returns ONLY the flagged
     * ids: { tree_id: { duplicate, duplicate_with[], colocated, colocated_with[] } }.
     *   - duplicate  : shares a photo_url with another row, or the tree_id repeats.
     *   - colocated  : a DIFFERENT tree_id sits within `colocatedMeters` (default 1 m).
     * A 200 m threshold is deliberately NOT the default: on a real plantation trees
     * sit ~3 m apart, so 200 m would flag ~98% of the list and be ignored. This is
     * purely advisory UI and never part of the signed payload.
     */
    function computeOverpayFlags(rows, opts) {
        opts = opts || {};
        var within = (typeof opts.colocatedMeters === 'number') ? opts.colocatedMeters : OVERPAY_COLOCATED_METERS;
        var norm = (rows || []).map(function (r) {
            return {
                tree_id: trim(r.tree_id || r.telegram_message_id || ''),
                photo_url: trim(r.photo_url || ''),
                latitude: _num(r.latitude),
                longitude: _num(r.longitude)
            };
        });
        var byId = {};
        function bucket(id) {
            if (!byId[id]) {
                byId[id] = { tree_id: id, duplicate: false, duplicate_with: [], colocated: false, colocated_with: [] };
            }
            return byId[id];
        }
        norm.forEach(function (r) { if (r.tree_id) bucket(r.tree_id); });

        // duplicate: same photo_url (byte-identical = same physical tree re-ingested)
        var byPhoto = {};
        norm.forEach(function (r) {
            if (!r.tree_id || !r.photo_url) return;
            (byPhoto[r.photo_url] = byPhoto[r.photo_url] || []).push(r.tree_id);
        });
        Object.keys(byPhoto).forEach(function (p) {
            var ids = byPhoto[p];
            if (ids.length < 2) return;
            ids.forEach(function (id) {
                var b = bucket(id);
                b.duplicate = true;
                ids.forEach(function (o) {
                    if (o !== id && b.duplicate_with.indexOf(o) === -1) b.duplicate_with.push(o);
                });
            });
        });

        // duplicate: the same tree_id appears more than once in the feed
        var counts = {};
        norm.forEach(function (r) { if (r.tree_id) counts[r.tree_id] = (counts[r.tree_id] || 0) + 1; });
        Object.keys(counts).forEach(function (id) { if (counts[id] > 1) bucket(id).duplicate = true; });

        // colocated: a DIFFERENT tree_id within `within` metres
        for (var i = 0; i < norm.length; i++) {
            for (var j = i + 1; j < norm.length; j++) {
                var a = norm[i], b = norm[j];
                if (!a.tree_id || !b.tree_id || a.tree_id === b.tree_id) continue;
                if (a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) continue;
                var m = haversineMeters(a.latitude, a.longitude, b.latitude, b.longitude);
                if (m > within) continue;
                var rounded = Math.round(m * 10) / 10;
                bucket(a.tree_id).colocated = true;
                bucket(b.tree_id).colocated = true;
                bucket(a.tree_id).colocated_with.push({ tree_id: b.tree_id, meters: rounded });
                bucket(b.tree_id).colocated_with.push({ tree_id: a.tree_id, meters: rounded });
            }
        }

        var out = {};
        Object.keys(byId).forEach(function (id) {
            var b = byId[id];
            if (b.duplicate || b.colocated) out[id] = b;
        });
        return out;
    }

    /** Flags for the ids the operator actually entered (input order preserved). */
    function overpayWarningsFor(flags, treeIds) {
        var out = [];
        (treeIds || []).forEach(function (id) {
            var f = (flags || {})[id];
            if (f) out.push(f);
        });
        return out;
    }

    // --- payout-registration review (P2.3 / governor page) --------------------
    // Collapse the raw `payout registrations` rows to ONE per pk_hash so a
    // governor sees a single unambiguous recipient instead of a pile of
    // RECORDED/UPDATED rows. Precedence: an ACTIVE row wins; otherwise the most
    // recent submitted_date. PURE + privacy-safe: it only reads fields the read
    // endpoint already returns (never a raw pix_key), and it never invents one.
    function dedupeActiveRegistrations(rows) {
        var byPk = {};
        var order = [];
        (rows || []).forEach(function (r) {
            var pk = trim(r && r.pk_hash);
            if (!pk) return;
            var cur = byPk[pk];
            if (!cur) { byPk[pk] = r; order.push(pk); return; }
            var curActive = trim(cur.status).toUpperCase() === 'ACTIVE';
            var newActive = trim(r.status).toUpperCase() === 'ACTIVE';
            if (newActive && !curActive) { byPk[pk] = r; return; }
            if (newActive === curActive && _s(r.submitted_date) > _s(cur.submitted_date)) { byPk[pk] = r; }
        });
        return order.map(function (pk) { return byPk[pk]; });
    }

    var utils = {
        EVENT_NAME: EVENT_NAME,
        CURRENCIES: CURRENCIES,
        BANK_REF_TYPES: BANK_REF_TYPES,
        STATUSES: STATUSES,
        UNLINKED_RECIPIENT: UNLINKED_RECIPIENT,
        UNLINKED_TREES: UNLINKED_TREES,
        UNLINKED_PROGRAM: UNLINKED_PROGRAM,
        parseTreeIds: parseTreeIds,
        parseAmount: parseAmount,
        isValidIso8601: isValidIso8601,
        validate: validate,
        buildAttributes: buildAttributes,
        dedupeActiveRegistrations: dedupeActiveRegistrations,
        OVERPAY_COLOCATED_METERS: OVERPAY_COLOCATED_METERS,
        haversineMeters: haversineMeters,
        computeOverpayFlags: computeOverpayFlags,
        overpayWarningsFor: overpayWarningsFor
    };

    global.PayoutEventUtils = utils;
    if (typeof module !== 'undefined' && module.exports) { module.exports = utils; }
})(typeof window !== 'undefined' ? window : this);
