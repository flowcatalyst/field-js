/** Codes of a failed push subscribe (docs/contracts/push.md section 6.1), plus the library's own. */
export type PushErrorCode = "NO_TOPICS" | "PUSH_LIMIT" | "VALIDATION" | "UNAUTHORIZED" | "STREAM_TOKEN_INVALID" | "STREAM_TOKEN_EXPIRED" | "NETWORK" | "BAD_RESPONSE" | "HANDLER" | (string & {});
/** An error from the push reader. */
export declare class PushError extends Error {
    readonly code: PushErrorCode;
    /** HTTP status when the host answered. */
    readonly status?: number;
    readonly cause?: unknown;
    constructor(code: PushErrorCode, message?: string, extra?: {
        status?: number;
        cause?: unknown;
    });
}
/** One push, as delivered to handlers. `id` is the log id (64-bit, so a string). */
export interface PushMessage {
    id: string;
    topic: string;
    type: string;
    data: unknown;
}
export type PushStreamState = "connecting" | "open" | "reconnecting" | "stopped";
export type PushStreamEventType = "subscribed" | "reset" | "denied" | "error" | "state";
export interface SubscribedDetail {
    granted: string[];
    latest: string;
}
export interface ResetDetail {
    reason: "retention" | "unknown-id" | (string & {});
    latest: string;
}
export interface DeniedTopic {
    topic: string;
    code: string;
}
export interface PushStreamOptions {
    /** The host's base URL; `/push/subscriptions` and `/push/stream` hang off it. */
    baseUrl: string;
    topics: string[];
    /** Used for the subscribe call: `auth.fetch.bind(auth)` in a field app, `globalThis.fetch` on a web page. */
    fetch: typeof fetch;
    /** Used for the stream GET (the token is the capability). Default: `globalThis.fetch`. */
    streamFetch?: typeof fetch;
    /** Mints tickets for the topics, from the application's own endpoint. */
    getTickets?: (topics: string[]) => Promise<string[]>;
    /** Resume from this id, e.g. one persisted before a restart. */
    lastEventId?: string;
    /** Needed only for the EventSource fallback: EventSource cannot listen to unnamed event types. */
    eventTypes?: string[];
    /** Constructor used when response bodies are not streamable. Default: `globalThis.EventSource`. */
    eventSource?: new (url: string) => EventSourceLike;
    /** Jitter source, in [0, 1). */
    random?: () => number;
    /** Waits `ms`; rejects when `signal` aborts. */
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
/** The part of EventSource the fallback uses. */
export interface EventSourceLike {
    addEventListener(type: string, listener: (e: {
        data?: string;
        lastEventId?: string;
    }) => void): void;
    close(): void;
}
export declare const DEFAULT_RETRY_MS = 3000;
export declare const MAX_BACKOFF_MS = 60000;
type Handler = (push: PushMessage) => void;
export interface SseMessage {
    event: string;
    data: string;
    id: string | undefined;
}
/** Incremental SSE parser: feed it text in any chunking. */
export declare class SseParser {
    private buf;
    private started;
    private data;
    private event;
    private id;
    private readonly onRetry;
    constructor(onRetry?: (ms: number) => void);
    feed(text: string): SseMessage[];
    private line;
}
/** Decodes a byte stream to text; a character split across chunks is held until it is complete. */
export interface Utf8Decoder {
    decode(chunk: Uint8Array): string;
}
/**
 * Streaming UTF-8 decoder for runtimes with no TextDecoder. Invalid bytes become U+FFFD, as TextDecoder
 * does (a lead byte with the continuation bytes seen so far is one U+FFFD); a sequence cut off by the end
 * of a chunk waits for the next one.
 */
export declare class Utf8StreamDecoder implements Utf8Decoder {
    private pending;
    decode(chunk: Uint8Array): string;
}
/** TextDecoder when the runtime has one, else the built-in decoder. */
export declare function createUtf8Decoder(): Utf8Decoder;
/**
 * Whether `pattern` matches `topic`. Segments split on `:`; `*` matches one
 * segment, a final `**` matches one or more. Anything else is literal.
 */
export declare function topicMatches(pattern: string, topic: string): boolean;
/** Where PushCore sends its events: `subscribed`, `reset`, `denied`, `error` and `state`. */
export type PushEmit = (type: PushStreamEventType, detail: unknown) => void;
export declare class PushCore {
    private readonly baseUrl;
    private topicList;
    private readonly fetchImpl;
    private readonly streamFetch;
    private readonly getTickets;
    private readonly eventTypes;
    private readonly eventSourceCtor;
    private readonly random;
    private readonly sleep;
    private readonly handlers;
    private last;
    private token;
    private retryMs;
    private failures;
    private expiryStreak;
    private useEventSource;
    private gen;
    private ctl;
    private current;
    private readonly sink;
    constructor(opts: PushStreamOptions, emit: PushEmit);
    /** The id of the last push delivered (or reset seen); persist it and pass it back after a restart. */
    get lastEventId(): string | undefined;
    get state(): PushStreamState;
    get topics(): readonly string[];
    /** Listens for pushes on a topic or pattern (`*` one segment, final `**` the rest). Returns an unsubscribe function. */
    on(pattern: string, fn: Handler): () => void;
    /** Listens for every push. Returns an unsubscribe function. */
    onAny(fn: Handler): () => void;
    start(): void;
    stop(): void;
    /** Subscribes again with a new topic set; the last id is kept. */
    setTopics(topics: string[]): void;
    private launch;
    private emit;
    private setState;
    private fail;
    private run;
    private backoff;
    private subscribe;
    private streamUrl;
    private listen;
    private listenEventSource;
    private handle;
    private push;
    private json;
}
export {};
//# sourceMappingURL=push-core.d.ts.map