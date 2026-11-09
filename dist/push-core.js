// The push reader's logic, with no DOM: no EventTarget, no CustomEvent, and no TextDecoder unless the
// runtime has one. Events go out through the `emit` callback given to PushCore.
//
// This file is shared verbatim between @flowcatalyst/field-js (wrapped by push.ts, an EventTarget) and
// @flowcatalyst/field-react-native (wrapped by PushStream.ts, a listener map). It imports nothing so it
// can be copied as is. clients/field-react-native/tests/push-core-sync.test.ts fails when the copies differ:
// edit field-js's, then `cp` it over the other.
/** An error from the push reader. */
export class PushError extends Error {
    constructor(code, message, extra = {}) {
        super(message ?? code);
        this.name = "PushError";
        this.code = code;
        if (extra.status !== undefined)
            this.status = extra.status;
        if (extra.cause !== undefined)
            this.cause = extra.cause;
    }
}
export const DEFAULT_RETRY_MS = 3000;
export const MAX_BACKOFF_MS = 60000;
/** Incremental SSE parser: feed it text in any chunking. */
export class SseParser {
    constructor(onRetry = () => { }) {
        this.buf = "";
        this.started = false;
        this.data = [];
        this.event = "";
        this.onRetry = onRetry;
    }
    feed(text) {
        this.buf += text;
        if (!this.started && this.buf.length > 0) {
            this.started = true;
            if (this.buf.charCodeAt(0) === 0xfeff)
                this.buf = this.buf.slice(1);
        }
        const out = [];
        let pos = 0;
        for (;;) {
            let end = -1;
            let skip = 1;
            for (let i = pos; i < this.buf.length; i++) {
                const c = this.buf[i];
                if (c === "\n") {
                    end = i;
                    break;
                }
                if (c === "\r") {
                    // A trailing CR may be the first half of CRLF: wait for more.
                    if (i === this.buf.length - 1)
                        break;
                    end = i;
                    if (this.buf[i + 1] === "\n")
                        skip = 2;
                    break;
                }
            }
            if (end < 0)
                break;
            const m = this.line(this.buf.slice(pos, end));
            if (m)
                out.push(m);
            pos = end + skip;
        }
        this.buf = this.buf.slice(pos);
        return out;
    }
    line(line) {
        if (line === "") {
            const had = this.data.length > 0;
            const m = had ? { event: this.event || "message", data: this.data.join("\n"), id: this.id } : null;
            this.data = [];
            this.event = "";
            this.id = undefined;
            return m;
        }
        if (line.startsWith(":"))
            return null;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" "))
            value = value.slice(1);
        switch (field) {
            case "data":
                this.data.push(value);
                break;
            case "event":
                this.event = value;
                break;
            case "id":
                if (!value.includes("\0"))
                    this.id = value;
                break;
            case "retry":
                if (/^\d+$/.test(value))
                    this.onRetry(Number(value));
                break;
        }
        return null;
    }
}
/**
 * Streaming UTF-8 decoder for runtimes with no TextDecoder. Invalid bytes become U+FFFD, as TextDecoder
 * does (a lead byte with the continuation bytes seen so far is one U+FFFD); a sequence cut off by the end
 * of a chunk waits for the next one.
 */
