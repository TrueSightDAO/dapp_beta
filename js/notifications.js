// DApp notification badge — Facebook-style red counter for action items
// across DApp modules. Loaded by menu.js on every page so the operator
// can spot pending work without loading each module.
//
// Architecture
// ------------
// Each module is a "source" registered via Notifications.register({...}).
// A source's fetch() returns either null (no items / fetch failed — module
// hidden from popup) or an object of the shape:
//
//   {
//     count: <int>,                  // number contributed to the red badge
//     label: <string>,               // module name shown in popup
//     sublabel: <string>,            // short description e.g. "drafts to review"
//     link: <string>,                // where clicking the entry sends the user
//     items: [                       // optional, top N items shown nested in popup
//       { title: <string>, link: <string>, since: <string> }
//     ]
//   }
//
// Sources fetch in parallel. The badge totals counts; null sources are
// silently skipped. A source that throws is treated as null + logged.
//
// To add a new module: append a source via Notifications.register() in
// this file (or from another script loaded after notifications.js). The
// JSON contract above is the only thing the popup understands; new
// modules don't need any change to this widget.

(function (global) {
  'use strict';

  var STATE = {
    sources: [],
    results: {},          // id -> result (or null)
    refreshing: false,
    rendered: false,
    open: false
  };

  var REFRESH_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

  // ----- Public API ---------------------------------------------------------

  function register(source) {
    if (!source || !source.id || typeof source.fetch !== 'function') {
      console.warn('[notifications] register() expects {id, fetch}', source);
      return;
    }
    STATE.sources.push(source);
    // If the widget has already booted, refresh so the new source shows.
    if (STATE.rendered) refresh();
  }

  function refresh() {
    if (STATE.refreshing) return;
    STATE.refreshing = true;
    var pending = STATE.sources.map(function (src) {
      return Promise.resolve()
        .then(function () { return src.fetch(); })
        .then(function (result) { STATE.results[src.id] = result || null; })
        .catch(function (err) {
          console.warn('[notifications] source "' + src.id + '" failed:', err);
          STATE.results[src.id] = null;
        });
    });
    return Promise.all(pending).finally(function () {
      STATE.refreshing = false;
      renderBadge();
      renderPopup();
    });
  }

  // ----- DOM ----------------------------------------------------------------

  function ensureChrome() {
    if (document.getElementById('tsd-notif-root')) return;
    var root = document.createElement('div');
    root.id = 'tsd-notif-root';
    root.innerHTML = [
      '<style>',
      '  #tsd-notif-root { position: fixed; top: 0.75rem; right: 0.75rem; z-index: 9999; font-family: inherit; }',
      '  #tsd-notif-btn { position: relative; width: 40px; height: 40px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.18); border: 1px solid #e1ddd4; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; overflow: visible; z-index: 10000; }',
      '  #tsd-notif-btn svg { width: 20px; height: 20px; fill: #4a4a4a; }',
      '  #tsd-notif-btn:hover { background: #faf7f1; }',
      '  #tsd-notif-badge { position: absolute; top: -3px; right: -2px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: #d64545; color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; box-sizing: border-box; display: none; }',
      '  #tsd-notif-badge.has-count { display: inline-block; }',
      '  #tsd-notif-popup { position: absolute; top: 48px; right: 0; min-width: 280px; max-width: 360px; background: #fff; border: 1px solid #e1ddd4; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); padding: 0.5rem 0; display: none; }',
      '  #tsd-notif-popup.open { display: block; }',
      '  .tsd-notif-header { padding: 0.5rem 0.85rem; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8a8275; border-bottom: 1px solid #f0ece4; }',
      '  .tsd-notif-empty { padding: 0.85rem; color: #8a8275; font-size: 0.875rem; text-align: center; }',
      '  .tsd-notif-entry { display: block; padding: 0.7rem 0.85rem; color: inherit; text-decoration: none; border-bottom: 1px solid #f6f3eb; }',
      '  .tsd-notif-entry:last-child { border-bottom: none; }',
      '  .tsd-notif-entry:hover { background: #faf7f1; }',
      '  .tsd-notif-entry-title { font-weight: 600; font-size: 0.9375rem; color: #2a2a2a; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }',
      '  .tsd-notif-entry-count { background: #d64545; color: #fff; min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; box-sizing: border-box; }',
      '  .tsd-notif-entry-sub { font-size: 0.8125rem; color: #6f6859; margin-top: 0.15rem; }',
      '  .tsd-notif-items { margin: 0.4rem 0 0 0; padding: 0; list-style: none; font-size: 0.8125rem; color: #6f6859; }',
      '  .tsd-notif-items li { padding: 0.15rem 0; }',
      '  .tsd-notif-entry-header { background: #faf7f1; }',
      '  .tsd-notif-entry-item { display: flex; justify-content: space-between; align-items: baseline; padding: 0.45rem 1.1rem; font-size: 0.875rem; color: #2a2a2a; gap: 0.5rem; }',
      '  .tsd-notif-entry-item:hover { background: #faf7f1; }',
      '  .tsd-notif-item-title { font-weight: 500; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '  .tsd-notif-item-since { font-size: 0.75rem; color: #8a8275; flex: 0 0 auto; }',
      '</style>',
      '<button id="tsd-notif-btn" type="button" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">',
      '  <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2a7 7 0 0 0-7 7v3.586l-1.707 1.707A1 1 0 0 0 4 16h16a1 1 0 0 0 .707-1.707L19 12.586V9a7 7 0 0 0-7-7zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3z"/></svg>',
      '  <span id="tsd-notif-badge">0</span>',
      '</button>',
      '<div id="tsd-notif-popup" role="dialog" aria-label="Action items"></div>'
    ].join('');
    document.body.appendChild(root);

    document.getElementById('tsd-notif-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      togglePopup();
    });
    document.addEventListener('click', function (e) {
      if (!STATE.open) return;
      if (e.target.closest && e.target.closest('#tsd-notif-root')) return;
      togglePopup(false);
    });
    STATE.rendered = true;
  }

  function togglePopup(force) {
    var willOpen = (typeof force === 'boolean') ? force : !STATE.open;
    STATE.open = willOpen;
    var popup = document.getElementById('tsd-notif-popup');
    var btn = document.getElementById('tsd-notif-btn');
    if (!popup || !btn) return;
    popup.classList.toggle('open', willOpen);
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) renderPopup();
  }

  function renderBadge() {
    var badge = document.getElementById('tsd-notif-badge');
    if (!badge) return;
    var total = 0;
    Object.keys(STATE.results).forEach(function (id) {
      var r = STATE.results[id];
      if (r && typeof r.count === 'number') total += r.count;
    });
    badge.textContent = total > 99 ? '99+' : String(total);
    badge.classList.toggle('has-count', total > 0);
  }

  function renderPopup() {
    var popup = document.getElementById('tsd-notif-popup');
    if (!popup) return;
    var entries = STATE.sources
      .map(function (src) { return STATE.results[src.id]; })
      .filter(function (r) { return r && typeof r.count === 'number' && r.count > 0; });

    var html = ['<div class="tsd-notif-header">Action items</div>'];
    if (entries.length === 0) {
      html.push('<div class="tsd-notif-empty">No pending action items.</div>');
    } else {
      entries.forEach(function (r) {
        // Module header — clickable, leads to the module's index/landing.
        html.push(
          '<a class="tsd-notif-entry tsd-notif-entry-header" href="' + escapeAttr(r.link || '#') + '">' +
            '<div class="tsd-notif-entry-title"><span>' + escapeHtml(r.label || '') + '</span>' +
              '<span class="tsd-notif-entry-count">' + r.count + '</span>' +
            '</div>' +
            (r.sublabel ? '<div class="tsd-notif-entry-sub">' + escapeHtml(r.sublabel) + '</div>' : '') +
          '</a>'
        );
        // Per-item rows — each its own clickable <a> with optional deep-link.
        // Items with no item-level link fall back to the module's link.
        if (Array.isArray(r.items) && r.items.length) {
          r.items.slice(0, 4).forEach(function (it) {
            var itemLink = it.link || r.link || '#';
            html.push(
              '<a class="tsd-notif-entry tsd-notif-entry-item" href="' + escapeAttr(itemLink) + '">' +
                '<span class="tsd-notif-item-title">' + escapeHtml(it.title || '') + '</span>' +
                (it.since ? '<span class="tsd-notif-item-since">' + escapeHtml(it.since) + '</span>' : '') +
              '</a>'
            );
          });
        }
      });
    }
    popup.innerHTML = html.join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ----- Built-in sources ---------------------------------------------------

  // Outbound Review (warmup, follow-up, prospect-replied drafts)
  // Uses the same GAS endpoint warmup_review.html already calls — no new
  // server-side work needed.
  register({
    id: 'warmup',
    fetch: function () {
      var routes = global.Routes;
      if (!routes || !routes.gas || !routes.gas.storesHitList) return null;
      var url = routes.gas.storesHitList + '?action=getWarmupReviewQueue';
      return fetch(url, { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || json.status !== 'success' || !json.data) return null;
          var counts = json.data.counts || {};
          var warmup = Number(counts['AI/Warm-up'] || 0);
          var followup = Number(counts['AI/Follow-up'] || 0);
          var replied = Number(counts['AI/Prospect Replied'] || 0);
          var poke = Number(counts['AI/Partner Poke'] || 0);
          var total = warmup + followup + replied + poke;
          if (!total) return null;
          var parts = [];
          if (replied) parts.push(replied + ' prospect replied');
          if (poke) parts.push(poke + ' partner poke');
          if (followup) parts.push(followup + ' follow-up');
          if (warmup) parts.push(warmup + ' warm-up');
          return {
            count: total,
            label: 'Outbound Review',
            sublabel: parts.join(' · ') + ' (drafts to review)',
            link: './warmup_review.html'
          };
        });
    }
  });

  // Partner Check-in follow-ups due
  // Uses the existing `list_partners_needing_attention` action on
  // tdg_shipping_planner, which returns partners whose operator-specified
  // Next Check-in Date is overdue or within 3 days (today + 3 cutoff). The
  // cadence is operator-driven — Gary picks the next-check-in date when
  // filing each check-in, so the badge surfaces exactly what the operator
  // asked to be reminded about (avoids the "tracker tells you to act"
  // anti-pattern documented in
  // feedback_check_tracking_before_recommending_action.md).
  //
  // The GAS response carries partner_id (slug). We join against
  // partners-velocity.json to surface partner_name in the popup.
  // The same velocity blob also feeds the Partner Stock source below,
  // so we cache the entire JSON, not just a name map.
  var velocityCache = null;
  var inventoryCache = null;
  var VELOCITY_URL  = 'https://raw.githubusercontent.com/TrueSightDAO/agroverse-inventory/main/partners-velocity.json';
  var INVENTORY_URL = 'https://raw.githubusercontent.com/TrueSightDAO/agroverse-inventory/main/partners-inventory.json';

  function fetchVelocityJson() {
    if (velocityCache) return Promise.resolve(velocityCache);
    return fetch(VELOCITY_URL, { method: 'GET', cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { velocityCache = json; return json; })
      .catch(function () { return null; });
  }
  function fetchInventoryJson() {
    if (inventoryCache) return Promise.resolve(inventoryCache);
    return fetch(INVENTORY_URL, { method: 'GET', cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (json) { inventoryCache = json; return json; })
      .catch(function () { return null; });
  }
  function getPartnerNameMap() {
    return fetchVelocityJson().then(function (json) {
      var map = {};
      if (json && json.partners && typeof json.partners === 'object') {
        Object.keys(json.partners).forEach(function (slug) {
          var p = json.partners[slug];
          if (p && p.partner_name) map[slug] = p.partner_name;
        });
      }
      return map;
    });
  }

  // Date helpers (lifted verbatim from partner_check_in.html so the
  // bell's stock-attention scoring matches what the page itself shows).
  function daysSince(isoDate) {
    if (!isoDate) return null;
    var d = new Date(isoDate + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }
  function relativeAge(isoDate) {
    var days = daysSince(isoDate);
    if (days === null) return 'unknown';
    if (days < 0) return 'in the future';
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 14) return days + ' days ago';
    if (days < 60) return Math.round(days / 7) + ' weeks ago';
    if (days < 365) return Math.round(days / 30) + ' months ago';
    return Math.round(days / 365 * 10) / 10 + ' years ago';
  }
  function slugDisplayName(slug) {
    var s = String(slug || '').split('/').pop();
    return s.split('-').map(function (w) {
      if (!w) return '';
      if (w.length <= 2) return w.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ').trim();
  }

  register({
    id: 'partner_followups',
    fetch: function () {
      var routes = global.Routes;
      if (!routes || !routes.gas || !routes.gas.shipping) return null;
      var url = routes.gas.shipping + '?action=list_partners_needing_attention';
      var apiPromise = fetch(url, { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
      return Promise.all([apiPromise, getPartnerNameMap()])
        .then(function (parts) {
          var json = parts[0];
          var nameMap = parts[1] || {};
          if (!json || json.status !== 'success' || !json.data) return null;
          var partners = json.data.partners || [];
          if (!partners.length) return null;

          // Sort: overdue first (largest days_overdue first), then upcoming
          partners.sort(function (a, b) {
            return (b.days_overdue || 0) - (a.days_overdue || 0);
          });

          var items = partners.slice(0, 4).map(function (p) {
            var pid = String(p.partner_id || '');
            var name = nameMap[pid] || pid || 'Partner';
            var days = Number(p.days_overdue);
            var since;
            if (isNaN(days)) since = '';
            else if (days > 0) since = days + 'd overdue';
            else if (days === 0) since = 'due today';
            else since = 'due in ' + (-days) + 'd';
            return {
              title: name,
              since: since,
              link: pid ? './partner_check_in.html?partner_id=' + encodeURIComponent(pid) : './partner_check_in.html'
            };
          });

          var overdueCount = partners.filter(function (p) {
            return Number(p.days_overdue) > 0;
          }).length;
          var sublabel = overdueCount
            ? overdueCount + ' overdue · ' + (partners.length - overdueCount) + ' upcoming'
            : partners.length + ' upcoming check-in' + (partners.length === 1 ? '' : 's');

          return {
            count: partners.length,
            label: 'Partner Check-in',
            sublabel: sublabel,
            link: './partner_check_in.html',
            items: items
          };
        })
        .catch(function () { return null; });
    }
  });

  // Partner Stock attention
  // Mirrors the "Needs Attention" scoring on partner_check_in.html so the
  // bell surfaces the same business-signal urgency the page does. Reads two
  // static GitHub-hosted JSONs (partners-velocity.json + partners-inventory.json),
  // both cached for the lifetime of the page.
  //
  // Severity rules (lifted verbatim from partner_check_in.html computeAttentionList):
  //   - critical: totalInv === 0          (out of stock)
  //   - warning : totalInv <= 3           (running low — N left)
  //   - info    : any SKU last_sale > 45d (dormant)
  //
  // Distinct from the partner_followups source above: this source surfaces
  // partners the business signals are flagging RIGHT NOW (data-driven),
  // not partners on the operator's planned check-in calendar (operator-driven).
  // Both can fire simultaneously on the same partner — that's by design;
  // they represent independent reasons to look at the partner.
  register({
    id: 'partner_stock',
    fetch: function () {
      return Promise.all([fetchVelocityJson(), fetchInventoryJson()])
        .then(function (parts) {
          var velocity = parts[0];
          var inventory = parts[1];
          if (!velocity || !velocity.partners) return null;

          var RETAIL_TYPES = { 'Consignment': true, 'Wholesale': true };
          var attention = [];

          Object.keys(velocity.partners).forEach(function (slug) {
            if (slug.indexOf('/') !== -1) return;  // skip cooperative slugs
            var vel = velocity.partners[slug];
            var ptype = (vel && vel.partner_type) || 'Consignment';
            if (RETAIL_TYPES[ptype] !== true) return;

            var inv = inventory && inventory.partners && inventory.partners[slug];
            var totalInv = 0;
            var reasons = [];
            var severity = null;

            if (inv && inv.items) {
              inv.items.forEach(function (it) { totalInv += (it.venueInventory || 0); });
              if (totalInv === 0) {
                reasons.push('out of stock');
                severity = 'critical';
              } else if (totalInv <= 3) {
                reasons.push('running low (' + totalInv + ' left)');
                severity = 'warning';
              }
            }

            if (vel && vel.items) {
              Object.keys(vel.items).forEach(function (sku) {
                var it = vel.items[sku];
                if (it.last_sale_date) {
                  var ds = daysSince(it.last_sale_date);
                  if (ds !== null && ds > 45) {
                    reasons.push('last sale ' + relativeAge(it.last_sale_date));
                    if (!severity) severity = 'info';
                  }
                }
              });
            }

            if (!reasons.length) return;
            attention.push({
              slug: slug,
              name: (vel && vel.partner_name) || slugDisplayName(slug),
              severity: severity,
              reasons: reasons
            });
          });

          if (!attention.length) return null;

          // Sort: critical → warning → info, then alphabetical
          var sevOrder = { critical: 0, warning: 1, info: 2 };
          attention.sort(function (a, b) {
            if (sevOrder[a.severity] !== sevOrder[b.severity]) {
              return sevOrder[a.severity] - sevOrder[b.severity];
            }
            return a.name.localeCompare(b.name);
          });

          var critical = attention.filter(function (a) { return a.severity === 'critical'; }).length;
          var warning  = attention.filter(function (a) { return a.severity === 'warning';  }).length;
          var dormant  = attention.filter(function (a) { return a.severity === 'info';     }).length;
          var subParts = [];
          if (critical) subParts.push(critical + ' out of stock');
          if (warning)  subParts.push(warning  + ' low stock');
          if (dormant)  subParts.push(dormant  + ' dormant');

          return {
            count: attention.length,
            label: 'Partner Stock',
            sublabel: subParts.join(' · '),
            link: './partner_check_in.html',
            items: attention.slice(0, 4).map(function (a) {
              return {
                title: a.name,
                since: a.reasons[0],
                link: a.slug ? './partner_check_in.html?partner_id=' + encodeURIComponent(a.slug) : './partner_check_in.html'
              };
            })
          };
        })
        .catch(function () { return null; });
    }
  });

  // Pending Lineage program-registration requests (governor review surface).
  register({
    id: 'program_registrations',
    fetch: function () {
      var routes = global.Routes;
      if (!routes || !routes.gas || !routes.gas.programRegistrations) return null;
      var url = routes.gas.programRegistrations + '?action=getPendingProgramRegistrations';
      return fetch(url, { method: 'GET' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (json) {
          if (!json || json.status !== 'success' || !json.data) return null;
          var count = Number(json.data.pending_count || 0);
          if (!count) return null;
          return {
            count: count,
            label: 'Program Registrations',
            sublabel: count + ' pending to review',
            link: './program_registrations_review.html',
            items: (json.data.items || []).slice(0, 4).map(function (item) {
              return {
                title: item.display_name || item.program_name || 'Unknown program',
                since: item.submitted_date || '',
                link: './program_registrations_review.html'
              };
            })
          };
        })
        .catch(function () { return null; });
    }
  });

  // ----- Boot ---------------------------------------------------------------

  function boot() {
    ensureChrome();
    refresh();
    setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Notifications = {
    register: register,
    refresh: refresh
  };
})(typeof window !== 'undefined' ? window : this);
