# @kuma-00/bot-kit-voice

単一guildのDiscord Voice接続を管理するControllerです。Ready待機、channel切替、
予期しない切断からの上限付き復旧、AbortSignal、listener/timer cleanupを提供します。

AudioPlayer、読み上げ、録音、Queue、guild別Controller管理は含みません。

切断時の復旧は `grace` → `rejoin` → `recreate` の順で試行します。既定値は
grace 5 秒、rejoin は最大 3 回（Ready 待機 15 秒、backoff 100 ms）で、
`recreate` は有効、最大 1 回（Ready 待機 15 秒、backoff 100 ms）です。
`recreate.enabled` を false にすると transport 再作成を無効化できます。各段階の
`maxAttempts`、`readyTimeoutMs`、`backoffMs` と
grace の待機時間は `recovery` で個別に指定できます。

```ts
import { VoiceConnectionController } from "@kuma-00/bot-kit-voice";

const controller = new VoiceConnectionController({
    onStateChange: (state) => console.log(state),
    recovery: {
        gracePeriodMs: 5_000,
        rejoin: { maxAttempts: 3, readyTimeoutMs: 15_000, backoffMs: 100 },
        recreate: { enabled: true, maxAttempts: 1 },
    },
    onRecovered: ({ method, connection }) => {
        console.log(`voice recovered with ${method}`);
        if (method === "recreate") connection.subscribe(audioPlayer);
    },
});

const connection = await controller.connect(voiceChannel);
audioPlayer && connection.subscribe(audioPlayer);
```

`onConnected` は初回 `connect()` 成功時だけ呼ばれます。復旧時は
`onRecoveryAttempt`（`rejoin`/`recreate` の試行前）、`onRecovered`（`grace` を含む
復旧成功時）、`onRecoveryFailed`（全試行失敗時）をコンテキストオブジェクトで
受け取ります。プレイヤー、キュー、再生位置などの状態は Controller が所有しない
ため、`onRecovered` で再購読や必要な移行をアプリケーション側で行ってください。
