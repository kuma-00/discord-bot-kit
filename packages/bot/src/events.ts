import type { Client, ClientEvents } from "discord.js";
import type { BotEvent } from "./types.ts";

/** Defines event handlers whose execute callback receives a specific client type. */
export type EventDefinitionFactory<TClient extends Client> = <
    const TEvent extends keyof ClientEvents,
    const TDefinition extends BotEvent<TClient, TEvent>,
>(
    event: TDefinition,
) => TDefinition;

/**
 * Creates an event-definition helper bound to a Discord client subclass.
 *
 * @returns A helper that infers the selected Discord event and its argument tuple.
 */
export function createEventDefinition<
    TClient extends Client = Client,
>(): EventDefinitionFactory<TClient> {
    return <
        const TEvent extends keyof ClientEvents,
        const TDefinition extends BotEvent<TClient, TEvent>,
    >(
        event: TDefinition,
    ): TDefinition => event;
}

/** Defines an event handled by the standard Discord.js client. */
export const defineEvent: EventDefinitionFactory<Client> =
    createEventDefinition<Client>();
