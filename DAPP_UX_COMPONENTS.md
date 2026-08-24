# DApp UX Components

Central place for reusable UI components shared across DApp pages. New pages
should use these components instead of hand-rolling per-page implementations.

## Combobox (pick existing or type new)

**File:** `scripts/dapp_combobox.js`

The DApp's standard searchable combobox for fields that take a value from a
growing list (contributors, currencies/inventory items, managers, recipients)
but must also accept values not yet in the list.

**When to use:** any form field where the value is usually chosen from a known
list but can also be a brand-new entry. If selection must be restricted to a
closed list, pass `allowNewValue: false`.

**API:**

```js
DappCombobox.attach({
  inputEl,          // <input type="text"> to decorate
  optionsSource,    // () => string[] | Promise<string[]>
  onSelect,         // (value) => void — fired when an option is picked
  allowNewValue,    // boolean (default true) — false = Enter only commits listed options
  placeholder       // hint shown when the filter matches nothing
});
// Returns { getValue, setValue, refresh, destroy }
```

**Behavior:**
- Click / focus opens a searchable dropdown; typing filters live.
- ArrowUp / ArrowDown highlight; Enter picks the highlighted option (or commits
  the typed value when `allowNewValue: true` and nothing is highlighted).
- Escape or Tab closes; clicking outside closes.
- The decorated element stays a real `<input type="text">` — existing `.value`
  reads and `input` listeners keep working unchanged.

**Sources of truth / option sources:**
- Contributors / fund handlers → `scripts/dao_members_cache.js`
  (`DaoMembersCache.fetchSnapshot()` → `contributors[].name`)
- Currencies (offchain treasury) → `scripts/currencies_cache.js`
  (`CurrenciesCache.fetchCurrencies()` → de-duplicated `items[].currency`)

**Pages using the shared component:**
- `report_asset_receipt.html` — Fund Handler, Currency Name

**Legacy hand-rolled implementations (pending consolidation):**
- `report_contribution.html` — `contributorSelectCombobox` (multi-select chip variant)
- `report_inventory_movement.html` — `managerSelectCombobox`, `itemSelectCombobox`,
  `recipientSelectCombobox`

Those pages predate the shared component and each carry their own independent
implementation with different internal names. They should be migrated to
`DappCombobox` in a future PR — do not copy their code into new pages.
