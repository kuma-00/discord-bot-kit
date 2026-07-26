import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface PackageManifest {
    readonly version: string;
    readonly license?: string;
}

interface ExtraFile {
    readonly type: string;
    readonly path: string;
    readonly jsonpath: string;
}

interface ReleasePleaseConfig {
    readonly packages: {
        readonly ".": {
            readonly "extra-files": readonly ExtraFile[];
        };
    };
}

const repositoryDirectory = join(import.meta.dir, "..");

describe("release configuration", () => {
    test("keeps every package manifest on the root release version and MIT license", async () => {
        const rootPackage = (await Bun.file(
            join(repositoryDirectory, "package.json"),
        ).json()) as PackageManifest;
        const packageNames = (
            await readdir(join(repositoryDirectory, "packages"))
        ).sort();

        for (const packageName of packageNames) {
            const packageDirectory = join(
                repositoryDirectory,
                "packages",
                packageName,
            );
            const packageManifest = (await Bun.file(
                join(packageDirectory, "package.json"),
            ).json()) as PackageManifest;
            const jsrManifest = (await Bun.file(
                join(packageDirectory, "jsr.json"),
            ).json()) as PackageManifest;

            expect(packageManifest.version).toBe(rootPackage.version);
            expect(jsrManifest.version).toBe(rootPackage.version);
            expect(packageManifest.license).toBe("MIT");
            expect(jsrManifest.license).toBe("MIT");
        }
    });

    test("updates both manifests for every public package", async () => {
        const config = (await Bun.file(
            join(repositoryDirectory, "release-please-config.json"),
        ).json()) as ReleasePleaseConfig;
        const extraFiles = config.packages["."]["extra-files"];
        const packageNames = (
            await readdir(join(repositoryDirectory, "packages"))
        ).sort();
        const expectedPaths = packageNames
            .flatMap((packageName) => [
                `packages/${packageName}/package.json`,
                `packages/${packageName}/jsr.json`,
            ])
            .sort();

        expect(extraFiles).toHaveLength(20);
        expect(extraFiles.map(({ path }) => path).sort()).toEqual(
            expectedPaths,
        );
        expect(
            extraFiles.every(
                ({ type, jsonpath }) =>
                    type === "json" && jsonpath === "$.version",
            ),
        ).toBe(true);
    });
});
