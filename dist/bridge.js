// The page side of the WebView bridge, protocol version 1
// (docs/field-mobile-libraries-spec.md section 3).
import { b64uDecode, b64uEncode } from "./encoding.js";
import { FieldProviderError, isProviderErrorCode } from "./errors.js";
import { IndexedDbSecureStore, WebCryptoKeyProvider } from "./storage.js";
/** A request the page may take 60 s over (a biometric prompt can be slow). */
export const BRIDGE_TIMEOUT_MS = 60000;
/** True when the page runs inside a host that installed the bridge. */
export function bridgeAvailable(g = globalThis) {
    return (typeof g.__fcFieldBridge === "object" &&
        g.__fcFieldBridge !== null &&
        g.__fcFieldBridge.version === 1 &&
        typeof g.ReactNativeWebView?.postMessage === "function");
}
/**
 * Request/response correlation over `ReactNativeWebView.postMessage` and
 * `__fcFieldBridge`. The page sets `__fcFieldBridge._l` (never replaces
 * `receive`) and drains `_q`; both may be absent until the host first needs
 * them.
 */
export class BridgeClient {
    constructor(opts = {}) {
        this.pending = new Map();
        this.seq = 0;
        this.hooked = false;
        this.g = opts.global ?? globalThis;
        this.timeoutMs = opts.timeoutMs ?? BRIDGE_TIMEOUT_MS;
        this.nonce = opts.idPrefix ?? Math.random().toString(36).slice(2, 10);
    }
    /**
     * Sets the host's `_l` listener (never replaces `receive`) and handles
     * anything the host queued in `_q` before the listener existed.
     */
    hook() {
        const host = this.g.__fcFieldBridge;
        if (!host)
            return;
        if (!this.hooked || host._l == null) {
            host._l = (msg) => this.receive(msg);
            this.hooked = true;
        }
        const q = host._q || [];
        host._q = [];
        for (const m of q)
            this.receive(m);
    }
    /** Handles one host message; ignores anything that is not ours. */
    receive(raw) {
        let m;
        try {
            m = typeof raw === "string" ? JSON.parse(raw) : raw;
        }
        catch {
            return;
        }
        if (!m || typeof m !== "object")
            return;
        const r = m;
        if (r.fcField !== 1 || typeof r.id !== "string")
            return;
        const p = this.pending.get(r.id);
        if (!p)
            return;
        this.pending.delete(r.id);
        clearTimeout(p.timer);
        if (r.ok === true) {
            p.resolve(r.result ?? {});
            return;
        }
        const code = isProviderErrorCode(r.error?.code) ? r.error.code : "INTERNAL";
        p.reject(new FieldProviderError(code, typeof r.error?.message === "string" ? r.error.message : code));
    }
    call(op, args = {}) {
        const post = this.g.ReactNativeWebView?.postMessage;
        if (!bridgeAvailable(this.g) || !post) {
            return Promise.reject(new FieldProviderError("INTERNAL", "the WebView bridge is not installed"));
        }
        const id = `${this.nonce}-${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new FieldProviderError("INTERNAL", `bridge request ${op} timed out`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve: resolve, reject, timer });
            this.hook();
            try {
                this.g.ReactNativeWebView?.postMessage(JSON.stringify({ fcField: 1, id, op, args }));
            }
            catch {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new FieldProviderError("INTERNAL", "could not post to the host"));
            }
        });
    }
}
let shared = null;
function sharedClient() {
    shared ?? (shared = new BridgeClient());
    return shared;
}
export class BridgeKeyProvider {
    constructor(client) {
        this.client = client ?? sharedClient();
    }
    getOrCreateDeviceKey() {
        return this.client.call("key.getOrCreate");
    }
    async sign(data) {
        const r = await this.client.call("key.sign", {
            data: b64uEncode(data),
        });
        const sig = b64uDecode(r.signature);
        if (sig.length !== 64) {
            throw new FieldProviderError("INTERNAL", "the host returned a malformed signature");
        }
        return sig;
    }
    async deleteDeviceKey() {
        await this.client.call("key.delete");
    }
}
export class BridgeSecureStore {
    constructor(client) {
        this.client = client ?? sharedClient();
    }
    async get(key, opts) {
        const args = { key };
        if (opts?.prompt !== undefined)
            args["prompt"] = opts.prompt;
        const r = await this.client.call("store.get", args);
        return typeof r.value === "string" ? r.value : null;
    }
    async set(key, value, opts) {
        const args = { key, value };
        if (opts?.requireBiometric)
            args["requireBiometric"] = true;
        await this.client.call("store.set", args);
    }
    async delete(key) {
        await this.client.call("store.delete", { key });
    }
    async biometricAvailable() {
        const r = await this.client.call("bio.available");
        return r.available === true;
    }
}
/** The bridge providers inside a host, else WebCrypto + IndexedDB. */
export function defaultProviders() {
    if (bridgeAvailable()) {
        const c = sharedClient();
        return { keys: new BridgeKeyProvider(c), store: new BridgeSecureStore(c) };
    }
    return { keys: new WebCryptoKeyProvider(), store: new IndexedDbSecureStore() };
}
