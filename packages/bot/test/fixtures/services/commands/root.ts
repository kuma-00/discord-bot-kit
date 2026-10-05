import { SlashCommandBuilder } from "discord.js";
import { createCommandDefinition } from "../../../../src/index.ts";
import type { Services } from "../services.ts";
export default createCommandDefinition<Services>()({
    kind: "chat-input",
    id: "root",
    builder: new SlashCommandBuilder().setName("root").setDescription("Root"),
    execute(_client, _interaction, { services, signal }) {
        if (!signal.aborted) return services.record("root");
    },
    autocomplete(_client, _interaction, { services }) {
        return services.record("autocomplete");
    },
});
