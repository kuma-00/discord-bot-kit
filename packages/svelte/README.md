# @kuma-00/bot-kit-svelte

Svelte 5 readable stores for bot-kit frontend observables and realtime controllers.

```ts
import { ObservableValue } from "@kuma-00/bot-kit-frontend";
import { toReadable } from "@kuma-00/bot-kit-svelte";

const status = new ObservableValue("idle");
export const statusStore = toReadable(status);
```
