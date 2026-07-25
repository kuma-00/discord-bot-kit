# 設定

`@kuma-00/bot-kit-config`は設定値そのものを定義せず、複数sourceの統合とStandard Schema検証を提供します。

## 読み込み順

後のsourceが前のsourceを上書きします。

1. `defaults`
2. YAML文字列またはYAMLファイル
3. environment binding
4. 明示的な`override`

YAML文字列とファイルは同時に指定できません。Object同士は再帰的にmergeし、配列やprimitiveは後の値で置換します。

## 使用例

```ts
const config = await loadConfig({
    schema: applicationConfigSchema,
    defaults: { backend: { port: 3000 } },
    file: "./config/config.yml",
    environment: process.env,
    bindings: [
        {
            env: "DISCORD_TOKEN",
            path: "bot.discord.token",
            secret: true,
        },
        {
            env: "BACKEND_PORT",
            path: "backend.port",
            parse: Number,
        },
    ],
});
```

利用側はArkTypeなどStandard Schema互換validatorで最終形を検証します。ライブラリはBot固有の環境変数名や設定schemaを持ちません。

## エラーとsecret

`ConfigError`は失敗sourceを`file | yaml | environment | override | validation`で公開します。Environment parserの例外本文やsecretの実値を公開エラーメッセージへ含めません。Schema issueはpathとmessageを保持しますが、validator側もsecret値をmessageへ埋め込まない必要があります。
