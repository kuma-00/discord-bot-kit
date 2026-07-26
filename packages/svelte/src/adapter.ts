import type {
    ObservableValue,
    RealtimeConnectionState,
    RealtimeController,
} from "@kuma-00/bot-kit-frontend";
import { type Readable, readable } from "svelte/store";

/** Converts a framework-neutral observable value to a Svelte readable store. */
export function toReadable<T>(observable: ObservableValue<T>): Readable<T> {
    return readable(observable.value, (set) => observable.subscribe(set));
}

/** Svelte stores backed by one reference-counted realtime controller. */
export interface RealtimeStores<TEvent> {
    readonly state: Readable<RealtimeConnectionState>;
    readonly event: Readable<TEvent | undefined>;
}

/** Starts realtime delivery with the first subscriber and stops after the last. */
export function createRealtimeStores<TEvent>(
    controller: Pick<
        RealtimeController<string, number, never>,
        "start" | "stop"
    > & {
        readonly state: ObservableValue<RealtimeConnectionState>;
        readonly lastEvent: ObservableValue<TEvent | undefined>;
    },
): RealtimeStores<TEvent> {
    let subscriptions = 0;
    const wrap = <T>(observable: ObservableValue<T>): Readable<T> =>
        readable(observable.value, (set) => {
            subscriptions += 1;
            if (subscriptions === 1) controller.start();
            const unsubscribe = observable.subscribe(set);
            return () => {
                unsubscribe();
                subscriptions -= 1;
                if (subscriptions === 0) controller.stop();
            };
        });
    return {
        state: wrap(controller.state),
        event: wrap(controller.lastEvent),
    };
}
