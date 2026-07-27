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
    SseSubscription,
    type TransportFailureDetails,
} from "@kuma-00/bot-kit-transport";

/** Observable state of a frontend realtime connection. */
export type RealtimeConnectionState = "idle" | "connecting" | "open" | "closed";

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

/** Framework-neutral controller for a standard EventSource subscription. */
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
    private readonly subscription: SseSubscription<
        TType,
        TVersion,
        TPayloadSchema
    >;

    constructor(options: {
        readonly url: string;
        readonly contract: EventContract<TType, TVersion, TPayloadSchema>;
        readonly fetch?: FetchLike;
        readonly headers?: Readonly<Record<string, string>>;
    }) {
        this.subscription = new SseSubscription({
            ...options,
            onEvent: (event) => this.lastEvent.set(event),
            onStateChange: (state) => this.state.set(state),
        });
    }

    /** Starts realtime delivery without requiring the caller to await closure. */
    start(): void {
        this.subscription.start();
    }

    /** Stops delivery and closes the EventSource synchronously. */
    stop(): void {
        this.subscription.stop();
    }
}
