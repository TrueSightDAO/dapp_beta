/**
 * EdgarSubmission — reliable multipart submission of signed reports to Edgar.
 *
 * Why this exists
 * ---------------
 * iOS WebKit intermittently sends a `fetch(url, { method: 'POST', body: FormData })`
 * request with an EMPTY body when the FormData carries a File taken from the
 * camera / photo library. The request still reaches the server (HTTP 200 comes
 * back) but with no `text` part, so Edgar records a "[No Text Provided]" row with
 * `signature_verification: "no_signature_format"`. The previous client only
 * checked `resp.ok`, so it reported success on a silently-empty submission.
 *
 * What this does
 * --------------
 *   1. toSendableBlob() materialises the attachment as an in-memory Blob so the
 *      file part is read from memory, not a live camera File handle.
 *   2. postMultipart() posts via XMLHttpRequest — the transport that reliably
 *      carries multipart bodies on iOS — instead of fetch().
 *   3. submitWithRetry() retries a bounded number of times when the body did not
 *      arrive (transport error, OR Edgar replied without a verified signature).
 *
 * It does NOT fall back to share / clipboard. After the retries are exhausted it
 * rejects, and the caller surfaces a hard error.
 */
(function (root) {
    'use strict';

    var DEFAULT_ATTEMPTS = 3;
    var DEFAULT_DELAY_MS = 400;
    var DEFAULT_TIMEOUT_MS = 45000;

    function buildFormData(text, file, fileName) {
        var fd = new FormData();
        fd.append('text', text);
        if (file) {
            fd.append('attachment', file, fileName || file.name || 'attachment');
        }
        return fd;
    }

    /**
     * Read the File's bytes into a fresh Blob. This detaches us from the live
     * iOS camera File handle that fetch() sometimes fails to serialise.
     * Falls back to the original file if arrayBuffer() is unavailable or fails.
     */
    function toSendableBlob(file) {
        if (!file) { return Promise.resolve(null); }
        if (typeof file.arrayBuffer !== 'function') { return Promise.resolve(file); }
        return file.arrayBuffer().then(function (buf) {
            return new Blob([buf], { type: file.type || 'application/octet-stream' });
        })['catch'](function () { return file; });
    }

    // Edgar only "has" the submission when it reports a verified signature.
    // Anything else (no_signature_format / empty body) means the body was lost.
    function isDelivered(result) {
        return !!(result && result.signature_verification === 'success');
    }

    // 4xx is a deliberate server rejection — retrying will not help.
    function isRetryableStatus(status) {
        return status === 0 || status === 408 || status === 429 || status >= 500;
    }

    function postMultipart(url, formData, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var XHR = opts.XMLHttpRequest || root.XMLHttpRequest;
            if (!XHR) { return reject(new Error('XMLHttpRequest is not available')); }
            var xhr = new XHR();
            try { xhr.open('POST', url, true); } catch (e) { return reject(e); }

            xhr.onload = function () {
                var raw = xhr.responseText || '';
                var parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
                if (xhr.status >= 200 && xhr.status < 300) {
                    return resolve({ response: xhr, result: parsed, raw: raw });
                }
                if (isRetryableStatus(xhr.status)) {
                    var re = new Error('Edgar HTTP ' + xhr.status);
                    re.retryable = true;
                    return reject(re);
                }
                return reject(new Error(
                    'Edgar rejected the submission (HTTP ' + xhr.status + '): ' + raw));
            };
            xhr.onerror = function () {
                var e = new Error('Network error while contacting Edgar');
                e.retryable = true;
                reject(e);
            };
            xhr.ontimeout = function () {
                var e = new Error('Timed out contacting Edgar');
                e.retryable = true;
                reject(e);
            };
            xhr.timeout = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
            try { xhr.send(formData); } catch (e) { reject(e); }
        });
    }

    /**
     * Submit text (+ optional attachment) and retry until Edgar confirms a
     * verified signature, or until the attempt budget is exhausted.
     * Resolves { result, response, attempts }; rejects on final failure.
     */
    function submitWithRetry(opts) {
        opts = opts || {};
        var attempts = opts.attempts || DEFAULT_ATTEMPTS;
        var delayMs = (opts.delayMs == null) ? DEFAULT_DELAY_MS : opts.delayMs;
        var url = opts.url;
        var text = opts.text;
        var file = opts.file;
        var fileName = opts.fileName;
        var lastError = null;

        if (!url) { return Promise.reject(new Error('submitWithRetry: url is required')); }
        if (!text) { return Promise.reject(new Error('submitWithRetry: text is required')); }

        function delay(ms) {
            return new Promise(function (resolve) {
                (root.setTimeout || setTimeout)(resolve, ms);
            });
        }

        function attemptOnce(n) {
            var fd = buildFormData(text, file, fileName);
            return postMultipart(url, fd, opts).then(function (out) {
                if (isDelivered(out.result)) {
                    return { result: out.result, response: out.response, attempts: n };
                }
                lastError = new Error('Edgar did not verify the submission ' +
                    '(signature_verification=' +
                    ((out.result && out.result.signature_verification) || 'none') + ')');
                lastError.retryable = true;
                return null;
            }, function (err) {
                lastError = err || new Error('Submission failed');
                // Only retry errors we explicitly flagged as retryable.
                // A 4xx from Edgar is a deliberate rejection — surface it at once.
                if (lastError.retryable !== true) { throw lastError; }
                return null;
            }).then(function (done) {
                if (done) { return done; }
                if (n >= attempts) {
                    throw lastError || new Error('Submission failed after ' + n + ' attempts');
                }
                return delay(delayMs).then(function () { return attemptOnce(n + 1); });
            });
        }

        return attemptOnce(1);
    }

    root.EdgarSubmission = {
        buildFormData: buildFormData,
        toSendableBlob: toSendableBlob,
        isDelivered: isDelivered,
        postMultipart: postMultipart,
        submitWithRetry: submitWithRetry
    };
})(typeof window !== 'undefined' ? window : globalThis);
