import { createCommandDefinition } from "../../../../src/index.ts";
import type { Services } from "../services.ts";
export default createCommandDefinition<Services>()({
    kind: "subcommand",
    id: "sub",
    parentId: "root",
    builder: (b) => b.setName("sub").setDescription("Sub"),
    execute(_client, _interaction, { services }) {
        return services.record("sub");
    },
});
