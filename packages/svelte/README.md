# @kuma-00/bot-kit-svelte

Svelte 5 readable stores for bot-kit frontend observables and realtime controllers.

```ts
import { ObservableValue } from "@kuma-00/bot-kit-frontend";
import { toReadable } from "@kuma-00/bot-kit-svelte";

const status = new ObservableValue("idle");
export const statusStore = toReadable(status);
```

registry付き`RealtimeController`から作るstoreもeventの判別unionを保持します。
最初のsubscriberでstartし、state/eventを通じた最終unsubscribeでstopします。
[複数event利用例](../../docs/minimum-integration.md)を参照してください。
