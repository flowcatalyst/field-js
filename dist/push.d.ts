import { type PushMessage, type PushStreamEventType, type PushStreamOptions, type PushStreamState } from "./push-core.js";
export { DEFAULT_RETRY_MS, MAX_BACKOFF_MS, SseParser, topicMatches, } from "./push-core.js";
export type { DeniedTopic, EventSourceLike, PushMessage, PushStreamEventType, PushStreamOptions, PushStreamState, ResetDetail, SseMessage, SubscribedDetail, } from "./push-core.js";
export declare class PushStreamEvent<T = unknown> extends Event {
    readonly detail: T;
    constructor(type: PushStreamEventType, detail: T);
}
type Handler = (push: PushMessage) => void;
export declare class PushStream extends EventTarget {
    private readonly core;
    constructor(opts: PushStreamOptions);
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
}
//# sourceMappingURL=push.d.ts.map