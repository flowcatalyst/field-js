import { FieldProviderError } from "./errors.js";
export class MemoryDb {
    constructor() {
        this.m = new Map();
    }
    async get(key) {
        return this.m.get(key);
    }
    async put(key, value) {
        this.m.set(key, value);
    }
    async delete(key) {
        this.m.delete(key);
    }
}
/** One object store in one IndexedDB database. */
export class IdbDb {
    constructor(dbName, storeName, factory) {
        this.dbp = null;
        this.dbName = dbName;
        this.storeName = storeName;
        this.factory = factory;
    }
    open() {
        this.dbp ?? (this.dbp = new Promise((resolve, reject) => {
            const f = this.factory ?? globalThis.indexedDB;
            if (!f) {
                reject(new FieldProviderError("INTERNAL", "indexedDB is unavailable"));
                return;
            }
            const req = f.open(this.dbName, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(this.storeName);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(new FieldProviderError("INTERNAL", "could not open indexedDB"));
        }));
        return this.dbp;
    }
    async run(mode, fn) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.storeName, mode);
            const req = fn(tx.objectStore(this.storeName));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = tx.onabort = () => reject(new FieldProviderError("INTERNAL", "indexedDB transaction failed"));
        });
    }
    get(key) {
        return this.run("readonly", (s) => s.get(key));
    }
    async put(key, value) {
        await this.run("readwrite", (s) => s.put(value, key));
    }
    async delete(key) {
        await this.run("readwrite", (s) => s.delete(key));
    }
}
const DEVICE_KEY = "device-key";
/**
 * A non-extractable ECDSA P-256 key kept in IndexedDB (a CryptoKey survives
 * structured clone). Attestation level SOFTWARE.
 */
export class WebCryptoKeyProvider {
    constructor(opts = {}) {
        this.pending = null;
        this.db = opts.db ?? new IdbDb("fc-field-keys", "keys");
    }
    load() {
        this.pending ?? (this.pending = (async () => {
            const found = (await this.db.get(DEVICE_KEY));
            if (found?.privateKey && found.jwk)
                return found;
            const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
            const raw = (await crypto.subtle.exportKey("jwk", pair.publicKey));
            const jwk = {
                kty: "EC",
                crv: "P-256",
                x: raw.x ?? "",
                y: raw.y ?? "",
            };
            const stored = { privateKey: pair.privateKey, jwk };
            await this.db.put(DEVICE_KEY, stored);
            return stored;
        })().catch((e) => {
            this.pending = null;
            throw e instanceof FieldProviderError
                ? e
                : new FieldProviderError("INTERNAL", "could not load the device key");
        }));
        return this.pending;
    }
    async getOrCreateDeviceKey() {
        const k = await this.load();
        return { jwk: { ...k.jwk }, attestation: { level: "SOFTWARE" } };
    }
    async sign(data) {
        const k = await this.load();
        const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, data);
        return new Uint8Array(sig); // WebCrypto already returns raw r‖s
    }
    async deleteDeviceKey() {
        this.pending = null;
        await this.db.delete(DEVICE_KEY);
    }
}
/**
 * Plain key/value storage in IndexedDB. No biometric support:
 * `set(..., {requireBiometric: true})` throws BIOMETRIC_UNAVAILABLE.
 */
export class IndexedDbSecureStore {
    constructor(opts = {}) {
        this.db = opts.db ?? new IdbDb("fc-field-store", "values");
    }
    async get(key) {
        const v = await this.db.get(key);
        return typeof v === "string" ? v : null;
    }
    async set(key, value, opts) {
        if (opts?.requireBiometric)
            throw new FieldProviderError("BIOMETRIC_UNAVAILABLE");
        await this.db.put(key, value);
    }
    async delete(key) {
        await this.db.delete(key);
    }
    async biometricAvailable() {
        return false;
    }
}
/** For tests. Same behaviour as [IndexedDbSecureStore], in memory. */
export class MemorySecureStore {
    constructor() {
        this.m = new Map();
    }
    async get(key) {
        return this.m.get(key) ?? null;
    }
    async set(key, value, opts) {
        if (opts?.requireBiometric)
            throw new FieldProviderError("BIOMETRIC_UNAVAILABLE");
        this.m.set(key, value);
    }
    async delete(key) {
        this.m.delete(key);
    }
    async biometricAvailable() {
        return false;
    }
    /** Test hook: everything stored, to assert nothing secret leaks. */
    dump() {
        return Object.fromEntries(this.m);
    }
}
