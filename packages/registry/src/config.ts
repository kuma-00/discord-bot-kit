import type {
    StaticRegistryGeneratorConfig,
    StaticRegistryGroupConfig,
} from "./types.ts";

/** Preserves literal values in static registry generator configuration. */
export function defineStaticRegistryConfig<
    const T extends StaticRegistryGeneratorConfig,
>(config: T): T {
    return config;
}

/** Preserves literal values in grouped static registry configuration. */
export function defineStaticRegistryGroupConfig<
    const T extends StaticRegistryGroupConfig,
>(config: T): T {
    return config;
}
