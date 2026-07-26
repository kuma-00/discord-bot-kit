import type { BotEvent } from "./types.ts";

/** Preserves the concrete client and event types of a static event handler. */
export function defineEvent<const TEvent extends BotEvent>(
    event: TEvent,
): TEvent {
    return event;
}
