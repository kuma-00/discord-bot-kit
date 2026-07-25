# パッケージ境界

## 許可する依存

| Package | 内部依存 |
| --- | --- |
| `config` | なし |
| `contracts` | なし |
| `transport` | `contracts` |
| `bot` | なし |
| `backend` | `contracts` |
| `elysia` | `backend`, `contracts` |
| `frontend` | `contracts`, `transport` |
| `svelte` | `frontend` |

`tests/package-boundaries.test.ts`がmanifestとsource importの両方を検証します。

## 禁止事項

- Coreからadapterへの依存
- Runtime app同士に相当する`bot`、`backend`、`frontend`間の直接依存
- `contracts`からDiscord.js、Elysia、Svelteへの依存
- `backend`へのElysia型の流入
- `frontend`へのSvelte型やDOM UIの流入
- 公開sourceでのリポジトリ固有alias

## 追加packageの判断

新しい責務が既存packageの全利用者に必要でなければ、既存packageへ追加せずadapterまたは独立packageにします。特定Botの用語、永続化schema、外部サービス設定を含むものは原則として利用側へ残します。

境界を変更する場合は、manifestだけでなく境界testと[初期設計ADR](decisions/0001-initial-architecture.md)を更新します。
