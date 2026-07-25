import { readdir } from "node:fs/promises";
import { join } from "node:path";

const packagesDirectory = join(import.meta.dir, "..", "packages");
const packageNames = (await readdir(packagesDirectory)).sort();

for (const packageName of packageNames) {
    const cwd = join(packagesDirectory, packageName);
    if (!(await Bun.file(join(cwd, "jsr.json")).exists())) continue;
    console.log(`Validating @kuma-00/bot-kit-${packageName}`);
    const process = Bun.spawn(["bunx", "jsr", "publish", "--dry-run"], {
        cwd,
        stdout: "inherit",
        stderr: "inherit",
    });
    const exitCode = await process.exited;
    if (exitCode !== 0) {
        throw new Error(`JSR dry-run failed for ${packageName}`);
    }
}
