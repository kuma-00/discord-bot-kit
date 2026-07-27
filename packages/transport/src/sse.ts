import {
    type AnyEventContract,
    type EventContract,
    type EventEnvelope,
    type EventEnvelopeFor,
    type EventRegistry,
    parseEventEnvelope,
    type SchemaOutput,
    type StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";
import { EventSource, type FetchLike as EventSourceFetch } from "eventsource";
import type { FetchLike } from "./http.ts";

/** Standard EventSource connection states. */
export type SseConnectionState = "connecting" | "open" | "closed";

/** Configuration for a typed EventSource subscription. */
export interface SseSubscriptionOptions<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    readonly url: string;
    readonly contract?: EventContract<TType, TVersion, TPayloadSchema>;
    readonly contracts?: EventRegistry<TContracts>;
    readonly onEvent: (
        event: TContracts extends readonly []
            ? EventEnvelope<TType, SchemaOutput<TPayloadSchema>>
            : EventEnvelopeFor<TContracts[number]>,
    ) => void | Promise<void>;
    /** Receives JSON, contract, or event-handler failures without closing the connection. */
    readonly onEventError?: (
        error: unknown,
        event: MessageEvent,
    ) => void | Promise<void>;
    /**
     * Observes connection state without delaying EventSource lifecycle work.
     * Synchronous throws and rejected promises are contained.
     */
    readonly onStateChange?: (
        state: SseConnectionState,
    ) => void | Promise<void>;
    readonly fetch?: FetchLike;
    readonly headers?: Readonly<Record<string, string>>;
    readonly withCredentials?: boolean;
}

/**
 * A typed wrapper around the standard EventSource API.
 *
 * EventSource owns parsing, reconnects, retry directives, Last-Event-ID, and
 * connection validation. This wrapper only validates JSON event envelopes.
 */
export class SseSubscription<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    private source: EventSource | undefined;
    private state: SseConnectionState = "closed";
    private lifecycleVersion = 0;
    private deliveryChain: Promise<void> = Promise.resolve();

    constructor(
        private readonly options: SseSubscriptionOptions<
            TType,
            TVersion,
            TPayloadSchema,
            TContracts
        >,
    ) {
        if (
            (options.contract === undefined) ===
            (options.contracts === undefined)
        ) {
            throw new TypeError(
                "SseSubscription requires exactly one of contract or contracts",
            );
        }
    }

    /** The underlying EventSource readyState. */
    get readyState(): number {
        return this.source?.readyState ?? EventSource.CLOSED;
    }

    /** Opens the EventSource connection. Repeated calls while active are ignored. */
    start(): void {
        if (this.source && this.source.readyState !== EventSource.CLOSED)
            return;

        const lifecycleVersion = ++this.lifecycleVersion;
        this.emitState("connecting");
        if (lifecycleVersion !== this.lifecycleVersion) return;

        const fetch = this.createFetch();
        let source: EventSource;
        try {
            source = new EventSource(this.options.url, {
                ...(this.options.withCredentials === undefined
                    ? {}
                    : { withCredentials: this.options.withCredentials }),
                ...(fetch === undefined ? {} : { fetch }),
            });
        } catch (error) {
            if (lifecycleVersion === this.lifecycleVersion)
                this.emitState("closed");
            throw error;
        }
        if (lifecycleVersion !== this.lifecycleVersion) {
            source.close();
            return;
        }
        this.source = source;

        source.addEventListener("open", (event) => {
            if ("data" in event) return;
            if (this.source === source) this.emitState("open");
        });
        source.addEventListener("error", (event) => {
            if ("data" in event) return;
            if (this.source !== source) return;
            this.emitState(
                source.readyState === EventSource.CLOSED
                    ? "closed"
                    : "connecting",
            );
        });

        const eventTypes = new Set<string>(["message"]);
        if (this.options.contract) {
            eventTypes.add(this.options.contract.type);
        } else {
            for (const contract of this.options.contracts?.contracts ?? []) {
                eventTypes.add(contract.type);
            }
        }
        for (const eventType of eventTypes) {
            source.addEventListener(eventType, (event) => {
                if (!("data" in event)) return;
                this.enqueueEvent(event, source, lifecycleVersion);
            });
        }
    }

    /** Closes the EventSource connection synchronously. */
    stop(): void {
        this.lifecycleVersion++;
        this.source?.close();
        this.source = undefined;
        this.emitState("closed");
    }

    private createFetch(): EventSourceFetch | undefined {
        const fetchImplementation = this.options.fetch;
        const headers = this.options.headers;
        if (!fetchImplementation && !headers) return undefined;

        return async (input, init) => {
            const requestHeaders = new Headers(headers);
            for (const [name, value] of Object.entries(init.headers)) {
                requestHeaders.set(name, value);
            }
            return (fetchImplementation ?? globalThis.fetch)(input, {
                ...init,
                headers: requestHeaders,
                signal: init.signal as AbortSignal,
            });
        };
    }

    private enqueueEvent(
        event: MessageEvent,
        source: EventSource,
        lifecycleVersion: number,
    ): void {
        this.deliveryChain = this.deliveryChain
            .then(async () => {
                if (
                    this.source !== source ||
                    this.lifecycleVersion !== lifecycleVersion
                )
                    return;
                await this.handleEvent(event, source, lifecycleVersion);
            })
            .catch(() => {
                // handleEvent contains consumer failures; keep the queue alive
                // if an unexpected internal failure escapes that boundary.
            });
    }

    private async handleEvent(
        event: MessageEvent,
        source: EventSource,
        lifecycleVersion: number,
    ): Promise<void> {
        let deliveryStarted = false;
        try {
            const raw = JSON.parse(String(event.data)) as unknown;
            const parsed = this.options.contracts
                ? await this.options.contracts.parse(raw)
                : await parseEventEnvelope(
                      this.options.contract as EventContract<
                          TType,
                          TVersion,
                          TPayloadSchema
                      >,
                      raw,
                  );
            if (
                this.source !== source ||
                this.lifecycleVersion !== lifecycleVersion
            )
                return;
            deliveryStarted = true;
            await this.options.onEvent(
                parsed as TContracts extends readonly []
                    ? EventEnvelope<TType, SchemaOutput<TPayloadSchema>>
                    : EventEnvelopeFor<TContracts[number]>,
            );
        } catch (error) {
            if (
                !deliveryStarted &&
                (this.source !== source ||
                    this.lifecycleVersion !== lifecycleVersion)
            )
                return;
            try {
                await this.options.onEventError?.(error, event);
            } catch {
                // EventSource listeners cannot observe rejected promises.
            }
        }
    }

    private emitState(state: SseConnectionState): void {
        if (state === this.state) return;
        this.state = state;
        const onStateChange = this.options.onStateChange;
        if (!onStateChange) return;
        try {
            void Promise.resolve(onStateChange(state)).catch(() => {
                // EventSource listeners cannot observe rejected promises.
            });
        } catch {
            // State observers must not disrupt connection lifecycle.
        }
    }
}
