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
