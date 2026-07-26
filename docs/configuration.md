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

## 定義と自動読み込み

`defineConfig`でschema、default、ファイル、environment bindingを再利用可能な定義へまとめられます。型はschemaから推論されるため、設定型を別に生成・管理する必要はありません。

```ts
import {
    defineConfig,
    type InferConfig,
    loadDefinedConfig,
} from "@kuma-00/bot-kit-config";

const applicationConfig = defineConfig({
    schema: applicationConfigSchema,
    defaults: {
        backend: { port: 3000 },
    },
    file: {
        path: "./config.yaml",
        create: true,
        template: {
            backend: { port: 3000 },
        },
    },
    bindings: [
        {
            env: "DISCORD_TOKEN",
            path: "bot.discord.token",
            secret: true,
        },
    ],
    onValidationError: "use-defaults",
});

type ApplicationConfig = InferConfig<typeof applicationConfig>;

const config: ApplicationConfig = await loadDefinedConfig(applicationConfig);
```

ファイルpathの既定値はcurrent working directoryの`config.yaml`です。`loadDefinedConfig`の第2引数に`file`を渡すと、定義側のpathを起動時に上書きできます。既存の`loadConfig`は自動ファイル操作を行わない低レベルAPIとして維持されます。

## テンプレート生成

対象ファイルが存在せず`file.create`が`true`または省略されている場合、`file.template`からYAMLを作成します。テンプレートはobjectまたはコメントを含められるYAML文字列で指定できます。作成は排他的に行われ、別processが先に作成したファイルを上書きしません。

`secret: true`のbinding先はテンプレートへ含められません。secretや必須値は環境変数または利用者が編集した設定ファイルから供給してください。値が不足してschema検証に失敗した場合、loaderは`ConfigError`で停止します。

## 検証失敗時のdefault

`onValidationError`の既定値は`"throw"`です。`"use-defaults"`では、schema issueが示すpathと同じpathにdefaultが存在する場合だけ、その項目をランタイム上でdefaultへ戻して再検証します。

- 設定ファイルは書き換えません。
- defaultがないissue、pathのないissue、不正なpath、再検証で解消しないissueは停止します。
- `__proto__`、`constructor`、`prototype`を含むenvironment binding pathは拒否されます。

`onDiagnostic`では`file-created`、`default-used`、`configuration-required`を受け取れます。loggerへ接続できますが、callback内でも設定object全体やsecret environment値を記録しないでください。

## エラーとsecret

`ConfigError`は失敗sourceを`file | yaml | environment | override | validation`で公開します。Environment parserの例外本文やsecretの実値を公開エラーメッセージへ含めません。Schema issueはpathとmessageを保持しますが、validator側もsecret値をmessageへ埋め込まない必要があります。

## 既存コードからの移行

明示的なYAML文字列や単発のfile pathを渡す用途では`loadConfig`をそのまま利用できます。自動探索やテンプレート生成が必要なentrypointだけを`defineConfig`と`loadDefinedConfig`へ移行してください。sourceの優先順位は両APIで同じです。
