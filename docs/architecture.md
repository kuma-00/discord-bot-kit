# アーキテクチャ

## 目的

Discord Bot、Backend、Frontendに繰り返し現れる技術的な仕組みを、Bot固有の機能から分離して再利用可能にします。`nicobot-v6`を主な仕様参考とし、`gbot-v8Engine`と`botbase`は共通化候補を確認する補助資料として扱います。

## レイヤー

```text
config        contracts
                 ↑
              transport
              ↗      ↖
            bot     frontend ← svelte

backend ← elysia
   ↑
contracts
```

- Core packageはframeworkやUIへ依存しません。
- Adapter packageは対応するcoreだけを外部frameworkへ接続します。
- Bot、Backend、Frontendは互いの実装を直接importしません。
- HTTPとSSEのデータ境界では必ずruntime schemaを使用します。

## 共通化する責務

- 設定sourceの統合と検証
- HTTP・イベント契約
- timeout、abort、API key、SSE再接続
- Discord Clientのlifecycleと静的Registry
- framework-neutralなroute実行、認証、エラー変換
- FrontendのAPI結果とrealtime状態
- Elysia、Svelteへの薄いadapter

## 利用側に残す責務

- 音楽再生、Queue、Playlist、MIDI
- Voicevoxなどの読み上げ
- ゲーム、BCDice、メッセージ応答
- DB製品ごとのschema・query・migration
- Discord OAuthの具体的なsession実装
- Bot固有のCommand、Event、Frontend UI

## Runtimeと公開

Bunのみを正式対応します。Coreでは`Request`、`Response`、`ReadableStream`、FetchなどのWeb標準APIを優先します。公開packageは`@kuma-00/bot-kit-*`、versionはv0.1.0時点ですべて同期します。
