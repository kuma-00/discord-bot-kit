# Bot基盤

`@kuma-00/bot-kit-bot`はDiscord.js Clientの生成、静的Registry、interaction
dispatch、実行制御、lifecycleを提供します。

## Command

CommandはChat Input、Subcommand、Subcommand Group、User/Message Context Menuの
判別Unionです。Guild限定Commandでは`guild`と`guildId`が存在するinteraction型を
handlerへ渡します。

各モジュールはCommandを`default export`します。Subcommandは`parentId`と任意の
`groupId`を宣言し、Registryが親builderへの追加と実行経路を自動合成します。
カテゴリなどの表示情報は任意metadataであり、bot-kitは固定値を持ちません。

`createHelpEmbeds`はRegistry内のChat Input Command、Subcommand、Subcommand Groupを
`metadata.category`ごとにまとめたHelp Embed群を生成します。各項目は親Commandと
Subcommand Groupを含む完全な呼び出しパスで表示されます。
`metadata.hidden: true`とContext Menu Commandは除外されます。表示する説明は
`metadata.description`を優先し、未指定時はDiscord builderのdescriptionを使います。
タイトル、本文、footer、timestamp、未分類カテゴリ名はoptionsで変更できます。
Discord Embedのフィールド数・フィールド長・合計文字数の上限を超える内容は、
フィールドまたは複数Embedへ定義順のまま分割されます。単一項目や表示設定が個別の
文字数上限を超える場合は末尾を省略します。Discordの合計文字数上限はメッセージ単位
なので、返されたEmbedは1件ずつ別のメッセージとして送信します。

## 静的Registry生成

利用側の生成スクリプトから`generateBotRegistry`を呼びます。generatorは
`@kuma-00/bot-kit-registry`の汎用静的Registry生成を利用して、指定された
Command/Eventディレクトリをソートして走査し、静的importだけを含むTypeScriptを
生成します。`.test.ts`、`.spec.ts`、`.d.ts`は除外されます。

生成物は次をexportします。

- `botRegistry`: 検証済みCommand/Event Registry
- `applicationCommands`: Discord RESTへ渡せる合成済みJSON
- `createGeneratedDiscordBot`: Registry注入済みbot factory

生成物はコミットし、CIでは`checkBotRegistry`で更新漏れを検出します。実行時の
directory scanやdynamic importは行いません。

## Interactionと実行制御

- Chat Input、Context Menu、AutocompleteをルートIDからO(1)で探索します。
- 未登録、種類不一致、handler不在、Guild限定違反は理由付き`DispatchResult`を返します。
- defer、ephemeral、timeoutはbot既定またはCommand単位で明示した場合だけ有効です。
- timeout有効時はhandlerへ`AbortSignal`を渡します。
- handler例外は注入可能なerror boundaryへ渡し、bot-kit自身は返信内容を決めません。
- `CommandDispatcher`単体利用でerror boundaryを省略した場合、handler例外は
  `dispatch()`から再throwします。`DiscordBot`は常に内部boundaryを設定します。

`defineCommand`は判別Unionを直接定義するlow-level APIです。単純なtop-level
chat-input commandには`defineGlobalCommand`と`defineGuildCommand`も使用でき、
`execute`は`{ client, interaction, signal, services }`のobject引数を受け取ります。

## Lifecycle

`start`は同時呼び出しを単一loginへまとめます。`stop`は登録したlistenerを解除し、
実行中処理をabortしてsettleを待ち、最後にclientをdestroyします。同じDiscord eventに
複数handlerを登録でき、handler IDだけが一意である必要があります。

Discord.jsの`Client`を継承した利用側Clientでは
`createEventDefinition<TClient>()`でEvent定義helperを作成します。Event名から
`ClientEvents`の引数tupleを推論し、同じClient型を`BotRegistry<TClient>`、
runtime handler、生成済みbot factoryの`clientFactory`まで保持します。標準`Client`では
従来どおり`defineEvent`を使用できます。

標準`Client`と派生Clientのどちらでも、runtimeへ渡す`clientFactory`は必須です。
bot-kitはClientの具体型を推測して生成せず、factoryが返したinstanceのlifecycleを管理します。

単一guildの音声connection transport lifecycle（Ready待機、channel切替、切断復旧、
cleanup）は`voice` packageが所有します。Audio Player、Queue、guild単位のController管理、
DB、個別Command、Application CommandのREST同期は利用側の責務です。

## 型付きservicesとdispatch hook

`createCommandDefinition<Services>()`でroot/subcommand/context menu/autocompleteを
定義し、Eventは`createEventDefinition<Client, Services>()`で定義します。
`BotRegistry<Client, Services>`と生成factoryはClientとservicesの型を独立して保持します。
`defineGlobalCommand<Services>` / `defineGuildCommand<Services>`もservicesを推論済みの
object引数として渡します。services付きregistryではruntimeの`services`が必須です。
従来の定義では省略でき、contextの`services`は`undefined`です。
Kitはconsumerのobjectを同一参照で渡すだけで、生成時にserviceを初期化しません。
serviceの生成・起動・終了はconsumerが所有します。
handlerがcontextを省略する場合や、rootにexecuteがない場合もhelperで宣言したservices型を保持します。

`dispatchWrapper(interaction, next, { signal, services })`はdefer前からcommandと
未処理hookまでを包み、`next()`の結果を返します。`next`はwrapperがactiveな間に一度だけ
呼べます。重複・終了後の呼び出しはthrowします。wrapperが開始したdispatchは、awaitを
忘れた場合もKitがjoinしますが、ログcontextを保持するため必ず`await next()`してください。
`onUnhandledInteraction(interaction, result, context)`は内部dispatchが返した未処理結果を
一度だけ受け取り、handled時には呼ばれません。button/modalを含めKitは自動返信しません。
返信、autocomplete fallback、logger製品はconsumerが決めます。

wrapper/hookの例外は`phase: "dispatch"`のerror boundaryへ渡します。境界がある場合の
戻り値は`{ handled: false, reason: "dispatch-failed" }`で、この境界結果は未処理hookへ
再通知しません。単体dispatcherで境界を省略すると例外を再throwします。
command/autocompleteのerror boundary自身が失敗した場合は二重通知せず、その失敗を再throwします。
commandの既存timeoutはcommand/deferに適用し、wrapper/hookは追加timeoutを設けません。
wrapper、hook、error boundaryを含むdispatch全体をstop時に追跡し、context.signalで
協調的に終了させます。signalを無視する処理の終了は保証しません。

[最小consumer利用例](minimum-integration.md)と
[型付きstatic fixture](../packages/bot/test/fixtures/services/generated.ts)を参照してください。
