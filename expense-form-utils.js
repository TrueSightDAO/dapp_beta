/**
 * Expense form utility functions - isomorphic (browser + Node).
 * Used by report_dao_expenses.html and tested in tests/expense-form-utils.test.js
 */
(function (global) {
    'use strict';

    function normalizeLedgerName(ledgerName) {
        if (!ledgerName) return '';
        return ledgerName.toLowerCase().replace(/[\s\-_]/g, '');
    }

    function extractLedgerFromResource(resourceValue) {
        if (!resourceValue) return null;
        const match = String(resourceValue).match(/^\[([^\]]+)\]\s*(.+)$/);
        return match ? match[1] : null;
    }

    function extractCleanCurrency(resourceValue) {
        if (!resourceValue) return '';
        const match = String(resourceValue).match(/^\[([^\]]+)\]\s*(.+)$/);
        return match ? match[2].trim() : String(resourceValue).trim();
    }

    /**
     * Builds submit payload: resourceName (clean currency) and targetLedger.
     * @param {string} rawResourceValue - e.g. "[AGL15] USD" or "USD"
     * @param {string} ledgerValue - Explicit ledger from dropdown
     * @returns {{ resourceName: string, targetLedger: string }}
     */
    function buildSubmitPayload(rawResourceValue, ledgerValue) {
        const resourceName = extractCleanCurrency(rawResourceValue);
        const targetLedger = (ledgerValue && String(ledgerValue).toLowerCase() !== 'offchain')
            ? ledgerValue
            : (extractLedgerFromResource(rawResourceValue) || 'offchain');
        return { resourceName, targetLedger };
    }

    // MIME types the expense form accepts as an attachment. The form works on a
    // whitelist, so the same list gates both the file picker and clipboard paste.
    var PASSTHROUGH_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'];

    /**
     * Pulls a File out of a ClipboardEvent's clipboardData.
     *
     * Prefers .files (standard) and falls back to .items, because some browsers
     * (notably mobile Safari) only populate items with kind === 'file'. Returns
     * null when the clipboard carried no file at all -- e.g. a plain-text paste.
     * That case is NOT an error: the caller must stay silent and let the browser
     * perform its normal text paste.
     *
     * @param {object} clipboardData - event.clipboardData (or equivalent)
     * @returns {File|null}
     */
    function extractClipboardFile(clipboardData) {
        if (!clipboardData) return null;
        if (clipboardData.files && clipboardData.files.length > 0) {
            return clipboardData.files[0];
        }
        var items = clipboardData.items;
        if (!items) return null;
        for (var i = 0; i < items.length; i++) {
            if (items[i] && items[i].kind === 'file') {
                var f = items[i].getAsFile();
                if (f) return f;
            }
        }
        return null;
    }

    /**
     * True when the clipboard event carries a file we would accept as an attachment.
     * @param {object} clipboardData
     * @param {string[]} [allowedTypes]
     * @returns {boolean}
     */
    function hasAttachableFile(clipboardData, allowedTypes) {
        var file = extractClipboardFile(clipboardData);
        if (!file) return false;
        var allowed = allowedTypes || PASSTHROUGH_MIME_TYPES;
        return allowed.indexOf(file.type) !== -1;
    }

    function validateDescription(description) {
        // Multiline descriptions are ALLOWED (2026-09-12). We only require some
        // non-whitespace content; the parser-safe single-line form is produced
        // separately by normalizeDescription() at submit time.
        if (description === null || description === undefined) return false;
        return String(description).trim().length > 0;
    }

    /**
     * Collapses a (possibly multiline) description into the single line the
     * Edgar expense parser expects. _extractField reads "- Label: value" up to
     * the next "\n- " or end-of-line, so a raw newline -- or worse, a wrapped
     * continuation line starting with "- " -- would silently truncate the value.
     * Logical lines are joined with " | ".
     */
    function normalizeDescription(description) {
        if (description === null || description === undefined) return '';
        return String(description)
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map(function (line) { return line.trim(); })
            .filter(function (line) { return line.length > 0; })
            .join(' | ');
    }

    function generateExpenseFileName(originalFileName, contributorName) {
        const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
        const cleanContributorName = (contributorName || '').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        const cleanFileName = (originalFileName || '').replace(/[^a-zA-Z0-9.]/g, '_').toLowerCase();
        return `expense_${timestamp}_${cleanContributorName}_${cleanFileName}`;
    }

    var utils = {
        PASSTHROUGH_MIME_TYPES: PASSTHROUGH_MIME_TYPES,
        extractClipboardFile: extractClipboardFile,
        hasAttachableFile: hasAttachableFile,
        normalizeLedgerName: normalizeLedgerName,
        extractLedgerFromResource: extractLedgerFromResource,
        extractCleanCurrency: extractCleanCurrency,
        buildSubmitPayload: buildSubmitPayload,
        validateDescription: validateDescription,
        normalizeDescription: normalizeDescription,
        generateExpenseFileName: generateExpenseFileName
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = utils;
    } else {
        global.expenseFormUtils = utils;
    }
})(typeof window !== 'undefined' ? window : globalThis);
