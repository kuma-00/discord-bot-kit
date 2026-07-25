# ADR 0001: CoreとAdapterを分離した責務別JSRパッケージ

- Status: Accepted
- Date: 2026-07-25

## Context

`nicobot-v6`、`gbot-v8Engine`、`botbase`には設定、Discord起動、Command/Event登録、Backend通信などの重複があります。一方、音楽、読み上げ、ゲーム、DB構造はBotごとの差が大きく、同じ抽象化へ押し込むと利用側の結合が増えます。

## Decision

- Bun専用・ESM・TypeScript sourceとしてJSRへ公開する。
- `@kuma-00/bot-kit-*`の責務別packageに分割する。
- Contractとframework-neutral coreを先に置き、ElysiaとSvelteをadapterにする。
- HTTPはFetch、Backend境界はWeb標準Request/Responseを使用する。
- Realtime v0.1.0はSSEのみとする。
- Discord Command/Eventは静的Registryを使用する。
- Bot固有domain、DB実装、UIを共通libraryへ含めない。

## Consequences

利用側は必要なpackageだけ導入でき、Elysia/Svelteのversionをcoreへ伝播させずに済みます。一方、package数とrelease検証対象は増えるため、versionを同期し、boundary testと全packageのJSR dry-runを必須にします。

## Reconsider when

- NodeまたはDenoを正式対応するとき
- 双方向・低遅延通信を共通化するとき
- 永続的なmulti-process event brokerが必要になったとき
- framework adapterが3種類以上へ増え、共通adapter APIが必要になったとき
