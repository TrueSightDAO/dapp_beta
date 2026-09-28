/**
 * Ledger Explorer utilities — isomorphic (browser + Node).
 * Used by ledger_explorer.html and tested in tests/ledger-explorer-utils.test.js
 *
 * A read-only view over TrueSightDAO/verify_public_signatures — the DAO's public,
 * auditable RSA-attestation ledger (one immutable JSON file per signed event).
 * Design contract (plans/TRUESIGHT_LEDGER_EXPLORER_PLAN.md §4):
 *
 *   1. Static, serverless, client-side-fetch. NO Google Apps Script, no backend,
 *      no auth — the page fetches public GitHub JSON only.
 *   2. Search-by-txid is ONE fetch: ledger_index.json (PR1) maps
 *      sha256(request_transaction_id) -> the event. We never fan out across the
 *      ~34 per-event-type folders.
 *   3. Everything below is pure (no DOM, no network) so it is unit-testable in
 *      Node; the page owns fetching + rendering.
 */
(function (global) {
  'use strict';

  // `this` at a CommonJS module top level is module.exports (NOT the real
  // global), so resolve the true global explicitly for TextEncoder/WebCrypto.
  var G =
    typeof globalThis !== 'undefined'
      ? globalThis
      : typeof window !== 'undefined'
        ? window
        : global;

  var LEDGER_RAW_BASE =
    'https://raw.githubusercontent.com/TrueSightDAO/verify_public_signatures/main/';
  var LEDGER_INDEX_URL = LEDGER_RAW_BASE + 'ledger_index.json';

  // sha256(request_transaction_id) -> 64 lowercase hex (the canonical mirror
  // filename). See sync_sunmint_signatures.py::_txid_key.
  var TXID_HASH_RE = /^[0-9a-f]{64}$/i;
  // Edgar-named message ids look like Edgar_20260924125541_071.
  var EDGAR_MID_RE = /^Edgar_\d{14}_\d{3}$/;
  var NUMERIC_MID_RE = /^\d+$/;

  function normalizeQuery(q) {
    return String(q == null ? '' : q).trim();
  }

  function isTxidHash(q) {
    return TXID_HASH_RE.test(normalizeQuery(q));
  }

  function isEdgarMessageId(q) {
    return EDGAR_MID_RE.test(normalizeQuery(q));
  }

  function isNumericMessageId(q) {
    return NUMERIC_MID_RE.test(normalizeQuery(q));
  }

  /** Flatten an index's events into an array, honouring events_ordered when present. */
  function indexRows(index) {
    if (!index || typeof index !== 'object') return [];
    var events = index.events;
    if (!events || typeof events !== 'object') return [];
    if (Array.isArray(index.events_ordered)) {
      var out = [];
      for (var i = 0; i < index.events_ordered.length; i++) {
        var r = events[index.events_ordered[i]];
        if (r) out.push(r);
      }
      return out;
    }
    return Object.keys(events).map(function (k) {
      return events[k];
    });
  }

  /** Direct txid_hash -> row lookup (case-insensitive on the hex). */
  function lookupByHash(index, hash) {
    if (!index || !index.events) return null;
    var h = normalizeQuery(hash).toLowerCase();
    if (index.events[h]) return index.events[h];
    // Defensive: keys may carry original case if the generator ever changes.
    var keys = Object.keys(index.events);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === h) return index.events[keys[i]];
    }
    return null;
  }

  /** All rows whose telegram_message_id equals the query (usually 0 or 1). */
  function lookupByMessageId(index, mid) {
    var m = normalizeQuery(mid);
    if (!m) return [];
    return indexRows(index).filter(function (r) {
      return r && String(r.telegram_message_id) === m;
    });
  }

  /**
   * Resolve a user query against the global index.
   *   - 64-hex            -> direct txid_hash lookup
   *   - numeric / Edgar   -> message-id lookup
   *   - anything else      -> treated as a RAW txid: sha256 it, then look up
   *                            (requires opts.hashFn, e.g. WebCrypto in the page)
   * Returns { mode, rows } where mode ∈ {empty, txid_hash, message_id, raw_txid}.
   */
  async function resolveQuery(index, query, opts) {
    opts = opts || {};
    var q = normalizeQuery(query);
    if (!q) return { mode: 'empty', rows: [] };

    if (isTxidHash(q)) {
      var row = lookupByHash(index, q);
      return { mode: 'txid_hash', rows: row ? [row] : [] };
    }

    var byMid = lookupByMessageId(index, q);
    if (byMid.length) return { mode: 'message_id', rows: byMid };

    if (isNumericMessageId(q) || isEdgarMessageId(q)) {
      return { mode: 'message_id', rows: [] };
    }

    if (typeof opts.hashFn !== 'function') {
      return { mode: 'raw_txid', rows: [], error: 'no-hash-fn' };
    }
    var h = await opts.hashFn(q);
    var r = lookupByHash(index, String(h));
    return { mode: 'raw_txid', rows: r ? [r] : [] };
  }

  function toHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  function defaultDigest(bytes) {
    var subtle = G.crypto && G.crypto.subtle;
    if (!subtle) throw new Error('WebCrypto SHA-256 is unavailable in this context');
    return subtle.digest('SHA-256', bytes);
  }

  /**
   * sha256(text) -> lowercase hex. `digestImpl` is an injectable
   * (Uint8Array) -> (ArrayBuffer|Uint8Array|Buffer) async function so the same
   * code is testable in Node; the browser default uses WebCrypto.
   */
  async function sha256Hex(text, digestImpl) {
    var enc = new G.TextEncoder();
    var bytes = enc.encode(String(text));
    var digest = digestImpl || defaultDigest;
    var out = await digest(bytes);
    return toHex(new Uint8Array(out));
  }

  /** Pad a base64 string to a multiple of 4 (WebCrypto/atob are strict-ish). */
  function padBase64(b64) {
    var s = String(b64 == null ? '' : b64).replace(/\s+/g, '');
    var r = s.length % 4;
    if (r === 2) s += '==';
    else if (r === 3) s += '=';
    else if (r === 1) r = 1; // malformed; leave as-is for the caller to fail
    return s;
  }

  /** Wrap a bare SPKI base64 body into a PEM public-key block. */
  function pemFromSpkiB64(b64) {
    return (
      '-----BEGIN PUBLIC KEY-----\n' +
      String(b64 == null ? '' : b64).replace(/\s+/g, '') +
      '\n-----END PUBLIC KEY-----\n'
    );
  }

  function escapeHtml(unsafe) {
    return String(unsafe == null ? '' : unsafe)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /** Shorten a long hash/url for display, keeping both ends. */
  function shortenHash(h, keep) {
    var s = String(h == null ? '' : h);
    var n = keep || 10;
    if (s.length <= n * 2 + 3) return s;
    return s.slice(0, n) + '…' + s.slice(s.length - n);
  }

  /** The immutable event filename for a row (the canonical mirror, by default). */
  function eventFileName(row, preferMessageId) {
    if (!row) return '';
    var url = preferMessageId ? row.message_id_url || row.canonical_url : row.canonical_url || row.message_id_url;
    if (!url) return '';
    return String(url).split('/').pop();
  }

  /**
   * The offline re-verification recipe, verbatim from the ledger README
   * (verify_public_signatures/README.md §"Verify any signature"), parameterised
   * with the event's own URL so a verifier can paste it directly.
   */
  function buildOpensslVerifySnippet(eventUrl) {
    var url = String(eventUrl == null ? '' : eventUrl);
    return (
      '# 1. Fetch the event file\n' +
      'curl -sL ' + url + ' -o event.json\n' +
      '\n' +
      '# 2. Reconstruct the PEM public key + write payload/signature\n' +
      "python3 - <<'EOF'\n" +
      'import json, base64\n' +
      'd = json.load(open("event.json"))\n' +
      'open("pub.pem", "w").write("-----BEGIN PUBLIC KEY-----\\n" + d["public_key"] + "\\n-----END PUBLIC KEY-----\\n")\n' +
      'open("payload.txt", "w").write(d["signed_payload"])\n' +
      'open("sig.bin", "wb").write(base64.b64decode(d["signature"] + "=="))\n' +
      'EOF\n' +
      '\n' +
      '# 3. Verify\n' +
      'openssl dgst -sha256 -verify pub.pem -signature sig.bin payload.txt\n' +
      '# => Verified OK'
    );
  }

  var utils = {
    LEDGER_RAW_BASE: LEDGER_RAW_BASE,
    LEDGER_INDEX_URL: LEDGER_INDEX_URL,
    normalizeQuery: normalizeQuery,
    isTxidHash: isTxidHash,
    isEdgarMessageId: isEdgarMessageId,
    isNumericMessageId: isNumericMessageId,
    indexRows: indexRows,
    lookupByHash: lookupByHash,
    lookupByMessageId: lookupByMessageId,
    resolveQuery: resolveQuery,
    toHex: toHex,
    sha256Hex: sha256Hex,
    padBase64: padBase64,
    pemFromSpkiB64: pemFromSpkiB64,
    escapeHtml: escapeHtml,
    shortenHash: shortenHash,
    eventFileName: eventFileName,
    buildOpensslVerifySnippet: buildOpensslVerifySnippet
  };

  global.LedgerExplorerUtils = utils;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
})(typeof window !== 'undefined' ? window : this);
