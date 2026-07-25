interface TestSchema<T> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) =>
            | { readonly value: T; readonly issues?: undefined }
            | { readonly issues: ReadonlyArray<{ readonly message: string }> };
        readonly types?: {
            readonly input: unknown;
            readonly output: T;
        };
    };
}

export function schema<T>(
    guard: (value: unknown) => value is T,
    message = "Invalid value",
): TestSchema<T> {
    return {
        "~standard": {
            version: 1,
            vendor: "bot-kit-test",
            validate: (value) =>
                guard(value) ? { value } : { issues: [{ message }] },
        },
    };
}

export const unknownSchema = schema<unknown>(
    (_value): _value is unknown => true,
);

export const objectSchema = schema<Record<string, unknown>>(
    (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && !Array.isArray(value),
);
