import {
    ContractValidationError,
    parseSchema,
    type SchemaOutput,
    type StandardSchemaV1,
} from "./schema.ts";

/** Versioned event metadata shared by SSE producers and consumers. */
export interface EventEnvelope<TType extends string, TPayload> {
    readonly id: string;
    readonly type: TType;
    readonly version: number;
    readonly occurredAt: string;
    readonly guildId?: string;
    readonly payload: TPayload;
}

/** Runtime definition of a versioned event. */
export interface EventContract<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
> {
    readonly type: TType;
    readonly version: TVersion;
    readonly payload: TPayloadSchema;
}

/** Any event contract accepted by a heterogeneous event registry. */
export type AnyEventContract = EventContract<string, number, StandardSchemaV1>;

/** Infers the validated envelope produced by an event contract. */
export type EventEnvelopeFor<TContract extends AnyEventContract> =
    TContract extends EventContract<
        infer TType,
        infer _TVersion,
        infer TPayloadSchema
    >
        ? EventEnvelope<TType, SchemaOutput<TPayloadSchema>>
        : never;

/** Runtime lookup for a fixed set of event contracts. */
export interface EventRegistry<
    TContracts extends
        readonly AnyEventContract[] = readonly AnyEventContract[],
> {
    readonly contracts: TContracts;
    parse(value: unknown): Promise<EventEnvelopeFor<TContracts[number]>>;
}

/** Creates an event contract while preserving literal type and version values. */
export function defineEventContract<
    const TType extends string,
    const TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
>(
    contract: EventContract<TType, TVersion, TPayloadSchema>,
): EventContract<TType, TVersion, TPayloadSchema> {
    return contract;
}

/**
 * Creates a type-safe registry keyed by event type and version.
 *
 * Duplicate type/version pairs are rejected when the registry is created.
 */
export function createEventRegistry<
    const TContracts extends readonly AnyEventContract[],
>(contracts: TContracts): EventRegistry<TContracts> {
    const byKey = new Map<string, AnyEventContract>();
    for (const contract of contracts) {
        const key = `${contract.type}\u0000${contract.version}`;
        if (byKey.has(key)) {
            throw new Error(
                `Duplicate event contract: ${contract.type}@${contract.version}`,
            );
        }
        byKey.set(key, contract);
    }
    return {
        contracts,
        async parse(value) {
            if (typeof value !== "object" || value === null) {
                throw new ContractValidationError(
                    [{ message: "Expected an event envelope object" }],
                    "event",
                );
            }
            const candidate = value as Record<string, unknown>;
            const contract = byKey.get(
                `${String(candidate.type)}\u0000${String(candidate.version)}`,
            );
            if (!contract) {
                throw new ContractValidationError(
                    [{ message: "Unknown event type or version" }],
                    "event",
                );
            }
            return (await parseEventEnvelope(
                contract,
                value,
            )) as EventEnvelopeFor<TContracts[number]>;
        },
    };
}

/** Validates a versioned event envelope and its payload. */
export async function parseEventEnvelope<
    TType extends string,
    TVersion extends number,
    TPayloadSchema extends StandardSchemaV1,
>(
    contract: EventContract<TType, TVersion, TPayloadSchema>,
    value: unknown,
): Promise<EventEnvelope<TType, SchemaOutput<TPayloadSchema>>> {
    if (typeof value !== "object" || value === null) {
        throw new ContractValidationError(
            [{ message: "Expected an event envelope object" }],
            "event",
        );
    }
    const candidate = value as Record<string, unknown>;
    if (
        candidate.type !== contract.type ||
        candidate.version !== contract.version
    ) {
        throw new ContractValidationError(
            [{ message: "Unexpected event type or version" }],
            "event",
        );
    }
    for (const key of ["id", "occurredAt"] as const) {
        if (typeof candidate[key] !== "string") {
            throw new ContractValidationError(
                [{ message: `Expected ${key} to be a string`, path: [key] }],
                "event",
            );
        }
    }
    if (
        candidate.guildId !== undefined &&
        typeof candidate.guildId !== "string"
    ) {
        throw new ContractValidationError(
            [{ message: "Expected guildId to be a string", path: ["guildId"] }],
            "event",
        );
    }
    const payload = (await parseSchema(
        contract.payload,
        candidate.payload,
        `${contract.type}.payload`,
    )) as SchemaOutput<TPayloadSchema>;
    return {
        id: candidate.id as string,
        type: contract.type,
        version: contract.version,
        occurredAt: candidate.occurredAt as string,
        ...(candidate.guildId === undefined
            ? {}
            : { guildId: candidate.guildId as string }),
        payload,
    };
}
