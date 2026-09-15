/**
 * Permissions — client-side gate for the TrueSight DAO DApp permission model.
 *
 * Loads `permissions.json` (the action -> required_roles map; PR-reviewed source
 * of truth) from treasury-cache and resolves `(action, public_key) -> { allowed,
 * contributor, missing_roles }` by joining against `dao_members.json` (loaded
 * via the existing window.DaoMembersCache helper).
 *
 *   Source files:
 *     https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/permissions.json
 *     https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/public_keys/<sha256>.json
 *       (point-lookup of the signed-in RSA — O(1), no monolith scan; preferred)
 *     https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/dao_members.json
 *       (monolith fallback when the per-key file is missing/unavailable)
 *
 * IMPORTANT: this is the UX gate only. Every privileged endpoint (Edgar,
 * tokenomics GAS) MUST also enforce the same rule server-side; the client
 * gate stops accidental misuse, not motivated bypass.
 *
 * Exposes:
 *   window.Permissions.fetchManifest() -> Promise<manifest JSON>
 *   window.Permissions.check(action, publicKey)
 *       -> Promise<{ allowed, contributor, missing_roles, action_def, reason }>
 *   window.Permissions.requireRole(opts)
 *       opts: { action, publicKey, denyContainerId, onAllowed, onDenied }
 *       Renders the explicit permission-denied UI inside denyContainerId
 *       (or document.body if not specified) when not allowed; otherwise
 *       calls onAllowed(checkResult).
 *   window.Permissions.invalidate() -> drop cached manifest; next call refetches.
 *
 * Convention note: roles are case-sensitive lowercase strings ("governor",
 * "member", "operator", "custodian"). dao_members_cache_publisher emits the
 * Governors-tab join as ["governor", "member"]; see treasury-cache README
 * `dao_members.json` schema (v3+) for the source of truth.
 */
