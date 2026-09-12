/**
 * Unit tests for scripts/edgar_submission.js
 * Run: node tests/edgar-submission.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'scripts', 'edgar_submission.js'), 'utf8');

let passed = 0;
let failed = 0;

function load() {
    const sandbox = { console: console, setTimeout: setTimeout, FormData: FormData, Blob: Blob };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return sandbox.window.EdgarSubmission;
}

// A scripted fake XMLHttpRequest. `script[i]` is the behaviour of the i-th send():
//   { status, responseText }  -> onload with that response
//   { error: true }           -> onerror
//   { timeout: true }         -> ontimeout
function fakeXHR(script) {
    let i = 0;
    return class {
        open(method, url) { this.method = method; this.url = url; }
        send() {
            const b = script[Math.min(i, script.length - 1)];
            i++;
            Promise.resolve().then(() => {
                if (b.error) { if (this.onerror) this.onerror(); return; }
                if (b.timeout) { if (this.ontimeout) this.ontimeout(); return; }
                this.status = b.status;
                this.responseText = b.responseText;
                if (this.onload) this.onload();
            });
        }
    };
}

const OK = { status: 200, responseText: JSON.stringify({
    status: 'ok', signature_verification: 'success', fileUploadedToGithub: true }) };
const EMPTY = { status: 200, responseText: JSON.stringify({
    status: 'ok', signature_verification: 'no_signature_format', fileUploadedToGithub: false }) };
const REJECT = { status: 400, responseText: JSON.stringify({ status: 'error', error: 'Missing text field' }) };

async function test(name, fn) {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed++;
    } catch (err) {
        console.error(`  \u2717 ${name}`);
        console.error(`    ${err.message}`);
        failed++;
    }
}

async function rejects(fn, re) {
    let threw = false;
    try { await fn(); } catch (e) { threw = true; if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message); }
    if (!threw) throw new Error('expected rejection but it resolved');
}

async function run() {
    const ES = load();

    await test('isDelivered: only a verified signature counts as delivered', () => {
        assert.strictEqual(ES.isDelivered({ signature_verification: 'success' }), true);
        assert.strictEqual(ES.isDelivered({ signature_verification: 'no_signature_format' }), false);
        assert.strictEqual(ES.isDelivered(null), false);
        assert.strictEqual(ES.isDelivered({}), false);
    });

    await test('buildFormData: appends text and optional attachment', () => {
        const fd1 = ES.buildFormData('hello', null, null);
        assert.strictEqual(fd1.get('text'), 'hello');
        assert.strictEqual(fd1.get('attachment'), null);
        const realFile = new Blob(['abc'], { type: 'image/png' });
        const fd2 = ES.buildFormData('hello', realFile, 'x.png');
        assert.strictEqual(fd2.get('text'), 'hello');
        assert.ok(fd2.get('attachment'));
        assert.strictEqual(fd2.get('attachment').name, 'x.png');
    });

    await test('toSendableBlob: null passes through', async () => {
        assert.strictEqual(await ES.toSendableBlob(null), null);
    });

    await test('toSendableBlob: materialises the File into an in-memory Blob', async () => {
        const file = {
            type: 'image/jpeg',
            arrayBuffer: async () => new ArrayBuffer(8)
        };
        const blob = await ES.toSendableBlob(file);
        assert.strictEqual(blob.size, 8);
        assert.strictEqual(blob.type, 'image/jpeg');
    });

    await test('toSendableBlob: falls back to the original file if reads fail', async () => {
        const file = { type: 'image/jpeg', arrayBuffer: async () => { throw new Error('nope'); } };
        assert.strictEqual(await ES.toSendableBlob(file), file);
    });

    await test('postMultipart: success resolves with the parsed result', async () => {
        const out = await ES.postMultipart('u', new FormData(), { XMLHttpRequest: fakeXHR([OK]) });
        assert.strictEqual(out.result.signature_verification, 'success');
        assert.strictEqual(out.response.status, 200);
    });

    await test('postMultipart: 5xx is retryable', async () => {
        await rejects(
            () => ES.postMultipart('u', new FormData(),
                { XMLHttpRequest: fakeXHR([{ status: 503, responseText: 'down' }]) }),
            /HTTP 503/);
    });

    await test('postMultipart: network error is retryable', async () => {
        await rejects(
            () => ES.postMultipart('u', new FormData(), { XMLHttpRequest: fakeXHR([{ error: true }]) }),
            /Network error/);
    });

    await test('postMultipart: 4xx is NOT retryable', async () => {
        await rejects(
            () => ES.postMultipart('u', new FormData(), { XMLHttpRequest: fakeXHR([REJECT]) }),
            /rejected the submission/);
    });

    await test('postMultipart: non-JSON body does not crash (result null)', async () => {
        const out = await ES.postMultipart('u', new FormData(),
            { XMLHttpRequest: fakeXHR([{ status: 200, responseText: '<html>oops' }]) });
        assert.strictEqual(out.result, null);
    });

    await test('submitWithRetry: recovers when a dropped body is followed by success', async () => {
        const out = await ES.submitWithRetry({
            url: 'u', text: 'payload', attempts: 3, delayMs: 0,
            XMLHttpRequest: fakeXHR([EMPTY, OK])
        });
        assert.strictEqual(out.attempts, 2);
        assert.strictEqual(out.result.signature_verification, 'success');
    });

    await test('submitWithRetry: retries transport failures too', async () => {
        const out = await ES.submitWithRetry({
            url: 'u', text: 'payload', attempts: 3, delayMs: 0,
            XMLHttpRequest: fakeXHR([{ error: true }, OK])
        });
        assert.strictEqual(out.attempts, 2);
    });

    await test('submitWithRetry: rejects after exhausting attempts on empty body', async () => {
        await rejects(
            () => ES.submitWithRetry({
                url: 'u', text: 'payload', attempts: 3, delayMs: 0,
                XMLHttpRequest: fakeXHR([EMPTY])
            }),
            /signature_verification=no_signature_format/);
    });

    await test('submitWithRetry: a 400 rejection is not retried', async () => {
        let sends = 0;
        const Rec = fakeXHR([REJECT]);
        const Counting = class extends Rec { send() { sends++; return super.send(); } };
        await rejects(
            () => ES.submitWithRetry({
                url: 'u', text: 'payload', attempts: 3, delayMs: 0, XMLHttpRequest: Counting
            }),
            /rejected the submission/);
        assert.strictEqual(sends, 1);
    });

    await test('submitWithRetry: requires url and text', async () => {
        await rejects(() => ES.submitWithRetry({ text: 'x' }), /url is required/);
        await rejects(() => ES.submitWithRetry({ url: 'u' }), /text is required/);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
