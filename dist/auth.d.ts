import type { KeyProvider, SecureStore } from "./types.js";
export declare const STORE_DEVICE = "fc.field.device";
export declare const STORE_REFRESH = "fc.field.refresh";
export declare const STORE_SESSION = "fc.field.session";
/** The supervisor's session metadata, kept aside while a worker is impersonated. */
export declare const STORE_SUPERVISOR = "fc.field.supervisor";
/** The supervisor's refresh token (biometric when the supervisor's session was). */
export declare const STORE_SUPERVISOR_REFRESH = "fc.field.supervisor.refresh";
/** Refresh first when the access token expires within this many ms. */
export declare const REFRESH_SKEW_MS = 30000;
export interface FieldAuthOptions {
    /** Optional until enrolment: an enrolment QR payload carries it. */
    platformUrl?: string;
    /**
     * Additional platform origins (scheme + host + port, e.g.
     * `"https://fc-eu.example.com"`) an enrolment QR may name besides
     * [platformUrl]'s. When `platformUrl` is set, a QR for any other origin is
     * refused with `PLATFORM_MISMATCH` and nothing is stored. An `http:` origin is
     * only accepted for loopback hosts or when named here or as `platformUrl`.
     * Default: none.
     */
    allowedPlatformOrigins?: string[];
    appCode: string;
    keys: KeyProvider;
    store: SecureStore;
    fetch?: typeof fetch;
    /** ms since the epoch; for tests. */
    clock?: () => number;
    /**
     * Keep the refresh token behind a biometric prompt (PERSONAL devices on a
     * store that supports it) and allow [FieldAuth.unlock].
     */
    biometricUnlock?: boolean;
    /** The prompt text shown for a biometric read. */
    unlockPrompt?: string;
    /**
     * The client's identifier (the `client_identifier` claim). Required to sign
     * in by worker code on a device that is not enrolled; [FieldAuth.login]
     * can override it per call.
     */
    clientIdentifier?: string;
}
export interface DeviceInfo {
    platform?: string;
    model?: string;
}
export interface EnrolOptions {
    label?: string;
    /** Defaults to `"web"` and `navigator.userAgent`. */
    deviceInfo?: DeviceInfo;
}
export interface DeviceRecord {
    deviceId: string;
    mode: "PERSONAL" | "SHARED";
    clientId: string;
    appCodes: string[];
    platformUrl: string;
}
/** How the device is known to the platform; UNENROLLED = a key the platform has not enrolled. */
export type DeviceMode = "PERSONAL" | "SHARED" | "UNENROLLED";
/** Who is acting as the worker (impersonation): a supervisor or a console admin. */
export interface Actor {
    id: string;
    type: "field_worker" | "principal" | (string & {});
    name: string;
}
/** All times are ms since the epoch on the device clock. */
export interface Session {
    worker: {
        id: string;
        workerCode: string;
        name: string;
        /**
         * The version of the worker's photo; null when there is none, or when photos are off
         * for the client or the platform. It follows the platform's answer at every sign-in
         * and refresh (a `sessionChanged` event is raised each time), so a photo that changed
         * or was removed elsewhere shows up as a different value: fetch it again with
         * [FieldAuth.getPhoto].
         */
        photoVersion: string | null;
        /**
         * True only when photos are on for the platform and the client, the client lets a
         * worker set their own, and this session is the worker's own (not a supervisor or an
         * admin acting as them). Show the "change photo" control only then.
         */
        canSetOwnPhoto: boolean;
    };
    /** Non-null while someone else is acting as the worker. */
    actor: Actor | null;
    /** A test identity. */
    test: boolean;
    deviceMode: DeviceMode;
    /** Null on an unenrolled device. */
    deviceId: string | null;
    appCode: string;
    /** When the access token expires. */
    expiresAt: number;
    idleExpiresAt: number;
    refreshExpiresAt: number;
    pinChangeRequired: boolean;
}
export type SessionEndedReason = "logout" | "invalid_token" | (string & {});
export type FieldAuthEventType = "sessionChanged" | "pinChangeRequired" | "sessionEnded" | "locked";
export declare class FieldAuthEvent<T = unknown> extends Event {
    readonly detail: T;
    constructor(type: FieldAuthEventType, detail: T);
}
export interface LockedDetail {
    /** Seconds until the lock lifts; absent for a hard lock. */
    retryAfter?: number;
    hard: boolean;
}
export interface QrPayload {
    platformUrl: string;
    code: string;
}
/** Sign in by worker code (with PIN) or by badge (PIN unless the client allows badge-only). */
export type LoginCredentials = {
    workerCode: string;
    pin: string;
    badgeToken?: never;
    clientIdentifier?: string;
} | {
    badgeToken: string;
    pin?: string;
    workerCode?: never;
    clientIdentifier?: string;
};
export type ActAsTarget = {
    workerCode: string;
    workerId?: never;
    pin: string;
} | {
    workerId: string;
    workerCode?: never;
    pin: string;
};
/**
 * Normalises a scanned badge (or keyboard-wedge string, which usually ends
 * with Enter): drops whitespace and control characters, upper-cases.
 */
