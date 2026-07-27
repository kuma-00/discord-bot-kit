import { join } from "node:path";
import { loadReleasePackages } from "./release-packages";

const packagesDirectory = join(import.meta.dir, "..", "packages");
const nodeOptions = [
    process.env.NODE_OPTIONS,
    // The downloaded JSR CLI currently uses child_process with shell:true
    // internally. Suppress only its Node DEP0190 warning; keep every other
    // publish diagnostic visible.
    "--disable-warning=DEP0190",
]
    .filter(Boolean)
    .join(" ");

for (const { directoryName, directory: cwd } of await loadReleasePackages(
    packagesDirectory,
)) {
    console.log(`Validating @kuma-00/bot-kit-${directoryName}`);
    const child = Bun.spawn(
        ["bunx", "jsr", "publish", "--dry-run", "--allow-dirty"],
        {
            cwd,
            env: {
                ...process.env,
                NODE_OPTIONS: nodeOptions,
            },
            stdout: "inherit",
            stderr: "inherit",
        },
    );
    const exitCode = await child.exited;
    if (exitCode !== 0) {
        throw new Error(`JSR dry-run failed for ${directoryName}`);
    }
}
