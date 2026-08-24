/**
 * Integration tests for report_asset_receipt.html
 * - Verifies scripts load without errors; caches + DappCombobox are available
 * - Verifies Fund Handler + Currency Name comboboxes populate from their cache
 *   sources (dao_members_cache.js / currencies_cache.js) and that picking an
 *   option sets the input value
 * - Verifies a user can still type a currency name NOT in the option list and it
 *   is accepted (allowNewValue — brand-new Currency rows are created by typing
 *   into this field)
 * - Verifies the persistent hidden file input exists in the DOM and selecting a
 *   file populates the info-box fields
 * - Verifies a synthetic paste event with clipboardData.items (kind=file, no
 *   .files) triggers handleFile (the mobile/browser fallback path)
 * Mocked APIs — no real network calls.
 */
import { test, expect } from '@playwright/test';

const MOCK_MEMBERS = {
  contributors: [
    { name: 'Gary Teh', public_keys: [] },
    { name: 'Kirsten', public_keys: [] },
    { name: 'Sophia Truesight', public_keys: [] },
  ],
};

const MOCK_TREASURY = {
  items: [
    { currency: 'USD' },
    { currency: 'Cacao Nibs Kraft Pouch - V2' },
    { currency: 'Stand-Up Pouch Kraft w/Zip 10x15cm (per unit) - Brazil' },
    { currency: 'Bluetooth Label Printer w/20 Label Rolls - Brazil' },
    { currency: 'USD' }, // duplicate on purpose — must be de-duplicated
    { currency: 'Ceremonial Cacao Kraft Pouch' },
  ],
};

const TEST_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyC5HgVLODmtFQZiM91XK';

async function mockCaches(page: import('@playwright/test').Page) {
  // Single catch-all for raw.githubusercontent.com (Playwright matches routes in
  // reverse registration order, so separate catch-alls would shadow specifics).
  await page.route('**/raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('dao_members.json')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_MEMBERS),
      });
    }
    if (url.includes('dao_offchain_treasury.json')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_TREASURY),
      });
    }
    return route.fulfill({ status: 404, body: 'mocked 404' });
  });
}

