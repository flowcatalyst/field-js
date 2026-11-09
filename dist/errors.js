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
