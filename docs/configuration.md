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

## バージョンと自動移行

`version`と`migrations`を指定すると、トップレベルの整数`version`でYAMLを管理できます。versionがない既存YAMLはv1として扱い、1段階ずつ最新版へ移行します。移行対象はYAMLだけで、defaults、environment binding、overrideは現行形式のsourceとして移行後に統合されます。

```ts
const applicationConfig = defineConfig({
    schema: applicationConfigSchema,
    version: 3,
    migrations: [
        { from: 1, to: 2, migrate: renameLegacyField },
        { from: 2, to: 3, migrate: addBackendSettings },
    ],
});
```

各migrationはobjectを返す同期または非同期関数です。`from`から`to`は必ず1ずつ増やし、v1から現行版まで欠落や重複のない経路を定義します。ローダーが各段階の`version`を書き換えるため、migration関数自身でversionを管理する必要はありません。現行版より新しい設定、不正なversion、経路の欠落、migrationの失敗は`ConfigError`になります。

YAML文字列はメモリ上だけ移行します。ファイルは、移行後の全sourceを統合して現行schemaの検証に成功してから書き換えます。元ファイルは`config.yaml.v1.bak`のような名前で残し、同名のbackupがあれば別名を使います。backupと置換後のファイルは元ファイルのpermission modeを維持します。指定pathがsymlinkの場合は解決した実ファイルを移行するため、symlink自体は維持され、backupも実ファイルの隣に作成されます。

同じ実ファイルに対する並行移行は、実ファイルに隣接する`.migration.lock`リースで排他します。異なるsymlinkから同じ実ファイルを参照しても同じlockを使い、競合したloaderは元ファイルを書き換えず`ConfigError`で停止します。lockは処理中にheartbeatを更新し、異常終了で残った更新の古いlockは後続の移行が回収します。

外部processによるsymlinkの付け替え、実ファイルの差し替え、内容変更も置換直前に再確認し、検出した場合は上書きしません。ただし、このlockを利用しない外部processが最終確認後に書き込むことまでは排他できません。最新版は実ファイルと同じdirectoryの一時ファイルから原子的に置換されます。再生成したYAMLではコメントや元の書式が失われますが、原文はbackupから復元できます。成功時は`file-migrated` diagnosticで移行元・移行先・指定pathを通知します。

## 検証失敗時のdefault

`onValidationError`の既定値は`"throw"`です。`"use-defaults"`では、schema issueが示すpathと同じpathにdefaultが存在する場合だけ、その項目をランタイム上でdefaultへ戻して再検証します。

- 設定ファイルは書き換えません。
- defaultがないissue、pathのないissue、不正なpath、再検証で解消しないissueは停止します。
- `__proto__`、`constructor`、`prototype`を含むenvironment binding pathは拒否されます。

`onDiagnostic`では`file-created`、`file-migrated`、`default-used`、`configuration-required`を受け取れます。loggerへ接続できますが、callback内でも設定object全体やsecret environment値を記録しないでください。

## エラーとsecret

`ConfigError`は失敗sourceを`file | yaml | environment | override | validation`で公開します。Environment parserの例外本文やsecretの実値を公開エラーメッセージへ含めません。Schema issueはpathとmessageを保持しますが、validator側もsecret値をmessageへ埋め込まない必要があります。

### `toConfigDiagnostics`

起動境界では`toConfigDiagnostics(error)`を使うと、任意のthrow値をlogger非依存のJSON化可能なdiagnosticへ変換できます。

```ts
try {
    await loadDefinedConfig(applicationConfig);
} catch (error) {
    logger.error(toConfigDiagnostics(error), "Configuration loading failed");
    throw error;
}
```

`ConfigError`は`kind: "config-error"`、安定した`code`、`source`、安全な`message`、任意の`path`、`issues`、`cause`を返します。未知のthrow値は`kind: "unknown-error"`、`code: "unknown"`、`message: "Unknown configuration error"`、空の`issues`、`cause: "unknown"`になります。raw cause・stack・設定値・environment値は含まれません。

`secret: true`のbinding pathは`loadConfig`/`loadDefinedConfig`が`ConfigError` metadataへ引き継ぎます。validation issueのpathがsecret pathと祖先・子孫関係を含めて重なる場合、messageは`Invalid secret configuration value`に置換され、`redacted: true`が付きます。利用側でsecret path一覧を別管理せず、diagnosticをそのままloggerへ渡してください。

## 既存コードからの移行

明示的なYAML文字列や単発のfile pathを渡す用途では`loadConfig`をそのまま利用できます。自動探索やテンプレート生成が必要なentrypointだけを`defineConfig`と`loadDefinedConfig`へ移行してください。sourceの優先順位は両APIで同じです。