export class Utf8StreamDecoder {
    constructor() {
        this.pending = new Uint8Array(0);
    }
    decode(chunk) {
        let b = chunk;
        if (this.pending.length > 0) {
            b = new Uint8Array(this.pending.length + chunk.length);
            b.set(this.pending, 0);
            b.set(chunk, this.pending.length);
            this.pending = new Uint8Array(0);
        }
        const n = b.length;
        let out = "";
        let i = 0;
        while (i < n) {
            const c = b[i] ?? 0;
            if (c < 0x80) {
                out += String.fromCharCode(c);
                i++;
                continue;
            }
            let need = 0;
            let cp = 0;
            let lo = 0x80;
            let hi = 0xbf;
            if (c >= 0xc2 && c <= 0xdf) {
                need = 1;
                cp = c & 0x1f;
            }
            else if (c >= 0xe0 && c <= 0xef) {
                need = 2;
                cp = c & 0x0f;
                if (c === 0xe0)
                    lo = 0xa0;
                if (c === 0xed)
                    hi = 0x9f;
            }
            else if (c >= 0xf0 && c <= 0xf4) {
                need = 3;
                cp = c & 0x07;
                if (c === 0xf0)
                    lo = 0x90;
                if (c === 0xf4)
                    hi = 0x8f;
            }
            else {
                out += "\ufffd";
                i++;
                continue;
            }
            let j = i + 1;
            let got = 0;
            let ok = true;
            for (; got < need && j < n; got++, j++) {
                const x = b[j] ?? 0;
                if (x < lo || x > hi) {
                    ok = false;
                    break;
                }
                lo = 0x80;
                hi = 0xbf;
                cp = (cp << 6) | (x & 0x3f);
            }
            if (!ok) {
                // The offending byte is looked at again as the start of whatever follows.
                out += "\ufffd";
                i = j;
                continue;
            }
            if (got < need) {
                this.pending = b.slice(i);
                break;
            }
            out += String.fromCodePoint(cp);
            i = j;
        }
        return out;
    }
}
/** TextDecoder when the runtime has one, else the built-in decoder. */
export function createUtf8Decoder() {
    const TD = globalThis.TextDecoder;
    if (!TD)
        return new Utf8StreamDecoder();
    const td = new TD();
    return { decode: (chunk) => td.decode(chunk, { stream: true }) };
}
// ── topic patterns ───────────────────────────────────────────────────
/**
 * Whether `pattern` matches `topic`. Segments split on `:`; `*` matches one
 * segment, a final `**` matches one or more. Anything else is literal.
 */
