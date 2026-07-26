import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildStaticRegistryModule,
    checkStaticRegistry,
    generateStaticRegistry,
    StaticRegistryError,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((path) => rm(path, { recursive: true, force: true })),
    );
});

async function fixture(moduleExport: "default" | string = "default") {
    const directory = await mkdtemp(join(tmpdir(), "static-registry-"));
    temporaryDirectories.push(directory);
    const sourceDir = join(directory, "entries");
    await mkdir(sourceDir);
    const declaration =
        moduleExport === "default"
            ? "export default { id: "
            : `export const ${moduleExport} = { id: `;
    await Bun.write(join(sourceDir, "b.ts"), `${declaration}"b" };`);
    await Bun.write(join(sourceDir, "a.ts"), `${declaration}"a" };`);
    await Bun.write(
        join(sourceDir, "ignored.test.ts"),
        `${declaration}"ignored" };`,
    );
    return {
        sourceDir,
        outputPath: join(directory, "generated", "registry.ts"),
        exportName: "customRegistry",
        moduleExport,
    };
}

describe("static registry generator", () => {
    test("builds a deterministic readonly default-export registry", async () => {
        const built = await buildStaticRegistryModule(await fixture());
        expect(built.entryCount).toBe(2);
        expect(built.content.indexOf("entries/a.ts")).toBeLessThan(
            built.content.indexOf("entries/b.ts"),
        );
        expect(built.content).toContain(
            "export const customRegistry = [registryItem0, registryItem1] as const;",
        );
        expect(built.content).not.toContain("ignored.test.ts");
    });

    test("supports named exports and validation", async () => {
        const config = {
            ...(await fixture("minigame")),
            validate: (value: unknown) =>
                typeof value === "object" && value !== null && "id" in value,
        };
        const built = await buildStaticRegistryModule(config);
        expect(built.content).toContain("import { minigame as registryItem0 }");
    });

    test("rejects reserved export binding names", async () => {
        const config = await fixture();
        for (const exportName of ["default", "class", "await", "arguments"]) {
            expect(
                buildStaticRegistryModule({ ...config, exportName }),
            ).rejects.toMatchObject({
                code: "invalid-export-name",
            });
        }
    });

    test("generates files and detects stale content", async () => {
        const config = await fixture();
        expect((await generateStaticRegistry(config)).changed).toBe(true);
        expect((await checkStaticRegistry(config)).changed).toBe(false);
        await Bun.write(config.outputPath, "// stale");
        expect(checkStaticRegistry(config)).rejects.toMatchObject({
            code: "stale",
        });
    });

    test("rejects empty sources, missing exports, and invalid entries", async () => {
        const empty = await mkdtemp(join(tmpdir(), "static-registry-empty-"));
        temporaryDirectories.push(empty);
        expect(
            buildStaticRegistryModule({
                sourceDir: empty,
                outputPath: join(empty, "registry.ts"),
                exportName: "registry",
            }),
        ).rejects.toBeInstanceOf(StaticRegistryError);

        const missing = await fixture("minigame");
        await Bun.write(join(missing.sourceDir, "a.ts"), "export default {};");
        expect(buildStaticRegistryModule(missing)).rejects.toMatchObject({
            code: "missing-export",
        });

        const invalid = {
            ...(await fixture()),
            validate: () => false,
        };
        expect(buildStaticRegistryModule(invalid)).rejects.toMatchObject({
            code: "invalid-entry",
        });
    });
});
