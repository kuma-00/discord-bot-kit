import { ApplicationCommandType, ContextMenuCommandBuilder } from "discord.js";
import { createCommandDefinition } from "../../../../src/index.ts";
import type { Services } from "../services.ts";
export default createCommandDefinition<Services>()({
    kind: "context-menu",
    id: "menu",
    builder: new ContextMenuCommandBuilder()
        .setName("menu")
        .setType(ApplicationCommandType.User),
    execute(_client, _interaction, { services }) {
        return services.record("menu");
    },
});
