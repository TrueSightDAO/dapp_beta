(function (global) {
  // Single source of truth for every remote endpoint the DApp calls.
  // Works in both window (pages) and self (service worker via importScripts).
  // Schemas live in tokenomics/API_ENDPOINTS.md — keep that doc in sync when
  // adding or changing any URL here.
  //
  // Two modes for Routes.gas.*:
  //   direct — call script.google.com directly (default, works everywhere except GFW)
  //   proxy  — route via edgar.truesight.me/proxy/gas/<name>, for networks
  //            that block script.google.com (server-side implementation lives
  //            in sentiment_importer/app/controllers/proxy_controller.rb; its
  //            GAS_UPSTREAMS keys MUST stay in lockstep with directGas below).
  //            Proxy forwards GET (query string) and POST (urlencoded body) to GAS.
  //
  // Mode selection at parse time (in this order):
  //   1. ?route=direct / ?route=proxy URL param (wins; persisted to localStorage)
  //   2. localStorage.routesMode (set by prior probe or prior URL override)
  //   3. default: direct
  //
  // A page may pin itself out of the probe by setting window.ROUTES_NO_PROBE = true
  // BEFORE this script loads. That is the correct choice for pages that must not
  // have their in-flight fetches aborted by a mid-session reload (e.g.
  // report_payout_event.html). ?route=proxy remains the manual escape hatch for
  // genuinely blocked networks.
  //
  // An async probe fires once per session on direct mode. If script.google.com
  // is unreachable within 3 seconds the probe sets localStorage.routesMode='proxy'
  // and raises a soft 'routes:proxy-suggested' event. It does NOT reload the page,
  // so in-flight requests on the current page are never aborted; the proxy takes
  // effect on the next navigation. An explicit ?route= URL param always wins and
  // is never overridden by the probe.

  var PROXY_BASE = 'https://edgar.truesight.me/proxy/gas/';

  var directGas = {
    assetVerify:      'https://script.google.com/macros/s/AKfycbygmwRbyqse-dpCYMco0rb93NSgg-Jc1QIw7kUiBM7CZK6jnWnMB5DEjdoX_eCsvVs7/exec',
    qrCodes:          'https://script.google.com/macros/s/AKfycbyGD0CDkvjo7K9O1gPnnqmdXvaJt9FM2v39HHqiDud5wwU6Mf41wwIOFS-NDD93xqoL/exec',
    qrCodeGenerator:  'https://script.google.com/macros/s/AKfycbyGD0CDkvjo7K9O1gPnnqmdXvaJt9FM2v39HHqiDud5wwU6Mf41wwIOFS-NDD93xqoL/exec',
    daoForms:         'https://script.google.com/macros/s/AKfycbztpV3TUIRn3ftNW1aGHAKw32OBJrp_p1Pr9mMAttoyWFZyQgBRPU2T6eGhkmJtz7xV/exec',
    proposals:        'https://script.google.com/a/macros/agroverse.shop/s/AKfycbzgNstwRX1dWo17Dxny0t1ipJ6yLX02bTD_cKRuHr5RPJPemNVTj25mFhKo4UmR5Z7BIg/exec',
    feedback:         'https://script.google.com/macros/s/AKfycbz3FQgXLaEc4KNq9fhCCFbf677OIcEMjVq_HjcgttMfCNWk7QWaCeTEq0xc5aRRbduFdg/exec',
    stores:           'https://script.google.com/macros/s/AKfycbwB2zqNV9nMCMWs2hSa8FecjA36Oh-mSVuz3pk8TpXrXcy9dvqOqgbWIirNka2LmacgPw/exec',
    storesHitList:    'https://script.google.com/macros/s/AKfycbwoBqZnDS4JRRdFkxSXdlGt-qIn-RauMcORuDHeWs29oQ2CpJ3L4A10uM8se9anL108/exec',
    shipping:         'https://script.google.com/macros/s/AKfycbz5Tt_vz1X26i82yqlGUSI_OtCUEO31jImZH2tXfNaxMbfmJ01dkwUIEZDjsnd10xMbcg/exec',
    programRegistrations: 'https://script.google.com/macros/s/AKfycbyxwkIp6Yn79YIuHCPmZ36J7dwIi7K8BLiUBj4qGm5RxSKta77sXRQf1M0wKuEBRbJW/exec',
    payoutRegistrations: 'https://script.google.com/macros/s/AKfycbxQDdGnwS7G6iJhNj9japW-9sFA7EUvrnznmJCu44S5ZHqOoIks2be4FXbIVpuaOHVW/exec'
  };

  var proxyGas = {};
  for (var key in directGas) {
    if (Object.prototype.hasOwnProperty.call(directGas, key)) {
      proxyGas[key] = PROXY_BASE + key;
    }
  }

  var isWindow = typeof window !== 'undefined';
  var mode = 'direct';
  var explicitRoute = false;

  if (isWindow) {
    try {
      var params = new URLSearchParams(window.location.search);
      var override = params.get('route');
      if (override === 'direct' || override === 'proxy') {
        mode = override;
        explicitRoute = true;
        localStorage.setItem('routesMode', mode);
      } else {
        mode = localStorage.getItem('routesMode') || 'direct';
      }
    } catch (_) {
      mode = 'direct';
    }
  }

  global.Routes = {
    edgar: {
      base:   'https://edgar.truesight.me',
      ping:   'https://edgar.truesight.me/ping',
      submit: 'https://edgar.truesight.me/dao/submit_contribution'
    },
    gas: mode === 'proxy' ? proxyGas : directGas,
    mode: mode,
    proxyBase: PROXY_BASE
  };

  // Async probe: only in window, only on direct mode, once per session.
  // Uses sessionStorage to guard against a reload loop if the probe itself
  // triggers a reload. On failure, flip localStorage to 'proxy' and reload.
  if (isWindow && mode === 'direct' && !explicitRoute) {
    // Skip probe on localhost — developer mode, no CORS to script.google.com.
    var hostname = window.location.hostname;
    var pinnedNoProbe = false;
    try {
      pinnedNoProbe = window.ROUTES_NO_PROBE === true;
    } catch (_) {}
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // no-op: developer is running locally
    } else if (!pinnedNoProbe) {
    try {
      if (sessionStorage.getItem('routesProbed') !== 'true') {
        sessionStorage.setItem('routesProbed', 'true');

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 3000);

        fetch(directGas.assetVerify, {
          method: 'GET',
          mode: 'no-cors',
          cache: 'no-store',
          signal: controller.signal
        }).then(function () {
          clearTimeout(timeoutId);
        }).catch(function () {
          clearTimeout(timeoutId);
          try {
            localStorage.setItem('routesMode', 'proxy');
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[routes.js] script.google.com unreachable; proxy mode will be used on the next navigation.');
            }
            // Soft signal instead of a reload: pages may listen and re-point their
            // own URLs, and the current page's in-flight fetches are left intact.
            try {
              if (typeof window.dispatchEvent === 'function' && typeof window.CustomEvent === 'function') {
                window.dispatchEvent(new window.CustomEvent('routes:proxy-suggested'));
              }
            } catch (_) {}
          } catch (_) {
            // localStorage unavailable — nothing to do.
          }
        });
      }
    } catch (_) {
      // sessionStorage unavailable — skip probe.
    }
    } // end else (non-localhost / not pinned)
  } // end if (isWindow && mode === 'direct' && !explicitRoute)
})(typeof self !== 'undefined' ? self : this);
