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
import type { FetchLike } from "./http.ts";
import { SseConnection } from "./sse-connection.ts";

/** Observable lifecycle states for an SSE connection. */
export type SseConnectionState = "connecting" | "open" | "closed";

/** Phase in which an SSE connection failure occurred. */
export type SseConnectionFailurePhase = "connect" | "response" | "stream";

interface SseFailureContext {
    readonly phase: SseConnectionFailurePhase;
    readonly attempt: number;
    readonly retrying: boolean;
    readonly retryInMs?: number;
}

/**
 * A classified SSE connection failure.
 *
 * Event payload validation and consumer callback failures are reported
 * separately through `onEventError`.
 */
export type SseConnectionFailure =
    | (SseFailureContext & {
          readonly kind: "network";
          readonly cause: unknown;
      })
    | (SseFailureContext & {
          readonly kind: "aborted";
          readonly cause: unknown;
      })
    | (SseFailureContext & {
          readonly kind: "eof";
      })
    | (SseFailureContext & {
          readonly kind: "http";
          readonly status: number;
      })
    | (SseFailureContext & {
          readonly kind: "invalid-response";
          readonly status: number;
          readonly reason: "content-type" | "missing-body" | "stream-format";
          readonly cause?: unknown;
      });

/** Client-controlled SSE reconnect policy. */
export interface SseReconnectOptions {
    /** Delay before the first reconnect attempt. Defaults to 3000 ms. */
    readonly initialDelayMs?: number;
    /** Maximum reconnect delay, including server hints. Defaults to 30000 ms. */
    readonly maxDelayMs?: number;
    /** Exponential multiplier applied after consecutive failures. Defaults to 2. */
    readonly multiplier?: number;
    /** Symmetric random jitter ratio from 0 to 1. Defaults to 0.2. */
    readonly jitterRatio?: number;
}

/** Configuration for a typed SSE subscription. */
export interface SseSubscriptionOptions<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    /** Absolute or relative SSE endpoint URL accepted by the configured fetch. */
    readonly url: string;
    /** Single event contract. Exactly one of `contract` and `contracts` is required. */
    readonly contract?: EventContract<TType, TVersion, TPayloadSchema>;
    /** Event registry. Exactly one of `contract` and `contracts` is required. */
    readonly contracts?: EventRegistry<TContracts>;
    /** Receives validated event envelopes in stream order. */
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
     * Observes connection state without delaying lifecycle work.
     * Synchronous throws and rejected promises are contained.
     */
    readonly onStateChange?: (
        state: SseConnectionState,
    ) => void | Promise<void>;
    /**
     * Receives classified connection failures and the selected reconnect action.
     * Synchronous throws and rejected promises are contained.
     */
    readonly onConnectionFailure?: (
        failure: SseConnectionFailure,
    ) => void | Promise<void>;
    /** Fetch implementation used for every connection attempt. */
    readonly fetch?: FetchLike;
    /** Request headers merged with transport-owned SSE headers. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Maps to Fetch credentials `include` when true and `same-origin` when false. */
    readonly withCredentials?: boolean;
    /** Reconnect policy, or false to close after the first connection failure. */
    readonly reconnect?: false | SseReconnectOptions;
    /** Maximum number of characters buffered by the SSE parser. Defaults to 1048576. */
    readonly maxBufferSize?: number;
}

/**
 * A typed SSE subscription with transport-owned parsing and reconnects.
 *
 * Delivery is serial. Connection failures are classified independently from
 * event JSON, contract validation, and consumer callback failures.
 */
export class SseSubscription<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
    TContracts extends readonly AnyEventContract[] = readonly [],
> {
    private readonly connection: SseConnection;
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

        const eventTypes = new Set<string>(["message"]);
        if (options.contract) {
            eventTypes.add(options.contract.type);
        } else {
            for (const contract of options.contracts?.contracts ?? []) {
                eventTypes.add(contract.type);
            }
        }

        this.connection = new SseConnection({
            url: options.url,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            ...(options.headers === undefined
                ? {}
                : { headers: options.headers }),
            ...(options.withCredentials === undefined
                ? {}
                : { withCredentials: options.withCredentials }),
            ...(options.reconnect === undefined
                ? {}
                : { reconnect: options.reconnect }),
            ...(options.maxBufferSize === undefined
                ? {}
                : { maxBufferSize: options.maxBufferSize }),
            eventTypes,
            onEvent: (event, lifecycle) => this.enqueueEvent(event, lifecycle),
            ...(options.onStateChange === undefined
                ? {}
                : { onStateChange: options.onStateChange }),
            ...(options.onConnectionFailure === undefined
                ? {}
                : { onConnectionFailure: options.onConnectionFailure }),
        });
    }

    /** EventSource-compatible ready state: 0 connecting, 1 open, or 2 closed. */
    get readyState(): number {
        return this.connection.readyState;
    }

    /** Starts delivery. Repeated calls while active are ignored. */
    start(): void {
        this.connection.start();
    }

    /** Stops delivery, cancels pending work, and transitions to closed. */
    stop(): void {
        this.connection.stop();
    }

    /** Immediately continues a currently pending reconnect delay. */
    retryNow(): void {
        this.connection.retryNow();
    }

    private enqueueEvent(event: MessageEvent, lifecycle: number): void {
        this.deliveryChain = this.deliveryChain
            .then(async () => {
                if (!this.connection.isLifecycleCurrent(lifecycle)) return;
                await this.handleEvent(event, lifecycle);
            })
            .catch(() => {
                // handleEvent contains consumer failures; keep the queue alive
                // if an unexpected internal failure escapes that boundary.
            });
    }

    private async handleEvent(
        event: MessageEvent,
        lifecycle: number,
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
            if (!this.connection.isLifecycleCurrent(lifecycle)) return;
            deliveryStarted = true;
            await this.options.onEvent(
                parsed as TContracts extends readonly []
                    ? EventEnvelope<TType, SchemaOutput<TPayloadSchema>>
                    : EventEnvelopeFor<TContracts[number]>,
            );
        } catch (error) {
            if (
                !deliveryStarted &&
                !this.connection.isLifecycleCurrent(lifecycle)
            ) {
                return;
            }
            try {
                await this.options.onEventError?.(error, event);
            } catch {
                // Consumer error observers cannot disrupt stream delivery.
            }
        }
    }
}
