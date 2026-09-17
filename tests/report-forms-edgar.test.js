// Regression guard: every signed-report form must submit to Edgar through the
// shared EdgarSubmission helper (XHR + verified-delivery retry), never via the
// raw fetch()+FormData path that iOS WebKit intermittently sends with an empty
// body. See dapp_beta PR #88 and the report_inventory_movement follow-up.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORMS = [
  'report_contribution.html',
  'report_dao_expenses.html',
  'report_asset_receipt.html',
  'report_inventory_movement.html',
  'report_payout_event.html'
];

let passed = 0, failed = 0;
function check(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  FAIL: ' + msg); }
}

FORMS.forEach(function (f) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  check(src.includes('scripts/edgar_submission.js'),
    f + ' loads scripts/edgar_submission.js');
  check(src.includes('EdgarSubmission.submitWithRetry'),
    f + ' submits via EdgarSubmission.submitWithRetry');
  // The buggy pattern is a POST whose body is a raw FormData.
  check(!/body:\s*formData/.test(src),
    f + ' does not POST a raw FormData body (iOS empty-body bug)');
  check(!/formData\.append\('attachment'/.test(src),
    f + ' does not hand-roll the attachment FormData part');
});

console.log('\nreport-forms-edgar: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
