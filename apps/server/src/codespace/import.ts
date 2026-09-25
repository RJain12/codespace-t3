import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";

export const CodeSessionImport = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literals(["codex", "claude"]),
  sessionId: TrimmedNonEmptyString,
  sourceHome: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  state: Schema.Literal("stopped"),
  messages: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      role: Schema.Literals(["user", "assistant", "system"]),
      text: Schema.String,
      createdAt: IsoDateTime,
    }),
  ),
});
export type CodeSessionImport = typeof CodeSessionImport.Type;

export class CodeImportError extends Schema.TaggedErrorClass<CodeImportError>()("CodeImportError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export function importIdentity(
  input: Pick<CodeSessionImport, "provider" | "sourceHome" | "sessionId">,
) {
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([input.provider, input.sourceHome, input.sessionId]))
    .digest("hex")
    .slice(0, 32);
}

export function continuationKeyMatches(input: CodeSessionImport, key: string) {
  const sourceHome = input.sourceHome;
  if (key === `${input.provider}:home:${sourceHome}`) return true;
  // T3's default Claude instance identifies the user's home, whereas the CLI
  // stores its default credentials and sessions in ~/.claude.
  return (
    input.provider === "claude" &&
    sourceHome === `${NodeOS.homedir()}/.claude` &&
    key === `claude:home:${NodeOS.homedir()}`
  );
}

export const importCodeSession = Effect.fn("codespace.importSession")(function* (
  input: CodeSessionImport,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const engine = yield* OrchestrationEngineService;
  const snapshot = yield* ProjectionSnapshotQuery;
  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  if (
    !path.isAbsolute(input.cwd) ||
    !path.isAbsolute(input.sourceHome) ||
    input.messages.length > 10000
  ) {
    return yield* new CodeImportError({
      detail: "Import requires absolute local paths and at most 10,000 messages.",
    });
  }
  input = {
    ...input,
    sourceHome: path.normalize(input.sourceHome),
    cwd: path.normalize(input.cwd),
  };
  const cwdInfo = yield* fs.stat(input.cwd);
  if (cwdInfo.type !== "Directory")
    return yield* new CodeImportError({ detail: "The session workspace must exist on this host." });
  const instances = yield* Effect.forEach(yield* registry.listInstances(), (id) =>
    registry.getInstanceInfo(id),
  );
  const instance = instances.find(
    (item) =>
      item.enabled &&
      item.driverKind === input.provider &&
      continuationKeyMatches(input, item.continuationIdentity.continuationKey),
  );
  if (!instance)
    return yield* new CodeImportError({
      detail: `Configure a ${input.provider} provider instance with home ${input.sourceHome} in T3 before importing this account.`,
    });

  const identity = importIdentity(input);
  const threadId = ThreadId.make(`codespace-${identity}`);
  const existing = yield* snapshot.getThreadDetailById(threadId);
  const binding = yield* directory.getBinding(threadId);
  if (Option.isSome(existing) && existing.value.deletedAt !== null) {
    return yield* new CodeImportError({ detail: "This imported thread was deleted in T3." });
  }
  if (Option.isSome(binding) && binding.value.status !== "stopped") {
    return yield* new CodeImportError({
      detail:
        "This thread is owned by a live T3 session. Stop it before importing more CLI history.",
    });
  }
  if (Option.isSome(existing) && existing.value.latestTurn !== null) {
    return yield* new CodeImportError({
      detail: "This imported thread has continued in T3; import will not overwrite its history.",
    });
  }
  const now = DateTime.formatIso(yield* DateTime.now);
  const modelSelection = createModelSelection(instance.instanceId, input.model);
  const project = yield* snapshot.getActiveProjectByWorkspaceRoot(input.cwd);
  const projectId = Option.isSome(project)
    ? project.value.id
    : ProjectId.make(
        `codespace-${NodeCrypto.createHash("sha256").update(input.cwd).digest("hex").slice(0, 32)}`,
      );
  if (Option.isNone(project)) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`codespace-project-${projectId}`),
      projectId,
      title: path.basename(input.cwd) || input.cwd,
      workspaceRoot: input.cwd,
      createdAt: now,
    });
  }
  if (Option.isNone(existing)) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`codespace-create-${identity}`),
      threadId,
      projectId,
      title: input.title,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: input.messages[0]?.createdAt ?? now,
    });
  }
  if (Option.isNone(yield* snapshot.getThreadDetailById(threadId))) {
    return yield* new CodeImportError({ detail: "This imported thread was deleted in T3." });
  }
  const seen = new Set(
    Option.isSome(existing) ? existing.value.messages.map((message) => String(message.id)) : [],
  );
  let imported = 0;
  for (const message of input.messages) {
    const messageId = MessageId.make(
      `codespace-${identity}-${NodeCrypto.createHash("sha256").update(message.id).digest("hex").slice(0, 24)}`,
    );
    if (seen.has(messageId)) continue;
    yield* engine.dispatch({
      type: "thread.message.import",
      commandId: CommandId.make(`import-${messageId}`),
      threadId,
      messageId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    });
    seen.add(messageId);
    imported++;
  }
  yield* directory.upsert({
    threadId,
    provider: instance.driverKind,
    providerInstanceId: instance.instanceId,
    runtimeMode: "approval-required",
    status: "stopped",
    resumeCursor:
      input.provider === "codex" ? { threadId: input.sessionId } : { resume: input.sessionId },
    runtimePayload: { cwd: input.cwd, modelSelection, codespaceSourceSessionId: input.sessionId },
  });
  return { threadId, projectId, imported, providerInstanceId: instance.instanceId };
});
