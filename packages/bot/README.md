# @kuma-00/bot-kit-bot

Bun向けのDiscord.js bot基盤です。型安全なCommand/Event定義、静的Registry生成、
interaction dispatch、timeout/abort、client lifecycleを提供します。

CommandとEventはそれぞれのファイルから`default export`します。

```ts
import { defineCommand } from "@kuma-00/bot-kit-bot";
import { SlashCommandBuilder } from "discord.js";

export default defineCommand({
    kind: "chat-input",
    id: "ping",
    builder: new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Replies with pong"),
    execute: async (_client, interaction) => {
        await interaction.followUp("pong");
    },
});
```

利用側の生成スクリプトから`generateBotRegistry`を呼び、生成されたfactoryで起動します。
生成処理だけがディレクトリを走査し、botの実行時には静的importだけが使われます。

```ts
import { generateBotRegistry } from "@kuma-00/bot-kit-bot/generator";

await generateBotRegistry({
    commandSourceDir: "src/commands",
    eventSourceDir: "src/events",
    outputPath: "src/generated/bot.ts",
});
```

```ts
import { GatewayIntentBits } from "discord.js";
import { createGeneratedDiscordBot } from "./generated/bot.ts";

await createGeneratedDiscordBot({
    token: process.env.DISCORD_TOKEN!,
    clientOptions: { intents: [GatewayIntentBits.Guilds] },
}).start();
```
