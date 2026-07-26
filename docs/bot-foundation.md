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

## 静的Registry生成

利用側の生成スクリプトから`generateBotRegistry`を呼びます。generatorは指定された
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

## Lifecycle

`start`は同時呼び出しを単一loginへまとめます。`stop`は登録したlistenerを解除し、
実行中処理をabortしてsettleを待ち、最後にclientをdestroyします。同じDiscord eventに
複数handlerを登録でき、handler IDだけが一意である必要があります。

音声connection、Player、Guild runtime、DB、個別Command、Application CommandのREST同期は
利用側の責務です。
