# TrueSight DAO DApp - UX Conventions

This document outlines UX patterns and conventions used across the TrueSight DAO DApp to ensure consistency and provide clear user feedback.

## Table of Contents
1. [Remote Data Loading Patterns](#remote-data-loading-patterns)
2. [Form Field States](#form-field-states)
3. [Digital Signature Verification](#digital-signature-verification)
4. [TDG Balance Badge (Global)](#tdg-balance-badge-global)
5. [Combobox/Searchable Dropdowns](#comboboxsearchable-dropdowns)
6. [Error Handling](#error-handling)

---

## Remote Data Loading Patterns

### Pattern: Loading Remote Values into Form Fields

**When to use:** When form fields need to be populated with data fetched from a remote API (e.g., Google Apps Script, Edgar backend).

**Implementation Requirements:**

1. **Immediate Visual Feedback:**
   - Show loading state **immediately** when user action triggers remote data fetch
   - Apply loading state to all fields that will be populated
   - Use visual indicators (dimmed fields, "Loading..." text) to show fields are being updated

2. **Loading State Indicators:**
   - Fields should be visually dimmed (opacity: 0.6)
   - Fields should be disabled (pointer-events: none) during loading
   - Help text should change to indicate loading: "Loading [data type] details..."
   - Use blue/italic styling for loading messages to differentiate from normal help text

3. **Clear Loading State:**
   - Remove loading indicators once data is successfully loaded
   - Restore original help text after fields are populated
   - Handle errors gracefully with clear error messages

**Example Implementation:**

```javascript
function showFieldLoadingState() {
    // Apply loading class to fields
    field1.classList.add('loading-field');
    field2.classList.add('loading-field');
    
    // Update help text
    helpText1.textContent = 'Loading QR code details...';
    helpText1.className = 'field-loading-message';
}

function clearFieldLoadingState() {
    // Remove loading class
    field1.classList.remove('loading-field');
    field2.classList.remove('loading-field');
    
    // Restore original help text
    helpText1.textContent = 'Original help text';
    helpText1.className = 'help-text';
}

async function loadRemoteData() {
    showFieldLoadingState(); // Show immediately
    
    try {
        const data = await fetch(apiEndpoint);
        // Populate fields with data
        populateFields(data);
        clearFieldLoadingState(); // Clear after success
    } catch (err) {
        clearFieldLoadingState(); // Clear even on error
        showError(err.message);
    }
}
```

**CSS Classes:**

```css
.loading-field {
    opacity: 0.6;
    pointer-events: none;
    position: relative;
}

.loading-field::after {
    content: 'Loading...';
    position: absolute;
    right: 0.8rem;
    top: 50%;
    transform: translateY(-50%);
    color: #007bff;
    font-size: 0.85rem;
    font-style: italic;
}

.field-loading-message {
    font-size: 0.85rem;
    color: #007bff;
    font-style: italic;
    margin-top: 0.25rem;
}
```

**Files Using This Pattern:**
- `update_qr_code.html` - When QR code is selected, loads associated member, status, and email
- `report_inventory_movement.html` - When QR code is scanned, loads item details
- Future modules that populate fields from remote data

**Rationale:**
- Prevents user confusion during network latency
- Clearly indicates which fields are being updated
- Provides immediate feedback that the system is working
- Reduces perceived wait time

---

## Form Field States

### Normal State
- Fields are enabled and interactive
- Help text provides guidance on field usage
- Standard styling (black text, white background)

### Loading State
- Fields are dimmed and disabled
- Help text shows loading message
- Visual "Loading..." indicator

### Error State
- Fields may show error styling (red border)
- Help text shows error message in red
- User can correct and retry

### Success State
- Fields show populated values
- Help text may show current values if applicable
- Fields remain editable for updates

---

## Digital Signature Verification

### Pattern: Signature Verification on Page Load

**When to use:** On pages that require authenticated user actions.

**Implementation:**
1. Show "Verifying your digital signature..." message immediately on page load
2. Check for signature in localStorage
3. If missing, redirect to `create_signature.html` after 2-second countdown
4. **Cache-first identity lookup** (see below), falling back to the GAS `assetVerify` endpoint
5. If verification fails, show error and redirect to create signature
6. If successful, show welcome message and enable form

### Pattern: Cache-First Identity Lookup (fast path)

**Why:** The GAS `assetVerify` (`?signature=<publicKey>`) endpoint scans the ledger
spreadsheet and has a 1–5s cold-start. The same "is this key registered + who is it"
fact is published to GitHub as a static JSON, served from a CDN in ~50–150ms.

**Rule:** Verify against the cache first, then **fall back to GAS** on a cache miss.
The fallback matters: a brand-new signature (registered minutes ago) may not be in the
cron-published cache yet, so a cache miss must NOT immediately declare the key invalid.

**Standard helper — `DaoMembersCache.findByPublicKey(pk)`** (from `scripts/dao_members_cache.js`):
Returns `{contributor, key, ...}` and gives the contributor **name** most pages display.
Include `<script src="./scripts/dao_members_cache.js"></script>` in the head (after `tdg_balance.js`).

```js
let data;
// Cache-first identity lookup — dao_members.json from GitHub CDN
// (~50–150ms) vs the assetVerify GAS round-trip (1–5s cold-start).
try {
  const lookup = await window.DaoMembersCache.findByPublicKey(publicKey);
  if (lookup.contributor) {
    data = { contributor_name: lookup.contributor.name };
  }
} catch (_) { /* cache unavailable; fall through to GAS */ }

if (!data) {
  const response = await fetch(`${API_ENDPOINT}?signature=${encodeURIComponent(publicKey)}`);
  data = await response.json();
}
// …then use data.error / data.contributor_name exactly as before.
```

**Alternate helper — `TreasuryCache.verifyPublicKey(pk)`** (from `js/treasury_cache.js`):
For pages that need only a boolean "is registered?" gate (no name). Fetches a single
tiny `public_keys/<sha256(pubkey)>.json` file. Returns `{registered, reason, record}`.
Used by `view_inventory_holdings.html`. Fall back to GAS on `not_found`/`error`.

**Exceptions (keep authoritative GAS call):**
- `withdraw_voting_rights.html` / `withdraw_voting_rights_settlement.html` need live
  **balances** (`&full=true`: `total_assets`, `asset_per_circulated_voting_right`,
  `usd_provisions_for_cash_out`) that the identity cache does not carry.

**Files Using This Pattern:**
- Cache-first (name) + GAS fallback: `create_proposal.html`, `scanner.html`,
  `notarize.html`, `report_tree_planting.html`, `register_farm.html`,
  `submit_feedback.html`, `verify_request.html`, `update_qr_code.html`,
  `review_proposal.html`, `repackaging_planner.html`, `batch_qr_generator.html`,
  `report_contribution.html`, `report_sales.html`, `report_inventory_movement.html`,
  `report_dao_expenses.html`, `stores_nearby.html`, `store_interaction_history.html`
- Cache-first (boolean) + GAS fallback: `view_inventory_holdings.html`
- All authenticated DApp modules

---

## TDG Balance Badge (Global)

### Pattern: Always-Visible TDG Holdings After Verification

**When to use:** On every DApp page. Users should see their TDG voting rights and estimated value as soon as their digital signature is verified, without visiting the cash-out page.

**Implementation:**
1. Include `<script src="./tdg_balance.js"></script>` in the head (after menu.js).
2. Add `<div id="tdgBalanceBadge"></div>` in the body, after `navDropdown` and before `.container`.
3. The script checks for `publicKey` in localStorage and fetches holdings from the TDG API.
4. On success, renders a compact badge: "Your TDG: X voting rights · ~$Y" with a link to `withdraw_voting_rights.html`.
5. On load, shows "Loading your TDG holdings…" until the API responds.
6. On error or no signature, the badge container is left empty (and hidden via `display: none` when empty).

**UI/UX:**
- Badge appears below the nav dropdown, above main content.
- Matches DApp info-box styling: `#f8f9fa` background, `#ddd` border, 5px radius, consistent with `.info-box` on other pages.
- Format: `934,927 voting rights · ~$6,526 est. cash-out value` — formatted numbers (commas, sensible decimals) and clear labels for both rights and value.
- Whole badge is clickable, links to cash-out page; hover darkens background slightly.

**Rationale:**
- Reduces onboarding friction (users like Garis struggled to find their balance).
- Provides consistent context across all pages.
- Standardized pattern for all current and future DApp pages.

**See:** `dapp/tdg_balance.js`, `dapp/UX_CONVENTIONS.md`, `agentic_ai_context/DAPP_PAGE_CONVENTIONS.md`.

---

## Combobox/Searchable Dropdowns

### Pattern: Searchable Dropdown for Large Lists

**When to use:** When selecting from a large list of items (e.g., QR codes, members, managers).

**Implementation:**
1. Display div shows selected value or placeholder
2. Clicking opens dropdown with search input
3. Typing filters list in real-time
4. Clicking item selects it and closes dropdown
5. Enter key selects first match
6. Escape key closes dropdown
7. Click outside closes dropdown

**Files Using This Pattern:**
- `update_qr_code.html` - QR code selection, member selection
- `report_inventory_movement.html` - Manager selection, item selection, recipient selection
- `report_asset_receipt.html` - Fund Handler selection, Currency Name selection

**Shared component:** `scripts/dapp_combobox.js` is the standard implementation
going forward — see DAPP_UX_COMPONENTS.md. `report_contribution.html` and
`report_inventory_movement.html` still carry their own pre-existing hand-rolled
versions pending a future consolidation; do not copy their code into new pages.

---

## Error Handling

### Pattern: User-Friendly Error Messages

**Guidelines:**
1. Show clear, actionable error messages
2. Use red color for errors (#dc3545)
3. Provide next steps when possible
4. For signature errors, redirect to create signature page
5. For network errors, offer offline alternatives (copy to clipboard)

**Error States:**
- **Signature Missing:** Redirect to create signature (2-second countdown)
- **Signature Invalid:** Show error, redirect to create signature
- **Network Error:** Show error, offer offline submission option
- **Validation Error:** Show inline error near relevant field

---

## Contributing

When adding new modules or features to the DApp:

1. **Follow these conventions** for consistency
2. **Reference this document** when implementing similar patterns
3. **Update this document** if introducing new UX patterns
4. **Test loading states** on slow network connections
5. **Ensure accessibility** - loading states should be screen-reader friendly

---

## Notes

- All loading states should be cleared even if errors occur
- Help text should always be restored to original state after loading
- Visual feedback should be immediate (don't wait for network response)
- Consider mobile users with slow connections when implementing loading states

