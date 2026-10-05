import { type Client, Events } from "discord.js";
import { createEventDefinition } from "../../../../src/index.ts";
import type { Services } from "../services.ts";
export default createEventDefinition<Client, Services>()({
    id: "ready",
    event: Events.ClientReady,
    execute(_client, _args, { services }) {
        return services.record("event");
    },
});
