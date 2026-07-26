export { defineStaticRegistryConfig } from "./config.ts";
export { StaticRegistryError } from "./errors.ts";
export { buildStaticRegistryFragment } from "./fragment.ts";
export {
    buildStaticRegistryModule,
    checkStaticRegistry,
    generateStaticRegistry,
} from "./generator.ts";
export type {
    StaticRegistryBuildResult,
    StaticRegistryFragment,
    StaticRegistryGenerateResult,
    StaticRegistryGeneratorConfig,
    StaticRegistryValidationContext,
    StaticRegistryValidator,
} from "./types.ts";
