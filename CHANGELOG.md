# Changelog

## [1.2.0](https://github.com/kuma-00/discord-bot-kit/compare/v1.1.0...v1.2.0) (2026-07-30)


### Features

* add categorized help embed generation ([fabcc03](https://github.com/kuma-00/discord-bot-kit/commit/fabcc0368f3ed39b89646f7c578096511b9467b0))
* support typed Discord client subclasses in bot runtime ([0c0fb38](https://github.com/kuma-00/discord-bot-kit/commit/0c0fb388d6fa27425a3070484bdddb0342488bc2))

## [1.1.0](https://github.com/kuma-00/discord-bot-kit/compare/v1.0.0...v1.1.0) (2026-07-28)


### Features

* add grouped static registry generation ([ce2e274](https://github.com/kuma-00/discord-bot-kit/commit/ce2e27489ec3bffdde2ce98338c31f8a5c3221ea))

## [1.0.0](https://github.com/kuma-00/discord-bot-kit/compare/v0.3.1...v1.0.0) (2026-07-27)


### ⚠ BREAKING CHANGES

* CommandDispatcher now rejects dispatch calls when a handler fails and no onError boundary is configured.

### Features

* improve bot execution and transport APIs ([1ff1193](https://github.com/kuma-00/discord-bot-kit/commit/1ff119356d5e71dcb6d640478bed7f25505e9b29))


### Bug Fixes

* enforce validated error details and robust SSE retries ([8e5d146](https://github.com/kuma-00/discord-bot-kit/commit/8e5d146cca31b7b37f8071be6d5728bfcf1cdefe))
* preserve server retry interval after valid SSE events ([85888d7](https://github.com/kuma-00/discord-bot-kit/commit/85888d785b1692fa9151f472342182ce5919c8c0))

## [0.3.1](https://github.com/kuma-00/discord-bot-kit/compare/v0.3.0...v0.3.1) (2026-07-26)


### Bug Fixes

* publish JSR packages in dependency order ([3968d04](https://github.com/kuma-00/discord-bot-kit/commit/3968d042d347fadb8907c6a61e0fdf3f289db612))

## [0.3.0](https://github.com/kuma-00/discord-bot-kit/compare/v0.2.1...v0.3.0) (2026-07-26)


### Features

* add generated type-safe Discord bot registries ([9e00d8e](https://github.com/kuma-00/discord-bot-kit/commit/9e00d8ec5deb0a6d65531b95ec9773c46a4c2e1b))
* add reusable config definitions and default recovery ([828e64f](https://github.com/kuma-00/discord-bot-kit/commit/828e64fbff84dcee74e689c836a19c2965aabc25))
* add reusable registry and voice packages ([141fda5](https://github.com/kuma-00/discord-bot-kit/commit/141fda5f4387d0e39e49034761f3d5f0e376d464))
* automate package releases and JSR publishing ([4356fc0](https://github.com/kuma-00/discord-bot-kit/commit/4356fc03b012c78a8bfb64af7cff202d740eec1f))
* validate generated bot registries and defer within tracked runs ([e96fb3f](https://github.com/kuma-00/discord-bot-kit/commit/e96fb3f756df9750ae30afaf045f0cfd1226590b))


### Bug Fixes

* contain hook failures and replace stale voice connections ([641f88b](https://github.com/kuma-00/discord-bot-kit/commit/641f88b274095794f11903528dfed947e70bc6a1))
* preserve expanded jsr manifest formatting ([3301a97](https://github.com/kuma-00/discord-bot-kit/commit/3301a97c1a2096f0d8c72aebe9c69f34328cbe99))
* reject reserved JavaScript binding names ([354cddf](https://github.com/kuma-00/discord-bot-kit/commit/354cddfc56e7aa78c5eb931e01c20d038d9515d8))
* use component-free release tags ([5f8b3c0](https://github.com/kuma-00/discord-bot-kit/commit/5f8b3c04b901afe727a62528f81df8126fe2cd6d))

## [0.2.1](https://github.com/kuma-00/discord-bot-kit/compare/discord-bot-kit-v0.2.0...discord-bot-kit-v0.2.1) (2026-07-26)


### Bug Fixes

* preserve expanded jsr manifest formatting ([3301a97](https://github.com/kuma-00/discord-bot-kit/commit/3301a97c1a2096f0d8c72aebe9c69f34328cbe99))

## [0.2.0](https://github.com/kuma-00/discord-bot-kit/compare/discord-bot-kit-v0.1.0...discord-bot-kit-v0.2.0) (2026-07-26)


### Features

* add generated type-safe Discord bot registries ([9e00d8e](https://github.com/kuma-00/discord-bot-kit/commit/9e00d8ec5deb0a6d65531b95ec9773c46a4c2e1b))
* add reusable config definitions and default recovery ([828e64f](https://github.com/kuma-00/discord-bot-kit/commit/828e64fbff84dcee74e689c836a19c2965aabc25))
* add reusable registry and voice packages ([141fda5](https://github.com/kuma-00/discord-bot-kit/commit/141fda5f4387d0e39e49034761f3d5f0e376d464))
* automate package releases and JSR publishing ([4356fc0](https://github.com/kuma-00/discord-bot-kit/commit/4356fc03b012c78a8bfb64af7cff202d740eec1f))
* validate generated bot registries and defer within tracked runs ([e96fb3f](https://github.com/kuma-00/discord-bot-kit/commit/e96fb3f756df9750ae30afaf045f0cfd1226590b))


### Bug Fixes

* contain hook failures and replace stale voice connections ([641f88b](https://github.com/kuma-00/discord-bot-kit/commit/641f88b274095794f11903528dfed947e70bc6a1))
* reject reserved JavaScript binding names ([354cddf](https://github.com/kuma-00/discord-bot-kit/commit/354cddfc56e7aa78c5eb931e01c20d038d9515d8))
