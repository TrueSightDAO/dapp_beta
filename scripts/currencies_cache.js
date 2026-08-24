/**
 * CurrenciesCache — shared session-memoized fetch of the offchain treasury
 * snapshot, used to power the Currency Name datalist on report_asset_receipt.html.
 *
 * Source: https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json
 * Published by treasury-cache-publisher (cron) into the treasury-cache repo.
 *
 * Mirrors scripts/dao_members_cache.js structure & conventions exactly:
 * one in-flight promise is shared across all callers on a page, so multiple
 * consumers fetch the snapshot at most once per page load.
 *
 * Exposes:
 *   window.CurrenciesCache.fetchSnapshot()
 *       → Promise<snapshot JSON>.
 *   window.CurrenciesCache.fetchCurrencies()
 *       → Promise<string[]> — de-duplicated, sorted list of items[].currency.
 *   window.CurrenciesCache.invalidate()
 *       → drops the memoized promise; next call refetches.
 *   window.CurrenciesCache.DEFAULT_URL — the raw.githubusercontent.com URL.
 */
(function (global) {
  const DEFAULT_URL =
      'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_offchain_treasury.json';

  let cachedPromise = null;
  let cachedUrl = null;

  function resolveUrl() {
    return (global.Routes && global.Routes.currenciesCache) || DEFAULT_URL;
  }

  function fetchSnapshot() {
    const url = resolveUrl();
    if (cachedPromise && cachedUrl === url) return cachedPromise;
    cachedUrl = url;
    cachedPromise = global.fetch(url, { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) {
        cachedPromise = null; // don't pin a bad response for the rest of the session
        throw new Error('dao_offchain_treasury.json HTTP ' + resp.status);
      }
      return resp.json();
    }).catch(function (err) {
      cachedPromise = null;
      throw err;
    });
    return cachedPromise;
  }

  // De-duplicated, alphabetically sorted list of currency names (items[].currency).
  function fetchCurrencies() {
    return fetchSnapshot().then(function (snapshot) {
      const items = (snapshot && snapshot.items) || [];
      const seen = {};
      const currencies = [];
      for (let i = 0; i < items.length; i++) {
        const currency = items[i] && items[i].currency;
        if (currency && !seen[currency]) {
          seen[currency] = true;
          currencies.push(currency);
        }
      }
      return currencies.sort(function (a, b) { return a.localeCompare(b); });
    });
  }

  function invalidate() {
    cachedPromise = null;
    cachedUrl = null;
  }

  global.CurrenciesCache = {
    DEFAULT_URL: DEFAULT_URL,
    fetchSnapshot: fetchSnapshot,
    fetchCurrencies: fetchCurrencies,
    invalidate: invalidate
  };
})(window);
