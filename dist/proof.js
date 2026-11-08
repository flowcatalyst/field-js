import { b64uEncode, randomId, utf8 } from "./encoding.js";
import { FieldProviderError } from "./errors.js";
function jsonB64u(v) {
    return b64uEncode(utf8(JSON.stringify(v)));
}
/** base64url(SHA-256(token)), the proof's `ath`. */
export async function accessTokenHash(token) {
    const d = await crypto.subtle.digest("SHA-256", utf8(token));
    return b64uEncode(new Uint8Array(d));
}
/** Builds a DPoP proof (RFC 9449 shape, ES256) signed through the key provider. */
export async function buildProof(keys, jwk, p) {
    const header = {
        typ: "dpop+jwt",
        alg: "ES256",
        jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    };
    const claims = {
        htm: p.htm,
        htu: p.htu,
        iat: p.iat,
        jti: randomId(16),
    };
    if (p.nonce)
        claims["nonce"] = p.nonce;
    if (p.accessToken)
        claims["ath"] = await accessTokenHash(p.accessToken);
    const input = `${jsonB64u(header)}.${jsonB64u(claims)}`;
    const sig = await keys.sign(utf8(input));
    if (sig.length !== 64) {
        throw new FieldProviderError("INTERNAL", "the key provider returned a malformed signature");
    }
    return `${input}.${b64uEncode(sig)}`;
}
/** RFC 7638 thumbprint of an EC P-256 public key. */
export async function jwkThumbprint(jwk) {
    const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
    const d = await crypto.subtle.digest("SHA-256", utf8(canonical));
    return b64uEncode(new Uint8Array(d));
}
