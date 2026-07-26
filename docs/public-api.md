# Public API

各packageのroot exportは、利用側が直接構成・実行・型付けするためのAPIだけを明示的に公開します。
新しいsource fileを追加しても自動的には公開されません。

## 分類

| Package | Public API | Internal implementation |
| --- | --- | --- |
| `config` | config定義、load、公開option・diagnostic型、`ConfigError` | YAML source処理、path merge、validation helper |
| `contracts` | schema、HTTP contract、event contract・registry、envelope parse | 各責務内のlookup・validation helper |
| `registry` | config、generator、fragment、公開型、`StaticRegistryError` | filesystem discovery、import path・identifier helper |
| `transport` | `HttpClient`、SSE parser・subscription、公開option・result型 | response chunk reader、serializer、failure builder |
| `bot` | command/event定義、registry、dispatcher、lifecycle、generator、公開型・error | operation tracking、dispatch path・policy helper |
| `voice` | controller、adapter contract・default adapter、公開option・state・error | abort・delay helper |
| `backend` | route、auth、error mapping、health、SSE broker | serialization・schema boundary helper |
| `elysia` | Elysia adapter | adapter-local request mapping |
| `frontend` | API client、realtime controller、observable state | client内のsubscription wiring |
| `svelte` | Svelte store adapter | adapter-local subscription wiring |

公開symbolの追加・削除時はroot `src/index.ts` と `jsr.json` のexportsを確認し、
利用者向けのJSDocとテストを同時に更新します。内部helperをテスト都合だけでrootから
exportしません。
