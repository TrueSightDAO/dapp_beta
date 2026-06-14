// navigation menu shared across all individual pages
// When you change menuItems, bump the ?v= query on <script src="./menu.js?v=…"> in every
// HTML page (and in service-worker.js URLS_TO_CACHE) so browsers and the SW pick up edits.
// Section order in dropdown follows first occurrence: Home, Governor, Community, Inventory, Retail (field), Sunmint, Identity
(function() {
  window.menuItems = [
    { title: 'Home', url: './index.html', section: '' },
    { title: 'Governor Chat', url: './chat.html', section: 'Governor only' },
    { title: 'Add New Contributor', url: './governor_contributor_admin.html', section: 'Governor only' },
    { title: 'Permissions Viewer', url: './governor_permissions.html', section: 'Governor only' },
    { title: 'Program Registrations (review)', url: './program_registrations_review.html', section: 'Governor only' },
    { title: 'DAO Contribution Reporter', url: './report_contribution.html', section: 'Community Contributions' },
    { title: 'Content Feedback Submission', url: './submit_feedback.html', section: 'Community Contributions' },
    { title: 'Capital Injection Reporter', url: './report_capital_injection.html', section: 'Inventory & ledger' },
    { title: 'Currency Conversion Reporter', url: './currency_conversion.html', section: 'Inventory & ledger' },
    { title: 'Inventory Expense Reporter', url: './report_dao_expenses.html', section: 'Inventory & ledger' },
    { title: 'Asset Receipt Reporter', url: './report_asset_receipt.html', section: 'Inventory & ledger' },
    { title: 'Inventory Movement Reporter', url: './report_inventory_movement.html', section: 'Inventory & ledger' },
    { title: 'Inventory Holdings by Manager', url: './view_inventory_holdings.html', section: 'Inventory & ledger' },
    { title: 'Batch QR Code Generator', url: './batch_qr_generator.html', section: 'Inventory & ledger' },
    { title: 'Update QR Code', url: './update_qr_code.html', section: 'Inventory & ledger' },
    { title: 'Repackaging Planner', url: './repackaging_planner.html', section: 'Inventory & ledger' },
    { title: 'Shipping Planner', url: './shipping_planner.html', section: 'Inventory & ledger' },
    { title: 'Restock Recommender', url: './restock_recommender.html', section: 'Inventory & ledger' },
    { title: 'Cacao Bag Scanner', url: './scanner.html', section: 'Retail & field activity' },
    { title: 'Sales Reporter', url: './report_sales.html', section: 'Retail & field activity' },
    { title: 'Stores Nearby', url: './stores_nearby.html', section: 'Retail & field activity' },
    { title: 'Stores by Status', url: './stores_by_status.html', section: 'Retail & field activity' },
    { title: 'Store Interaction History', url: './store_interaction_history.html', section: 'Retail & field activity' },
    { title: 'Partner Check-in', url: './partner_check_in.html', section: 'Retail & field activity' },
    { title: 'Add Partner', url: './partner_add.html', section: 'Retail & field activity' },
    { title: 'Outbound Review', url: './warmup_review.html', section: 'Retail & field activity' },
    { title: 'Register Your Farm', url: './register_farm.html', section: 'Sunmint Tree Planting Program' },
    { title: 'Report Tree Planting', url: './report_tree_planting.html', section: 'Sunmint Tree Planting Program' },
    { title: 'Digital Signature Creator', url: './create_signature.html', section: 'Identity & Governance' },
    { title: 'Voting Rights Cash Out', url: './withdraw_voting_rights.html', section: 'Identity & Governance' },
    { title: 'Notarize Official Document', url: './notarize.html', section: 'Identity & Governance' },
    { title: 'Verify Signed Request', url: './verify_request.html', section: 'Identity & Governance' },
    { title: 'DAO Proposal Management', url: './view_open_proposals.html', section: 'Identity & Governance' },
    { title: 'Create Proposal', url: './create_proposal.html', section: 'Identity & Governance' },
    { title: 'Review & Vote on Proposal', url: './review_proposal.html', section: 'Identity & Governance' }
  ];

  document.addEventListener('DOMContentLoaded', function() {
    var container = document.getElementById('navDropdown');
    if (!container) return;
    var select = document.createElement('select');
    select.style.padding = '0.5rem';
    select.style.fontSize = '1rem';
    select.style.marginBottom = '1rem';
    var currentPage = location.pathname.split('/').pop();
    var sectionsMap = {};
    var sectionOrder = [];
    window.menuItems.forEach(function(item) {
      var sec = item.section || '';
      if (!sectionsMap.hasOwnProperty(sec)) {
        sectionsMap[sec] = [];
        sectionOrder.push(sec);
      }
      sectionsMap[sec].push(item);
    });
    sectionOrder.forEach(function(sec) {
      var parent = select;
      if (sec) {
        var optgroup = document.createElement('optgroup');
        optgroup.label = sec;
        select.appendChild(optgroup);
        parent = optgroup;
      }
      sectionsMap[sec].forEach(function(item) {
        var option = document.createElement('option');
        option.value = item.url;
        option.textContent = item.title;
        var itemPage = item.url.split('/').pop();
        var isProposalPage = currentPage === 'review_proposal.html' || currentPage === 'create_proposal.html';
        var isDAOProposalManagement = item.title === 'DAO Proposal Management';
        if (currentPage === itemPage || (isProposalPage && isDAOProposalManagement)) {
          option.selected = true;
        }
        parent.appendChild(option);
      });
    });
    select.addEventListener('change', function () {
      var url = this.value;
      if (!url) return;
      location.href = url;
    });
    container.appendChild(select);
  });

  // Inject the notifications widget (red-badge action-item indicator)
  // on every page that loads menu.js. Loaded async so it never blocks
  // the menu render. The widget self-mounts a fixed-position badge in
  // the top-right corner; see js/notifications.js for the source contract.
  document.addEventListener('DOMContentLoaded', function () {
    if (document.getElementById('tsd-notif-script')) return;
    var s = document.createElement('script');
    s.id = 'tsd-notif-script';
    s.src = './js/notifications.js?v=20260603a';
    s.async = true;
    document.head.appendChild(s);
  });
})();
