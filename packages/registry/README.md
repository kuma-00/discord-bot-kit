# @kuma-00/bot-kit-registry

Bun用の汎用静的Registry generatorです。指定ディレクトリのTypeScript moduleを
生成時に検証し、決定的な順序のstatic importとreadonly配列を生成します。

```ts
import { generateStaticRegistry } from "@kuma-00/bot-kit-registry";

await generateStaticRegistry({
    sourceDir: "src/games",
    outputPath: "src/generated/minigames.ts",
    exportName: "minigameRegistry",
    moduleExport: "minigame",
    validate: (value) => typeof value === "function",
});
```

生成物のMap化、重複管理、lifecycleは利用側の責務です。

複数種類のmoduleを1つの生成物へまとめる場合は、group APIを使用します。

```ts
import {
    defineStaticRegistryGroupConfig,
    generateStaticRegistryGroup,
} from "@kuma-00/bot-kit-registry";

const config = defineStaticRegistryGroupConfig({
    outputPath: "src/generated/registries.ts",
    registries: [
        {
            sourceDir: "src/message-responses",
            exportName: "messageResponses",
            validate: (value) =>
                typeof value === "object" &&
                value !== null &&
                "execute" in value,
        },
        {
            sourceDir: "src/minigames",
            exportName: "minigames",
        },
    ],
});

const result = await generateStaticRegistryGroup(config);
console.log(result.entryCounts);
```

各sourceは設定順、各source内のmoduleはpath順で出力されます。生成時だけconsumerの
moduleをdynamic importし、生成物にはstatic importとreadonly配列だけを含めます。
IDの正規化、Map化、重複policy、domain lifecycleは利用側で実装します。
