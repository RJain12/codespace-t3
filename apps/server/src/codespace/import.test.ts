import { CommandId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { CodeSessionImport, importCodeSession } from "./import.ts";

function system(provider: "codex" | "claude") {
  const instanceId = ProviderInstanceId.make(`${provider}-work`);
  const registry = Layer.succeed(ProviderAdapterRegistry, {
    listInstances: () => Effect.succeed([instanceId]),
    getInstanceInfo: () =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(provider),
        displayName: "Work",
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(provider),
          continuationKey: `${provider}:home:/test/account`,
        },
      }),
    getByInstance: () => Effect.die("Import must not start a provider adapter"),
    listProviders: () => Effect.succeed([ProviderDriverKind.make(provider)]),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.die("Import must not subscribe to provider events"),
  });
  // Each case owns an isolated SQLite runtime and tests explicit persistence across imports.
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests
  return ManagedRuntime.make(
    Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
      ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntime.layer)),
      registry,
    ).pipe(
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "codespace-import-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
}

function payload(provider: "codex" | "claude"): CodeSessionImport {
  return {
    version: 1,
    provider,
    sessionId: "native-session-123",
    sourceHome: "/test/account",
    cwd: process.cwd(),
    title: "Imported Code conversation",
    model: "test-model",
    state: "stopped",
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "Please inspect this project",
        createdAt: "2026-09-25T00:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "Here is the result",
        createdAt: "2026-09-25T00:00:01.000Z",
      },
    ],
  };
}

describe("Codespace session import", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`persists ${provider} history and native resume binding, and retries without duplicates`, async () => {
      const runtime = system(provider);
      try {
        const input = payload(provider);
        const result = await runtime.runPromise(importCodeSession(input));
        expect(result.imported).toBe(2);
        const retry = await runtime.runPromise(importCodeSession(input));
        expect(retry.threadId).toBe(result.threadId);
        expect(retry.imported).toBe(0);
        const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
        const state = await runtime.runPromise(query.getSnapshot());
        expect(state.projects).toHaveLength(1);
        expect(state.threads).toHaveLength(1);
        expect(state.threads[0]?.messages.map((m) => m.text)).toEqual(
          input.messages.map((m) => m.text),
        );
        expect(state.threads[0]?.latestTurn).toBeNull();
        const directory = await runtime.runPromise(Effect.service(ProviderSessionDirectory));
        const binding = Option.getOrThrow(
          await runtime.runPromise(directory.getBinding(result.threadId)),
        );
        expect(binding.providerInstanceId).toBe(`${provider}-work`);
        expect(binding.status).toBe("stopped");
        expect(binding.resumeCursor).toEqual(
          provider === "codex" ? { threadId: input.sessionId } : { resume: input.sessionId },
        );
        await runtime.runPromise(directory.upsert({ ...binding, status: "running" }));
        await expect(runtime.runPromise(importCodeSession(input))).rejects.toThrow(
          /live T3 session/,
        );
      } finally {
        await runtime.dispose();
      }
    });
  }
  it("rejects a different account home before creating any history", async () => {
    const runtime = system("codex");
    try {
      await expect(
        runtime.runPromise(
          importCodeSession({ ...payload("codex"), sourceHome: "/another/account" }),
        ),
      ).rejects.toThrow(/Configure a codex provider instance/);
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      expect((await runtime.runPromise(query.getSnapshot())).threads).toHaveLength(0);
    } finally {
      await runtime.dispose();
    }
  });
  it("adds new history on retry but preserves deletion in T3", async () => {
    const runtime = system("codex");
    try {
      const input = payload("codex");
      const first = await runtime.runPromise(importCodeSession(input));
      const extended = {
        ...input,
        messages: [
          ...input.messages,
          {
            id: "user-2",
            role: "user" as const,
            text: "One more question",
            createdAt: "2026-09-25T00:00:02.000Z",
          },
        ],
      };
      expect((await runtime.runPromise(importCodeSession(extended))).imported).toBe(1);
      const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
      expect((await runtime.runPromise(query.getSnapshot())).threads[0]?.messages).toHaveLength(3);
      const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
      await runtime.runPromise(
        engine.dispatch({
          type: "thread.delete",
          threadId: first.threadId,
          commandId: CommandId.make("delete-imported"),
        }),
      );
      await expect(runtime.runPromise(importCodeSession(extended))).rejects.toThrow(
        /deleted in T3/,
      );
    } finally {
      await runtime.dispose();
    }
  });
});
