import type { DeviceKey, KeyProvider, SecureStore } from "./types.js";
/** The little async key/value surface both IndexedDB-backed classes use. */
export interface KeyValueDb {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}
export declare class MemoryDb implements KeyValueDb {
    private readonly m;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}
/** One object store in one IndexedDB database. */
export declare class IdbDb implements KeyValueDb {
    private dbp;
    private readonly dbName;
    private readonly storeName;
    private readonly factory;
    constructor(dbName: string, storeName: string, factory?: IDBFactory);
    private open;
    private run;
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
}
export interface WebCryptoKeyProviderOptions {
    /** Defaults to IndexedDB database `fc-field-keys`. */
    db?: KeyValueDb;
}
/**
 * A non-extractable ECDSA P-256 key kept in IndexedDB (a CryptoKey survives
 * structured clone). Attestation level SOFTWARE.
 */
export declare class WebCryptoKeyProvider implements KeyProvider {
    private readonly db;
    private pending;
    constructor(opts?: WebCryptoKeyProviderOptions);
    private load;
    getOrCreateDeviceKey(): Promise<DeviceKey>;
    sign(data: Uint8Array): Promise<Uint8Array>;
    deleteDeviceKey(): Promise<void>;
}
export interface IndexedDbSecureStoreOptions {
    db?: KeyValueDb;
}
/**
 * Plain key/value storage in IndexedDB. No biometric support:
 * `set(..., {requireBiometric: true})` throws BIOMETRIC_UNAVAILABLE.
 */
export declare class IndexedDbSecureStore implements SecureStore {
    private readonly db;
    constructor(opts?: IndexedDbSecureStoreOptions);
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts?: {
        requireBiometric?: boolean;
    }): Promise<void>;
    delete(key: string): Promise<void>;
    biometricAvailable(): Promise<boolean>;
}
/** For tests. Same behaviour as [IndexedDbSecureStore], in memory. */
export declare class MemorySecureStore implements SecureStore {
    private readonly m;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, opts?: {
        requireBiometric?: boolean;
    }): Promise<void>;
    delete(key: string): Promise<void>;
    biometricAvailable(): Promise<boolean>;
    /** Test hook: everything stored, to assert nothing secret leaks. */
    dump(): Record<string, string>;
}
//# sourceMappingURL=storage.d.ts.map