(function (global) {
  const DEFAULT_URL =
      'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/permissions.json';
  const PER_KEY_BASE_URL =
      'https://raw.githubusercontent.com/TrueSightDAO/treasury-cache/main/public_keys/';

  let cachedPromise = null;
  let cachedUrl = null;

  function resolveUrl() {
    return (global.Routes && global.Routes.permissions) || DEFAULT_URL;
  }

  function fetchManifest() {
    const url = resolveUrl();
    if (cachedPromise && cachedUrl === url) return cachedPromise;
    cachedUrl = url;
    cachedPromise = global.fetch(url, { cache: 'no-cache' }).then(function (resp) {
      if (!resp.ok) {
        cachedPromise = null;
        throw new Error('permissions.json HTTP ' + resp.status);
      }
      return resp.json();
    }).catch(function (err) {
      cachedPromise = null;
      throw err;
    });
    return cachedPromise;
  }

  function actionDef(manifest, action) {
    if (!manifest || !manifest.actions) return null;
    return manifest.actions[action] || null;
  }

  function rolesIntersect(have, required) {
    if (!Array.isArray(have) || !Array.isArray(required)) return false;
    for (let i = 0; i < required.length; i++) {
      if (have.indexOf(required[i]) >= 0) return true;
    }
    return false;
  }

  // ---- Point-lookup the signed-in RSA via the content-addressed per-key file ----
  // treasury-cache/public_keys/<sha256(publicKeyBase64)>.json — one small file,
  // O(1), no monolith scan. Falls back to the dao_members.json monolith scan when
  // the per-key surface is unavailable (network/crypto error) or the key is not
  // yet in it (brand-new signature). A key present but NOT ACTIVE is an
  // authoritative deny — no fallback (mirrors TreasuryCache.verifyPublicKey).

  function perKeyUrl(hash) {
    const base = (global.Routes && global.Routes.publicKeys) || PER_KEY_BASE_URL;
    return base + hash + '.json';
  }

  function sha256Hex(str) {
    if (!global.crypto || !global.crypto.subtle) {
      return Promise.reject(new Error('WebCrypto unavailable'));
    }
    const data = new TextEncoder().encode(str);
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      const bytes = new Uint8Array(buf);
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, '0');
      }
      return out;
    });
  }

  function fetchPerKey(publicKeyBase64) {
    return sha256Hex(publicKeyBase64).then(function (hash) {
      return global.fetch(perKeyUrl(hash), { cache: 'no-cache' }).then(function (resp) {
        if (resp.status === 404) return { state: 'missing' };
        if (!resp.ok) return { state: 'error' };
        return resp.json().then(function (rec) { return { state: 'found', record: rec }; });
      });
    });
  }

  function monolithLookup(publicKey) {
    if (!global.DaoMembersCache) {
      return Promise.reject(new Error(
          'Permissions.check requires DaoMembersCache (load scripts/dao_members_cache.js first)'));
    }
    return global.DaoMembersCache.findByPublicKey(publicKey).then(function (lookup) {
      return { contributor: lookup.contributor, key: lookup.key, source: 'monolith' };
    });
  }

  function resolveContributor(publicKey) {
    if (!publicKey) return monolithLookup(publicKey);
    return fetchPerKey(publicKey).then(function (r) {
      if (r.state === 'found') {
        const rec = r.record;
        if (rec && rec.status === 'ACTIVE') {
          return {
            contributor: { name: rec.contributor, roles: (rec.roles || []).slice() },
            key: { public_key: rec.public_key || publicKey, status: rec.status },
            source: 'per-key',
          };
        }
        return { contributor: null, key: null, source: 'per-key' }; // known-inactive → deny
      }
      // 'missing' (brand-new key?) or 'error' → fall back to the monolith scan.
      return monolithLookup(publicKey);
    }).catch(function () {
      return monolithLookup(publicKey);
    });
  }

  function check(action, publicKey) {
    return Promise.all([
      fetchManifest(),
      resolveContributor(publicKey),
    ]).then(function (results) {
      const manifest = results[0];
      const lookup = results[1];
      const def = actionDef(manifest, action);
      if (!def) {
        return {
          allowed: false,
          contributor: lookup.contributor,
          missing_roles: [],
          action_def: null,
          reason:
              'Unknown action ' + JSON.stringify(action) +
              '. The action is not declared in permissions.json — it must be added there ' +
              'before the DApp can gate it.',
        };
      }
      const required = def.required_roles || [];
      if (!lookup.contributor) {
        return {
          allowed: false,
          contributor: null,
          missing_roles: required,
          action_def: def,
          reason: 'Signed-in public key is not a registered DAO contributor.',
        };
      }
      const have = (lookup.contributor.roles && lookup.contributor.roles.slice()) || [];
      const ok = rolesIntersect(have, required);
      return {
        allowed: ok,
        contributor: lookup.contributor,
        missing_roles: ok ? [] : required.filter(function (r) { return have.indexOf(r) < 0; }),
        action_def: def,
        reason: ok
            ? null
            : 'Permission denied — this action is restricted to roles: ' +
              required.join(', ') + '. Your roles: ' + (have.join(', ') || '(none)') + '.',
      };
    });
  }

  function renderDenied(opts, checkResult) {
    const containerId = opts && opts.denyContainerId;
    const target = containerId ? document.getElementById(containerId) : document.body;
    if (!target) return;
    const def = checkResult.action_def || {};
    const action = (opts && opts.action) || '(unknown)';
    const required = (def.required_roles || []).join(', ') || '(undeclared)';
    const have = (checkResult.contributor && checkResult.contributor.roles &&
        checkResult.contributor.roles.join(', ')) || '(none)';
    const description = def.description || '';
    target.innerHTML =
        '<div class="permission-denied" style="' +
        'max-width: 600px; margin: 2rem auto; padding: 1.5rem; ' +
        'background: #fff5f5; border: 1px solid #f5c2c7; border-radius: 8px; ' +
        'color: #842029; font-family: Arial, sans-serif;">' +
        '<h2 style="margin: 0 0 0.5rem 0; color: #842029;">Permission denied</h2>' +
        '<p style="margin: 0 0 1rem 0;">This action is restricted to <strong>' +
        required + '</strong>.</p>' +
        (description
            ? '<p style="margin: 0 0 1rem 0; font-size: 0.95rem; color: #555;">' +
              '<em>' + description.replace(/</g, '&lt;') + '</em></p>'
            : '') +
        '<p style="margin: 0 0 0.5rem 0; font-size: 0.9rem;">' +
        '<strong>Action:</strong> ' + action + '<br>' +
        '<strong>Your roles:</strong> ' + have + '</p>' +
        '<p style="margin: 1rem 0 0 0; font-size: 0.9rem;">' +
        'If you believe this is incorrect, contact a Governor. The Governor list ' +
        'rotates 4×/year on the equinoxes/solstices; current members are visible on ' +
        '<a href="https://docs.google.com/spreadsheets/d/1GE7PUq-UT6x2rBN-Q2ksogbWpgyuh2SaxJyG_uEK6PU/edit?gid=842148543" target="_blank">' +
        'the Governors tab</a> on the Main Ledger.</p>' +
        '<p style="margin: 1rem 0 0 0;"><a href="./index.html" style="color: #0d6efd;">' +
        '← Back to Home</a></p>' +
        '</div>';
  }

  function requireRole(opts) {
    if (!opts || !opts.action) {
      return Promise.reject(new Error('Permissions.requireRole requires opts.action'));
    }
    return check(opts.action, opts.publicKey).then(function (result) {
      if (result.allowed) {
        if (typeof opts.onAllowed === 'function') opts.onAllowed(result);
        return result;
      }
      renderDenied(opts, result);
      if (typeof opts.onDenied === 'function') opts.onDenied(result);
      return result;
    });
  }

  function invalidate() {
    cachedPromise = null;
    cachedUrl = null;
  }

  global.Permissions = {
    DEFAULT_URL: DEFAULT_URL,
    PER_KEY_BASE_URL: PER_KEY_BASE_URL,
    fetchManifest: fetchManifest,
    resolveContributor: resolveContributor,
    check: check,
    requireRole: requireRole,
    invalidate: invalidate,
  };
})(window);