export declare function normaliseBadgeToken(scanned: string): string;
/**
 * Parses `fcfield:1:<platformBaseUrl>:<code>`; the code is the last segment.
 * An `http:` URL is refused unless its host is loopback or its origin is in
 * `allowedHttpOrigins` (default none).
 */
export declare function parseEnrolmentQr(payload: string, allowedHttpOrigins?: readonly string[]): QrPayload;
/** Which rendition of a worker's photo: `thumb` (128 px longest side) or `full` (512 px). */
export type PhotoSize = "thumb" | "full";
/** The signed-in worker's own photo as [FieldAuth.getPhoto] reads it. */
export interface WorkerPhoto {
    /** The JPEG; null when [notModified]. */
    bytes: Uint8Array | null;
    contentType: string | null;
    /** The photo's version (also `session.worker.photoVersion`); pass it as `haveVersion` next time. */
    version: string | null;
    /** True when the platform answered 304 to `haveVersion`: the bytes the device holds are current. */
    notModified: boolean;
}
/** A picture to upload: its bytes and, when known, its type (the platform decides from the bytes). */
export interface PhotoUpload {
    bytes: Uint8Array | Blob;
    /** `image/jpeg`, `image/png` or `image/webp`; absent sends `application/octet-stream`. */
    contentType?: string;
}
export declare class FieldAuth extends EventTarget {
    private readonly opts;
    private readonly fetchImpl;
    private readonly clock;
    private platformUrl;
    private device;
    private sessionState;
    private access;
    private refreshToken;
    private supervisor;
    private jwk;
    private loaded;
    private refreshing;
    private queue;
    private readonly nonces;
    constructor(opts: FieldAuthOptions);
    static parseEnrolmentQr(payload: string): QrPayload;
    parseEnrolmentQr(payload: string): QrPayload;
    /** The signed-in session (metadata restored from the store counts), or null. */
    get session(): Session | null;
    /** True while someone is acting as the signed-in worker (act-as or a sign-in code). */
    get impersonating(): boolean;
    /** The enrolled device, once [restore] or [enrol] has run. */
    get enrolledDevice(): DeviceRecord | null;
    private emit;
    /** Loads the enrolled device and session metadata from the store (once). */
    restore(): Promise<{
        device: DeviceRecord | null;
        session: Session | null;
    }>;
    private load;
    /** Fills the fields a session stored by an older version lacks. */
    private normaliseSession;
    /** Maps a provider failure to a [FieldAuthError] that carries only its code. */
    private store;
    /** An authenticated platform POST; one retry with a fresh access token on invalid_token. */
    private bearerPost;
    private requirePlatform;
    private publicKey;
    private getKey;
    private proof;
    /** Serialises platform calls so a single-use nonce is never shared. */
    private enqueue;
    private send;
    private primeNonce;
    /** One platform POST with nonce handling (prime, one retry on use_dpop_nonce). */
    private platformPost;
    /**
     * Enrols this device. `codeOrQr` is the 10-character code or a whole
     * `fcfield:1:` QR payload (which also sets the platform URL when none is configured;
     * with one configured, a QR for another origin not in `allowedPlatformOrigins` is refused).
     */
    enrol(codeOrQr: string, opts?: EnrolOptions): Promise<DeviceRecord>;
    /**
     * Signs a worker in by worker code or badge. Works without enrolment: the
     * key provider creates and keeps the signing key on first use. The PIN is
     * passed through: never stored, never logged.
     */
    login(creds: LoginCredentials): Promise<Session>;
    /**
     * Redeems a sign-in code an administrator created in the console. The
     * session is the worker's, with the admin as `actor`; no PIN is involved.
     */
    redeemSignInCode(code: string): Promise<Session>;
    /**
     * A supervisor acts as a worker on this device. The supervisor's own
     * session is kept aside and the active session becomes the worker's;
     * [endImpersonation] returns to it. The PIN is the supervisor's.
     */
    actAs(target: ActAsTarget): Promise<Session>;
    /**
     * Ends the impersonated session (logs out its family) and returns to the
     * supervisor's, refreshing it if its access token has lapsed. For a session
     * from a sign-in code there is nothing to return to: the session just ends
     * and this resolves null.
     */
    endImpersonation(): Promise<Session | null>;
    private supervisorToken;
    /** Makes the kept-aside supervisor session the active one. */
    private switchToSupervisor;
    private clearSupervisorStore;
    private clearSupervisor;
    private noteFailure;
    /** Biometric storage is for the signed-in worker's own enrolled PERSONAL session only. */
    private useBiometricStore;
    private persistSession;
    /** Stores a token response and publishes the new session. */
    private apply;
    /** Clears local session state and tells listeners. */
    private endSession;
    /** Rotates the refresh token. Concurrent callers share one request. */
    refresh(): Promise<Session>;
    private doRefresh;
    private ensureAccess;
    /**
     * Local biometric unlock: reads the stored refresh token (the host shows
     * the prompt), then refreshes. PERSONAL devices on a biometric store only.
     */
    unlock(): Promise<Session>;
    /** Changes the PIN, then refreshes (which drops a `pcr` token). */
    changePin(pins: {
        currentPin: string;
        newPin: string;
    }): Promise<Session>;
    /**
     * Reads the signed-in worker's own photo. `size` is `thumb` (the default) or `full`. Pass
     * `haveVersion` (the version of the bytes the device already holds, for example
     * `session.worker.photoVersion` when they were fetched for it): while it is still current the
     * answer has `notModified` true and no bytes. Returns null when the worker has no photo or
     * the client has photos off (the platform's 404 `PHOTO_NOT_FOUND`); throws `PHOTOS_DISABLED`
     * when the platform has them off, and `TOO_MANY_REQUESTS` (429, with `retryAfter`) when
     * the worker's hourly budget is spent. A supervisor acting as the worker may read it.
     */
    getPhoto(opts?: {
        size?: PhotoSize;
        haveVersion?: string | null;
    }): Promise<WorkerPhoto | null>;
    /**
     * Sets (or replaces) the signed-in worker's own photo from a picture's bytes (JPEG, PNG or WebP:
     * the platform decides the type from the bytes; `contentType` may only agree). The platform scales
     * it to 512 px and 128 px and keeps nothing else of the upload. Only when the client lets workers
     * set their own (`session.worker.canSetOwnPhoto`); otherwise `OWN_PHOTO_NOT_ALLOWED`. Refused as
     * `IMPERSONATING` while someone acts as the worker. The platform's other refusals come as their
     * codes: `PHOTO_EMPTY`, `PHOTO_TOO_LARGE`, `PHOTO_UNSUPPORTED_TYPE`, `PHOTO_TYPE_MISMATCH`,
     * `PHOTO_DIMENSIONS_TOO_LARGE`, `PHOTO_UNREADABLE`, `PHOTO_BUSY`, `PHOTOS_DISABLED_FOR_CLIENT`,
     * `PHOTOS_DISABLED`, and `TOO_MANY_REQUESTS` (a spent hourly budget, with `retryAfter`). Returns the session with the new
     * `worker.photoVersion` (and raises `sessionChanged`).
     */
    setPhoto(photo: PhotoUpload): Promise<Session>;
    /** Removes the signed-in worker's own photo (the same rule as setting it). Returns the session. */
    removePhoto(): Promise<Session>;
    private refuseWhenImpersonating;
    /** The session with a new photo version, stored and announced. */
    private withPhotoVersion;
    /** Ends the session (or every session on this device) and clears local state. */
    logout(opts?: {
        scope?: "session" | "device-all";
    }): Promise<void>;
    /**
     * `fetch` with `Authorization: DPoP <access>` and a DPoP proof. Refreshes
     * first when the access token expires within 30 s; retries once on
     * `use_dpop_nonce`; on `invalid_token` refreshes and retries once, and if
     * the answer is still `invalid_token` emits `sessionEnded`.
     */
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    /** A fresh random id, e.g. for idempotency keys. */
    static newId(): string;
}
//# sourceMappingURL=auth.d.ts.map