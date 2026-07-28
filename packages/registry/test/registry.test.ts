import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildStaticRegistryGroupModule,
    buildStaticRegistryModule,
    checkStaticRegistry,
    checkStaticRegistryGroup,
    generateStaticRegistry,
    generateStaticRegistryGroup,
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

describe("grouped static registry generator", () => {
    async function groupedFixture() {
        const directory = await mkdtemp(
            join(tmpdir(), "static-registry-group-"),
        );
        temporaryDirectories.push(directory);
        const responses = join(directory, "message-responses");
        const minigames = join(directory, "minigames");
        await Promise.all([mkdir(responses), mkdir(minigames)]);
        await Promise.all([
            Bun.write(
                join(responses, "b.ts"),
                'export default { id: "response-b", execute() {} };',
            ),
            Bun.write(
                join(responses, "a.ts"),
                'export default { id: "response-a", execute() {} };',
            ),
            Bun.write(
                join(minigames, "quiz.ts"),
                'export const minigame = { id: "quiz", play() {} };',
            ),
        ]);
        return {
            outputPath: join(directory, "generated", "registries.ts"),
            registries: [
                {
                    sourceDir: responses,
                    exportName: "messageResponses",
                    validate: (value: unknown) =>
                        typeof value === "object" &&
                        value !== null &&
                        "execute" in value,
                },
                {
                    sourceDir: minigames,
                    exportName: "minigames",
                    moduleExport: "minigame",
                    validate: async (value: unknown) =>
                        typeof value === "object" &&
                        value !== null &&
                        "play" in value,
                },
            ],
        } as const;
    }

    test("builds multiple deterministic readonly exports", async () => {
        const built = await buildStaticRegistryGroupModule(
            await groupedFixture(),
        );
        expect(built.entryCounts).toEqual({
            messageResponses: 2,
            minigames: 1,
        });
        expect(built.content.indexOf("message-responses/a.ts")).toBeLessThan(
            built.content.indexOf("message-responses/b.ts"),
        );
        expect(built.content).toContain(
            "export const messageResponses = [registryGroup0Item0, registryGroup0Item1] as const;",
        );
        expect(built.content).toContain(
            "import { minigame as registryGroup1Item0 }",
        );
        expect(built.content).toContain(
            "export const minigames = [registryGroup1Item0] as const;",
        );
        expect(built.content).not.toContain("import(");
    });

    test("avoids collisions between exports and generated bindings", async () => {
        const config = await groupedFixture();
        const built = await buildStaticRegistryGroupModule({
            ...config,
            registries: [
                {
                    ...config.registries[0],
                    exportName: "registryGroup0Item0",
                },
            ],
        });
        expect(built.content).toContain("import registryGroup0Item_0 from");
        expect(built.content).toContain(
            "export const registryGroup0Item0 = [registryGroup0Item_0, registryGroup0Item_1] as const;",
        );
    });

    test("preserves special property names in entry counts", async () => {
        const config = await groupedFixture();
        const built = await buildStaticRegistryGroupModule({
            ...config,
            registries: [
                {
                    ...config.registries[1],
                    exportName: "__proto__",
                },
            ],
        });
        expect(Object.hasOwn(built.entryCounts, "__proto__")).toBe(true);
        expect(built.entryCounts.__proto__).toBe(1);
    });

    test("generates grouped output and detects stale content", async () => {
        const config = await groupedFixture();
        const generated = await generateStaticRegistryGroup(config);
        expect(generated.changed).toBe(true);
        expect(generated.entryCounts.messageResponses).toBe(2);
        expect((await checkStaticRegistryGroup(config)).changed).toBe(false);
        await Bun.write(config.outputPath, "// stale");
        expect(checkStaticRegistryGroup(config)).rejects.toMatchObject({
            code: "stale",
        });
    });

    test("rejects duplicate, reserved, and invalid export names", async () => {
        const config = await groupedFixture();
        expect(
            buildStaticRegistryGroupModule({
                ...config,
                registries: [
                    config.registries[0],
                    {
                        ...config.registries[1],
                        exportName: "messageResponses",
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: "duplicate-export-name" });

        for (const exportName of ["class", "await", "not-valid"]) {
            expect(
                buildStaticRegistryGroupModule({
                    ...config,
                    registries: [{ ...config.registries[0], exportName }],
                }),
            ).rejects.toMatchObject({ code: "invalid-export-name" });
        }
    });

    test("rejects empty, missing, and invalid grouped entries", async () => {
        const config = await groupedFixture();
        const empty = await mkdtemp(join(tmpdir(), "static-registry-empty-"));
        temporaryDirectories.push(empty);
        expect(
            buildStaticRegistryGroupModule({
                ...config,
                registries: [
                    {
                        sourceDir: empty,
                        exportName: "emptyRegistry",
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: "empty-source" });

        expect(
            buildStaticRegistryGroupModule({
                ...config,
                registries: [
                    {
                        ...config.registries[1],
                        moduleExport: "missing",
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: "missing-export" });

        expect(
            buildStaticRegistryGroupModule({
                ...config,
                registries: [
                    {
                        ...config.registries[0],
                        validate: () => false,
                    },
                ],
            }),
        ).rejects.toMatchObject({ code: "invalid-entry" });
    });
});