async function openForm(page: import('@playwright/test').Page) {
  await page.addInitScript((pk) => {
    localStorage.setItem('publicKey', pk);
    localStorage.setItem('privateKey', 'fake-private-key-for-test');
  }, TEST_PUBLIC_KEY);

  await mockCaches(page);

  await page.goto('/report_asset_receipt.html');

  // Signature verification gate: form is shown after ~1s delay.
  await expect(page.locator('#info')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#fundHandlerInput')).toBeEnabled();
  await expect(page.locator('#currencyInput')).toBeEnabled();
}

async function openCombobox(page: import('@playwright/test').Page, inputId: string) {
  await page.locator(`#${inputId}`).click();
  await expect(page.locator(`#${inputId} ~ .dapp-combobox-dropdown`)).toBeVisible();
}

// Options of the combobox attached to a given input (both dropdowns exist in the
// DOM, one hidden — always scope to the input's own dropdown).
function optionsOf(page: import('@playwright/test').Page, inputId: string) {
  return page.locator(`#${inputId} ~ .dapp-combobox-dropdown .dapp-combobox-option`);
}

test.describe('Asset receipt form — combobox + file input UX', () => {
  test('scripts load without errors; caches + DappCombobox available', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openForm(page);
    expect(errors, `Script errors: ${errors.join('; ')}`).toHaveLength(0);

    const apis = await page.evaluate(() => ({
      daoMembers: typeof (window as any).DaoMembersCache?.fetchSnapshot === 'function',
      currencies: typeof (window as any).CurrenciesCache?.fetchSnapshot === 'function',
      currenciesList: typeof (window as any).CurrenciesCache?.fetchCurrencies === 'function',
      combobox: typeof (window as any).DappCombobox?.attach === 'function',
    }));
    expect(apis.daoMembers).toBe(true);
    expect(apis.currencies).toBe(true);
    expect(apis.currenciesList).toBe(true);
    expect(apis.combobox).toBe(true);
  });

  test('(a) comboboxes populate from their cache sources (deduped)', async ({
    page,
  }) => {
    await openForm(page);

    // Fund Handler options come from dao_members.json contributors[].name.
    await openCombobox(page, 'fundHandlerInput');
    await expect(optionsOf(page, 'fundHandlerInput')).toHaveCount(3);
    const fundHandlerValues = await optionsOf(page, 'fundHandlerInput').allTextContents();
    expect(fundHandlerValues).toContain('Gary Teh');
    expect(fundHandlerValues).toContain('Kirsten');
    await page.keyboard.press('Escape');

    // Currency options come from dao_offchain_treasury.json items[].currency,
    // de-duplicated (USD appears twice in the mock → once in the list).
    await openCombobox(page, 'currencyInput');
    await expect(optionsOf(page, 'currencyInput')).toHaveCount(5);
    const currencyValues = await optionsOf(page, 'currencyInput').allTextContents();
    expect(currencyValues).toContain(
      'Stand-Up Pouch Kraft w/Zip 10x15cm (per unit) - Brazil'
    );
    expect(currencyValues.filter((v) => v === 'USD')).toHaveLength(1);
    await page.keyboard.press('Escape');
  });

  test('(e) picking an option sets the input value', async ({ page }) => {
    await openForm(page);

    await openCombobox(page, 'fundHandlerInput');
    await optionsOf(page, 'fundHandlerInput').filter({ hasText: 'Kirsten' }).click();
    await expect(page.locator('#fundHandlerInput')).toHaveValue('Kirsten');

    await openCombobox(page, 'currencyInput');
    await optionsOf(page, 'currencyInput')
      .filter({ hasText: 'Bluetooth Label Printer' })
      .click();
    await expect(page.locator('#currencyInput')).toHaveValue(
      'Bluetooth Label Printer w/20 Label Rolls - Brazil'
    );
  });

  test('(b) user can still type a currency name NOT in the option list and it is accepted', async ({
    page,
  }) => {
    await openForm(page);

    const brandNewCurrency = 'Brand New Currency Never Seen Before - Brazil';
    await page.locator('#currencyInput').fill(brandNewCurrency);

    // Value persists as typed (dropdown is suggestions only — not a locked list).
    await expect(page.locator('#currencyInput')).toHaveValue(brandNewCurrency);

    // Fill the remaining required fields and confirm the submit button enables —
    // proving a non-listed currency passes the form's own validation.
    await page.locator('#fundHandlerInput').fill('Gary Teh');
    await page.locator('#amountInput').fill('2');
    await page.locator('#descriptionInput').fill('Test purchase of brand-new item');
    await expect(page.locator('#submitButton')).toBeEnabled();

    // Event preview reflects the typed currency.
    await expect(page.locator('#eventPreview')).toContainText(brandNewCurrency);
  });

  test('(c) hidden file input is present in the DOM and file selection populates info-box', async ({
    page,
  }) => {
    await openForm(page);

    const fileInput = page.locator('#fileInput');
    await expect(fileInput).toHaveCount(1);
    await expect(fileInput).toBeHidden();
    const accept = await fileInput.getAttribute('accept');
    expect(accept).toBe('image/*,application/pdf');

    await fileInput.setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'),
    });

    await expect(page.locator('#originalFileName')).toHaveText('receipt.png');
    await expect(page.locator('#assetReceiptFileName')).not.toHaveText(
      'Waiting for file selection...'
    );
    await expect(page.locator('#assetReceiptLocation')).not.toHaveText(
      'Waiting for file selection...'
    );
    await expect(page.locator('#uploaded-file-preview')).toBeVisible();
  });

  test('(d) synthetic paste with clipboardData.items (kind=file, empty .files) triggers handleFile', async ({
    page,
  }) => {
    await openForm(page);

    // Simulate the mobile/browser flow where .files is empty but .items carries
    // the file entry (kind === 'file', retrieved via getAsFile()).
    await page.evaluate(() => {
      const file = new File(['pdf-bytes'], 'pasted.pdf', { type: 'application/pdf' });
      const items = [{ kind: 'file', getAsFile: () => file }];
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', {
        value: { files: [], items },
      });
      document.dispatchEvent(ev);
    });

    await expect(page.locator('#originalFileName')).toHaveText('pasted.pdf');
    await expect(page.locator('#assetReceiptFileName')).not.toHaveText(
      'Waiting for file selection...'
    );
  });
});
