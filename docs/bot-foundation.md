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
`execute`は`{ client, interaction, signal }`のobject引数を受け取ります。

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

音声connection、Player、Guild runtime、DB、個別Command、Application CommandのREST同期は
利用側の責務です。
