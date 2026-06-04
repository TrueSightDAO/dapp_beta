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
  // An async probe fires once per session on direct mode. If script.google.com
  // is unreachable within 3 seconds, the probe flips localStorage to 'proxy'
  // and reloads the page so subsequent URL captures see proxy URLs.

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
    programRegistrations: 'https://script.google.com/macros/s/AKfycbyxwkIp6Yn79YIuHCPmZ36J7dwIi7K8BLiUBj4qGm5RxSKta77sXRQf1M0wKuEBRbJW/exec'
  };

  var proxyGas = {};
  for (var key in directGas) {
    if (Object.prototype.hasOwnProperty.call(directGas, key)) {
      proxyGas[key] = PROXY_BASE + key;
    }
  }

  var isWindow = typeof window !== 'undefined';
  var mode = 'direct';

  if (isWindow) {
    try {
      var params = new URLSearchParams(window.location.search);
      var override = params.get('route');
      if (override === 'direct' || override === 'proxy') {
        mode = override;
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
  if (isWindow && mode === 'direct') {
    // Skip probe on localhost — developer mode, no CORS to script.google.com.
    var hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      // no-op: developer is running locally
    } else {
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
              console.warn('[routes.js] script.google.com unreachable; switching to Edgar proxy and reloading.');
            }
            window.location.reload();
          } catch (_) {
            // localStorage unavailable — nothing to do.
          }
        });
      }
    } catch (_) {
      // sessionStorage unavailable — skip probe.
    }
    } // end else (non-localhost)
  } // end if (isWindow && mode === 'direct')
})(typeof self !== 'undefined' ? self : this);
