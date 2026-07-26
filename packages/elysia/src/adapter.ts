import {
    type ApiKeyAuthOptions,
    authenticateApiKey,
    type BackendLogger,
    executeRoute,
    healthResponse,
    type RouteDefinition,
    type SseEventBroker,
} from "@kuma-00/bot-kit-backend";
import type { StandardSchemaV1 } from "@kuma-00/bot-kit-contracts";
import { Elysia } from "elysia";

type AnyRouteDefinition = RouteDefinition<
    StandardSchemaV1,
    StandardSchemaV1,
    StandardSchemaV1
>;

/** Options for creating an Elysia adapter application. */
export interface CreateElysiaAppOptions {
    readonly service: string;
    readonly routes?: ReadonlyArray<AnyRouteDefinition>;
    readonly apiKey?: ApiKeyAuthOptions;
    readonly healthPath?: string;
    readonly sse?: {
        readonly path: string;
        readonly broker: SseEventBroker;
    };
    readonly logger?: BackendLogger;
}

/** Creates an Elysia application backed by framework-neutral route definitions. */
export function createElysiaApp(options: CreateElysiaAppOptions): Elysia {
    const app = new Elysia();
    app.get(options.healthPath ?? "/healthz", () =>
        healthResponse(options.service),
    );

    for (const definition of options.routes ?? []) {
        app.route(
            definition.contract.method,
            definition.contract.path,
            async ({ request, body, query, params }) => {
                if (options.apiKey) {
                    const failure = authenticateApiKey(request, options.apiKey);
                    if (failure) return Response.json(failure, { status: 401 });
                }
                return executeRoute(
                    definition,
                    request,
                    { params, query, body },
                    params,
                    options.logger,
                );
            },
        );
    }

    if (options.sse) {
        app.get(options.sse.path, ({ request }) => {
            if (options.apiKey) {
                const failure = authenticateApiKey(request, options.apiKey);
                if (failure) return Response.json(failure, { status: 401 });
            }
            return options.sse?.broker.response(request.signal);
        });
    }
    return app;
}
