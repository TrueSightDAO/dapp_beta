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
    function _uniq(a) {
        var seen = {}, out = [];
        (a || []).forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
        return out;
    }
    function _nearestByTreeId(list) {
        var best = {}, order = [];
        (list || []).forEach(function (c) {
            if (!c || !c.tree_id) return;
            if (!(c.tree_id in best)) { best[c.tree_id] = c; order.push(c.tree_id); }
            else if ((c.meters || 0) < (best[c.tree_id].meters || 0)) best[c.tree_id] = c;
        });
        return order.map(function (t) { return best[t]; });
    }

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
     * The recipient is linked by `recipientPkHash` alone (the tree picker fills it);
     * there is no free-text recipient-name field (Gary, 2026-09-25).
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
     * Derive the capture `status` instead of asking the operator for it. The
     * distinction the ledger cares about is live ("captured as it happened") vs
     * backfill ("reconstructed after the fact") -- and the operator ALREADY
     * signals that with `paidAt` (a historical date == a backfill). So:
     *   same UTC calendar day as `now` (or a future date) -> 'live'
     *   any earlier UTC calendar day                     -> 'backfill'
     * A blank/unparseable paidAt degrades to 'live' (the caller's validation
     * rejects a bad date before submit anyway).
     */
    function deriveStatus(paidAt, nowIso) {
        var d = new Date(paidAt);
        if (!paidAt || isNaN(d.getTime())) return 'live';
        var now = new Date(nowIso || Date.now());
        if (isNaN(now.getTime())) now = new Date();
        var a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        var b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        return a < b ? 'backfill' : 'live';
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
    // A SAME-FIX collision: two DIFFERENT trees sitting on (effectively) ONE GPS
    // fix. A single stale fix re-reported across submissions lands several trees on
    // the SAME coordinate -- that IS an overpay risk (one pick could be paid twice).
    // Merely-NEARBY distinct trees (a dense plantation, ~3 m apart) are NOT a risk.
    // So the default window is sub-metre; OVERPAY_COLOCATED_METERS stays only as a
    // "nearby" advisory a caller may opt into (Gary, 2026-09-27, thread 35944).
    var OVERPAY_SAME_FIX_METERS = 0.5;
    // Perceptual-hash DUPLICATE gate (dHash-64, bits): a safety net for the same
    // photo re-ingested under a NEW url, which the exact photo_url check misses. On
    // the live feed the closest DISTINCT-photo pair is 14/64, so <=8 never merges two
    // real trees (Gary, 2026-09-27, thread 35944).
    var OVERPAY_PHASH_HAMMING = 8;
    // Max co-located partners named in a human reason string (nearest first).
    var OVERPAY_REASON_PARTNER_LIMIT = 3;

    /** Coerce a possibly-stringy coordinate to a finite number, else null. */
    function _num(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = Number(v);
        return isFinite(n) ? n : null;
    }

    /** Great-circle distance in metres between two lat/lng pairs (haversine). */
    // Hamming distance between two equal-length hex hash strings (bits differing).
    // Returns a huge number for unparseable / unequal-length input so callers read
    // it as "not a match".
    function _hammingHex(a, b) {
        a = _s(a); b = _s(b);
        if (!a || a.length !== b.length) return 1e9;
        var d = 0;
        for (var i = 0; i < a.length; i++) {
            var x = parseInt(a[i], 16), y = parseInt(b[i], 16);
            if (isNaN(x) || isNaN(y)) return 1e9;
            var z = x ^ y;
            while (z) { d += z & 1; z >>= 1; }
        }
        return d;
    }

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
     *   - duplicate  : shares a photo_url / Request Transaction ID with another row,
     *                  a near-identical perceptual hash (photo_hash), or the tree_id repeats.
     *   - colocated  : a DIFFERENT tree_id sits on the SAME GPS fix (within
     *                  `sameFixMeters`, default 0.5 m) -- one stale fix shared by
     *                  several distinct picks. NOT "merely nearby": on a real
     *                  plantation trees legitimately sit ~3 m apart, so a 3 m window
     *                  flagged the whole planting as at-risk and was noise (Gary,
     *                  2026-09-27, thread 35944). Purely advisory UI; never part of
     *                  the signed payload.
     */
    function computeOverpayFlags(rows, opts) {
        opts = opts || {};
        var within = (typeof opts.sameFixMeters === 'number') ? opts.sameFixMeters
            : (typeof opts.colocatedMeters === 'number') ? opts.colocatedMeters
            : OVERPAY_SAME_FIX_METERS;
        var norm = (rows || []).map(function (r) {
            return {
                tree_id: trim(r.tree_id || r.telegram_message_id || ''),
                photo_url: trim(r.photo_url || ''),
                request_txid: trim(r.request_txid || ''),
                photo_hash: trim(r.photo_hash || ''),
                latitude: _num(r.latitude),
                longitude: _num(r.longitude)
            };
        });
        var byId = {};
        function bucket(id) {
            if (!byId[id]) {
                byId[id] = { tree_id: id, duplicate: false, duplicate_with: [], duplicate_txid: '', colocated: false, colocated_with: [] };
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

        // duplicate (PRIMARY KEY): rows sharing the same non-empty Request
        // Transaction ID are ONE signed submission re-ingested -- a signature is
        // unique per submission (Gary, 2026-09-26, thread 35944). This replaces
        // the noisy telegram-update-id keying: two trees that merely sit on the
        // same GPS fix but carry DIFFERENT txids are separate, legitimate
        // submissions and must NOT be flagged as a duplicate pair.
        var byTx = {};
        norm.forEach(function (r) {
            if (!r.tree_id || !r.request_txid) return;
            (byTx[r.request_txid] = byTx[r.request_txid] || []).push(r.tree_id);
        });
        Object.keys(byTx).forEach(function (tx) {
            var ids = byTx[tx];
            if (ids.length < 2) return;
            ids.forEach(function (id) {
                var b = bucket(id);
                b.duplicate = true;
                b.duplicate_txid = tx;
                ids.forEach(function (o) {
                    if (o !== id && b.duplicate_with.indexOf(o) === -1) b.duplicate_with.push(o);
                });
            });
        });

        // duplicate (perceptual safety net): rows whose photo_hash are near-identical
        // (Hamming <= opts.photoHashThreshold, default 8/64) are the SAME physical
        // photo re-ingested under a DIFFERENT url -- which the exact photo_url check
        // above misses. On the live feed the closest DISTINCT-photo pair is 14/64,
        // so <=8 never merges two real trees (Gary, 2026-09-27, thread 35944).
        var phThr = (typeof opts.photoHashThreshold === 'number') ? opts.photoHashThreshold : OVERPAY_PHASH_HAMMING;
        var hashed = [];
        norm.forEach(function (r) { if (r.tree_id && r.photo_hash) hashed.push({ id: r.tree_id, h: r.photo_hash }); });
        for (var pI = 0; pI < hashed.length; pI++) {
            for (var pJ = pI + 1; pJ < hashed.length; pJ++) {
                if (hashed[pI].id === hashed[pJ].id) continue;
                if (_hammingHex(hashed[pI].h, hashed[pJ].h) > phThr) continue;
                var pid = hashed[pI].id, oid = hashed[pJ].id;
                var bp = bucket(pid);
                bp.duplicate = true;
                if (bp.duplicate_with.indexOf(oid) === -1) bp.duplicate_with.push(oid);
                var bp2 = bucket(oid);
                bp2.duplicate = true;
                if (bp2.duplicate_with.indexOf(pid) === -1) bp2.duplicate_with.push(pid);
            }
        }

        // colocated: a DIFFERENT tree_id on the SAME GPS fix (within `within` metres)
        for (var i = 0; i < norm.length; i++) {
            for (var j = i + 1; j < norm.length; j++) {
                var a = norm[i], b = norm[j];
                if (!a.tree_id || !b.tree_id || a.tree_id === b.tree_id) continue;
                if (a.latitude === null || a.longitude === null || b.latitude === null || b.longitude === null) continue;
                // same Request Transaction ID => same submission, already a duplicate;
                // not two DISTINCT trees that merely landed close together.
                if (a.request_txid && a.request_txid === b.request_txid) continue;
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
            // collapse partner lists: a partner is never listed twice (the feed can
            // carry the same tree_id on more than one row, which previously made a
            // co-located partner repeat, e.g. "Edgar_.._093 (0 m), Edgar_.._093 (0 m)").
            b.colocated_with = _nearestByTreeId(b.colocated_with);
            b.duplicate_with = _uniq(b.duplicate_with);
            if (b.duplicate || b.colocated) out[id] = b;
        });
        return out;
    }

    /**
     * Human reason(s) for ONE overpay flag, as plain strings (no HTML) so both
     * the entered-id rows and the "show all" list can label a flagged tree
     * instead of just printing a bare id. e.g.
     *   ['duplicate (same record as Edgar_.._013)']
     *   ['co-located with Edgar_.._015 (0.0 m)']
     */
    function overpayReasonBits(f, opts) {
        var bits = [];
        if (!f) return bits;
        // `opts.labelFor` lets a caller render partner ids in their DISPLAY form
        // (e.g. `tx:<8>`) without changing the stored (canonical) keys. Defaults
        // to identity so the pure-util contract is unchanged.
        var L = (opts && typeof opts.labelFor === 'function') ? opts.labelFor : function (x) { return x; };
        if (f.duplicate) {
            var dw = (f.duplicate_with || []);
            if (f.duplicate_txid) {
                bits.push('duplicate (same Request Transaction ID as ' + (dw.length ? dw.map(L).join(', ') : 'another row') + ')');
            } else {
                bits.push('duplicate' + (dw.length ? ' (same record as ' + dw.map(L).join(', ') + ')' : ''));
            }
        }
        if (f.colocated) {
            // Co-location is ADVISORY. A single stale GPS fix can put ~20 DISTINCT
            // submissions on one coordinate, which used to render as a 20-id
            // "co-located with ... 0 m" chain -- the noise Gary flagged (2026-09-26,
            // thread 35944). Show only the nearest few, then a count.
            var cwAll = _nearestByTreeId(f.colocated_with || []).sort(function (a, b) {
                return (a.meters || 0) - (b.meters || 0);
            });
            var shown = cwAll.slice(0, OVERPAY_REASON_PARTNER_LIMIT).map(function (c) {
                return L(c.tree_id) + ' (' + c.meters + ' m)';
            });
            var extra = cwAll.length - OVERPAY_REASON_PARTNER_LIMIT;
            // Name it honestly: these are DISTINCT trees sharing ONE (stale) GPS fix
            // -- a real duplicate-pick risk, not "merely nearby".
            bits.push('same GPS fix as ' + shown.join(', ') + (extra > 0 ? ' and ' + extra + ' more' : ''));
        }
        return bits;
    }

    /**
     * The tree ids the given tree is flagged AGAINST -- nearest co-located partner
     * first, then any duplicate partners. This is exactly what a reviewer must look
     * at side by side when deciding whether to pay `id`: not every flagged tree in
     * the feed, only the ones that actually collide with THIS one. Empty array =
     * this tree carries no overpay risk. Pure; never reads PII.
     */
    function overpayConflictPartners(flags, id, limit) {
        var f = (flags || {})[id];
        if (!f) return [];
        var ordered = [];
        var seen = {};
        (f.colocated_with || []).slice()
            .sort(function (a, b) { return (a.meters || 0) - (b.meters || 0); })
            .forEach(function (c) {
                if (c && c.tree_id && !seen[c.tree_id]) { seen[c.tree_id] = 1; ordered.push(c.tree_id); }
            });
        (f.duplicate_with || []).forEach(function (d) {
            if (d && !seen[d]) { seen[d] = 1; ordered.push(d); }
        });
        return ordered.slice(0, (typeof limit === 'number' && limit > 0) ? limit : 3);
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

    /**
     * Build a `tree_id -> pk_hash` lookup from the governor-only
     * `getTreeRecipientMap` payload (`{status, data:{items:[{tree_id, pk_hash}]}}`).
     * Tolerant of shape drift: a missing/blank list yields {}, never a throw.
     */
    function buildTreeRecipientMap(payload) {
        var out = {};
        var items = (payload && payload.data && payload.data.items) || [];
        items.forEach(function (it) {
            if (!it) return;
            var id = trim(it.tree_id);
            var pk = trim(it.pk_hash);
            if (id && pk && !out[id]) out[id] = pk;
        });
        return out;
    }

    /**
     * Find one tree row in the public pending list by id (canonical
     * `telegram_message_id`, falling back to `tree_id`). Returns null when the id
     * is absent -- a typed-in id, or one already paid and dropped from the list.
     */
    function findPendingTree(rows, treeId) {
        var id = trim(treeId);
        if (!id) return null;
        var list = rows || [];
        for (var i = 0; i < list.length; i++) {
            var t = list[i];
            if (!t) continue;
            var tid = trim(t.telegram_message_id || t.tree_id || '');
            if (tid === id) return t;
        }
        return null;
    }

    /**
     * Ordered, blank-stripped [label, value] pairs describing a pending tree.
     * Kept pure so the details panel and its tests share ONE definition of what a
     * tree shows. `photo_url` is deliberately excluded -- the panel renders it as
     * an <img>, not as text.
     */
    function treeDetailFields(tree) {
        if (!tree) return [];
        var fields = [
            ['Tree ID', trim(tree.telegram_message_id || tree.tree_id || '')],
            ['Species', trim(tree.species)],
            ['Planting date', trim(tree.planting_date)],
            ['Latitude', trim(tree.latitude)],
            ['Longitude', trim(tree.longitude)],
            ['Submitted by', trim(tree.submitted_name)]
        ];
        return fields.filter(function (f) { return f[1] !== ''; });
    }

    /**
     * First 8 chars of a tree's signed `Request Transaction ID` (the DAO's
     * canonical, re-post-stable identity), or '' when the row predates the txid
     * column. A raw txid is ~344 chars -- far too long to display -- so the short
     * form is the human handle. It is a LABEL only, never a payload key
     * (conventions/DEDUP_KEY_CONVENTION.md).
     */
    function shortTxid(tree) {
        var t = trim((tree && tree.request_txid) || '');
        return t ? t.slice(0, 8) : '';
    }

    /**
     * Display identity for a pending tree: the signed `Request Transaction ID`
     * rendered as `tx:<8 chars>` (the DAO's canonical key), falling back to the
     * transport id (`telegram_message_id` / `tree_id`) only when the row has no
     * txid. DISPLAY ONLY -- the picker value and the signed payload keep the
     * canonical id, so nothing downstream (autofill map, reject join, consumer)
     * changes.
     */
    function treeDisplayId(tree) {
        if (!tree) return '';
        var tx = shortTxid(tree);
        if (tx) return 'tx:' + tx;
        return trim(tree.telegram_message_id || tree.tree_id || '');
    }

    /**
     * Build a `pk_hash -> {pix_key_type, pix_key_masked}` lookup from the payout
     * register payload, so a tree card can show the PARTIAL (masked) key of the
     * account a payout would reach. Privacy-safe by construction: it reads ONLY the
     * already-masked fields, so a raw key value can never pass through here.
     */
    function maskedKeyByPkHash(rows) {
        var out = {};
        (rows || []).forEach(function (r) {
            if (!r) return;
            var pk = trim(r.pk_hash);
            if (!pk || out[pk]) return;
            out[pk] = { pix_key_type: trim(r.pix_key_type), pix_key_masked: trim(r.pix_key_masked) };
        });
        return out;
    }

    // Unique program slugs declared in a sunmint_program_registry.json
    // ({hosts:{host:slug}}). Data-driven so a new program appears in the
    // Program dropdown without a code change.
    function programsFromRegistry(reg) {
        var hosts = (reg && reg.hosts) || {};
        var seen = {};
        Object.keys(hosts).forEach(function (h) {
            var s = String(hosts[h] || '').trim();
            if (s) seen[s] = 1;
        });
        return Object.keys(seen).sort();
    }

    // host -> program slug, from the registry's `hosts` map. This is the SSOT the
    // page uses to turn a submission's ORIGIN HOST into a program slug (the domain
    // itself is never the slug, e.g. cfr.truesight.me -> crf-anapu).
    function programSlugsByHost(reg) {
        var hosts = (reg && reg.hosts) || {};
        var out = {};
        Object.keys(hosts).forEach(function (h) {
            var host = String(h || '').trim().toLowerCase();
            var slug = String(hosts[h] || '').trim();
            if (host && slug) out[host] = slug;
        });
        return out;
    }

    // The program slug a pending tree belongs to, given the registry host map.
    // Prefers an explicit program_slug/program on the row; else resolves the
    // `submission_source` URL's host through hostMap. '' when unattributable.
    function programForTree(tree, hostMap) {
        if (!tree) return '';
        var explicit = String(tree.program_slug || tree.program || '').trim();
        if (explicit) return explicit;
        var src = String(tree.submission_source || '').trim();
        if (!src) return '';
        var host = submissionSourceHost(src);
        if (!host) return '';
        var map = hostMap || {};
        if (map[host]) return map[host];
        // Tolerate a leading 'www.' or a sub-domain of a registered host.
        var keys = Object.keys(map);
        for (var i = 0; i < keys.length; i++) {
            if (host === keys[i] || host.slice(-(keys[i].length + 1)) === '.' + keys[i]) return map[keys[i]];
        }
        return '';
    }

    // Extract the host from a Submission Source value (a URL or a bare host).
    function submissionSourceHost(src) {
        var s = String(src || '').trim();
        if (!s) return '';
        var m = s.match(/^[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/([^\/\s]+)/);
        if (m) return m[1].toLowerCase().replace(/:\d+$/, '');
        return s.split('/')[0].toLowerCase();
    }

    // True when the pending-tree feed carries ANY program attribution
    // (program_slug / program / submission_source). Until it does, a Program
    // filter cannot narrow the list -- the page says so plainly rather than
    // silently showing everything.
    function feedHasProgramData(trees) {
        return (trees || []).some(function (tree) {
            return String((tree && (tree.program_slug || tree.program || tree.submission_source)) || '').trim() !== '';
        });
    }

    // STRICT program filter (governor directive, thread 35944): when a program is
    // chosen, KEEP a tree only when its resolved program EQUALS it. Rows that
    // resolve to '' (unattributed) are HIDDEN -- never shown as if they belonged.
    // A blank program is the general disbursement => every tree. `hasProgramData`
    // guards the pre-attribution feed: while NO row carries attribution the filter
    // cannot narrow, so every tree is kept and programFilterNotApplied() says so.
    function treesForProgram(trees, program, hostMap, hasProgramData) {
        var all = trees || [];
        if (!program) return all;
        var hasData = (typeof hasProgramData === 'boolean')
            ? hasProgramData
            : feedHasProgramData(all);
        if (!hasData) return all;
        return all.filter(function (t) { return programForTree(t, hostMap) === program; });
    }

    // True when a program is chosen but the feed carries no program attribution to
    // filter on -- the page must SAY so rather than imply the filter applied.
    function programFilterNotApplied(program, trees, hasProgramData) {
        if (!program) return false;
        var all = trees || [];
        if (!all.length) return false;
        var hasData = (typeof hasProgramData === 'boolean')
            ? hasProgramData
            : feedHasProgramData(all);
        return !hasData;
    }

    // --- [TREE PLANTING REJECT EVENT] payload -------------------------------
    // The governor action "mark tree as invalid": the SAME event the
    // monitor-tree-growth page emits, so the governor/sentinel-only GAS consumer
    // (process_tree_planting_link.js) treats both identically. The feed tree id
    // IS the `SunMint Submission Message ID` (the QR line is parsed but unused by
    // the reject path, hence the `(unlinked)` sentinel for a not-yet-linked tree).
    // The payload NEVER carries a raw PIX key or any recipient material.
    var TREE_REJECT_EVENT_NAME = 'TREE PLANTING REJECT EVENT';
    var TREE_REJECT_UNLINKED_QR = '(unlinked)';
    var TREE_REJECT_DEFAULT_REASON = 'Not a valid tree';

    function buildTreeRejectAttributes(treeId, qrCode, contributorName, reason) {
        var id = String(treeId == null ? '' : treeId).trim();
        return {
            'QR Code': String(qrCode == null ? '' : qrCode).trim() || TREE_REJECT_UNLINKED_QR,
            'SunMint Submission Message ID': id,
            'Updated by': String(contributorName == null ? '' : contributorName).trim(),
            'Reason': String(reason == null ? '' : reason).trim() || TREE_REJECT_DEFAULT_REASON
        };
    }

    var utils = {
        EVENT_NAME: EVENT_NAME,
        TREE_REJECT_EVENT_NAME: TREE_REJECT_EVENT_NAME,
        TREE_REJECT_UNLINKED_QR: TREE_REJECT_UNLINKED_QR,
        TREE_REJECT_DEFAULT_REASON: TREE_REJECT_DEFAULT_REASON,
        buildTreeRejectAttributes: buildTreeRejectAttributes,
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
        OVERPAY_SAME_FIX_METERS: OVERPAY_SAME_FIX_METERS,
        OVERPAY_PHASH_HAMMING: OVERPAY_PHASH_HAMMING,
        overpayConflictPartners: overpayConflictPartners,
        haversineMeters: haversineMeters,
        computeOverpayFlags: computeOverpayFlags,
        overpayWarningsFor: overpayWarningsFor,
        overpayReasonBits: overpayReasonBits,
        buildTreeRecipientMap: buildTreeRecipientMap,
        findPendingTree: findPendingTree,
        treeDetailFields: treeDetailFields,
        shortTxid: shortTxid,
        treeDisplayId: treeDisplayId,
        maskedKeyByPkHash: maskedKeyByPkHash,
        deriveStatus: deriveStatus,
        programsFromRegistry: programsFromRegistry,
        programSlugsByHost: programSlugsByHost,
        programForTree: programForTree,
        submissionSourceHost: submissionSourceHost,
        feedHasProgramData: feedHasProgramData,
        treesForProgram: treesForProgram,
        programFilterNotApplied: programFilterNotApplied
    };

    global.PayoutEventUtils = utils;
    if (typeof module !== 'undefined' && module.exports) { module.exports = utils; }
})(typeof window !== 'undefined' ? window : this);
