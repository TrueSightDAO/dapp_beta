/**
 * Shared treasury-cache loader + adapter helpers.
 *
 * Loads https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json
 * (refreshed on every [INVENTORY MOVEMENT] batch + 30-min safety-net cron) and
 * exposes adapter functions that translate the schema back to the exact shapes
 * the existing DApp pages already know how to render. Each consumer page falls
 * back to its original GAS fetch on any failure.
 *
 * Schema: https://github.com/TrueSightDAO/treasury-cache/blob/main/README.md
 *
 * Usage on a page that already has `DAO_FORMS_BASE`:
 *
 *   <script src="js/treasury_cache.js"></script>
 *   ...
 *   const managers = (await TreasuryCache.getManagers()) ||
 *                    await fetch(`${DAO_FORMS_BASE}?list=true`).then(r => r.json());
 *
 * All adapters return null when the cache couldn't be loaded, letting the
 * caller decide how to fall back. They never throw.
 */
(function (global) {
  'use strict';

  var TREASURY_CACHE_BASE_URL =
    'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json';
  var PUBLIC_KEYS_BASE_URL =
    'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/public_keys/';
  var TREASURY_CACHE_SESSION_BUST = Date.now(); // freshen per page load, memoize within session
  var _promise = null;

  function load() {
    if (_promise) return _promise;
    _promise = (async function () {
      try {
        var url = TREASURY_CACHE_BASE_URL + '?t=' + TREASURY_CACHE_SESSION_BUST;
        var res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var json = await res.json();
        if (!json || !Array.isArray(json.items) || !Array.isArray(json.managers)) {
          throw new Error('malformed treasury-cache JSON');
        }
        console.log('[treasury-cache] loaded', {
          generated_at: json.generated_at,
          trigger: json.trigger,
          schema_version: json.schema_version,
          item_types: json.totals && json.totals.item_types,
          managers: json.totals && json.totals.managers_count
        });
        return json;
      } catch (err) {
        console.warn('[treasury-cache] load failed, consumers will fall back to GAS:', err);
        return null;
      }
    })();
    return _promise;
  }

  // [{key, name}] — drop-in for DAO_FORMS_BASE?list=true
  async function getManagers() {
    var snap = await load();
    if (!snap) return null;
    return snap.managers.map(function (m) {
      return { key: m.manager_key, name: m.manager_name };
    });
  }

  // [{ledger_name, ledger_url}] — drop-in for DAO_FORMS_BASE?ledgers=true
  async function getLedgers() {
    var snap = await load();
    if (!snap || !Array.isArray(snap.ledgers)) return null;
    return snap.ledgers.map(function (l) {
      return { ledger_name: l.ledger_name, ledger_url: l.ledger_url };
    });
  }

  // {status:'success', data:{currencies:[…]}} — drop-in for DAO_FORMS_BASE?all_currencies=true.
  // Excludes "Main Ledger" from ledger_quantities to match GAS response exactly.
  async function getAllCurrencies() {
    var snap = await load();
    if (!snap) return null;
    var currencies = snap.items.map(function (it) {
      var lq = {};
      Object.keys(it.ledgers || {}).forEach(function (k) {
        if (k !== 'Main Ledger') lq[k] = it.ledgers[k];
      });
      return {
        product_name: it.currency,
        product_image: '',
        landing_page: '',
        ledger: '',
        farm_name: '',
        state: '',
        country: '',
        year: '',
        unit_weight_g: it.unit_weight_g != null ? it.unit_weight_g : null,
        total_quantity: it.total_quantity,
        ledger_quantities: lq
      };
    });
    return { status: 'success', data: { currencies: currencies, total_currencies: currencies.length } };
  }

  // [{currency, amount, unit_cost?, total_value?, ledger?, gtin?, hs_code?}]
  // gtin and hs_code are available from schema v4+ (Currencies columns R and S).
  async function getManagerAssets(managerKey) {
    var snap = await load();
    if (!snap) return null;
    var manager = snap.managers.find(function (m) { return m.manager_key === managerKey; });
    if (!manager) return [];
    return manager.items.map(function (itm) {
      var out = { currency: itm.currency, amount: itm.amount };
      if (itm.unit_cost_usd != null) out.unit_cost = itm.unit_cost_usd;
      if (itm.total_value_usd != null) out.total_value = itm.total_value_usd;
      if (itm.ledger) out.ledger = itm.ledger;
      if (itm.gtin) out.gtin = itm.gtin;
      if (itm.hs_code) out.hs_code = itm.hs_code;
      return out;
    });
  }

  // {status:'success', data:{inventory:[{currency, amount, ledger_name, weight_grams, has_weight}]}}
  // — drop-in for tdg_shipping_planner ?action=get_inventory&manager=<…>.
  // Accepts either the raw manager name OR the URI-encoded key, matching
  // whichever form the caller has on hand.
  async function getManagerInventoryForShipping(managerIdentifier) {
    var snap = await load();
    if (!snap) return null;
    var manager = snap.managers.find(function (m) {
      return m.manager_name === managerIdentifier || m.manager_key === managerIdentifier;
    });
    if (!manager) {
      try {
        var decoded = decodeURIComponent(managerIdentifier);
        manager = snap.managers.find(function (m) { return m.manager_name === decoded; });
      } catch (_) { /* malformed URI component — give up */ }
    }
    var inventory = manager
      ? manager.items.map(function (itm) {
          var entry = {
            currency: itm.currency,
            amount: itm.amount,
            ledger_name: itm.ledger || '',
            weight_grams: itm.unit_weight_g != null ? itm.unit_weight_g : null,
            has_weight: itm.unit_weight_g != null
          };
          if (itm.gtin) entry.gtin = itm.gtin;
          if (itm.hs_code) entry.hs_code = itm.hs_code;
          return entry;
        })
      : [];
    return { status: 'success', data: { inventory: inventory } };
  }

  // {status:'success', data:{managers:[{key, name}]}} — drop-in for
  // tdg_shipping_planner ?action=list_managers (different wrap than DAO_FORMS_BASE).
  async function getManagersForShipping() {
    var snap = await load();
    if (!snap) return null;
    return {
      status: 'success',
      data: {
        managers: snap.managers.map(function (m) {
          return { key: m.manager_key, name: m.manager_name };
        })
      }
    };
  }

  function _hexFromBuffer(buf) {
    var bytes = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }

  // Fast, GAS-free signature-registration check. The cache publisher writes one
  // file per ACTIVE public key at public_keys/<sha256(publicKeyBase64)>.json, so
  // a single static CDN fetch confirms registration without an Apps Script
  // cold-start + full-sheet scan.
  //
  // Returns one of:
  //   { registered: true,  record: {...} }          — ACTIVE key found in cache
  //   { registered: false, reason: 'not_active' }   — file exists but status !== ACTIVE
  //   { registered: false, reason: 'not_found' }    — no file (unknown OR too new for cache)
  //   { registered: null,  reason: 'error', error } — network/crypto failure; caller should fall back
  //
  // `reason: 'not_found'` is intentionally ambiguous: a brand-new signature may
  // not be in the cron-published cache yet, so callers should fall back to the
  // GAS assetVerify endpoint before declaring the key invalid.
  async function verifyPublicKey(publicKeyBase64) {
    if (!publicKeyBase64) return { registered: false, reason: 'not_found' };
    try {
      if (!global.crypto || !global.crypto.subtle) {
        return { registered: null, reason: 'error', error: new Error('WebCrypto unavailable') };
      }
      var data = new TextEncoder().encode(publicKeyBase64);
      var digest = await global.crypto.subtle.digest('SHA-256', data);
      var hash = _hexFromBuffer(digest);
      var url = PUBLIC_KEYS_BASE_URL + hash + '.json?t=' + TREASURY_CACHE_SESSION_BUST;
      var res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) {
        return { registered: false, reason: 'not_found' };
      }
      if (!res.ok) {
        return { registered: null, reason: 'error', error: new Error('HTTP ' + res.status) };
      }
      var record = await res.json();
      if (record && record.status === 'ACTIVE') {
        return { registered: true, record: record };
      }
      return { registered: false, reason: 'not_active', record: record };
    } catch (err) {
      console.warn('[treasury-cache] verifyPublicKey failed, caller should fall back to GAS:', err);
      return { registered: null, reason: 'error', error: err };
    }
  }

  global.TreasuryCache = {
    load: load,
    getManagers: getManagers,
    getLedgers: getLedgers,
    getAllCurrencies: getAllCurrencies,
    getManagerAssets: getManagerAssets,
    getManagerInventoryForShipping: getManagerInventoryForShipping,
    getManagersForShipping: getManagersForShipping,
    verifyPublicKey: verifyPublicKey
  };
})(window);
