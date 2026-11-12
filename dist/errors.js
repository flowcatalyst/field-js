export const PROVIDER_ERROR_CODES = [
    "KEY_INVALIDATED",
    "BIOMETRIC_UNAVAILABLE",
    "BIOMETRIC_CANCELLED",
    "NO_SECURE_LOCK_SCREEN",
    "INTERNAL",
];
export function isProviderErrorCode(v) {
    return (typeof v === "string" &&
        PROVIDER_ERROR_CODES.includes(v));
}
/** Thrown by key providers and secure stores. */
export class FieldProviderError extends Error {
    constructor(code, message) {
        super(message ?? code);
        this.name = "FieldProviderError";
        this.code = code;
    }
}
/**
 * True when the platform refused a PIN check (sign-in, impersonation) with 403 `PIN_RESET_REQUIRED`: the worker's
 * PIN was set under an app key that has since been removed. It is not a wrong PIN, so retrying cannot help; show
 * "ask your supervisor to reset your PIN". The device stays enrolled and no session is ended.
 */
export function isPinResetRequired(e) {
    return e instanceof FieldAuthError && e.code === "PIN_RESET_REQUIRED";
}
/**
 * An error from the library. Its message never contains a PIN or a refresh
 * token.
 */
export class FieldAuthError extends Error {
    constructor(code, message, extra = {}) {
        super(message ?? code);
        this.name = "FieldAuthError";
        this.code = code;
        if (extra.status !== undefined)
            this.status = extra.status;
        if (extra.retryAfter !== undefined)
            this.retryAfter = extra.retryAfter;
        if (extra.violations !== undefined)
            this.violations = extra.violations;
    }
}
// The push reader's error lives in push-core.ts (which imports nothing, so field-react-native can carry a verbatim copy).
export { PushError } from "./push-core.js";
