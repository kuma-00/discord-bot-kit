import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface PackageManifest {
    readonly name: string;
    readonly version: string;
    readonly license?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly optionalDependencies?: Readonly<Record<string, string>>;
    readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface ReleasePackage {
    readonly directoryName: string;
    readonly directory: string;
    readonly packageManifest: PackageManifest;
    readonly jsrManifest: PackageManifest;
}

function workspaceDependencies(manifest: PackageManifest): ReadonlySet<string> {
    const dependencies = new Set<string>();
    for (const dependencyGroup of [
        manifest.dependencies,
        manifest.optionalDependencies,
        manifest.peerDependencies,
    ]) {
        for (const [name, version] of Object.entries(dependencyGroup ?? {})) {
            if (version.startsWith("workspace:")) dependencies.add(name);
        }
    }
    return dependencies;
}

/**
 * Orders release packages so every workspace dependency is published before
 * its consumers.
 *
 * @throws When package names are duplicated, a workspace dependency is not
 * present in the release, or the workspace dependency graph contains a cycle.
 */
export function orderReleasePackages(
    packages: readonly ReleasePackage[],
): readonly ReleasePackage[] {
    const packagesByName = new Map<string, ReleasePackage>();
    for (const releasePackage of packages) {
        const { name } = releasePackage.packageManifest;
        if (packagesByName.has(name)) {
            throw new Error(`Duplicate release package ${name}`);
        }
        packagesByName.set(name, releasePackage);
    }

    const dependencyCounts = new Map<string, number>();
    const consumersByDependency = new Map<string, Set<string>>();
    for (const [name, releasePackage] of packagesByName) {
        const dependencies = workspaceDependencies(
            releasePackage.packageManifest,
        );
        dependencyCounts.set(name, dependencies.size);
        for (const dependency of dependencies) {
            if (!packagesByName.has(dependency)) {
                throw new Error(
                    `${name} has unknown workspace dependency ${dependency}`,
                );
            }
            const consumers =
                consumersByDependency.get(dependency) ?? new Set<string>();
            consumers.add(name);
            consumersByDependency.set(dependency, consumers);
        }
    }

    const ready = [...packagesByName.keys()]
        .filter((name) => dependencyCounts.get(name) === 0)
        .sort();
    const ordered: ReleasePackage[] = [];

    while (ready.length > 0) {
        const name = ready.shift();
        if (name === undefined) break;
        const releasePackage = packagesByName.get(name);
        if (releasePackage === undefined) {
            throw new Error(`Missing release package ${name}`);
        }
        ordered.push(releasePackage);

        for (const consumer of [
            ...(consumersByDependency.get(name) ?? []),
        ].sort()) {
            const remainingDependencies =
                (dependencyCounts.get(consumer) ?? 0) - 1;
            dependencyCounts.set(consumer, remainingDependencies);
            if (remainingDependencies === 0) {
                ready.push(consumer);
                ready.sort();
            }
        }
    }

    if (ordered.length !== packages.length) {
        const cyclicPackages = [...packagesByName.keys()]
            .filter((name) => (dependencyCounts.get(name) ?? 0) > 0)
            .sort();
        throw new Error(
            `Workspace dependency cycle: ${cyclicPackages.join(", ")}`,
        );
    }

    return ordered;
}

/** Loads public package manifests and returns them in publish order. */
export async function loadReleasePackages(
    packagesDirectory: string,
): Promise<readonly ReleasePackage[]> {
    const packages: ReleasePackage[] = [];
    for (const directoryName of (await readdir(packagesDirectory)).sort()) {
        const directory = join(packagesDirectory, directoryName);
        const jsrManifestPath = join(directory, "jsr.json");
        if (!(await Bun.file(jsrManifestPath).exists())) continue;

        packages.push({
            directoryName,
            directory,
            packageManifest: (await Bun.file(
                join(directory, "package.json"),
            ).json()) as PackageManifest,
            jsrManifest: (await Bun.file(
                jsrManifestPath,
            ).json()) as PackageManifest,
        });
    }
    return orderReleasePackages(packages);
}
