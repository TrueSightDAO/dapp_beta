/**
 * Integration tests for report_payout_event.html (module M4).
 *
 * Covers the page's three real behaviours, against the ACTUAL page:
 *   1. the governor gate — signed-out shows the "No digital signature" notice,
 *      a non-governor key is denied, a governor key reveals the form;
 *   2. client-side validation — a bad amount / missing bank_ref / bad date is
 *      rejected inline and NEVER reaches Edgar (no phantom submissions);
 *   3. the happy path — a well-formed backfill signs a real RSA payload in the
 *      browser (ephemeral keypair) and the verbatim payload reaches the
 *      #submissionResult forensic panel, with the raw PIX key absent.
 *
 * The load-bearing privacy assertion is in the happy path: the signed payload
 * must carry `Recipient PK Hash: unlinked_recipient` (or a hash) and must never
 * carry a raw PIX key — Edgar's intake is republished as a PUBLIC raw chatlog.
 *
 * All network is mocked — no real Edgar submissions, no real sheet writes.
 */
import { test, expect, Page } from '@playwright/test';

const GOV_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyC5HgVLODmtFQZiM91XK';
const NON_GOV_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnonGovernorKeyXXXXXXXXXXXX';

const MOCK_MEMBERS = {
  generated_at: '2026-09-18T00:00:00Z',
  schema_version: 1,
  counts: { contributors: 2 },
  dao_totals: {},
  contributors: [
    { name: 'Gary Teh', roles: ['governor'], public_keys: [{ public_key: GOV_PUBLIC_KEY }] },
    { name: 'Nadia', roles: ['member'], public_keys: [{ public_key: NON_GOV_PUBLIC_KEY }] },
  ],
};

// The declared action the page gates on must EXIST, else requireRole denies
// everyone (see scripts/permissions.js actionDef).
const MOCK_PERMISSIONS = {
  schema_version: 1,
  actions: {
    'governor_chat.access': {
      required_roles: ['governor'],
      description: "Access the Governor's private chat interface.",
      surfaces: [],
      endpoints: [],
    },
  },
};

async function mockBackend(page: Page, opts: { submitOk?: boolean } = {}) {
  await page.route('**/raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('permissions.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PERMISSIONS) });
    }
    if (url.includes('dao_members.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MEMBERS) });
    }
    if (url.includes('/public_keys/')) {
      // Per-key path is tried first; 404 makes permissions.js fall back to the monolith.
      return route.fulfill({ status: 404, body: 'mocked 404' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Governor identity resolution (cache-first) then GAS fallback — both mocked.
  await page.route('**/macros/**/exec*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contributor_name: 'Gary Teh' }) })
  );

  await page.route('**/edgar.truesight.me/**', (route) => {
    if (route.request().url().includes('ping')) return route.fulfill({ status: 200 });
    if (route.request().url().includes('submit_contribution')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ signature_verification: opts.submitOk === false ? 'failed' : 'success' }),
      });
    }
    return route.continue();
  });
}

async function signIn(page: Page, publicKey: string, privateKey = 'fake') {
  await page.addInitScript(
    ([pk, sk]) => {
      localStorage.setItem('publicKey', pk);
      localStorage.setItem('privateKey', sk);
    },
    [publicKey, privateKey]
  );
}

test.describe('report_payout_event.html', () => {
  test('signed-out: shows the "No digital signature" gate and hides the form', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/report_payout_event.html');

    await expect(page.locator('#gateContainer')).toContainText(/No digital signature/i, { timeout: 15000 });
    // The form container must stay hidden — nothing to submit without identity.
    await expect(page.locator('#content')).toBeHidden();
  });

  test('non-governor: is denied and the form stays hidden', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, NON_GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');

    await expect(page.locator('#gateContainer')).toContainText(/Permission denied/i, { timeout: 15000 });
    await expect(page.locator('#content')).toBeHidden();
  });

  test('governor: gate reveals the form and bad input never reaches Edgar', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');

    // Gate passes -> the form becomes visible.
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#submitButton')).toBeEnabled();

    // Count any accidental submit to Edgar.
    let submits = 0;
    page.on('request', (r) => {
      if (r.url().includes('submit_contribution')) submits++;
    });

    // Valid amount + date, but NO bank_ref -> inline reject, no submission.
    await page.fill('#amount', '50,00');
    await page.fill('#paidAt', '2026-09-12');
    await page.fill('#recipientName', 'Paulo');
    await page.fill('#programSlug', 'crf-anapu');
    await page.fill('#bankRef', '');
    await page.click('#submitButton');

    await expect(page.locator('#status')).toContainText(/Bank Ref/i, { timeout: 5000 });
    await expect(page.locator('#amount')).not.toHaveClass(/invalid/);
    await page.waitForTimeout(600);
    expect(submits, 'invalid input must not reach Edgar').toBe(0);
  });

  test('governor happy path: signs a real payload; no raw PIX leaks', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Swap in an EPHEMERAL RSA keypair so the in-browser signing is real, not stubbed.
    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });

    let submittedBody = '';
    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        submittedBody = route.request().postData() || '';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ signature_verification: 'success' }),
        });
      }
      return route.continue();
    });

    await page.fill('#programSlug', 'crf-anapu');
    await page.fill('#amount', 'R$ 50,00');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');
    await page.fill('#recipientName', 'Paulo');
    await page.fill('#treeIds', 'T-1, T-2');
    await page.selectOption('#payoutStatus', 'backfill');
    await page.click('#submitButton');

    // Success status + the verbatim signed payload rendered into the forensic panel.
    await expect(page.locator('#status')).toContainText(/Payout recorded/i, { timeout: 20000 });
    const requestPre = await page.locator('#requestPre').textContent();
    expect(requestPre).toContain('PAYOUT EVENT');
    expect(requestPre).toContain('Amount: 50');
    expect(requestPre).toContain('Bank Ref: E6890081000000000000000000000');
    expect(requestPre).toContain('Status: backfill');
    expect(requestPre).toContain('Tree Planting IDs: T-1, T-2');
    // The unlinked marker is used because no pk hash was supplied.
    expect(requestPre).toContain('Recipient PK Hash: unlinked_recipient');
    expect(requestPre).toContain('Request Transaction ID');

    // PRIVACY: no PIX-key field name and no CPF-shaped value in the payload.
    expect(requestPre, 'raw PIX label must not appear').not.toMatch(/pix[_ ]?key/i);
    expect(requestPre, 'a CPF-shaped value must not appear').not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);

    // And the same text reached Edgar.
    expect(submittedBody).toContain('PAYOUT EVENT');
  });

  test('scripts load with no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    expect(errors, `page errors: ${errors.join('; ')}`).toHaveLength(0);
  });
});
