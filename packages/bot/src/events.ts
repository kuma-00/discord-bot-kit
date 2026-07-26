import type { BotEvent } from "./types.ts";

export function defineEvent<const TEvent extends BotEvent>(
    event: TEvent,
): TEvent {
    return event;
}
