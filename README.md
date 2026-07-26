# discord-bot-kit

Discord Bot、Backend、Frontend間で再利用できるBun向けTypeScriptライブラリ群です。`nicobot-v6`の現在の設計を主な参考にしつつ、音楽再生、読み上げ、ゲーム、個別DBモデルなどのBot固有機能を持ち込まない基盤を提供します。

## Packages

| Package | Role |
| --- | --- |
| `@kuma-00/bot-kit-config` | YAML・環境変数・overrideの読み込みと検証 |
| `@kuma-00/bot-kit-contracts` | HTTP・イベントの実行時契約 |
| `@kuma-00/bot-kit-registry` | 静的module discoveryとreadonly registry生成 |
| `@kuma-00/bot-kit-transport` | 型付きFetch clientとSSE購読 |
| `@kuma-00/bot-kit-bot` | Discord.js Client、Command/Event Registry、lifecycle |
| `@kuma-00/bot-kit-voice` | Discord Voice接続、復旧、cleanup |
| `@kuma-00/bot-kit-backend` | framework-neutralなroute、認証、SSE broker |
| `@kuma-00/bot-kit-elysia` | Backend coreのElysia adapter |
| `@kuma-00/bot-kit-frontend` | UI非依存のAPI・realtime状態 |
| `@kuma-00/bot-kit-svelte` | Frontend状態のSvelte 5 store adapter |

正式対応runtimeはBunです。すべてESM・TypeScriptソースとしてJSRへ公開できる構成です。

## Development

```sh
bun install
bun run test
bun run check
bun run jsr:dry-run
```

`jsr:dry-run`は公開検証だけを実行し、JSRへパッケージを公開しません。

## AI Agent Skill

ライブラリを利用するBunプロジェクトで、パッケージ選択、実装、検証を支援するAgent Skillを提供しています。

```sh
npx skills add kuma-00/discord-bot-kit --skill use-discord-bot-kit
```

導入後は、`use-discord-bot-kit`スキルを指定して、利用したいBot、Backend、Frontend、HTTP、SSEなどの要件を伝えてください。スキルを更新する場合は、同じコマンドを再実行するか、Skills CLIの更新コマンドを使用します。

## Releases

`main`へ入ったConventional Commitをもとに、release-pleaseが全パッケージ共通のRelease PRを作成します。

- `fix:`はpatch versionを更新します。
- `feat:`はminor versionを更新します。
- `feat!:`または`BREAKING CHANGE:`はmajor versionを更新します。

Release PRをmergeすると、`vX.Y.Z`タグとGitHub Releaseを作成し、全パッケージをJSRへ公開します。公開に失敗した場合は、GitHub Actionsの`Release` workflowを手動実行して既存のタグを指定すると再試行できます。

## Documents

- [アーキテクチャ](docs/architecture.md)
- [パッケージ境界](docs/package-boundaries.md)
- [設定](docs/configuration.md)
- [通信](docs/communication.md)
- [Bot基盤](docs/bot-foundation.md)
- [Public API](docs/public-api.md)
- [初期設計ADR](docs/decisions/0001-initial-architecture.md)

## Status

現在はライブラリ、自動テスト、JSRへの自動公開を提供しています。既存Botの移植、Exampleアプリ、WebSocketは含みません。
