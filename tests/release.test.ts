import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
    loadReleasePackages,
    orderReleasePackages,
    type ReleasePackage,
} from "../scripts/release-packages";

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
    readonly "include-component-in-tag": boolean;
    readonly packages: {
        readonly ".": {
            readonly "extra-files": readonly ExtraFile[];
        };
    };
}

const repositoryDirectory = join(import.meta.dir, "..");

function releasePackage(
    name: string,
    dependencies: Readonly<Record<string, string>> = {},
): ReleasePackage {
    const manifest = {
        name,
        version: "0.0.0",
        license: "MIT",
        dependencies,
    };
    return {
        directoryName: name,
        directory: name,
        packageManifest: manifest,
        jsrManifest: manifest,
    };
}

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
        expect(config["include-component-in-tag"]).toBe(false);
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

    test("publishes workspace dependencies before their consumers", async () => {
        const orderedPackages = await loadReleasePackages(
            join(repositoryDirectory, "packages"),
        );

        expect(
            orderedPackages.map(({ directoryName }) => directoryName),
        ).toEqual([
            "config",
            "contracts",
            "backend",
            "elysia",
            "registry",
            "bot",
            "transport",
            "frontend",
            "svelte",
            "voice",
        ]);
    });

    test("rejects invalid workspace dependency graphs", () => {
        const first = "@kuma-00/bot-kit-first";
        const second = "@kuma-00/bot-kit-second";

        expect(() =>
            orderReleasePackages([
                releasePackage(first, {
                    "@kuma-00/bot-kit-missing": "workspace:*",
                }),
            ]),
        ).toThrow("unknown workspace dependency");
        expect(() =>
            orderReleasePackages([
                releasePackage(first, { [second]: "workspace:*" }),
                releasePackage(second, { [first]: "workspace:*" }),
            ]),
        ).toThrow("Workspace dependency cycle");
    });
});
