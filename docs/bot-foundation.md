# Bot基盤

`@kuma-00/bot-kit-bot`はDiscord.js Clientの生成、静的Registry、interaction dispatch、lifecycleを提供します。

## Registry

CommandとEventは起動時のディレクトリ探索ではなく、明示的な配列で渡します。

```ts
const bot = createDiscordBot({
    token,
    clientOptions: { intents: [GatewayIntentBits.Guilds] },
    commands: [pingCommand],
    events: [readyEvent],
});
```

Command IDはtrim・小文字化され、大文字小文字を無視して重複を拒否します。Event IDも重複を拒否します。この方式は静的import、型検査、テスト、bundle後の動作を優先したものです。

## Interaction

- Chat input commandは既定で実行前に`deferReply`します。
- Autocompleteはdeferせず、専用handlerへdispatchします。
- 未登録commandや対象外interactionは`false`を返します。
- handler例外は注入可能なerror boundaryへ渡します。
- 既定error boundaryはrepliable interactionへ安全な汎用メッセージを返します。

## Lifecycleとテスト

`start`はhandlerを一度だけ登録してloginし、`stop`はclientをdestroyします。`clientFactory`、logger、error handlerを注入できるため、Discordへ接続せずにテストできます。

音声connection、Player、Guild runtime、DB、個別Commandは利用側の責務です。