export function topicMatches(pattern, topic) {
    const p = pattern.split(":");
    const t = topic.split(":");
    for (let i = 0; i < p.length; i++) {
        const seg = p[i];
        if (seg === "**" && i === p.length - 1)
            return t.length > i;
        if (i >= t.length)
            return false;
        if (seg !== "*" && seg !== t[i])
            return false;
    }
    return p.length === t.length;
}
function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted)
            return reject(new Error("aborted"));
        const t = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function idGreater(a, b) {
    try {
        return BigInt(a) > BigInt(b);
    }
    catch {
        return false;
    }
}
export class PushCore {
    constructor(opts, emit) {
        this.handlers = new Set();
        this.token = null;
        this.retryMs = DEFAULT_RETRY_MS;
        this.failures = 0;
        this.expiryStreak = 0;
        this.useEventSource = false;
        this.gen = 0;
        this.ctl = null;
        this.current = "stopped";
        this.sink = emit;
        this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
        this.topicList = [...opts.topics];
        this.fetchImpl = opts.fetch;
        this.streamFetch = opts.streamFetch ?? ((...a) => globalThis.fetch(...a));
        this.getTickets = opts.getTickets;
        this.eventTypes = opts.eventTypes ?? [];
        this.eventSourceCtor =
            opts.eventSource ?? globalThis.EventSource;
        this.random = opts.random ?? Math.random;
        this.sleep = opts.sleep ?? defaultSleep;
        this.last = opts.lastEventId ?? "";
    }
    /** The id of the last push delivered (or reset seen); persist it and pass it back after a restart. */
    get lastEventId() {
        return this.last === "" ? undefined : this.last;
    }
    get state() {
        return this.current;
    }
    get topics() {
        return this.topicList;
    }
    /** Listens for pushes on a topic or pattern (`*` one segment, final `**` the rest). Returns an unsubscribe function. */
    on(pattern, fn) {
        const h = { pattern, fn };
        this.handlers.add(h);
        return () => this.handlers.delete(h);
    }
    /** Listens for every push. Returns an unsubscribe function. */
    onAny(fn) {
        const h = { pattern: null, fn };
        this.handlers.add(h);
        return () => this.handlers.delete(h);
    }
    start() {
        if (this.current !== "stopped")
            return;
        this.launch();
    }
    stop() {
        this.gen++;
        this.ctl?.abort();
        this.ctl = null;
        this.token = null;
        this.setState("stopped");
    }
    /** Subscribes again with a new topic set; the last id is kept. */
    setTopics(topics) {
        this.topicList = [...topics];
        if (this.current !== "stopped")
            this.launch();
    }
    launch() {
        this.gen++;
        this.ctl?.abort();
        this.token = null;
        this.failures = 0;
        this.expiryStreak = 0;
        const gen = this.gen;
        const ctl = new AbortController();
        this.ctl = ctl;
        this.setState("connecting");
        void this.run(gen, ctl);
    }
    emit(type, detail) {
        this.sink(type, detail);
    }
    setState(s) {
        if (s === this.current)
            return;
        this.current = s;
        this.emit("state", s);
    }
    fail(err) {
        this.emit("error", err instanceof PushError ? err : new PushError("NETWORK", String(err), { cause: err }));
    }
    // ── the loop ─────────────────────────────────────────────────────
    async run(gen, ctl) {
        const live = () => this.gen === gen && !ctl.signal.aborted;
        while (live()) {
            let wait = null; // null: reconnect after the server's retry
            try {
                if (this.token === null) {
                    this.setState("connecting");
                    await this.subscribe(ctl.signal);
                    if (!live())
                        return;
                }
                this.setState("connecting");
                const end = await this.listen(ctl, live);
                if (!live())
                    return;
                if (end === "auth-expired") {
                    this.token = null;
                    this.expiryStreak++;
                    if (this.expiryStreak > 1) {
                        this.failures = this.expiryStreak - 1;
                    }
                    else {
                        wait = 0;
                    }
                }
                else if (end === "token-invalid") {
                    this.token = null;
                    this.failures++;
                    if (this.failures <= 1)
                        wait = 0;
                }
                else if (end === "failed") {
                    this.failures++;
                }
            }
            catch (err) {
                if (!live())
                    return;
                this.failures++;
                this.fail(err);
                if (err instanceof PushError && err.code === "NO_TOPICS") {
                    this.stop();
                    return;
                }
            }
            if (!live())
                return;
            const ms = wait ?? this.backoff();
            this.setState("reconnecting");
            if (ms > 0) {
                try {
                    await this.sleep(ms, ctl.signal);
                }
                catch {
                    return;
                }
            }
        }
    }
    backoff() {
        const exp = this.retryMs * 2 ** Math.max(0, Math.min(this.failures - 1, 16));
        return Math.min(MAX_BACKOFF_MS, Math.round(exp * (0.5 + this.random())));
    }
    // ── subscribe ────────────────────────────────────────────────────
    async subscribe(signal) {
        const topics = [...this.topicList];
        const tickets = this.getTickets ? await this.getTickets(topics) : [];
        let res;
        try {
            res = await this.fetchImpl(`${this.baseUrl}/push/subscriptions`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ topics, tickets }),
                signal,
            });
        }
        catch (err) {
            throw new PushError("NETWORK", "subscribe failed", { cause: err });
        }
        if (!res.ok)
            throw await errorFrom(res);
        let body;
        try {
            body = (await res.json());
        }
        catch (err) {
            throw new PushError("BAD_RESPONSE", "subscribe answer is not JSON", { status: res.status, cause: err });
        }
        if (typeof body.streamToken !== "string" || body.streamToken === "") {
            throw new PushError("BAD_RESPONSE", "subscribe answer has no streamToken", { status: res.status });
        }
        this.token = body.streamToken;
        if (Array.isArray(body.denied) && body.denied.length > 0)
            this.emit("denied", body.denied);
    }
    // ── listen ───────────────────────────────────────────────────────
    streamUrl() {
        let url = `${this.baseUrl}/push/stream?st=${encodeURIComponent(this.token ?? "")}`;
        if (this.last !== "")
            url += `&lastEventId=${encodeURIComponent(this.last)}`;
        return url;
    }
    async listen(ctl, live) {
        if (this.useEventSource)
            return this.listenEventSource(ctl, live);
        const headers = { Accept: "text/event-stream" };
        if (this.last !== "")
            headers["Last-Event-ID"] = this.last;
        let res;
        try {
            res = await this.streamFetch(this.streamUrl(), { method: "GET", headers, signal: ctl.signal });
        }
        catch (err) {
            if (!live())
                return "ended";
            this.fail(new PushError("NETWORK", "stream request failed", { cause: err }));
            return "failed";
        }
        if (res.status === 401) {
            await res.body?.cancel().catch(() => { });
            return "token-invalid";
        }
        if (!res.ok) {
            const err = await errorFrom(res);
            this.fail(err);
            return "failed";
        }
        const reader = res.body?.getReader?.();
        if (!reader) {
            // Not streamable here: use EventSource from now on.
            await res.body?.cancel?.().catch(() => { });
            if (this.eventSourceCtor) {
                this.useEventSource = true;
                return this.listenEventSource(ctl, live);
            }
            this.fail(new PushError("NETWORK", "response bodies are not streamable and there is no EventSource"));
            return "failed";
        }
        const dec = createUtf8Decoder();
        const parser = new SseParser((ms) => {
            this.retryMs = ms;
        });
        let opened = false;
        let end = "ended";
        try {
            read: for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                for (const m of parser.feed(dec.decode(value))) {
                    if (!live())
                        return "ended";
                    const r = this.handle(m);
                    if (r === "subscribed")
                        opened = true;
                    if (r === "auth-expired") {
                        end = "auth-expired";
                        break read;
                    }
                }
            }
        }
        catch (err) {
            if (!live())
                return "ended";
            this.fail(new PushError("NETWORK", "stream read failed", { cause: err }));
            end = "failed";
        }
        finally {
            reader.cancel().catch(() => { });
        }
        if (end === "ended" && !opened)
            return "failed";
        return end;
    }
    listenEventSource(ctl, live) {
        const Ctor = this.eventSourceCtor;
        if (!Ctor)
            return Promise.resolve("failed");
        return new Promise((resolve) => {
            const es = new Ctor(this.streamUrl());
            let opened = false;
            const finish = (r) => {
                ctl.signal.removeEventListener("abort", onAbort);
                es.close();
                resolve(r);
            };
            const onAbort = () => finish("ended");
            ctl.signal.addEventListener("abort", onAbort, { once: true });
            const types = ["subscribed", "reset", "auth-expired", ...this.eventTypes];
            for (const type of types) {
                es.addEventListener(type, (e) => {
                    if (!live())
                        return finish("ended");
                    const r = this.handle({ event: type, data: e.data ?? "", id: e.lastEventId || undefined });
                    if (r === "subscribed")
                        opened = true;
                    if (r === "auth-expired")
                        finish("auth-expired");
                });
            }
            // EventSource cannot tell us the status: an error before `subscribed` means the token is bad.
            es.addEventListener("error", () => finish(opened ? "ended" : "token-invalid"));
        });
    }
    // ── one SSE message ──────────────────────────────────────────────
    handle(m) {
        switch (m.event) {
            case "subscribed": {
                const d = this.json(m);
                if (!d)
                    return null;
                this.failures = 0;
                this.setState("open");
                this.emit("subscribed", { granted: d.granted ?? [], latest: String(d.latest ?? "") });
                return "subscribed";
            }
            case "reset": {
                const d = this.json(m);
                if (!d)
                    return null;
                const latest = String(d.latest ?? m.id ?? "");
                // The reset id replaces ours, even when lower (unknown-id).
                if (latest !== "")
                    this.last = latest;
                this.emit("reset", { reason: d.reason ?? "", latest });
                return null;
            }
            case "auth-expired":
                return "auth-expired";
            default:
                this.push(m);
                return null;
        }
    }
    push(m) {
        if (m.id === undefined || m.id === "")
            return;
        // Resume overlap: an id we already delivered is dropped.
        if (this.last !== "" && !idGreater(m.id, this.last))
            return;
        const d = this.json(m);
        if (!d || typeof d.topic !== "string")
            return;
        this.last = m.id;
        this.expiryStreak = 0;
        const msg = { id: m.id, topic: d.topic, type: m.event, data: d.data };
        for (const h of [...this.handlers]) {
            if (h.pattern !== null && !topicMatches(h.pattern, msg.topic))
                continue;
            try {
                h.fn(msg);
            }
            catch (err) {
                this.emit("error", new PushError("HANDLER", "a push handler threw", { cause: err }));
            }
        }
    }
    json(m) {
        try {
            return JSON.parse(m.data);
        }
        catch (err) {
            this.emit("error", new PushError("BAD_RESPONSE", `bad ${m.event} event data`, { cause: err }));
            return null;
        }
    }
}
async function errorFrom(res) {
    let code;
    let message;
    try {
        // The framework answers {"error": "<CODE>", "message": "..."}; {"code": ...} and {"error": {"code": ...}} are read too.
        const b = (await res.json());
        const e = typeof b.error === "object" && b.error !== null ? b.error : undefined;
        const c = b.code ?? (typeof b.error === "string" ? b.error : e?.code);
        const msg = b.message ?? e?.message;
        if (typeof c === "string")
            code = c;
        if (typeof msg === "string")
            message = msg;
    }
    catch {
        // no JSON body
    }
    code ?? (code = res.status === 401 ? "UNAUTHORIZED" : res.status === 403 ? "NO_TOPICS" : res.status === 429 ? "PUSH_LIMIT" : res.status === 400 ? "VALIDATION" : `HTTP_${res.status}`);
    return new PushError(code, message ?? `${code} (HTTP ${res.status})`, { status: res.status });
}
