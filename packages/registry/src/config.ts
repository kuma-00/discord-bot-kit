import type { StaticRegistryGeneratorConfig } from "./types.ts";

/** Preserves literal values in static registry generator configuration. */
export function defineStaticRegistryConfig<
    const T extends StaticRegistryGeneratorConfig,
>(config: T): T {
    return config;
}
