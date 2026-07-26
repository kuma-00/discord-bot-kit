import type { ConfigDiagnostic, ConfigDiagnosticHandler } from "./types.ts";

export async function emitDiagnostic(
    handler: ConfigDiagnosticHandler | undefined,
    diagnostic: ConfigDiagnostic,
): Promise<void> {
    await handler?.(diagnostic);
}
