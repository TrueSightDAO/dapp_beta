/**
 * CurrenciesCache — shared session-memoized currency-name list for the
 * Currency Name combobox on report_asset_receipt.html.
 *
 * Sources (both unioned, catalog first):
 *   1. CATALOG  — agroverse-inventory/currencies.json
 *      The canonical list, generated directly from the Main Ledger "Currencies"
 *      tab (column A) by go_to_market/scripts/sync_agroverse_currencies.py.
 *      Authoritative: contains every catalogued currency, even ones with no
 *      current holdings.
 *   2. SNAPSHOT — treasury-cache/dao_offchain_treasury.json
 *      The offchain treasury snapshot (treasury-cache-publisher). Its items[]
 *      is holdings-derived only, so it can carry a held-but-uncatalogued
 *      currency. Unioned in as a safety net so nothing selectable is lost.
 *
 * If one source fails the other is still used; only if BOTH fail does
 * fetchCurrencies() reject. Mirrors scripts/dao_members_cache.js structure
 * (one in-flight promise shared per page).
 *
 * Exposes:
 *   window.CurrenciesCache.fetchSnapshot()   -> Promise<treasury snapshot JSON>
 *   window.CurrenciesCache.fetchCatalog()    -> Promise<string[]>
 *   window.CurrenciesCache.fetchCurrencies() -> Promise<string[]> (deduped, sorted)
 *   window.CurrenciesCache.invalidate()      -> drops memoized promises
 *   window.CurrenciesCache.DEFAULT_URL / CATALOG_URL
 */
(function (global) {
  const DEFAULT_URL =
      'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json';
  const CATALOG_URL =
      'https://raw.githubusercontent.com/TrueSightDAO/agroverse-inventory/main/currencies.json';

  let cachedSnapshotPromise = null;
  let cachedSnapshotUrl = null;
  let cachedCatalogPromise = null;
  let cachedCatalogUrl = null;

  function resolveSnapshotUrl() {
    return (global.Routes && global.Routes.currenciesCache) || DEFAULT_URL;
  }

  function resolveCatalogUrl() {
    return (global.Routes && global.Routes.currenciesCatalog) || CATALOG_URL;
  }

  function fetchSnapshot() {
    const url = resolveSnapshotUrl();
    if (cachedSnapshotPromise && cachedSnapshotUrl === url) return cachedSnapshotPromise;
    cachedSnapshotUrl = url;
    cachedSnapshotPromise = global.fetch(url, { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) {
        cachedSnapshotPromise = null; // don't pin a bad response for the session
        throw new Error('dao_offchain_treasury.json HTTP ' + resp.status);
      }
      return resp.json();
    }).catch(function (err) {
      cachedSnapshotPromise = null;
      throw err;
    });
    return cachedSnapshotPromise;
  }

  function fetchCatalog() {
    const url = resolveCatalogUrl();
    if (cachedCatalogPromise && cachedCatalogUrl === url) return cachedCatalogPromise;
    cachedCatalogUrl = url;
    cachedCatalogPromise = global.fetch(url, { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) {
        cachedCatalogPromise = null;
        throw new Error('currencies.json HTTP ' + resp.status);
      }
      return resp.json();
    }).then(function (data) {
      if (Array.isArray(data)) return data;
      return (data && data.currencies) || [];
    }).catch(function (err) {
      cachedCatalogPromise = null;
      throw err;
    });
    return cachedCatalogPromise;
  }

  function currenciesFromSnapshot(snapshot) {
    const items = (snapshot && snapshot.items) || [];
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const currency = items[i] && items[i].currency;
      if (currency) out.push(currency);
    }
    return out;
  }

  // De-duplicated, alphabetically sorted union of the catalog and the snapshot.
  function fetchCurrencies() {
    const catalog = fetchCatalog().catch(function () { return null; });
    const snapshot = fetchSnapshot()
        .then(currenciesFromSnapshot)
        .catch(function () { return null; });

    return Promise.all([catalog, snapshot]).then(function (results) {
      const catalogList = results[0];
      const snapshotList = results[1];
      if (catalogList === null && snapshotList === null) {
        throw new Error('currencies cache unavailable: catalog and snapshot both failed');
      }
      const seen = {};
      const currencies = [];
      const merged = (catalogList || []).concat(snapshotList || []);
      for (let i = 0; i < merged.length; i++) {
        const currency = merged[i];
        if (currency && !seen[currency]) {
          seen[currency] = true;
          currencies.push(currency);
        }
      }
      return currencies.sort(function (a, b) { return a.localeCompare(b); });
    });
  }

  function invalidate() {
    cachedSnapshotPromise = null;
    cachedSnapshotUrl = null;
    cachedCatalogPromise = null;
    cachedCatalogUrl = null;
  }

  global.CurrenciesCache = {
    DEFAULT_URL: DEFAULT_URL,
    CATALOG_URL: CATALOG_URL,
    fetchSnapshot: fetchSnapshot,
    fetchCatalog: fetchCatalog,
    fetchCurrencies: fetchCurrencies,
    invalidate: invalidate
  };
})(window);
