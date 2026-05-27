# TrueSight DAO DApp

<div align="center">
  <img height="200px" src="https://github.com/TrueSightDAO/.github/blob/main/assets/20240612_truesight_dao_logo_square.png?raw=true" alt="TrueSight DAO Logo"/>
</div>

Welcome to the TrueSight DAO DApp, a suite of web-based tools for managing decentralized operations in the Agroverse cacao circles. Explore the live DApp at [https://dapp.truesight.me](https://dapp.truesight.me) to manage cacao bags, voting rights, and more.

## API Documentation

For comprehensive API documentation covering all endpoints used by this DApp, including request formats, authentication, and response examples, see the [API.md file in the tokenomics repository](https://github.com/TrueSightDAO/tokenomics/blob/main/API.md).

## UX Conventions

For UX patterns and conventions used across the DApp, including remote data loading, form field states, and error handling, see [UX_CONVENTIONS.md](./UX_CONVENTIONS.md). This document ensures consistency across all DApp modules and provides implementation guidelines for common UX patterns.

## Testing

The DApp has unit and integration tests to prevent regressions. See [tests/README.md](./tests/README.md) for details.

```bash
npm test              # Run unit + integration tests (~15s)
npm run test:unit     # Unit tests only (~1s)
npm run test:integration  # Playwright integration tests
```

- **Unit tests**: Pure logic in `expense-form-utils.js` (extractCleanCurrency, extractLedgerFromResource, etc.).
- **Integration tests**: Playwright tests with **mocked APIs** (no real Google Apps Script or Edgar calls). Verifies scripts load and form flow works.

## Modules

This repository contains tools for TrueSight DAO members, each accessible via the live DApp at [https://dapp.truesight.me](https://dapp.truesight.me):

- **[Digital Signature Creator](./create_signature.html)**: Generate and manage secure cryptographic key pairs for authenticating DAO operations.
- **[Voting Rights Cash Out](./withdraw_voting_rights.html)**: View and exchange voting rights for other assets, generating signed withdrawal requests.
- **[Withdrawal Request Verifier](./verify_request.html)**: Verify the authenticity of voting rights withdrawal requests, confirming member identity and transaction details.
- **[Serialized Cacao Bag Scanner](./scanner.html)**: Scan QR codes on cacao bags to report sales or stock updates, sharing standardized messages.
- **[Inventory Expense Reporter](./report_dao_expenses.html)**: Report expenses for DAO inventory resources, with options to attach images or PDFs.
- **[Inventory Movement Reporter](./report_inventory_movement.html)**: Track inventory movements with camera snapshots, selecting managers and recipients.
- **[Content Feedback Submission](./submit_feedback.html)**: Submit content ideas and feedback for Agroverse's social media and blog strategy. Simple text-based interface with automatic tracking and voice-support via Siri Shortcuts.

Visit [https://dapp.truesight.me](https://dapp.truesight.me) to use these tools and access detailed instructions.

## Future Modules
- Contributions reporting for $TDG awards
- Voting rights marketplace
- DAO governance proposal system

## Troubleshooting
If the latest version of the DApp does not load on your mobile device:
- **Clear Browser Cache**: Go to your browser settings (e.g., Chrome: Settings → Privacy and security → Clear browsing data; Safari: Settings → Safari → Clear History and Website Data).
- **Use Incognito Mode**: Open the site in a private/incognito tab to bypass cached content.
- **Append Query String**: Add `?v=2` to the URL (e.g., `https://dapp.truesight.me/?v=2`) to force a fresh load.
- **Wait for CDN Refresh**: GitHub Pages may take up to 10 minutes to reflect changes due to CDN caching. Check the deployment status in the repository’s **Actions** tab.

## License
This project is licensed under the terms in the [LICENSE](./LICENSE) file.
<!-- beta-deploy-gate smoke test 20260527T214035Z — harmless; verifies /ship CI-gated merge -->
