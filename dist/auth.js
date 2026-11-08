import { b64uDecode, randomId } from "./encoding.js";
import { FieldAuthError, FieldProviderError, isProviderErrorCode, } from "./errors.js";
import { buildProof } from "./proof.js";
export const STORE_DEVICE = "fc.field.device";
export const STORE_REFRESH = "fc.field.refresh";
export const STORE_SESSION = "fc.field.session";
/** The supervisor's session metadata, kept aside while a worker is impersonated. */
export const STORE_SUPERVISOR = "fc.field.supervisor";
/** The supervisor's refresh token (biometric when the supervisor's session was). */
export const STORE_SUPERVISOR_REFRESH = "fc.field.supervisor.refresh";
/** Refresh first when the access token expires within this many ms. */
export const REFRESH_SKEW_MS = 30000;
export class FieldAuthEvent extends Event {
    constructor(type, detail) {
        super(type);
        this.detail = detail;
    }
}
/**
 * Normalises a scanned badge (or keyboard-wedge string, which usually ends
 * with Enter): drops whitespace and control characters, upper-cases.
 */
export function normaliseBadgeToken(scanned) {
    // eslint-disable-next-line no-control-regex
    return scanned.replace(/[\s\u0000-\u001f\u007f]+/g, "").toUpperCase();
}
const QR_PREFIX = "fcfield:1:";
/** Parses `fcfield:1:<platformBaseUrl>:<code>`; the code is the last segment. */
export function parseEnrolmentQr(payload) {
    const bad = () => new FieldAuthError("INVALID_ENROLMENT_CODE", "not a FlowCatalyst enrolment QR code");
    const p = payload.trim();
    if (!p.startsWith(QR_PREFIX))
        throw bad();
    const rest = p.slice(QR_PREFIX.length);
    const i = rest.lastIndexOf(":");
    if (i <= 0)
        throw bad();
    const platformUrl = rest.slice(0, i).replace(/\/+$/, "");
    const code = rest.slice(i + 1);
    if (!code || /\s/.test(code))
        throw bad();
    let u;
    try {
        u = new URL(platformUrl);
    }
    catch {
        throw bad();
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
        throw bad();
    return { platformUrl, code };
}
/** Reads (does not verify) the access token's claims; null when it is not a JWT. */
function decodeClaims(jwt) {
    const parts = jwt.split(".");
    const part = parts[1];
    if (parts.length !== 3 || !part)
        return null;
    try {
        const v = JSON.parse(new TextDecoder().decode(b64uDecode(part)));
        return v && typeof v === "object" ? v : null;
    }
    catch {
        return null;
    }
}
const NONCE_PATH = "/field/auth/nonce";
const SESSION_ENDING = new Set([
    "INVALID_GRANT",
    "SESSION_EXPIRED",
    "DEVICE_REVOKED",
    "DEVICE_SUSPENDED",
    "UNKNOWN_DEVICE",
    "NO_APP_ACCESS",
]);
function wwwAuth(res) {
    return res.headers.get("WWW-Authenticate") ?? "";
}
export class FieldAuth extends EventTarget {
    constructor(opts) {
        super();
        this.device = null;
        this.sessionState = null;
        this.access = null;
        this.refreshToken = null;
        this.supervisor = null;
        this.jwk = null;
        this.loaded = null;
        this.refreshing = null;
        this.queue = Promise.resolve();
        this.nonces = new Map();
        this.opts = opts;
        this.fetchImpl = opts.fetch ?? ((...a) => globalThis.fetch(...a));
        this.clock = opts.clock ?? (() => Date.now());
        this.platformUrl = opts.platformUrl ? opts.platformUrl.replace(/\/+$/, "") : null;
    }
    static parseEnrolmentQr(payload) {
        return parseEnrolmentQr(payload);
    }
    parseEnrolmentQr(payload) {
        return parseEnrolmentQr(payload);
    }
    /** The signed-in session (metadata restored from the store counts), or null. */
    get session() {
        return this.sessionState;
    }
    /** True while someone is acting as the signed-in worker (act-as or a sign-in code). */
    get impersonating() {
        return this.supervisor !== null || this.sessionState?.actor != null;
    }
    /** The enrolled device, once [restore] or [enrol] has run. */
    get enrolledDevice() {
        return this.device;
    }
    emit(type, detail) {
        this.dispatchEvent(new FieldAuthEvent(type, detail));
    }
    // ── state ────────────────────────────────────────────────────────────
    /** Loads the enrolled device and session metadata from the store (once). */
    restore() {
        this.loaded ?? (this.loaded = this.load());
        return this.loaded.then(() => ({ device: this.device, session: this.sessionState }));
    }
    async load() {
        const dev = await this.store("get", STORE_DEVICE);
        if (dev) {
            try {
                this.device = JSON.parse(dev);
                this.platformUrl ?? (this.platformUrl = this.device.platformUrl.replace(/\/+$/, ""));
            }
            catch {
                this.device = null;
            }
        }
        const ses = await this.store("get", STORE_SESSION);
        if (ses) {
            try {
                this.sessionState = this.normaliseSession(JSON.parse(ses));
            }
            catch {
                this.sessionState = null;
            }
        }
        const sup = await this.store("get", STORE_SUPERVISOR);
        if (sup && this.sessionState) {
            try {
                this.supervisor = {
                    session: this.normaliseSession(JSON.parse(sup)),
                    refreshToken: null,
                    access: null,
                };
            }
            catch {
                this.supervisor = null;
            }
        }
    }
    /** Fills the fields a session stored by an older version lacks. */
    normaliseSession(s) {
        return {
            ...s,
            actor: s.actor ?? null,
            test: s.test === true,
            deviceMode: s.deviceMode ?? this.device?.mode ?? "UNENROLLED",
            deviceId: s.deviceId ?? this.device?.deviceId ?? null,
        };
    }
    async store(op, key, a, bio) {
        try {
            if (op === "get") {
                return await this.opts.store.get(key, a ? { prompt: a } : undefined);
            }
            if (op === "set") {
                return await this.opts.store.set(key, a ?? "", bio ? { requireBiometric: true } : undefined);
            }
            return await this.opts.store.delete(key);
        }
        catch (e) {
            throw providerToAuthError(e);
        }
    }
    /** An authenticated platform POST; one retry with a fresh access token on invalid_token. */
    async bearerPost(path, body, secrets) {
        const call = async () => {
            const bearer = await this.ensureAccess();
            return this.platformPost(path, body, { bearer, secrets });
        };
        try {
            return await call();
        }
        catch (e) {
            if (!(e instanceof FieldAuthError && e.code === "invalid_token"))
                throw e;
            this.access = null;
            return call();
        }
    }
    requirePlatform() {
        if (!this.platformUrl) {
            throw new FieldAuthError("NOT_ENROLLED", "no platform URL: configure platformUrl or enrol this device first");
        }
        return this.platformUrl;
    }
    async publicKey() {
        const key = await this.getKey();
        this.jwk = key.jwk;
        return { jwk: key.jwk, key };
    }
    async getKey() {
        try {
            return await this.opts.keys.getOrCreateDeviceKey();
        }
        catch (e) {
            throw providerToAuthError(e);
        }
    }
    async proof(htm, htu, nonce, accessToken) {
        const jwk = this.jwk ?? (await this.publicKey()).jwk;
        try {
            return await buildProof(this.opts.keys, jwk, {
                htm,
                htu,
                nonce,
                accessToken,
                iat: Math.floor(this.clock() / 1000),
            });
        }
        catch (e) {
            throw providerToAuthError(e);
        }
    }
    // ── platform calls ───────────────────────────────────────────────────
    /** Serialises platform calls so a single-use nonce is never shared. */
    enqueue(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }
    async send(url, body, proof, accessToken) {
        const headers = {
            "Content-Type": "application/json",
            Accept: "application/json",
            DPoP: proof,
        };
        if (accessToken)
            headers["Authorization"] = `DPoP ${accessToken}`;
        let res;
        try {
            res = await this.fetchImpl(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body ?? {}),
            });
        }
        catch {
            // The original error is dropped on purpose: it may quote the request.
            throw new FieldAuthError("NETWORK", "the platform could not be reached");
        }
        const nonce = res.headers.get("DPoP-Nonce");
        if (nonce)
            this.nonces.set(new URL(url).origin, nonce);
        let json = null;
        try {
            const text = await res.text();
            if (text)
                json = JSON.parse(text);
        }
        catch {
            json = null;
        }
        return { status: res.status, headers: res.headers, json };
    }
    async primeNonce(base) {
        const url = base + NONCE_PATH;
        const reply = await this.send(url, {}, await this.proof("POST", url, undefined));
        if (reply.status >= 400)
            throw replyError(reply, []);
    }
    /** One platform POST with nonce handling (prime, one retry on use_dpop_nonce). */
    platformPost(path, body, opts = {}) {
        return this.enqueue(async () => {
            const base = this.requirePlatform();
            const url = base + path;
            const origin = new URL(url).origin;
            if (!this.nonces.get(origin))
                await this.primeNonce(base);
            for (let attempt = 0;; attempt++) {
                const proof = await this.proof("POST", url, this.nonces.get(origin), opts.bearer);
                const reply = await this.send(url, body, proof, opts.bearer);
                if (reply.status === 401 &&
                    reply.json?.["error"] === "use_dpop_nonce" &&
                    attempt === 0) {
                    continue;
                }
                if (reply.status >= 400)
                    throw replyError(reply, opts.secrets ?? []);
                return reply;
            }
        });
    }
    // ── enrolment ────────────────────────────────────────────────────────
    /**
     * Enrols this device. `codeOrQr` is the 10-character code or a whole
     * `fcfield:1:` QR payload (which also sets the platform URL).
     */
    async enrol(codeOrQr, opts = {}) {
        await this.restore();
        let code = codeOrQr.trim();
        if (code.startsWith(QR_PREFIX)) {
            const q = parseEnrolmentQr(code);
            this.platformUrl = q.platformUrl;
            code = q.code;
        }
        const base = this.requirePlatform();
        const { key } = await this.publicKey();
        const info = opts.deviceInfo ?? {};
        const nav = globalThis.navigator;
        const body = {
            code,
            publicKeyJwk: key.jwk,
            platform: (info.platform ?? "web").slice(0, 40),
            model: (info.model ?? nav?.userAgent ?? "unknown").slice(0, 120),
        };
        if (key.attestation.chain?.length)
            body["attestationChain"] = key.attestation.chain;
        if (opts.label)
            body["label"] = opts.label;
        const reply = await this.platformPost("/field/devices/enrol", body);
        const j = reply.json ?? {};
        const record = {
            deviceId: String(j["deviceId"] ?? ""),
            mode: j["mode"] === "SHARED" ? "SHARED" : "PERSONAL",
            clientId: String(j["clientId"] ?? ""),
            appCodes: Array.isArray(j["appCodes"]) ? j["appCodes"] : [],
            platformUrl: base,
        };
        this.device = record;
        await this.store("set", STORE_DEVICE, JSON.stringify(record));
        return record;
    }
    // ── sign in ──────────────────────────────────────────────────────────
    /**
     * Signs a worker in by worker code or badge. Works without enrolment: the
     * key provider creates and keeps the signing key on first use. The PIN is
     * passed through: never stored, never logged.
     */
    async login(creds) {
        await this.restore();
        const badge = creds.badgeToken === undefined ? "" : normaliseBadgeToken(creds.badgeToken);
        const hasCode = typeof creds.workerCode === "string" && creds.workerCode !== "";
        if (hasCode === (badge !== "")) {
            throw new FieldAuthError("INVALID_REQUEST", "give either a worker code or a badge token");
        }
        const clientIdentifier = creds.clientIdentifier ?? this.opts.clientIdentifier;
        if (!this.device && hasCode && !clientIdentifier) {
            throw new FieldAuthError("INVALID_REQUEST", "clientIdentifier is required to sign in by worker code on a device that is not enrolled");
        }
        const body = { appCode: this.opts.appCode };
        if (hasCode)
            body["workerCode"] = creds.workerCode;
        else
            body["badgeToken"] = badge;
        if (creds.pin !== undefined && creds.pin !== "")
            body["pin"] = creds.pin;
        if (clientIdentifier)
            body["clientIdentifier"] = clientIdentifier;
        try {
            const reply = await this.platformPost("/field/auth/login", body, {
                secrets: [creds.pin ?? "", badge],
            });
            await this.clearSupervisor();
            return await this.apply(reply.json);
        }
        catch (e) {
            throw this.noteFailure(e);
        }
    }
    /**
     * Redeems a sign-in code an administrator created in the console. The
     * session is the worker's, with the admin as `actor`; no PIN is involved.
     */
    async redeemSignInCode(code) {
        await this.restore();
        const c = normaliseBadgeToken(code);
        if (!c)
            throw new FieldAuthError("INVALID_REQUEST", "a sign-in code is required");
        try {
            const reply = await this.platformPost("/field/auth/sign-in-code", { code: c }, { secrets: [c] });
            await this.clearSupervisor();
            return await this.apply(reply.json, { impersonated: true });
        }
        catch (e) {
            throw this.noteFailure(e);
        }
    }
    /**
     * A supervisor acts as a worker on this device. The supervisor's own
     * session is kept aside and the active session becomes the worker's;
     * [endImpersonation] returns to it. The PIN is the supervisor's.
     */
    async actAs(target) {
        await this.restore();
        if (this.impersonating) {
            throw new FieldAuthError("IMPERSONATING", "end the current impersonation first");
        }
        const hasCode = typeof target.workerCode === "string" && target.workerCode !== "";
        const hasId = typeof target.workerId === "string" && target.workerId !== "";
        if (hasCode === hasId) {
            throw new FieldAuthError("INVALID_REQUEST", "give either a worker code or a worker id");
        }
        const body = { pin: target.pin };
        if (hasCode)
            body["workerCode"] = target.workerCode;
        else
            body["workerId"] = target.workerId;
        let reply;
        try {
            reply = await this.bearerPost("/field/auth/act-as", body, [target.pin]);
        }
        catch (e) {
            throw this.noteFailure(e);
        }
        const before = this.sessionState;
        if (!before || !this.refreshToken) {
            throw new FieldAuthError("SESSION_EXPIRED", "there is no session");
        }
        // Keep the supervisor aside (its refresh token behind biometrics when it was) before the swap.
        const bio = await this.useBiometricStore();
        const sup = { session: before, refreshToken: this.refreshToken, access: this.access };
        await this.store("set", STORE_SUPERVISOR_REFRESH, sup.refreshToken ?? "", bio);
        await this.store("set", STORE_SUPERVISOR, JSON.stringify(before));
        this.supervisor = sup;
        return this.apply(reply.json, { impersonated: true });
    }
    /**
     * Ends the impersonated session (logs out its family) and returns to the
     * supervisor's, refreshing it if its access token has lapsed. For a session
     * from a sign-in code there is nothing to return to: the session just ends
     * and this resolves null.
     */
    async endImpersonation() {
        await this.restore();
        if (!this.impersonating) {
            throw new FieldAuthError("NOT_IMPERSONATING", "no one is being impersonated");
        }
        const sup = this.supervisor;
        if (sup)
            await this.supervisorToken(sup); // fail before anything is torn down
        let token = this.refreshToken;
        if (!token) {
            try {
                token = await this.store("get", STORE_REFRESH, this.opts.unlockPrompt);
            }
            catch {
                token = null;
            }
        }
        let failure = null;
        if (token) {
            try {
                await this.platformPost("/field/auth/logout", { refreshToken: token, scope: "session" }, { secrets: [token] });
            }
            catch (e) {
                failure = e;
            }
        }
        if (!sup) {
            await this.endSession("logout");
            if (failure)
                throw failure;
            return null;
        }
        await this.switchToSupervisor(sup, "logout");
        if (!this.access || this.access.expiresAt - this.clock() < REFRESH_SKEW_MS) {
            await this.refresh();
        }
        if (failure)
            throw failure;
        return this.sessionState;
    }
    async supervisorToken(sup) {
        if (sup.refreshToken)
            return sup.refreshToken;
        const t = await this.store("get", STORE_SUPERVISOR_REFRESH, this.opts.unlockPrompt);
        if (!t)
            throw new FieldAuthError("SESSION_EXPIRED", "the supervisor session is gone");
        sup.refreshToken = t;
        return t;
    }
    /** Makes the kept-aside supervisor session the active one. */
    async switchToSupervisor(sup, reason) {
        const refreshToken = await this.supervisorToken(sup);
        this.supervisor = null;
        this.access = sup.access;
        this.refreshToken = refreshToken;
        this.sessionState = sup.session;
        await this.persistSession(sup.session, refreshToken);
        await this.clearSupervisorStore();
        this.emit("sessionEnded", { reason });
        this.emit("sessionChanged", sup.session);
    }
    async clearSupervisorStore() {
        try {
            await this.opts.store.delete(STORE_SUPERVISOR);
            await this.opts.store.delete(STORE_SUPERVISOR_REFRESH);
        }
        catch {
            // best effort
        }
    }
    async clearSupervisor() {
        this.supervisor = null;
        await this.clearSupervisorStore();
    }
    noteFailure(e) {
        if (e instanceof FieldAuthError) {
            if (e.code === "WORKER_LOCKED") {
                this.emit("locked", { hard: true });
            }
            else if (e.code === "WORKER_LOCKED_TEMPORARILY" || e.code === "TOO_MANY_ATTEMPTS") {
                const d = { hard: false };
                if (e.retryAfter !== undefined)
                    d.retryAfter = e.retryAfter;
                this.emit("locked", d);
            }
        }
        return e;
    }
    /** Biometric storage is for the signed-in worker's own enrolled PERSONAL session only. */
    async useBiometricStore(session = this.sessionState) {
        if (!this.opts.biometricUnlock || this.device?.mode !== "PERSONAL")
            return false;
        if (!session || session.deviceMode !== "PERSONAL" || session.actor !== null)
            return false;
        try {
            return await this.opts.store.biometricAvailable();
        }
        catch {
            return false;
        }
    }
    async persistSession(session, refreshToken) {
        await this.store("set", STORE_REFRESH, refreshToken, await this.useBiometricStore(session));
        await this.store("set", STORE_SESSION, JSON.stringify(session));
    }
    /** Stores a token response and publishes the new session. */
    async apply(t, opts = {}) {
        const now = this.clock();
        const prevApp = this.sessionState?.appCode;
        const claims = decodeClaims(t.accessToken);
        const act = claims?.act;
        const actor = act && typeof act.sub === "string"
            ? {
                id: act.sub,
                type: typeof act.typ === "string" ? act.typ : "field_worker",
                name: typeof act.name === "string" ? act.name : "",
            }
            : null;
        const mode = claims?.device_mode;
        const deviceMode = mode === "PERSONAL" || mode === "SHARED" || mode === "UNENROLLED"
            ? mode
            : (this.device?.mode ?? "UNENROLLED");
        let deviceId;
        if (typeof claims?.device_id === "string")
            deviceId = claims.device_id;
        else if (claims)
            deviceId = null;
        else
            deviceId = this.device?.deviceId ?? null;
        const session = {
            worker: { id: t.worker.id, workerCode: t.worker.workerCode, name: t.worker.name },
            actor,
            test: claims?.test === true,
            deviceMode,
            deviceId,
            appCode: prevApp ?? this.opts.appCode,
            expiresAt: now + t.expiresIn * 1000,
            idleExpiresAt: Date.parse(t.idleExpiresAt),
            refreshExpiresAt: Date.parse(t.refreshExpiresAt),
            pinChangeRequired: t.pinChangeRequired === true,
        };
        const impersonated = opts.impersonated === true || this.supervisor !== null || actor !== null;
        this.access = { token: t.accessToken, expiresAt: session.expiresAt };
        this.refreshToken = t.refreshToken;
        this.sessionState = session;
        // An impersonated session is never kept behind biometrics.
        const bio = !impersonated && (await this.useBiometricStore(session));
        await this.store("set", STORE_REFRESH, t.refreshToken, bio);
        await this.store("set", STORE_SESSION, JSON.stringify(session));
        this.emit("sessionChanged", session);
        if (session.pinChangeRequired)
            this.emit("pinChangeRequired", session);
        return session;
    }
    /** Clears local session state and tells listeners. */
    async endSession(reason) {
        this.access = null;
        this.refreshToken = null;
        this.sessionState = null;
        this.supervisor = null;
        try {
            await this.opts.store.delete(STORE_REFRESH);
            await this.opts.store.delete(STORE_SESSION);
        }
        catch {
            // best effort: the in-memory state is already gone
        }
        await this.clearSupervisorStore();
        this.emit("sessionEnded", { reason });
        this.emit("sessionChanged", null);
    }
    // ── refresh ──────────────────────────────────────────────────────────
    /** Rotates the refresh token. Concurrent callers share one request. */
    refresh() {
        this.refreshing ?? (this.refreshing = this.doRefresh().finally(() => {
            this.refreshing = null;
        }));
        return this.refreshing;
    }
    async doRefresh() {
        await this.restore();
        let token = this.refreshToken;
        if (!token) {
            try {
                token = await this.store("get", STORE_REFRESH, this.opts.unlockPrompt);
            }
            catch (e) {
                if (e instanceof FieldAuthError && e.code === "KEY_INVALIDATED") {
                    await this.endSession("BIOMETRIC_INVALIDATED");
                    throw new FieldAuthError("BIOMETRIC_INVALIDATED", "the biometric key was invalidated; sign in with the PIN");
                }
                throw e;
            }
        }
        if (!token) {
            await this.endSession("SESSION_EXPIRED");
            throw new FieldAuthError("SESSION_EXPIRED", "there is no session to refresh");
        }
        try {
            const reply = await this.platformPost("/field/auth/refresh", { refreshToken: token }, { secrets: [token] });
            return await this.apply(reply.json);
        }
        catch (e) {
            if (e instanceof FieldAuthError && SESSION_ENDING.has(String(e.code))) {
                // An impersonation that ends on its own hands back to the supervisor.
                if (this.supervisor)
                    await this.switchToSupervisor(this.supervisor, String(e.code));
                else
                    await this.endSession(String(e.code));
            }
            throw e;
        }
    }
    async ensureAccess() {
        if (!this.access || this.access.expiresAt - this.clock() < REFRESH_SKEW_MS) {
            await this.refresh();
        }
        const a = this.access;
        if (!a)
            throw new FieldAuthError("SESSION_EXPIRED", "there is no session");
        return a.token;
    }
    // ── biometric unlock ─────────────────────────────────────────────────
    /**
     * Local biometric unlock: reads the stored refresh token (the host shows
     * the prompt), then refreshes. PERSONAL devices on a biometric store only.
     */
    async unlock() {
        await this.restore();
        const dev = this.device;
        let available = false;
        try {
            available = await this.opts.store.biometricAvailable();
        }
        catch {
            available = false;
        }
        // Enrolled PERSONAL sessions of the worker themselves only: never unenrolled, never impersonated.
        const sess = this.sessionState;
        if (!dev ||
            dev.mode !== "PERSONAL" ||
            !available ||
            this.impersonating ||
            (sess !== null && sess.deviceMode !== "PERSONAL")) {
            throw new FieldAuthError("BIOMETRIC_UNAVAILABLE", "biometric unlock is not available on this device");
        }
        let token;
        try {
            token = await this.opts.store.get(STORE_REFRESH, {
                prompt: this.opts.unlockPrompt ?? "Unlock",
            });
        }
        catch (e) {
            if (e instanceof FieldProviderError && e.code === "KEY_INVALIDATED") {
                await this.endSession("BIOMETRIC_INVALIDATED");
                throw new FieldAuthError("BIOMETRIC_INVALIDATED", "the biometric key was invalidated; sign in with the PIN");
            }
            throw providerToAuthError(e);
        }
        if (!token) {
            throw new FieldAuthError("SESSION_EXPIRED", "there is no stored session to unlock");
        }
        this.refreshToken = token;
        return this.refresh();
    }
    // ── PIN change, logout ───────────────────────────────────────────────
    /** Changes the PIN, then refreshes (which drops a `pcr` token). */
    async changePin(pins) {
        await this.restore();
        if (this.impersonating) {
            throw new FieldAuthError("IMPERSONATING", "the PIN cannot be changed while impersonating");
        }
        try {
            await this.bearerPost("/field/auth/pin", { currentPin: pins.currentPin, newPin: pins.newPin }, [pins.currentPin, pins.newPin]);
        }
        catch (e) {
            throw this.noteFailure(e);
        }
        return this.refresh();
    }
    /** Ends the session (or every session on this device) and clears local state. */
    async logout(opts = {}) {
        await this.restore();
        const scope = opts.scope ?? "session";
        if (scope === "device-all" && !this.device) {
            throw new FieldAuthError("INVALID_REQUEST", "device-all needs an enrolled device");
        }
        const sup = this.supervisor;
        let token = this.refreshToken;
        if (!token) {
            try {
                token = await this.store("get", STORE_REFRESH, this.opts.unlockPrompt);
            }
            catch {
                token = null;
            }
        }
        let failure = null;
        if (token) {
            try {
                await this.platformPost("/field/auth/logout", { refreshToken: token, scope }, { secrets: [token] });
            }
            catch (e) {
                failure = e;
            }
        }
        // Signing out while impersonating also ends the supervisor's session.
        if (sup) {
            try {
                const st = await this.supervisorToken(sup);
                await this.platformPost("/field/auth/logout", { refreshToken: st, scope: "session" }, { secrets: [st] });
            }
            catch {
                // best effort: the supervisor's local state is cleared below either way
            }
        }
        await this.endSession("logout");
        if (failure)
            throw failure;
    }
    // ── authenticated fetch for application backends ─────────────────────
    /**
     * `fetch` with `Authorization: DPoP <access>` and a DPoP proof. Refreshes
     * first when the access token expires within 30 s; retries once on
     * `use_dpop_nonce`; on `invalid_token` refreshes and retries once, and if
     * the answer is still `invalid_token` emits `sessionEnded`.
     */
    async fetch(input, init) {
        await this.restore();
        let refreshed = false;
        if (!this.access || this.access.expiresAt - this.clock() < REFRESH_SKEW_MS) {
            await this.refresh();
            refreshed = true;
        }
        const isReq = typeof Request !== "undefined" && input instanceof Request;
        const raw = isReq ? input.url : String(input);
        const loc = globalThis.location;
        const target = new URL(raw, loc?.href);
        const htu = target.origin + target.pathname;
        const htm = (init?.method ?? (isReq ? input.method : "GET")).toUpperCase();
        let nonceRetried = false;
        let refreshRetried = false;
        for (;;) {
            const token = this.access?.token;
            if (!token)
                throw new FieldAuthError("SESSION_EXPIRED", "there is no session");
            const proof = await this.proof(htm, htu, this.nonces.get(target.origin), token);
            const headers = new Headers(isReq ? input.headers : undefined);
            new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
            headers.set("Authorization", `DPoP ${token}`);
            headers.set("DPoP", proof);
            let res;
            try {
                res = await this.fetchImpl(isReq ? input.clone() : input, {
                    ...init,
                    headers,
                });
            }
            catch (e) {
                if (e instanceof FieldAuthError)
                    throw e;
                throw new FieldAuthError("NETWORK", "the request could not be sent");
            }
            const n = res.headers.get("DPoP-Nonce");
            if (n)
                this.nonces.set(target.origin, n);
            if (res.status === 401) {
                const www = wwwAuth(res);
                if (/use_dpop_nonce/.test(www) && !nonceRetried) {
                    nonceRetried = true;
                    await drain(res);
                    continue;
                }
                if (/invalid_token/.test(www)) {
                    if (!refreshed && !refreshRetried) {
                        refreshRetried = true;
                        await drain(res);
                        await this.refresh();
                        refreshed = true;
                        continue;
                    }
                    this.emit("sessionEnded", { reason: "invalid_token" });
                }
            }
            return res;
        }
    }
    // ── helpers exposed for the app ──────────────────────────────────────
    /** A fresh random id, e.g. for idempotency keys. */
    static newId() {
        return randomId(12);
    }
}
async function drain(res) {
    try {
        await res.arrayBuffer();
    }
    catch {
        // ignore
    }
}
function redact(s, secrets) {
    let out = s;
    for (const x of secrets)
        if (x && x.length >= 4)
            out = out.split(x).join("***");
    return out;
}
function replyError(r, secrets) {
    const j = r.json ?? {};
    const code = typeof j["error"] === "string" ? j["error"] : `HTTP_${r.status}`;
    const message = redact(typeof j["message"] === "string" ? j["message"] : code, secrets);
    const extra = { status: r.status };
    const ra = Number.parseInt(r.headers.get("Retry-After") ?? "", 10);
    if (Number.isFinite(ra))
        extra.retryAfter = ra;
    if (Array.isArray(j["violations"]))
        extra.violations = j["violations"].map(String);
    return new FieldAuthError(code, message, extra);
}
function providerToAuthError(e) {
    if (e instanceof FieldAuthError)
        return e;
    const code = e?.code;
    if (isProviderErrorCode(code))
        return new FieldAuthError(code, `secure storage failed: ${code}`);
    return new FieldAuthError("INTERNAL", "secure storage failed");
}
