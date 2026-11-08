import type { KeyProvider, PublicEcJwk } from "./types.js";
export interface ProofInput {
    htm: string;
    /** The request URL without query or fragment. */
    htu: string;
    nonce?: string | undefined;
    /** The access token the proof is bound to (adds `ath`). */
    accessToken?: string | undefined;
    /** Seconds since the epoch. */
    iat: number;
}
/** base64url(SHA-256(token)), the proof's `ath`. */
export declare function accessTokenHash(token: string): Promise<string>;
/** Builds a DPoP proof (RFC 9449 shape, ES256) signed through the key provider. */
export declare function buildProof(keys: KeyProvider, jwk: PublicEcJwk, p: ProofInput): Promise<string>;
/** RFC 7638 thumbprint of an EC P-256 public key. */
export declare function jwkThumbprint(jwk: PublicEcJwk): Promise<string>;
//# sourceMappingURL=proof.d.ts.map