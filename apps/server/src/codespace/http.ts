import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authenticateRawRouteWithScope } from "../http.ts";
import { ProviderAdapterRegistryLive } from "../provider/Layers/ProviderAdapterRegistry.ts";
import { CodeSessionImport, importCodeSession } from "./import.ts";

const decodeCodeSessionImport = Schema.decodeUnknownEffect(CodeSessionImport);

export const codespaceImportRoute = HttpRouter.add(
  "POST",
  "/api/codespace/import",
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const payload = yield* decodeCodeSessionImport(yield* request.json);
      return HttpServerResponse.jsonUnsafe(yield* importCodeSession(payload));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              error:
                error._tag === "CodeImportError"
                  ? error.detail
                  : "The session could not be imported. Check the payload and server logs.",
            },
            { status: 400 },
          ),
        ),
      ),
    );
  }),
).pipe(Layer.provide(ProviderAdapterRegistryLive));
