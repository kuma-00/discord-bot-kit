import type {
    ApiResult,
    EventContract,
    EventEnvelope,
    HttpContract,
    SchemaOutput,
    StandardSchemaV1,
} from "@kuma-00/bot-kit-contracts";
import {
    type FetchLike,
    HttpClient,
    type HttpClientOptions,
    type RequestOptions,
    type SseConnectionFailure,
    type SseReconnectOptions,
    SseSubscription,
    type TransportFailureDetails,
} from "@kuma-00/bot-kit-transport";

/** Observable state of a frontend realtime connection. */
export type RealtimeConnectionState = "idle" | "connecting" | "open" | "closed";

/** Configuration for a framework-neutral realtime controller. */
export interface RealtimeControllerOptions<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    /** SSE endpoint URL. */
    readonly url: string;
    /** Contract used to validate every received event envelope. */
    readonly contract: EventContract<TType, TVersion, TPayloadSchema>;
    /** Fetch implementation used for every connection attempt. */
    readonly fetch?: FetchLike;
    /** Request headers merged with transport-owned SSE headers. */
    readonly headers?: Readonly<Record<string, string>>;
    /** Maps to Fetch credentials `include` when true and `same-origin` when false. */
    readonly withCredentials?: boolean;
    /** Reconnect policy, or false to disable automatic reconnects. */
    readonly reconnect?: false | SseReconnectOptions;
    /** Maximum number of characters buffered by the SSE parser. Defaults to 1048576. */
    readonly maxBufferSize?: number;
}

/** Authentication state independent of any UI framework. */
export type AuthenticationState<TUser> =
    | { readonly status: "unknown" }
    | { readonly status: "anonymous" }
    | { readonly status: "authenticated"; readonly user: TUser };

/** Minimal observable value used by frontend adapters. */
export class ObservableValue<T> {
    private readonly listeners = new Set<(value: T) => void>();

    constructor(private current: T) {}

    get value(): T {
        return this.current;
    }

    set(value: T): void {
        if (Object.is(value, this.current)) return;
        this.current = value;
        for (const listener of this.listeners) listener(value);
    }

    subscribe(listener: (value: T) => void): () => void {
        this.listeners.add(listener);
        listener(this.current);
        return () => this.listeners.delete(listener);
    }
}

/** Framework-neutral frontend client for HTTP contracts. */
export class FrontendApiClient {
    private readonly http: HttpClient;

    constructor(options: HttpClientOptions | HttpClient) {
        this.http =
            options instanceof HttpClient ? options : new HttpClient(options);
    }

    request<
        TInputSchema extends StandardSchemaV1,
        TOutputSchema extends StandardSchemaV1,
        TErrorSchema extends StandardSchemaV1,
    >(
        contract: HttpContract<TInputSchema, TOutputSchema, TErrorSchema>,
        input: SchemaOutput<TInputSchema>,
        options?: RequestOptions,
    ): Promise<
        ApiResult<
            SchemaOutput<TOutputSchema>,
            SchemaOutput<TErrorSchema> | TransportFailureDetails
        >
    > {
        return this.http.request(contract, input, options);
    }
}

/** Framework-neutral controller for a transport-owned SSE subscription. */
export class RealtimeController<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    readonly state: ObservableValue<RealtimeConnectionState> =
        new ObservableValue<RealtimeConnectionState>("idle");
    readonly lastEvent: ObservableValue<
        EventEnvelope<TType, SchemaOutput<TPayloadSchema>> | undefined
    > = new ObservableValue<
        EventEnvelope<TType, SchemaOutput<TPayloadSchema>> | undefined
    >(undefined);
    /** Latest classified connection failure, cleared on open or explicit stop. */
    readonly failure: ObservableValue<SseConnectionFailure | undefined> =
        new ObservableValue<SseConnectionFailure | undefined>(undefined);
    private readonly subscription: SseSubscription<
        TType,
        TVersion,
        TPayloadSchema
    >;
    private removeReconnectHints: (() => void) | undefined;

    constructor(
        options: RealtimeControllerOptions<TType, TVersion, TPayloadSchema>,
    ) {
        this.subscription = new SseSubscription({
            ...options,
            onEvent: (event) => this.lastEvent.set(event),
            onConnectionFailure: (failure) => this.failure.set(failure),
            onStateChange: (state) => {
                if (state === "open") this.failure.set(undefined);
                if (state === "closed") this.detachReconnectHints();
                this.state.set(state);
            },
        });
    }

    /** Starts realtime delivery without requiring the caller to await closure. */
    start(): void {
        if (this.state.value === "connecting" || this.state.value === "open") {
            return;
        }
        this.failure.set(undefined);
        this.attachReconnectHints();
        this.subscription.start();
    }

    /** Stops delivery and closes the current SSE request synchronously. */
    stop(): void {
        this.failure.set(undefined);
        this.subscription.stop();
    }

    /** Skips a currently pending reconnect delay. */
    retryNow(): void {
        this.subscription.retryNow();
    }

    private attachReconnectHints(): void {
        if (
            this.removeReconnectHints ||
            typeof window === "undefined" ||
            typeof document === "undefined"
        ) {
            return;
        }
        const retry = () => this.subscription.retryNow();
        const retryWhenVisible = () => {
            if (document.visibilityState === "visible") retry();
        };
        window.addEventListener("online", retry);
        document.addEventListener("visibilitychange", retryWhenVisible);
        this.removeReconnectHints = () => {
            window.removeEventListener("online", retry);
            document.removeEventListener("visibilitychange", retryWhenVisible);
            this.removeReconnectHints = undefined;
        };
    }

    private detachReconnectHints(): void {
        this.removeReconnectHints?.();
    }
}
