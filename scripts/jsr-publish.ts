import { join } from "node:path";
import { loadReleasePackages, type PackageManifest } from "./release-packages";

interface ReleaseManifest {
    readonly [path: string]: string;
}

const repositoryDirectory = join(import.meta.dir, "..");
const packagesDirectory = join(repositoryDirectory, "packages");
const releaseTag = process.argv[2];

if (
    releaseTag === undefined ||
    !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)
) {
    throw new Error("Usage: bun run jsr:publish vX.Y.Z");
}

const expectedVersion = releaseTag.slice(1);
const rootPackage = (await Bun.file(
    join(repositoryDirectory, "package.json"),
).json()) as PackageManifest;
const releaseManifest = (await Bun.file(
    join(repositoryDirectory, ".release-please-manifest.json"),
).json()) as ReleaseManifest;

if (rootPackage.version !== expectedVersion) {
    throw new Error(
        `Tag ${releaseTag} does not match root package version ${rootPackage.version}`,
    );
}

if (releaseManifest["."] !== expectedVersion) {
    throw new Error(
        `Tag ${releaseTag} does not match release manifest version ${releaseManifest["."]}`,
    );
}

for (const {
    directory: cwd,
    packageManifest,
    jsrManifest,
} of await loadReleasePackages(packagesDirectory)) {
    if (
        packageManifest.version !== expectedVersion ||
        jsrManifest.version !== expectedVersion
    ) {
        throw new Error(
            `${jsrManifest.name} versions do not match release tag ${releaseTag}`,
        );
    }

    if (packageManifest.license !== "MIT" || jsrManifest.license !== "MIT") {
        throw new Error(`${jsrManifest.name} must declare the MIT license`);
    }

    console.log(`Publishing ${jsrManifest.name}@${expectedVersion}`);
    const publishProcess = Bun.spawn(["bunx", "jsr", "publish"], {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await publishProcess.exited;
    if (exitCode !== 0) {
        throw new Error(`JSR publish failed for ${jsrManifest.name}`);
    }
}
