/**
 * Stores Nearby — deep-link URL + filter UI (localhost:8001 or STORES_NEARBY_BASE).
 * Mocks Google Apps Script exec so the page can render without production credentials.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';

const STORES_NEARBY_BASE =
  process.env.STORES_NEARBY_BASE?.replace(/\/$/, '') || 'http://localhost:8001';

const DEEP_LINK_PATH =
  '/stores_nearby.html?lat=33.872550538353885&lng=-118.29846321541852&status=Research&status=AI%3A+Shortlisted&status=AI%3A+Photo+rejected&status=AI%3A+Photo+needs+review&status=AI%3A+Enrich+with+contact&status=AI%3A+Email+found&status=AI%3A+Contact+Form+found&status=AI%3A+Enrich+%E2%80%94+manual&status=AI%3A+Warm+up+prospect&status=AI%3A+Prospect+replied&status=Shortlisted&status=Instagram+Followed&status=Contacted&status=Manager+Follow-up&status=Bulk+Info+Requested&status=Meeting+Scheduled&status=Followed+Up&status=Partnered&status=On+Hold&status=Rejected&status=Not+Appropriate&shop_type=Metaphysical%2FSpiritual&shop_type=Wellness+Center&shop_type=Health+Food+Store&shop_type=Natural+Goods&shop_type=Conscious+Cafe&shop_type=Boutique+Chocolate&shop_type=Antique+Store&shop_type=Gift+Shop&shop_type=Candy+Store&shop_type=Yoga+Studio&shop_type=Apothecary&shop_type=Winery&shop_type=Other';

const MOCK_STORES_RESPONSE = {
  success: true,
  count: 2,
  stores: [
    {
      name: 'Playwright Test Shop A',
      latitude: 33.873,
      longitude: -118.299,
      distance: 0.2,
      address: '100 Test St',
      city: 'Torrance',
      state: 'CA',
      status: 'Research',
      priority: '1',
    },
    {
      name: 'Playwright Test Shop B',
      latitude: 33.871,
      longitude: -118.297,
      distance: 0.4,
      address: '200 Sample Ave',
      city: 'Torrance',
      state: 'CA',
      status: 'AI: Shortlisted',
      priority: '2',
    },
  ],
};

test.describe('stores_nearby.html deep link', () => {
  test('URL filters match checkbox state; search completes (mocked API)', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.route('**/script.google.com/macros/**', async (route) => {
      if (route.request().method() !== 'GET') {
        return route.continue();
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STORES_RESPONSE),
      });
    });

    const url = `${STORES_NEARBY_BASE}${DEEP_LINK_PATH}`;
    const goto = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    expect(goto?.ok(), `Failed to load ${url} — start server from dapp root: python3 -m http.server 8001`).toBeTruthy();

    // Read-only mode: no publicKey; signature verify not called.
    await expect(page.locator('#status')).toContainText(/read-only mode|Verifying/i, {
      timeout: 15000,
    });

    // Wait until URL-driven filters are applied and checkboxes exist.
    await page.waitForSelector('.status-filter-checkbox', { timeout: 15000 });

    const filterCheck = await page.evaluate(() => {
      const params = new URLSearchParams(window.location.search);
      const urlStatuses = params.getAll('status');
      const urlShopTypes = params.getAll('shop_type');
      const checkedStatus = Array.from(
        document.querySelectorAll<HTMLInputElement>('.status-filter-checkbox:checked')
      ).map((cb) => cb.value);
      const checkedShop = Array.from(
        document.querySelectorAll<HTMLInputElement>('.shop-type-filter-checkbox:checked')
      ).map((cb) => cb.value);

      const missingStatus = urlStatuses.filter((s) => !checkedStatus.includes(s));
      const extraCheckedStatus = checkedStatus.filter((s) => !urlStatuses.includes(s));

      const missingShop = urlShopTypes.filter((s) => !checkedShop.includes(s));
      const extraCheckedShop = checkedShop.filter((s) => !urlShopTypes.includes(s));

      return {
        urlStatusesCount: urlStatuses.length,
        urlShopTypesCount: urlShopTypes.length,
        checkedStatusCount: checkedStatus.length,
        checkedShopCount: checkedShop.length,
        missingStatus,
        extraCheckedStatus,
        missingShop,
        extraCheckedShop,
      };
    });

    // Interface issue detector: URL params must exactly match checked boxes (same string as value="...").
    expect(
      filterCheck.missingStatus,
      `Status filters in URL not checked in UI (value mismatch?): ${JSON.stringify(filterCheck.missingStatus)}`
    ).toEqual([]);
    expect(
      filterCheck.extraCheckedStatus,
      `Unexpected extra status checkboxes vs URL: ${JSON.stringify(filterCheck.extraCheckedStatus)}`
    ).toEqual([]);
    expect(filterCheck.urlStatusesCount, 'No status params in URL').toBeGreaterThan(0);
    expect(filterCheck.checkedStatusCount).toBe(filterCheck.urlStatusesCount);

    expect(
      filterCheck.missingShop,
      `Shop type filters in URL not checked in UI: ${JSON.stringify(filterCheck.missingShop)}`
    ).toEqual([]);
    expect(
      filterCheck.extraCheckedShop,
      `Unexpected extra shop type checkboxes vs URL: ${JSON.stringify(filterCheck.extraCheckedShop)}`
    ).toEqual([]);

    // Auto-search after load — wait for mocked result.
    await expect(page.locator('#statusMessage')).toContainText(/Found 2 store/i, { timeout: 20000 });

    const outDir = path.join(process.cwd(), 'test-results');
    fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({
      path: path.join(outDir, 'stores-nearby-deep-link.png'),
      fullPage: true,
    });

    expect(pageErrors, `Page errors: ${pageErrors.join('\n')}`).toHaveLength(0);
    const noisy = consoleErrors.filter(
      (t) =>
        !t.includes('Google Maps') &&
        !t.includes('maps.googleapis') &&
        !t.includes('CoreLocation') &&
        !t.includes('Google Maps initialization')
    );
    expect(noisy, `Console errors: ${noisy.join('\n')}`).toHaveLength(0);
  });
});
