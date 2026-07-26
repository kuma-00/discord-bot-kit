import type { StaticRegistryGeneratorConfig } from "./types.ts";

export function defineStaticRegistryConfig<
    const T extends StaticRegistryGeneratorConfig,
>(config: T): T {
    return config;
}
