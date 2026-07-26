import { join } from "node:path";
import { loadReleasePackages } from "./release-packages";

const packagesDirectory = join(import.meta.dir, "..", "packages");

for (const { directoryName, directory: cwd } of await loadReleasePackages(
    packagesDirectory,
)) {
    console.log(`Validating @kuma-00/bot-kit-${directoryName}`);
    const process = Bun.spawn(
        ["bunx", "jsr", "publish", "--dry-run", "--allow-dirty"],
        {
            cwd,
            stdout: "inherit",
            stderr: "inherit",
        },
    );
    const exitCode = await process.exited;
    if (exitCode !== 0) {
        throw new Error(`JSR dry-run failed for ${directoryName}`);
    }
}
