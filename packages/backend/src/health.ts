/** Returns a standard health response. */
export function healthResponse(
    service: string,
    now: () => Date = () => new Date(),
): Response {
    return Response.json({
        ok: true,
        data: {
            service,
            status: "ok",
            timestamp: now().toISOString(),
        },
    });
}
