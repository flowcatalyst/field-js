import { PushCore, } from "./push-core.js";
// Reader for the push stream (docs/contracts/push.md sections 6 and 7):
// subscribe with the caller's credentials, listen over SSE, keep the last id,
// reconnect and resume. The logic is in push-core.ts (no DOM, shared with
// field-react-native); this is the EventTarget face for web pages and WebViews.
export { DEFAULT_RETRY_MS, MAX_BACKOFF_MS, SseParser, topicMatches, } from "./push-core.js";
export class PushStreamEvent extends Event {
    constructor(type, detail) {
        super(type);
        this.detail = detail;
    }
}
export class PushStream extends EventTarget {
    constructor(opts) {
        super();
        this.core = new PushCore(opts, (type, detail) => {
            this.dispatchEvent(new PushStreamEvent(type, detail));
        });
    }
    /** The id of the last push delivered (or reset seen); persist it and pass it back after a restart. */
    get lastEventId() {
        return this.core.lastEventId;
    }
    get state() {
        return this.core.state;
    }
    get topics() {
        return this.core.topics;
    }
    /** Listens for pushes on a topic or pattern (`*` one segment, final `**` the rest). Returns an unsubscribe function. */
    on(pattern, fn) {
        return this.core.on(pattern, fn);
    }
    /** Listens for every push. Returns an unsubscribe function. */
    onAny(fn) {
        return this.core.onAny(fn);
    }
    start() {
        this.core.start();
    }
    stop() {
        this.core.stop();
    }
    /** Subscribes again with a new topic set; the last id is kept. */
    setTopics(topics) {
        this.core.setTopics(topics);
    }
}
