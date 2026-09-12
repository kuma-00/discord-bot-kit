# ADR 0002: TransportがSSE接続life cycleを所有する

- Status: Accepted
- Date: 2026-09-12

## Context

標準EventSource互換clientはstream EOFなどを再接続できる一方、Fetchの`AbortError`を
明示closeと区別できず、非200 responseでは再試行しません。consumerがその外側へ独自の
retryを追加すると、client内蔵retryとの競合、同時接続、timerとabortのcleanup漏れが
起きます。またfailure理由が接続状態だけでは判別できず、恒久failureと一時failureを
consumerが安全に扱えません。

## Decision

- `transport`がFetch、SSE parsing、reader、abort、retry timer、backoff、
  `Retry-After`、SSE `retry:`、`Last-Event-ID`を一元所有する。
- 接続clientとしての`eventsource`は使わず、接続life cycleを持たないSSE parserだけを
  dependencyにする。これにより二重再接続を構造的に排除する。
- 1 subscriptionにつきactive Fetch、reader、retry timerをそれぞれ最大1つにする。
- network、予期しないabort、EOF、408、425、429、5xxを一時failureとする。
  401、403、404、204、その他の非200、不正なSSE responseを恒久failureとする。
- connection failureとevent validation failureを別の公開通知として扱う。
- parserが保持する未完了入力に有限の既定上限を設け、上限超過を
  再試行しない不正responseとして閉じる。
- automatic reconnectではSSE cursorを維持するが、重複排除とdomain再同期はconsumerの
  責務とする。
- browserのonline・visibility復帰は`frontend`からtransportへ再試行を促すhintとし、
  transport coreにはDOM lifecycleを持ち込まない。

## Consequences

BotとFrontendはcontrollerを再生成せずに一時切断から復帰し、全runtimeで同じ分類と
backoffを利用できます。transportがSSE framingを読む責務は増えますが、parserは専用の
dependencyへ委譲し、有限bufferで不完全または悪意のあるstreamからプロセスを保護します。
fake Fetchとretry計算helperによる決定的なtestで状態機械を検証します。
恒久failureは自動復旧しないため、認証やendpoint設定を修正したconsumerが明示的に
`start()`する必要があります。

## Reconsider when

- WebSocketなど双方向transportを共通化するとき
- server ACKを含むexactly-once deliveryを導入するとき
- Nodeまたはbrowserを正式対応runtimeへ追加するとき
