# @kuma-00/bot-kit-voice

単一guildのDiscord Voice接続を管理するControllerです。Ready待機、channel切替、
予期しない切断からの上限付き復旧、AbortSignal、listener/timer cleanupを提供します。

AudioPlayer、読み上げ、録音、Queue、guild別Controller管理は含みません。

```ts
import { VoiceConnectionController } from "@kuma-00/bot-kit-voice";

const controller = new VoiceConnectionController({
    onStateChange: (state) => console.log(state),
});

const connection = await controller.connect(voiceChannel);
audioPlayer && connection.subscribe(audioPlayer);
```
