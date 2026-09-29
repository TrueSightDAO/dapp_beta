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

async function mockBackend(
  page: Page,
  opts: { submitOk?: boolean; mapDelayMs?: number; feedRecipient?: boolean } = {},
) {
  // When true (default), the public pending feed carries the inline
  // `recipient_pk_hash` the page now reads CACHE-FIRST. Set feedRecipient:false
  // to simulate an older cache and force the governor-only GAS fallback.
  const feedRecipient = opts.feedRecipient !== false;
  const gasCalls: string[] = [];
  await page.route('**/raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    if (url.includes('permissions.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_PERMISSIONS) });
    }
    if (url.includes('dao_members.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_MEMBERS) });
    }
    if (url.includes('sunmint_pending.json')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          count: 3,
          items: [
            { telegram_message_id: 'Edgar_TEST_T1', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/t1.jpg', latitude: '-3.1', longitude: '-52.1', status: 'NEW', program: 'crf-anapu', recipient_pk_hash: feedRecipient ? 'pk-qkejKJJW3IAD' : '' },
            { telegram_message_id: 'Edgar_TEST_T2', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/t2.jpg', latitude: '-3.2', longitude: '-52.2', status: 'NEW', program: '', recipient_pk_hash: '' },
            { telegram_message_id: 'Edgar_TEST_T3', species: 'Cacau', planting_date: '2026-09-03', photo_url: 'http://x/t3.jpg', latitude: '-3.3', longitude: '-52.3', status: 'NEW', program: 'crf-anapu', request_txid: 'TSL3TEST1234567890ABCDEF', recipient_pk_hash: '' },
          ],
        }),
      });
    }
    if (url.includes('sunmint_program_registry.json')) {
      // SSOT the Program dropdown is populated from.
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ hosts: { 'cfr.truesight.me': 'crf-anapu' } }) });
    }
    if (url.includes('/public_keys/')) {
      // Per-key path is tried first; 404 makes permissions.js fall back to the monolith.
      return route.fulfill({ status: 404, body: 'mocked 404' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Governor identity resolution (cache-first) then GAS fallback — both mocked.
  // The payout-register read (a governor-only GET) returns a realistic payload:
  // FOUR rows for the SAME pk_hash (1 RECORDED + 3 UPDATED) — the mess Gary sees.
  await page.route('**/macros/**/exec*', async (route) => {
    const url = route.request().url();
    if (url.includes('getTreeRecipientMap')) gasCalls.push(url);
    if (url.includes('getTreeRecipientMap')) {
      // Simulate the endpoint's real cold-start latency (it can 302/0-byte while
      // warming). Used by the load-order race test.
      if (opts.mapDelayMs) await new Promise((r) => setTimeout(r, opts.mapDelayMs));
      // Governor-only tree_id -> pk_hash map (hash-only, no raw PII).
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          data: { count: 1, items: [
            { tree_id: 'Edgar_TEST_T1', pk_hash: 'pk-qkejKJJW3IAD' },
          ] },
        }),
      });
    }
    if (url.includes('getPendingPayoutRegistrations')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'success',
          data: {
            count: 4,
            items: [
              { row: 2, status: 'RECORDED', submitted_date: '2026-09-24T16:07:18.237Z', program_slug: 'crf-anapu', pk_hash: 'pk-qkejKJJW3IAD', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
              { row: 3, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:18.725Z', program_slug: 'crf-anapu', pk_hash: 'pk-qkejKJJW3IAD', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
              { row: 4, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:19.461Z', program_slug: 'crf-anapu', pk_hash: 'pk-qkejKJJW3IAD', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
              { row: 5, status: 'UPDATED',  submitted_date: '2026-09-24T16:07:21.290Z', program_slug: 'crf-anapu', pk_hash: 'pk-qkejKJJW3IAD', pix_key_type: 'CPF', pix_key_masked: '***.***.***-19' },
            ],
          },
        }),
      });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ contributor_name: 'Gary Teh' }) });
  });

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

  return { gasCalls };
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
  test('Program is a dropdown ABOVE the tree picker; blank program lists all trees', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');

    // Program is now a <select>, not a free-text input.
    await expect(page.locator('select#programSlug')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('input#programSlug')).toHaveCount(0);

    // Populated from the live registry (SSOT); defaults to crf-anapu.
    await expect(page.locator('#programSlug option[value="crf-anapu"]')).toHaveCount(1);
    await expect(page.locator('#programSlug')).toHaveValue('crf-anapu');

    // It sits ABOVE the tree picker in DOM order.
    const above = await page.evaluate(() => {
      const p = document.getElementById('programSlug');
      const t = document.getElementById('treePicker');
      return !!(p && t) && (p.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(above).toBe(true);

    // STRICT: the default program (crf-anapu) keeps ONLY its own trees; the
    // unattributed tree is hidden -- never shown as if it belonged to the program.
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T2"]')).toHaveCount(0);

    // The feed HAS attribution, so the filter APPLIED -> no 'not applied' note.
    await expect(page.locator('#programFilterNote')).toBeHidden();

    // Blank program = general disbursement: note clears, all trees stay listed.
    await page.selectOption('#programSlug', '');
    await expect(page.locator('#programFilterNote')).toBeHidden();
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1);
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T2"]')).toHaveCount(1);
  });

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
    await page.selectOption('#programSlug', 'crf-anapu');
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

    // The redundant Status form field must be GONE (derived from Paid At instead).
    await expect(page.locator('#payoutStatus')).toHaveCount(0);

    await page.selectOption('#programSlug', 'crf-anapu');
    await page.fill('#amount', 'R$ 50,00');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');
    // No separate tree-id text field: the picker is the only input (single-select).
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    // No Status dropdown: it is derived. A 2026-09-12 paidAt is a prior UTC day,
    // so the payload must self-report Status: backfill.
    await page.click('#submitButton');

    // Success status + the verbatim signed payload rendered into the forensic panel.
    await expect(page.locator('#status')).toContainText(/Payout recorded/i, { timeout: 20000 });
    const requestPre = await page.locator('#requestPre').textContent();
    expect(requestPre).toContain('PAYOUT EVENT');
    expect(requestPre).toContain('Amount: 50');
    expect(requestPre).toContain('Bank Ref: E6890081000000000000000000000');
    expect(requestPre).toContain('Status: backfill');
    expect(requestPre).toContain('Tree Planting IDs: Edgar_TEST_T1');
    // Picking Edgar_TEST_T1 auto-fills its registered recipient pk_hash.
    expect(requestPre).toContain('Recipient PK Hash: pk-qkejKJJW3IAD');
    expect(requestPre).toContain('Request Transaction ID');

    // PRIVACY: no PIX-key field name and no CPF-shaped value in the payload.
    expect(requestPre, 'raw PIX label must not appear').not.toMatch(/pix[_ ]?key/i);
    expect(requestPre, 'a CPF-shaped value must not appear').not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);

    // And the same text reached Edgar.
    expect(submittedBody).toContain('PAYOUT EVENT');
  });

  test('governor: a BLANK program is optional and emits unlinked_program', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

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

    // Program deliberately left blank -> a general disbursement is still valid.
    await page.selectOption('#programSlug', '');
    await page.fill('#amount', 'R$ 50,00');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');
    await page.click('#submitButton');

    await expect(page.locator('#status')).toContainText(/Payout recorded/i, { timeout: 20000 });
    const requestPre = await page.locator('#requestPre').textContent();
    expect(requestPre).toContain('Program: unlinked_program');
    expect(submittedBody).toContain('unlinked_program');
  });

  test('governor: tree picker lists unpaid trees; post-submit they leave the list and the button resets', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });

    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ signature_verification: 'success' }) });
      }
      return route.continue();
    });

    // The picker exposes the unpaid trees. Use the general-disbursement view (blank
    // program) so BOTH trees are listed regardless of their program attribution.
    await page.selectOption('#programSlug', '');
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    // There is NO separate tree-id text field: only the picker.
    await expect(page.locator('#treeIds')).toHaveCount(0);
    // Single-select: picking T2 REPLACES T1.
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T1');
    await page.selectOption('#treePicker', 'Edgar_TEST_T2');
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T2');
    // Put T1 back so the paid-tree assertions below match the payload.
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');

    // Recipient is OPTIONAL - leave it blank.
    await page.fill('#amount', 'R$ 50,00');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');
    await page.click('#submitButton');

    await expect(page.locator('#status')).toContainText(/Payout recorded/i, { timeout: 20000 });
    const requestPre = await page.locator('#requestPre').textContent();
    expect(requestPre).toContain('Tree Planting IDs: Edgar_TEST_T1');

    // Only the PAID tree leaves the list (single-select: T2 was never paid)...
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(0);
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T2"]')).toHaveCount(1);
    // ...and the button now offers a fresh form.
    await expect(page.locator('#submitButton')).toHaveText(/Submit another payout/i);

    // Clicking it RESETS the form (the picker clears).
    await page.click('#submitButton');
    await expect(page.locator('#treePicker')).toHaveValue('');
    await expect(page.locator('#amount')).toHaveValue('');
    await expect(page.locator('#submitButton')).toHaveText(/Submit Payout/i);
  });

  test('overpay guard: the flagged list shows a REASON per tree and documents the filter', async ({ page }) => {
    await mockBackend(page);
    // Two DIFFERENT trees on the SAME fix (0 m apart) -> both flagged co-located.
    await page.route('**/sunmint_pending.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'success', count: 2, items: [
        { telegram_message_id: 'Edgar_FLAG_A', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/a.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
        { telegram_message_id: 'Edgar_FLAG_B', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/b.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    const guard = page.locator('#overpayGuard');
    await expect(guard).toContainText('2', { timeout: 15000 });
    // The filter is documented, not a mystery.
    await expect(guard).toContainText(/shares a photo/i);
    await expect(guard).toContainText(/same GPS fix/i);
    // Expanding the list shows WHY each tree is flagged (not a bare id dump).
    await page.click('#overpayGuard details.overpay-all summary');
    const list = page.locator('#overpayGuard .overpay-all-list');
    await expect(list).toContainText('Edgar_FLAG_A');
    await expect(list).toContainText('same GPS fix');
    await expect(list).toContainText('(0 m)');
  });

  test('flagged list sits UNDER the detail cards; clicking a flagged tree fills the comparison card', async ({ page }) => {
    await mockBackend(page);
    // Two DIFFERENT trees on the SAME fix (0 m) -> both flagged co-located -> both in the list.
    await page.route('**/sunmint_pending.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'success', count: 2, items: [
        { telegram_message_id: 'Edgar_FLAG_A', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/a.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
        { telegram_message_id: 'Edgar_FLAG_B', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/b.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // The flagged list must FOLLOW the detail card in DOM order (i.e. sit under it).
    await expect(page.locator('#overpayGuard details.overpay-all summary')).toBeVisible({ timeout: 15000 });
    const under = await page.evaluate(() => {
      const b = document.getElementById('overpayGuard');
      const d = document.getElementById('treeDetails');
      return !!(b && d) && (d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(under, 'flagged list must sit under the tree detail card').toBe(true);

    // NEW MODEL: the 2nd card is DERIVED from the picker selection. With no tree
    // picked it is just a prompt; the picker card is empty too.
    await expect(page.locator('#overpayTreeDetails .compare-empty')).toContainText('Pick a tree');
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(0);

    // Picking a flagged tree fills Tree Details AND shows the tree IT collides with
    // (FLAG_A<->FLAG_B, same fix), i.e. the comparison follows the selection.
    await page.selectOption('#treePicker', 'Edgar_FLAG_A');
    await expect(page.locator('#treeDetails .tc-id')).toHaveText('Edgar_FLAG_A');
    const ovCard = page.locator('#overpayTreeDetails .tree-card').first();
    await expect(page.locator('#overpayTreeDetails .tree-card')).toHaveCount(1);
    await expect(ovCard.locator('.tc-id')).toHaveText('Edgar_FLAG_B');
    await expect(ovCard.locator('img.tc-photo')).toHaveAttribute('src', 'http://x/b.jpg');
    // The selected row is highlighted in the flagged list.
    await expect(page.locator('#overpayGuard .overpay-all-row.is-selected')).toContainText('Edgar_FLAG_A');

    // Rows are one-per-line (block flow, not inline).
    await page.click('#overpayGuard details.overpay-all summary');
    const block = await page.locator('#overpayGuard .overpay-all-row').first().evaluate((el) => getComputedStyle(el).display);
    expect(block).toBe('block');
  });

  test('two cards: picker fills Tree Details, flagged row fills Overpay Tree Details, side by side', async ({ page }) => {
    await mockBackend(page);
    // T1 sits on its OWN fix (clean); FLAG_A/FLAG_B are co-located (0 m) so both are flagged.
    await page.route('**/sunmint_pending.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'success', count: 3, items: [
        { telegram_message_id: 'Edgar_TEST_T1', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/t1.jpg', latitude: '-3.05', longitude: '-52.05', status: 'NEW', program: 'crf-anapu' },
        { telegram_message_id: 'Edgar_FLAG_A', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/a.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW', program: 'crf-anapu' },
        { telegram_message_id: 'Edgar_FLAG_B', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/b.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW', program: 'crf-anapu' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });

    // 1) Picker selection -> Tree Details card; the Overpay card is still a placeholder.
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(1);
    await expect(page.locator('#treeDetails .tc-id')).toHaveText('Edgar_TEST_T1');
    await expect(page.locator('#overpayTreeDetails .tree-card')).toHaveCount(0);

    // 2) T1 is CLEAN -> the derived conflict card shows an explicit all-clear (T1 is
    //    not adjacent to the FLAG pair), and the picker card is untouched.
    await expect(page.locator('#overpayTreeDetails .compare-clear')).toContainText('No overpay risk');
    await expect(page.locator('#treeDetails .tc-id')).toHaveText('Edgar_TEST_T1');

    // 3) Tree Details sits in the FIRST column, Overpay Tree Details in the SECOND.
    const order = await page.evaluate(() => {
      const a = document.getElementById('treeDetails');
      const b = document.getElementById('overpayTreeDetails');
      return !!(a && b) && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(order, 'treeDetails must sit before overpayTreeDetails').toBe(true);

    // 4) The payout still targets the PICKER's tree -- the overpay click never repoints it.
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T1');

    // 5) Clearing the picker empties BOTH cards (the conflict card belongs to the
    //    selection, so it goes with it).
    await page.selectOption('#treePicker', '');
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(0);
    await expect(page.locator('#overpayTreeDetails .tree-card')).toHaveCount(0);

    // 6) Picking a FLAGGED tree -> its conflict partner appears in the 2nd card.
    await page.selectOption('#treePicker', 'Edgar_FLAG_A');
    await expect(page.locator('#treeDetails .tc-id')).toHaveText('Edgar_FLAG_A');
    await expect(page.locator('#overpayTreeDetails .tc-id')).toHaveText('Edgar_FLAG_B');
  });

  test('each tree card carries a copy-payee-link (?tx= preferred, ?tree= fallback), keyed to its program (Gary)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockBackend(page);
    // T_CRF is program crf-anapu -> cfr host; T_SUN has no program -> SunMint beta.
    await page.route('**/sunmint_pending.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'success', count: 2, items: [
        { telegram_message_id: 'Edgar_T_CRF', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/c.jpg', latitude: '-3.0', longitude: '-52.0', status: 'NEW', program: 'crf-anapu', request_txid: 'YgyO2UUE9IQ8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        { telegram_message_id: 'Edgar_T_SUN', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/s.jpg', latitude: '-3.9', longitude: '-52.9', status: 'NEW', program: '' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_T_CRF"]')).toHaveCount(1, { timeout: 15000 });

    // CRF tree (has a signed txid) -> the link lives INSIDE .tc-main, points at
    // the cfr viewer, and uses the SHORT tx handle (?tx=), NOT ?tree= (Gary 2026-09-29).
    await page.selectOption('#treePicker', 'Edgar_T_CRF');
    const card = page.locator('#treeDetails .tree-card').first();
    await expect(card).toHaveCount(1);
    const link = card.locator('.tc-main .tc-payee a.tc-copy');
    await expect(link).toHaveCount(1);
    await expect(link).toContainText('Copy payee link');
    const crfUrl = 'https://cfr.truesight.me/my-trees/?tx=YgyO2UUE';
    await expect(link).toHaveAttribute('data-copy-url', crfUrl);
    await expect(card.locator('.tc-main .tc-payee-url')).toHaveText(crfUrl);

    // Clicking copies the URL to the clipboard and flips the label as feedback.
    await link.click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe(crfUrl);
    await expect(link).toContainText(/Copied/);

    // A tree with NO txid (predates the txid column) FALLS BACK to ?tree=<id>, and
    // no program attribution -> the SunMint beta viewer.
    // The page's program filter DEFAULTS to crf-anapu, which HIDES an unattributed
    // tree from the picker -- blank the program first so all trees are listed.
    await page.selectOption('#programSlug', '');
    await expect(page.locator('#treePicker option[value="Edgar_T_SUN"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_T_SUN');
    const link2 = page.locator('#treeDetails .tree-card .tc-main .tc-payee a.tc-copy').first();
    await expect(link2).toHaveAttribute(
      'data-copy-url', 'https://beta.sunmint.truesight.me/my-trees/?tree=Edgar_T_SUN');
  });

  test('collision reason renders INLINE on the Overpay Conflict card (not in the guard below)', async ({ page }) => {
    await mockBackend(page);
    // Two DIFFERENT trees on the SAME fix (0 m apart) -> both flagged co-located.
    await page.route('**/sunmint_pending.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ status: 'success', count: 2, items: [
        { telegram_message_id: 'Edgar_FLAG_A', species: 'Cacau', planting_date: '2026-09-01', photo_url: 'http://x/a.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
        { telegram_message_id: 'Edgar_FLAG_B', species: 'Cacau', planting_date: '2026-09-02', photo_url: 'http://x/b.jpg', latitude: '-3.100000', longitude: '-52.100000', status: 'NEW' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_FLAG_A"]')).toHaveCount(1, { timeout: 15000 });

    // Pick a FLAGGED tree -> the reason appears ON the conflict card, spelling out
    // WHAT it collides with and the distance.
    await page.selectOption('#treePicker', 'Edgar_FLAG_A');
    const reason = page.locator('#overpayReason .overpay-row');
    await expect(reason).toHaveCount(1);
    await expect(reason).toContainText('Edgar_FLAG_A');
    await expect(reason).toContainText(/same GPS fix/i);
    await expect(reason).toContainText(/0(\.\d+)? m/);

    // ...and the reason sits ABOVE the compared tree card, inside the 2nd column.
    const above = await page.evaluate(() => {
      const r = document.getElementById('overpayReason');
      const d = document.getElementById('overpayTreeDetails');
      return !!(r && d) && (r.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    });
    expect(above, 'reason must sit above the compared tree card').toBe(true);

    // The guard no longer duplicates the selected tree's reason -- it keeps only the
    // summary + legend + the all-flagged list (one line per tree, still present).
    await expect(page.locator('#overpayGuard .overpay-row')).toHaveCount(0);
    await page.click('#overpayGuard details.overpay-all summary');
    await expect(page.locator('#overpayGuard .overpay-all-list')).toContainText('same GPS fix');

    // Clearing the picker clears the reason with the card.
    await page.selectOption('#treePicker', '');
    await expect(page.locator('#overpayReason .overpay-row')).toHaveCount(0);
  });

  test('attaching a receipt emits a PRIVATE destination and never the public store', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Real ephemeral keypair + Edgar route override (mirrors the happy-path test).
    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });
    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ signature_verification: 'success' }) });
      }
      return route.continue();
    });

    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await page.fill('#amount', 'R$ 50,00');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');

    // Attach a receipt (an in-memory PNG). The page must NOT echo the original
    // filename — it is replaced with an opaque payout_<stamp>_<rand>.<ext>.
    await page.setInputFiles('#receiptFileInput', {
      name: 'Maria_Silva_CPF_111.444.777-35.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 fake receipt'),
    });

    await page.click('#submitButton');
    await expect(page.locator('#status')).toContainText(/Payout recorded/i, { timeout: 20000 });

    const requestPre = await page.locator('#requestPre').textContent();
    // Destination must be the PRIVATE receipts repo...
    expect(requestPre).toContain('Destination Payout Receipt File Location: https://github.com/TrueSightDAO/payout-receipts-raw/');
    // ...and NEVER the public .github attachment store.
    expect(requestPre).not.toContain('github.com/TrueSightDAO/.github/');
    // The original (PII-bearing) filename must never appear in the public payload.
    expect(requestPre).not.toContain('Maria_Silva');
    expect(requestPre).not.toContain('111.444.777-35');
    // The Attached Filename is the opaque generated name.
    expect(requestPre).toMatch(/Attached Filename: payout_\d{14}_[0-9a-f]{6}\.pdf/);
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
  test('registered recipients: ONE row per pk_hash, full pk_hash visible, no raw PIX, Use fills the field', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');

    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    const panel = page.locator('#recipientsPanel');
    await expect(panel).toBeVisible({ timeout: 15000 });

    // The whole point: FOUR sheet rows collapse to ONE rendered recipient.
    await expect(page.locator('#recipientsList .recipient-row')).toHaveCount(1);
    const row = page.locator('#recipientsList .recipient-row').first();
    // The full, un-truncated pk_hash must be plainly visible so the operator
    // cannot mis-send to the wrong account.
    await expect(row.locator('.rp-pk')).toHaveText('pk-qkejKJJW3IAD');
    await expect(row.locator('.rp-status')).toHaveText('UPDATED');

    // PRIVACY: only the masked key may appear anywhere in the DOM.
    const html = await page.locator('#recipientsList').innerHTML();
    expect(html).toContain('***.***.***-19');
    expect(html).not.toMatch(/\bpix_key\b/);
    const rawCpf = html.match(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(rawCpf).toBeNull();

    // Clicking Use fills the recipient field (no hand-typing a hash).
    await row.locator('button.rp-use').click();
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD');
  });

  test('governor: picking a tree shows its details card', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // No selection -> no cards.
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(0);

    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');

    // One card, carrying the tree's own details (species / dates / coordinates).
    const card = page.locator('#treeDetails .tree-card').first();
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(1);
    await expect(card.locator('.tc-id')).toHaveText('Edgar_TEST_T1');
    await expect(card.locator('.tc-meta')).toContainText('Cacau');
    await expect(card.locator('.tc-meta')).toContainText('2026-09-01');
    await expect(card.locator('.tc-meta')).toContainText('-3.1');
    // The tree's photo is shown.
    await expect(card.locator('img.tc-photo')).toHaveAttribute('src', 'http://x/t1.jpg');

    // Clearing the selection (blank option) clears the cards.
    await page.selectOption('#treePicker', '');
    await expect(page.locator('#treeDetails .tree-card')).toHaveCount(0);
  });

  test('governor: "Mark tree as invalid" is hidden until a tree is selected, then emits the REJECT event', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    // Auto-accept the confirm(); supply the prompt() reason.
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'Not a valid tree' : ''));

    let submitted = '';
    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        submitted = route.request().postData() || '';
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ signature_verification: 'success' }) });
      }
      return route.continue();
    });

    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Swap in an EPHEMERAL RSA keypair so the in-browser signing is real.
    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });

    // Hidden with no selection; appears once a tree is picked (Gary's rule).
    await expect(page.locator('#invalidZone')).toBeHidden();
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#invalidZone')).toBeVisible();

    await page.locator('#markInvalidButton').click();
    await expect(page.locator('#status')).toContainText('INVALID', { timeout: 15000 });

    // The verbatim payload reaches the forensic panel with the exact labels...
    const req = await page.locator('#requestPre').textContent();
    expect(req).toContain('[TREE PLANTING REJECT EVENT]');
    expect(req).toContain('- SunMint Submission Message ID: Edgar_TEST_T1');
    expect(req).toContain('- QR Code: (unlinked)');
    // ...it hit Edgar, and REJECT never carries a raw CPF.
    expect(submitted).toContain('TREE PLANTING REJECT EVENT');
    expect(req).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
  });

  test('governor: a single resolved tree auto-fills the recipient pk_hash (and never clobbers a typed one)', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Edgar_TEST_T1 is IN the governor map -> picking it auto-fills the recipient.
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD');
    // ...and the card shows the linked pk_hash AND its PARTIAL (masked) key.
    await expect(page.locator('#treeDetails .tc-pk')).toContainText('pk-qkejKJJW3IAD');
    await expect(page.locator('#treeDetails .tc-masked')).toContainText('***.***.***-19');
    await expect(page.locator('#treeDetails .tc-masked')).toContainText(/CPF|EMAIL|PHONE|RANDOM/i);
    // PRIVACY: only the masked key may appear on the card -- never a raw CPF.
    const cardHtml = await page.locator('#treeDetails').innerHTML();
    expect(cardHtml).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);

    // A tree NOT in the map must NOT clobber an operator-typed hash. (Use the
    // general-disbursement view so the unattributed T2 is listed.)
    await page.selectOption('#programSlug', '');
    await page.fill('#recipientPkHash', 'pk-typed-by-operator');
    await page.selectOption('#treePicker', 'Edgar_TEST_T2');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-typed-by-operator');

    // Single-select: there is no multi-tree state to be ambiguous about.
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T2');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-typed-by-operator');
  });

  test('CLEAR: switching from a registered tree to an UNREGISTERED one empties the recipient pk_hash', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // T1 is registered -> selecting it auto-fills its pk_hash.
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD');

    // T2 has NO recipient. Switching to it must EMPTY the field -- one tree's
    // pk_hash must never ride along with a different tree (misfile risk).
    await page.selectOption('#programSlug', '');
    await page.selectOption('#treePicker', 'Edgar_TEST_T2');
    await expect(page.locator('#recipientPkHash')).toHaveValue('');
    // ...and the honest "not found" hint appears (not a silent blank).
    await expect(page.locator('#recipientLookupStatus')).toHaveText(/No payout registration found/i);

    // Switching BACK to the registered tree re-fills it.
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD');
  });

  test('CLEAR: an operator-typed pk_hash survives a switch to an unregistered tree', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Type a hash by hand, never having selected a registered tree.
    await page.selectOption('#programSlug', '');
    await page.fill('#recipientPkHash', 'pk-typed-by-operator');
    // Selecting an unregistered tree must NOT wipe a human-typed value.
    await page.selectOption('#treePicker', 'Edgar_TEST_T2');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-typed-by-operator');
  });

  test('BUGFIX: a tree picked BEFORE the recipient map lands still auto-fills (retroactive) and deep-links the URL', async ({ page }) => {
    // The FEED is instant but the MAP is delayed 1.5s -- the exact race that used
    // to strand the recipient field blank with no retry.
    await mockBackend(page, { mapDelayMs: 1500 });
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    // Pick while the map is still in flight.
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T1');

    // The selection is mirrored into the URL immediately...
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBe('Edgar_TEST_T1');
    // ...and when the delayed map finally arrives the recipient fills RETROACTIVELY.
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 15000 });
  });

  test('BUGFIX: ?tree_id= in the URL selects that tree on load and fills its recipient', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html?tree_id=Edgar_TEST_T1');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T1', { timeout: 15000 });
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 15000 });
    // ...and the link stays deep-linkable (does not get cleared on apply).
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBe('Edgar_TEST_T1');
  });

  test('HINT: a slow recipient map shows "Looking up recipient…" (not a silent blank), then fills', async ({ page }) => {
    // The map answers 3s late -- the real GAS concurrency-queue delay. This is
    // now the FALLBACK path (an older cache with no inline recipient_pk_hash), so
    // the feed must omit it (feedRecipient:false) to exercise it. During that
    // window the field must NOT read as "found nothing".
    await mockBackend(page, { mapDelayMs: 3000, feedRecipient: false });
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html?tree_id=Edgar_TEST_T1');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    const hint = page.locator('#recipientLookupStatus');
    await expect(hint).toHaveText(/Looking up recipient/i, { timeout: 15000 });
    await expect(hint).toHaveClass(/loading/);
    await expect(page.locator('#recipientPkHash')).toHaveValue('');

    // When the delayed map lands: the fill happens AND the loading hint clears.
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 15000 });
    await expect(hint).toHaveText('');
  });

  test('HINT: a loaded map with no entry for the tree says so explicitly (not a silent blank)', async ({ page }) => {
    // General-disbursement view lists the unattributed T2, which is NOT in the
    // governor map. Once the map has settled the operator must be told the
    // difference between "still loading" and "genuinely not registered".
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });

    await page.selectOption('#programSlug', '');
    await page.selectOption('#treePicker', 'Edgar_TEST_T2');
    await expect(page.locator('#recipientPkHash')).toHaveValue('');
    await expect(page.locator('#recipientLookupStatus')).toHaveText(/No payout registration found for this tree/i, { timeout: 15000 });
  });

  test('CACHE-FIRST: the public feed supplies the recipient — NO getTreeRecipientMap call', async ({ page }) => {
    // The feed carries recipient_pk_hash inline, so the page must fill from it
    // WITHOUT touching the governor-only GAS endpoint (the whole point of the
    // change: no shared-deployment queueing delay).
    const { gasCalls } = await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });

    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    // Fills promptly from cache, well under the GAS latency the old path suffered.
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 3000 });
    // And the hint never shows the misleading "still loading" state.
    await expect(page.locator('#recipientLookupStatus')).toHaveText('');
    // The decisive assertion: the GAS recipient call was NEVER made.
    expect(gasCalls.length).toBe(0);
  });

  test('CACHE-FIRST: deep-link fills from the feed with no GAS call', async ({ page }) => {
    const { gasCalls } = await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html?tree_id=Edgar_TEST_T1');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 3000 });
    expect(gasCalls.length).toBe(0);
  });

  test('FALLBACK: an older cache (no inline recipient) still resolves via GAS', async ({ page }) => {
    // feedRecipient:false simulates a cache predating this change: the feed has
    // no recipient_pk_hash, so the page MUST fall back to the governor-only GAS
    // map and still fill correctly. Proves the migration is backward-compatible.
    const { gasCalls } = await mockBackend(page, { feedRecipient: false });
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });

    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect(page.locator('#recipientPkHash')).toHaveValue('pk-qkejKJJW3IAD', { timeout: 15000 });
    // The fallback DID fire (exactly once — the guard prevents double-firing).
    expect(gasCalls.length).toBe(1);
  });

  test('BUGFIX: clearing the picker drops ?tree_id= from the URL', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });
    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBe('Edgar_TEST_T1');

    await page.selectOption('#treePicker', '');
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBeNull();
  });

  test('SELECT -> URL: a signed tree mirrors the SHORT tx handle (?tx=), not ?tree_id= (Gary 2026-09-29)', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T3"]')).toHaveCount(1, { timeout: 15000 });

    await page.selectOption('#programSlug', '');
    await page.selectOption('#treePicker', 'Edgar_TEST_T3');
    // The short 8-char transaction handle lands in the URL...
    await expect.poll(() => new URL(page.url()).searchParams.get('tx')).toBe('TSL3TEST');
    // ...and the long canonical id is NOT used for a signed row.
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBeNull();
  });

  test('DEEP-LINK: ?tx=<short handle> selects that tree on load', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html?tx=TSL3TEST');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker')).toHaveValue('Edgar_TEST_T3', { timeout: 15000 });
  });

  test('SELECT -> URL: a txid-less row still mirrors the canonical ?tree_id= (fallback)', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1, { timeout: 15000 });

    await page.selectOption('#treePicker', 'Edgar_TEST_T1');
    await expect.poll(() => new URL(page.url()).searchParams.get('tree_id')).toBe('Edgar_TEST_T1');
    await expect.poll(() => new URL(page.url()).searchParams.get('tx')).toBeNull();
  });

  test('FARM/PLOT filter: cascading selects narrow the unpaid-tree list (Gary 2026-09-29)', async ({ page }) => {
    await mockBackend(page);
    // Override the farm/plot SSOT fetches: PL-002 + PL-005 on fazenda-bom-sucesso.
    // T1's coords (-3.1, -52.1) fall inside PL-002; T2/T3 are off-plot.
    await page.route('**/plots/index.geojson', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { plot_id: 'PL-002', farm_id: 'fazenda-bom-sucesso' },
          geometry: { type: 'Polygon', coordinates: [[[-52.15, -3.15], [-52.05, -3.15], [-52.05, -3.05], [-52.15, -3.05], [-52.15, -3.15]]] } },
        { type: 'Feature', properties: { plot_id: 'PL-005', farm_id: 'fazenda-bom-sucesso' },
          geometry: { type: 'Polygon', coordinates: [[[-52.35, -3.25], [-52.25, -3.25], [-52.25, -3.15], [-52.35, -3.15], [-52.35, -3.25]]] } },
      ] }),
    }));
    await page.route('**/farms/index.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'farms_index', farms: [
        { farm_id: 'fazenda-bom-sucesso', name: 'Fazenda Bom Sucesso', region: 'Altamira, Para' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Farm dropdown is populated from the farms-with-plots set (not the raw index).
    await expect(page.locator('#farmFilter option[value="fazenda-bom-sucesso"]')).toHaveCount(1, { timeout: 15000 });

    // Pick the farm -> the Plot dropdown cascades from it.
    await page.selectOption('#farmFilter', 'fazenda-bom-sucesso');
    await expect(page.locator('#plotFilter option[value="PL-002"]')).toHaveCount(1);
    await expect(page.locator('#plotFilter option[value="PL-005"]')).toHaveCount(1);

    // With no program filter, the farm facet leaves only the on-plot tree (T1).
    await page.selectOption('#programSlug', '');
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1);
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T2"]')).toHaveCount(0);

    // Narrow further to PL-005 -> the on-PL-002 tree drops out.
    await page.selectOption('#plotFilter', 'PL-005');
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(0);
  });

  test('filters: changing Farm/Plot/Program mirrors the facets into the URL', async ({ page }) => {
    await mockBackend(page);
    await page.route('**/plots/index.geojson', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { plot_id: 'PL-002', farm_id: 'fazenda-bom-sucesso' },
          geometry: { type: 'Polygon', coordinates: [[[-52.15, -3.15], [-52.05, -3.15], [-52.05, -3.05], [-52.15, -3.05], [-52.15, -3.15]]] } },
      ] }),
    }));
    await page.route('**/farms/index.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'farms_index', farms: [
        { farm_id: 'fazenda-bom-sucesso', name: 'Fazenda Bom Sucesso', region: 'Altamira, Para' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#farmFilter option[value="fazenda-bom-sucesso"]')).toHaveCount(1, { timeout: 15000 });

    // Clean start: default program only -> the URL carries no filter facets.
    await expect.poll(() => new URL(page.url()).searchParams.get('program')).toBeNull();

    // Choose farm -> URL reflects it; plot cascades.
    await page.selectOption('#farmFilter', 'fazenda-bom-sucesso');
    await expect.poll(() => new URL(page.url()).searchParams.get('farm')).toBe('fazenda-bom-sucesso');
    await page.selectOption('#plotFilter', 'PL-002');
    await expect.poll(() => new URL(page.url()).searchParams.get('plot')).toBe('PL-002');

    // Clear the program away from its default -> the URL says so explicitly.
    await page.selectOption('#programSlug', '');
    await expect.poll(() => new URL(page.url()).searchParams.get('program')).toBe('');

    // Back to a pristine filter -> the facets drop out of the URL (clean link).
    await page.selectOption('#farmFilter', '');
    await expect.poll(() => new URL(page.url()).searchParams.get('farm')).toBeNull();
    await expect.poll(() => new URL(page.url()).searchParams.get('plot')).toBeNull();
    await page.selectOption('#programSlug', 'crf-anapu');
    await expect.poll(() => new URL(page.url()).searchParams.get('program')).toBeNull();
  });

  test('filters: a ?farm=&plot=&program= deep-link restores the filtered view', async ({ page }) => {
    await mockBackend(page);
    await page.route('**/plots/index.geojson', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { plot_id: 'PL-002', farm_id: 'fazenda-bom-sucesso' },
          geometry: { type: 'Polygon', coordinates: [[[-52.15, -3.15], [-52.05, -3.15], [-52.05, -3.05], [-52.15, -3.05], [-52.15, -3.15]]] } },
      ] }),
    }));
    await page.route('**/farms/index.json', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ type: 'farms_index', farms: [
        { farm_id: 'fazenda-bom-sucesso', name: 'Fazenda Bom Sucesso', region: 'Altamira, Para' },
      ] }),
    }));
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html?farm=fazenda-bom-sucesso&plot=PL-002&program=');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // The facets from the link are applied once the SSOTs land.
    await expect(page.locator('#farmFilter')).toHaveValue('fazenda-bom-sucesso', { timeout: 15000 });
    await expect(page.locator('#plotFilter')).toHaveValue('PL-002');
    await expect(page.locator('#programSlug')).toHaveValue('');
    // The on-PL-002 tree stays; the off-plot tree is filtered out.
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T1"]')).toHaveCount(1);
    await expect(page.locator('#treePicker option[value="Edgar_TEST_T2"]')).toHaveCount(0);
  });

  test('batch: ticking trees fires ONE single-tree PAYOUT EVENT per tree, each carrying total/N', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    // Real ephemeral keypair so the in-browser signing is genuine.
    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });

    // Capture every signed payload Edgar receives.
    const bodies: string[] = [];
    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        bodies.push(route.request().postData() || '');
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ signature_verification: 'success' }) });
      }
      return route.continue();
    });
    page.on('dialog', (d) => d.accept());

    // Enter batch mode -> the panel + checkbox list appear.
    await page.check('#batchMode');
    await expect(page.locator('#batchPanel')).toBeVisible();
    await expect(page.locator('#batchList input.batch-cb').first()).toBeVisible({ timeout: 15000 });

    // Select every filtered tree (3 in the mock feed).
    await page.selectOption('#programSlug', '');   // whole cluster in scope (T2 is unattributed)
    await page.click('#batchSelectAll');
    await expect(page.locator('#batchCount')).toContainText('3 selected');

    // ONE lump of 300 -> the split preview shows 100 each.
    await page.fill('#amount', '300');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');
    await expect(page.locator('#batchSplitNote')).toContainText('100 each');

    await page.click('#batchSubmitButton');
    await expect(page.locator('#status')).toContainText(/all 3 trees paid/i, { timeout: 30000 });

    // Exactly THREE events fired -- one per tree, NOT one multi-tree event.
    expect(bodies).toHaveLength(3);
    const treeLine = (b: string) => (b.match(/Tree Planting IDs:\s*(.+)/)?.[1] || '').trim();
    const amtLine = (b: string) => (b.match(/Amount:\s*(.+)/)?.[1] || '').trim();
    // Each event keys a SINGLE tree id, and each carries the split amount (100).
    for (const b of bodies) {
      expect(treeLine(b)).not.toContain(',');
      expect(amtLine(b)).toBe('100');
    }
    // The three tree ids are distinct and cover the whole cluster.
    const ids = bodies.map(treeLine).sort();
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('Edgar_TEST_T1');

    // The paid trees are gone from the batch list (no double-submit surface).
    await expect(page.locator('#batchSelectAll')).toBeVisible();
    await expect(page.locator('#batchList input.batch-cb')).toHaveCount(0);
  });

  test('batch: a mid-batch failure is reported per-tree, never swallowed as a silent partial success', async ({ page }) => {
    await mockBackend(page);
    await signIn(page, GOV_PUBLIC_KEY);
    await page.goto('/report_payout_event.html');
    await expect(page.locator('#content')).toBeVisible({ timeout: 15000 });

    await page.evaluate(async () => {
      const kp = await (window as any).EdgarPayloadHelper.generateEphemeralKeyPair();
      localStorage.setItem('privateKey', kp.privateKey);
      localStorage.setItem('publicKey', kp.publicKey);
    });

    // First tree succeeds; every later tree's Edgar call returns an UNVERIFIED result.
    let n = 0;
    await page.route('**/edgar.truesight.me/**', (route) => {
      if (route.request().url().includes('submit_contribution')) {
        n += 1;
        const ok = n === 1;
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ signature_verification: ok ? 'success' : 'failure' }) });
      }
      return route.continue();
    });
    page.on('dialog', (d) => d.accept());

    await page.check('#batchMode');
    await page.selectOption('#programSlug', '');   // whole cluster in scope (T2 is unattributed)
    await page.click('#batchSelectAll');
    await page.fill('#amount', '300');
    await page.selectOption('#currency', 'BRL');
    await page.fill('#paidAt', '2026-09-12T21:38:00Z');
    await page.fill('#bankRef', 'E6890081000000000000000000000');

    await page.click('#batchSubmitButton');
    // The batch reports BOTH halves -- success count AND the failures.
    await expect(page.locator('#status')).toContainText(/1 paid, 2 FAILED/i, { timeout: 30000 });
    const summary = page.locator('#batchSummary');
    await expect(summary.locator('.bs-ok')).toContainText('1 paid');
    await expect(summary.locator('.bs-fail')).toContainText('2 FAILED');
    // The two failures are NAMED, not just counted.
    await expect(summary.locator('ul li')).toHaveCount(2);
  });
});
