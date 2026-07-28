export {
    defineStaticRegistryConfig,
    defineStaticRegistryGroupConfig,
} from "./config.ts";
export { StaticRegistryError } from "./errors.ts";
export { buildStaticRegistryFragment } from "./fragment.ts";
export {
    buildStaticRegistryModule,
    checkStaticRegistry,
    generateStaticRegistry,
} from "./generator.ts";
export {
    buildStaticRegistryGroupModule,
    checkStaticRegistryGroup,
    generateStaticRegistryGroup,
} from "./group.ts";
export type {
    StaticRegistryBuildResult,
    StaticRegistryFragment,
    StaticRegistryGenerateResult,
    StaticRegistryGeneratorConfig,
    StaticRegistryGroupBuildResult,
    StaticRegistryGroupConfig,
    StaticRegistryGroupGenerateResult,
    StaticRegistryGroupSourceConfig,
    StaticRegistryValidationContext,
    StaticRegistryValidator,
} from "./types.ts";
