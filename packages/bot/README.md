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
import { Client, GatewayIntentBits } from "discord.js";
import { createGeneratedDiscordBot } from "./generated/bot.ts";

await createGeneratedDiscordBot({
    token: process.env.DISCORD_TOKEN!,
    clientOptions: { intents: [GatewayIntentBits.Guilds] },
    clientFactory: (options) => new Client(options),
}).start();
```

Registryからカテゴリ別のHelp Embedも生成できます。`metadata.hidden: true`のCommandと
Context Menu Commandは表示されません。説明は`metadata.description`が優先され、
未指定の場合はDiscord builderのdescriptionが使われます。

```ts
import { createHelpEmbeds } from "@kuma-00/bot-kit-bot";
import { botRegistry } from "./generated/bot.ts";

const embeds = createHelpEmbeds(botRegistry, {
    footer: {
        text: client.user?.username ?? "",
        iconURL: client.user?.displayAvatarURL(),
    },
});

for (const embed of embeds) {
    await interaction.followUp({ embeds: [embed] });
}
```
