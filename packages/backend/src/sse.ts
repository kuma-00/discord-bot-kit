/** Message accepted by the in-memory SSE event broker. */
export interface BrokerEvent {
    readonly id: string;
    readonly type?: string;
    readonly data: unknown;
    readonly retry?: number;
}

function encodeSse(event: BrokerEvent): Uint8Array {
    const lines = [
        `id: ${event.id}`,
        ...(event.type ? [`event: ${event.type}`] : []),
        ...(event.retry === undefined ? [] : [`retry: ${event.retry}`]),
        ...JSON.stringify(event.data)
            .split("\n")
            .map((line) => `data: ${line}`),
        "",
        "",
    ];
    return new TextEncoder().encode(lines.join("\n"));
}

/** In-memory fan-out broker suitable for one backend process. */
export class SseEventBroker {
    private readonly subscribers = new Set<
        ReadableStreamDefaultController<Uint8Array>
    >();

    /** Publishes an event to all active subscribers. */
    publish(event: BrokerEvent): void {
        const encoded = encodeSse(event);
        for (const subscriber of this.subscribers) {
            try {
                subscriber.enqueue(encoded);
            } catch {
                this.subscribers.delete(subscriber);
            }
        }
    }

    /** Opens an SSE response and removes it when the request is aborted. */
    response(signal?: AbortSignal): Response {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
            start: (value) => {
                controller = value;
                this.subscribers.add(value);
            },
            cancel: () => {
                if (controller) this.subscribers.delete(controller);
            },
        });
        const close = () => {
            if (!controller) return;
            this.subscribers.delete(controller);
            try {
                controller.close();
            } catch {
                // The consumer may already have cancelled the stream.
            }
        };
        signal?.addEventListener("abort", close, { once: true });
        return new Response(stream, {
            headers: {
                "cache-control": "no-cache",
                connection: "keep-alive",
                "content-type": "text/event-stream; charset=utf-8",
            },
        });
    }
}
