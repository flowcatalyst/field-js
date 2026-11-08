import type { DeviceKey, KeyProvider, SecureStore } from "./types.js";
/** A request the page may take 60 s over (a biometric prompt can be slow). */
export declare const BRIDGE_TIMEOUT_MS = 60000;
interface BridgeHost {
    version?: number;
    /** Installed by the host; never replaced by the page. */
    receive?: (msg: string) => unknown;
    /** Queue of responses that arrived before a listener was set (may be absent). */
    _q?: unknown[];
    /** The page's listener (may be absent). */
    _l?: ((msg: string) => void) | null;
}
/** The slice of `window` the bridge uses (injectable for tests). */
export interface BridgeGlobal {
    ReactNativeWebView?: {
        postMessage(msg: string): void;
    };
    __fcFieldBridge?: BridgeHost;
}
/** True when the page runs inside a host that installed the bridge. */
export declare function bridgeAvailable(g?: BridgeGlobal): boolean;
export interface BridgeClientOptions {
    global?: BridgeGlobal;
    timeoutMs?: number;
    /** Request id prefix (tests); random by default. */
    idPrefix?: string;
}
/**
 * Request/response correlation over `ReactNativeWebView.postMessage` and
 * `__fcFieldBridge`. The page sets `__fcFieldBridge._l` (never replaces
 * `receive`) and drains `_q`; both may be absent until the host first needs
 * them.
 */
export declare class BridgeClient {
    private readonly g;
    private readonly timeoutMs;
    private readonly pending;
    private seq;
    private hooked;
    private readonly nonce;
    constructor(opts?: BridgeClientOptions);
    /**
     * Sets the host's `_l` listener (never replaces `receive`) and handles
     * anything the host queued in `_q` before the listener existed.
     */
    private hook;
    /** Handles one host message; ignores anything that is not ours. */
    receive(raw: unknown): void;
    call<T>(op: string, args?: Record<string, unknown>): Promise<T>;
}
export declare class BridgeKeyProvider implements KeyProvider {
    private readonly client;
    constructor(client?: BridgeClient);
    getOrCreateDeviceKey(): Promise<DeviceKey>;
    sign(data: Uint8Array): Promise<Uint8Array>;
    deleteDeviceKey(): Promise<void>;
}
export declare class BridgeSecureStore implements SecureStore {
    private readonly client;
    constructor(client?: BridgeClient);
    get(key: string, opts?: {
        prompt?: string;
    }): Promise<string | null>;
    set(key: string, value: string, opts?: {
        requireBiometric?: boolean;
    }): Promise<void>;
    delete(key: string): Promise<void>;
    biometricAvailable(): Promise<boolean>;
}
/** The bridge providers inside a host, else WebCrypto + IndexedDB. */
export declare function defaultProviders(): {
    keys: KeyProvider;
    store: SecureStore;
};
export {};
//# sourceMappingURL=bridge.d.ts.map