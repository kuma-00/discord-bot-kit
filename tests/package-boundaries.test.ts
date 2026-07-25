import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const allowed: Readonly<Record<string, ReadonlyArray<string>>> = {
    config: [],
    contracts: [],
    transport: ["contracts"],
    bot: [],
    backend: ["contracts"],
    elysia: ["backend", "contracts"],
    frontend: ["contracts", "transport"],
    svelte: ["frontend"],
};

describe("package boundaries", () => {
    for (const [name, dependencies] of Object.entries(allowed)) {
        test(`${name} only depends on allowed bot-kit packages`, async () => {
            const manifest = await Bun.file(
                join(import.meta.dir, "..", "packages", name, "package.json"),
            ).json();
            const internal = Object.keys({
                ...(manifest.dependencies ?? {}),
                ...(manifest.peerDependencies ?? {}),
            })
                .filter((dependency) =>
                    dependency.startsWith("@kuma-00/bot-kit-"),
                )
                .map((dependency) =>
                    dependency.replace("@kuma-00/bot-kit-", ""),
                );
            expect(internal.sort()).toEqual([...dependencies].sort());
        });
    }

    test("all package source imports are declared dependencies", async () => {
        for (const name of Object.keys(allowed)) {
            const sourceDirectory = join(
                import.meta.dir,
                "..",
                "packages",
                name,
                "src",
            );
            for (const file of await readdir(sourceDirectory)) {
                if (!file.endsWith(".ts")) continue;
                const source = await Bun.file(
                    join(sourceDirectory, file),
                ).text();
                for (const match of source.matchAll(
                    /from\s+["']@kuma-00\/bot-kit-([^"']+)["']/g,
                )) {
                    expect(allowed[name]).toContain(match[1] as string);
                }
            }
        }
    });
});
