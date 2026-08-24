/**
 * DappCombobox — the DApp's standard "pick existing or type new" searchable combobox.
 *
 * Shared component extracted from the hand-rolled implementations on
 * report_contribution.html (contributorSelectCombobox) and
 * report_inventory_movement.html (managerSelectCombobox / itemSelectCombobox /
 * recipientSelectCombobox). See DAPP_UX_COMPONENTS.md for the full convention.
 *
 * Design: the decorated element stays a real <input type="text">, so any
 * existing `.value` reads / input listeners keep working unchanged. The
 * dropdown is suggestions-only (unless allowNewValue is false), so users can
 * always type a brand-new value — required by report_asset_receipt.html, where
 * this form is how new Currency rows get created.
 *
 * Usage:
 *   DappCombobox.attach({
 *     inputEl: document.getElementById('currencyInput'),
 *     optionsSource: () => window.CurrenciesCache.fetchCurrencies(),
 *     onSelect: (value) => { ... },        // fired when an option is picked
 *     allowNewValue: true,                 // false = Enter only commits listed options
 *     placeholder: 'Type to search...'     // hint shown when the filter matches nothing
 *   });
 * Returns { getValue, setValue, refresh, destroy }.
 */
(function (global) {
  'use strict';

  function attach(options) {
    var inputEl = options && options.inputEl;
    if (!inputEl) { throw new Error('DappCombobox.attach: inputEl is required'); }
    var optionsSource = options.optionsSource || function () { return []; };
    var onSelect = options.onSelect || function () {};
    var allowNewValue = options.allowNewValue !== false; // default true
    var placeholder = options.placeholder || 'No matches';

    var parent = inputEl.parentElement;
    if (!parent) { throw new Error('DappCombobox.attach: inputEl must be inside a container'); }

    // Move the input into a relative wrapper so the caret + dropdown anchor to it.
    var wrapper = document.createElement('div');
    wrapper.className = 'dapp-combobox';
    wrapper.style.cssText = 'position:relative; display:block;';
    parent.insertBefore(wrapper, inputEl);
    wrapper.appendChild(inputEl);

    // Dropdown caret affordance (pointer-events:none so it never blocks typing).
    var caret = document.createElement('span');
    caret.className = 'dapp-combobox-caret';
    caret.textContent = '\u25BC';
    caret.style.cssText = 'position:absolute; right:12px; top:50%; transform:translateY(-50%); color:#666; pointer-events:none; z-index:1; font-size:0.7rem;';
    wrapper.appendChild(caret);
    // Keep typed text clear of the caret.
    if (inputEl.style.paddingRight === '') { inputEl.style.paddingRight = '2rem'; }

    // Dropdown container + options list.
    var dropdown = document.createElement('div');
    dropdown.className = 'dapp-combobox-dropdown';
    dropdown.style.cssText = 'display:none; position:absolute; top:100%; left:0; right:0; z-index:1000; background:#fff; border:1px solid #ccc; border-top:none; box-shadow:0 2px 4px rgba(0,0,0,0.1); border-radius:0 0 4px 4px;';
    var list = document.createElement('div');
    list.className = 'dapp-combobox-list';
    list.style.cssText = 'max-height:200px; overflow-y:auto;';
    dropdown.appendChild(list);
    wrapper.appendChild(dropdown);

    var state = {
      options: null,       // null = not fetched yet
      optionsPromise: null,
      open: false,
      highlight: -1,
      destroyed: false
    };

    function fetchOptions() {
      if (!state.optionsPromise) {
        state.optionsPromise = Promise.resolve()
          .then(function () { return optionsSource(); })
          .then(function (opts) {
            state.options = Array.isArray(opts) ? opts : [];
            return state.options;
          })
          .catch(function (err) {
            state.options = [];
            if (typeof console !== 'undefined' && console.error) {
              console.error('[DappCombobox] failed to load options:', err);
            }
            return state.options;
          });
      }
      return state.optionsPromise;
    }

    function render() {
      list.innerHTML = '';
      var filterText = inputEl.value ? inputEl.value.toLowerCase() : '';
      var options = (state.options || []).filter(function (opt) {
        return !filterText || String(opt).toLowerCase().includes(filterText);
      });

      if (options.length === 0) {
        var empty = document.createElement('div');
        empty.className = 'dapp-combobox-empty';
        empty.style.cssText = 'padding:8px 12px; color:#999; font-style:italic;';
        empty.textContent = state.options === null ? 'Loading...' : placeholder;
        list.appendChild(empty);
        state.highlight = -1;
        return;
      }

      options.forEach(function (opt, i) {
        var item = document.createElement('div');
        item.className = 'dapp-combobox-option' + (i === state.highlight ? ' dapp-combobox-highlight' : '');
        item.style.cssText = 'padding:8px 12px; cursor:pointer; border-bottom:1px solid #eee;' + (i === state.highlight ? ' background:#f0f0f0;' : '');
        item.textContent = opt;
        item.addEventListener('mousedown', function (e) { e.preventDefault(); }); // keep input focus
        item.addEventListener('mouseenter', function () { setHighlight(i); });
        item.addEventListener('click', function () { selectOption(String(opt)); });
        list.appendChild(item);
      });
      state.highlight = state.highlight >= options.length ? 0 : state.highlight;
    }

    function setHighlight(i) {
      state.highlight = i;
      var items = list.querySelectorAll('.dapp-combobox-option');
      items.forEach(function (el, idx) {
        var hl = idx === i;
        el.classList.toggle('dapp-combobox-highlight', hl);
        el.style.backgroundColor = hl ? '#f0f0f0' : '';
      });
    }

    function open() {
      if (state.destroyed || inputEl.disabled || inputEl.readOnly) { return; }
      state.open = true;
      dropdown.style.display = 'block';
      fetchOptions().then(function () { if (state.open) { render(); } });
    }

    function close() {
      state.open = false;
      dropdown.style.display = 'none';
      state.highlight = -1;
    }

    function selectOption(value) {
      inputEl.value = value;
      onSelect(value);
      close();
    }

    function commitTyped() {
      var value = inputEl.value;
      if (!value) { return; }
      if (allowNewValue) {
        selectOption(value); // brand-new value: commit as typed
        return;
      }
      // allowNewValue=false: only commit if the raw text is a listed option.
      var options = state.options || [];
      if (options.some(function (o) { return String(o) === value; })) {
        selectOption(value);
      } else {
        close();
      }
    }

    function onKeydown(e) {
      if (!state.open) { return; }
      var options = list.querySelectorAll('.dapp-combobox-option');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(Math.min(state.highlight + 1, options.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(Math.max(state.highlight - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (state.highlight >= 0 && options[state.highlight]) {
          selectOption(options[state.highlight].textContent);
        } else {
          commitTyped();
        }
      } else if (e.key === 'Escape' || e.key === 'Tab') {
        close();
      }
    }

    function onInput() {
      if (state.destroyed || inputEl.disabled) { return; }
      state.highlight = -1;
      open();
      render();
    }

    function onClick(e) {
      e.stopPropagation();
      if (state.open) { render(); } else { open(); }
    }

    function onDocumentClick(e) {
      if (state.open && !wrapper.contains(e.target)) { close(); }
    }

    inputEl.addEventListener('input', onInput);
    inputEl.addEventListener('click', onClick);
    inputEl.addEventListener('focus', open);
    inputEl.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onDocumentClick);

    return {
      getValue: function () { return inputEl.value; },
      setValue: function (v) { inputEl.value = v; },
      refresh: function () { state.options = null; state.optionsPromise = null; },
      destroy: function () {
        state.destroyed = true;
        inputEl.removeEventListener('input', onInput);
        inputEl.removeEventListener('click', onClick);
        inputEl.removeEventListener('focus', open);
        inputEl.removeEventListener('keydown', onKeydown);
        document.removeEventListener('click', onDocumentClick);
        wrapper.removeChild(dropdown);
        wrapper.removeChild(caret);
        parent.insertBefore(inputEl, wrapper);
        parent.removeChild(wrapper);
      }
    };
  }

  global.DappCombobox = { attach: attach };
})(window);
