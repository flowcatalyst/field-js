export function b64uEncode(bytes) {
    let s = "";
    for (const b of bytes)
        s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64uDecode(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
export function utf8(s) {
    return new TextEncoder().encode(s);
}
export function randomId(bytes = 16) {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return b64uEncode(b);
}
