importScripts('./routes.js');

const CACHE_NAME = 'qr-scanner-cache-v14';

/**
 * Apps Script web apps + Edgar GAS proxy — must not use the Cache API or HTTP cache
 * for JSON list responses. exec URLs redirect to script.googleusercontent.com; those
 * hops were previously handled by the default fetch handler and could serve stale data.
 */
function isGasOrProxyGasUrl(url) {
  const host = url.hostname;
  const path = url.pathname;
  if (host === 'script.google.com' && (path.startsWith('/macros/s/') || path.startsWith('/a/macros/'))) {
    return true;
  }
  if (host === 'script.googleusercontent.com' && path.includes('/macros/')) {
    return true;
  }
  if (host === 'edgar.truesight.me' && path.startsWith('/proxy/gas/')) {
    return true;
  }
  return false;
}
const URLS_TO_CACHE = [
  // HTML pages
  './',
  './index.html',
  './create_signature.html',
  './notarize.html',
  './register_farm.html',
  './report_contribution.html',
  './report_dao_expenses.html',
  './report_inventory_movement.html',
  './currency_conversion.html',
  './view_inventory_holdings.html',
  './repackaging_planner.html',
  './partner_check_in.html',
  './report_sales.html',
  './report_tree_planting.html',
  './scanner.html',
  './submit_feedback.html',
  './verify_request.html',
  './withdraw_voting_rights.html',
  './governor_contributor_admin.html',
  './governor_permissions.html',
  './program_registrations_review.html',
  // Scripts
  './menu.js?v=20260603a',
  './routes.js',
  './service-worker.js',
  './js/treasury_cache.js',
  './js/dapp_footer_links.js?v=1',
  './js/notifications.js?v=20260603a',
  './scripts/dao_members_cache.js',
  './scripts/permissions.js',
  // External libraries
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
  // Assets
  './assets/brazil.png',
  './assets/usa.png',
  // Google Apps Script API endpoints — sourced from Routes for a single source of truth
  self.Routes.gas.assetVerify,
  self.Routes.gas.daoForms
];

// Install event: cache essential assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(URLS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

// Activate event: drop older qr-scanner-cache-* entries so stale GAS responses are not kept.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('qr-scanner-cache-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// Fetch event: serve from cache, update on network; support reload param
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // If reload param is present, fetch from network and update cache
  if (url.searchParams.has('reload')) {
    const cleanUrl = url.origin + url.pathname;
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(cleanUrl, responseClone));
          return response;
        })
        .catch(() => caches.match(cleanUrl))
    );
    return;
  }
  // Google Apps Script + Edgar /proxy/gas: network-only, never Cache-API or disk cache.
  // (Stores nearby and other live lists must always hit the wire.)
  if (isGasOrProxyGasUrl(url)) {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }
  // Default: network-first strategy for GET requests, pass through for POST/PUT/DELETE
  if (request.method !== 'GET') {
    event.respondWith(fetch(request));
    return;
  }
  event.respondWith(
    fetch(request)
      .then(response => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        return response;
      })
      .catch(() => caches.match(request))
  );
});