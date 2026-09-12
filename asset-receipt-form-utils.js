/**
 * Asset Receipt form utility functions - isomorphic (browser + Node).
 * Used by report_asset_receipt.html and tested in
 * tests/asset-receipt-form-utils.test.js
 */
(function (global) {
    'use strict';

    // Button labels. After a successful submission the submit button becomes a
    // "submit another one" reset control (mirrors report_inventory_movement.html's
    // "Report Another Movement" pattern).
    var SUBMIT_LABEL = 'Submit Asset Receipt Report';
    var SUBMIT_ANOTHER_LABEL = 'Submit another one';

    // Markup default for #amountInput (value="1") -- restored on reset.
    var DEFAULT_AMOUNT = '1';

    function _str(v) {
        return v == null ? '' : String(v);
    }

    /**
     * Mirrors the form's own validation exactly:
     *   fundHandler && currency && amount && parseFloat(amount) > 0 && description
     * (fundHandler/currency/description are trimmed; amount is the raw input value.)
     */
    function isFormValid(fields) {
        fields = fields || {};
        var fundHandler = _str(fields.fundHandler).trim();
        var currency = _str(fields.currency).trim();
        var amount = _str(fields.amount);
        var description = _str(fields.description).trim();
        return Boolean(
            fundHandler && currency && amount && parseFloat(amount) > 0 && description
        );
    }

    /** Label for the submit/reset button given whether a submission just happened. */
    function buttonLabel(isPostSubmission) {
        return isPostSubmission ? SUBMIT_ANOTHER_LABEL : SUBMIT_LABEL;
    }

    /**
     * Values a cleared form returns to. Text fields blank; amount back to its
     * markup default. File-related state lives in the page (not here).
     */
    function emptyFormState() {
        return {
            fundHandler: '',
            currency: '',
            amount: DEFAULT_AMOUNT,
            description: ''
        };
    }

    var utils = {
        SUBMIT_LABEL: SUBMIT_LABEL,
        SUBMIT_ANOTHER_LABEL: SUBMIT_ANOTHER_LABEL,
        DEFAULT_AMOUNT: DEFAULT_AMOUNT,
        isFormValid: isFormValid,
        buttonLabel: buttonLabel,
        emptyFormState: emptyFormState
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = utils;
    } else {
        global.assetReceiptFormUtils = utils;
    }
})(typeof window !== 'undefined' ? window : globalThis);
