/**
 * `t3 thread` - list, read, and message threads on the local running server.
 *
 * Uses the same HTTP API as `t3 project`, with a session that only has the
 * orchestration scopes and is revoked on exit. There is no offline mode: a
 * turn needs the running server's provider sessions.
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentHttpApi,
  MessageId,
  type ClientOrchestrationCommand,
  type OrchestrationLatestTurnState,
  OrchestrationMessageRole,
  OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { projectCommandErrorFromLiveServerRequest } from "./project.ts";

const THREAD_CLI_REQUEST_TIMEOUT = Duration.seconds(10);
const THREAD_POLL_INTERVAL = Duration.seconds(2);

export class ThreadServerNotRunningError extends Schema.TaggedError<ThreadServerNotRunningError>()(
  "ThreadServerNotRunningError",
  {},
) {
  override get message(): string {
    return "T3 Code is not running. Open the desktop app or run `t3`.";
  }
}

export class ThreadNotFoundError extends Schema.TaggedError<ThreadNotFoundError>()(
  "ThreadNotFoundError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Thread '${this.threadId}' not found.`;
  }
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { project: Schema.String },
) {
  override get message(): string {
    return `Project '${this.project}' not found.`;
  }
}

export class ThreadPromptEmptyError extends Schema.TaggedError<ThreadPromptEmptyError>()(
  "ThreadPromptEmptyError",
  {},
) {
  override get message(): string {
    return "Message is empty.";
  }
}

export class ThreadTurnEndedError extends Schema.TaggedError<ThreadTurnEndedError>()(
  "ThreadTurnEndedError",
  {
    outcome: Schema.Literals(["needs-input", "interrupted", "error"]),
    detail: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    switch (this.outcome) {
      case "needs-input":
        return "Thread is waiting on an approval or answer. Resolve it in T3 Code.";
      case "interrupted":
        return "The turn was interrupted.";
      case "error":
        return this.detail === null ? "The turn failed." : `The turn failed: ${this.detail}`;
    }
  }
}

const ThreadStatus = Schema.Union([OrchestrationSessionStatus, Schema.Literal("needs-input")]);

const encodeThreadList = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        id: ThreadId,
        title: Schema.String,
        project: Schema.String,
        status: ThreadStatus,
        lastActivityAt: Schema.String,
      }),
    ),
    { space: 2 },
  ),
);

const encodeThreadShow = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      id: ThreadId,
      title: Schema.String,
      status: OrchestrationSessionStatus,
      messages: Schema.Array(
        Schema.Struct({
          id: MessageId,
          role: OrchestrationMessageRole,
          text: Schema.String,
          createdAt: Schema.String,
        }),
      ),
    }),
    { space: 2 },
  ),
);

const threadStatus = (thread: OrchestrationThreadShell): typeof ThreadStatus.Type =>
  thread.hasPendingApprovals || thread.hasPendingUserInput
    ? "needs-input"
    : (thread.session?.status ?? "idle");

const isThreadBusy = (thread: OrchestrationThreadShell) =>
  thread.session?.status === "running" || thread.session?.status === "starting";

/**
 * How the turn requested at `requestedAt` ended, or undefined while it runs.
 * `requestedAt` is the sent message's `createdAt`. The server gives the turn
 * that message starts the same `latestTurn.requestedAt`. A turn that fails to
 * start sets the session to error with that same timestamp instead.
 */
export const turnOutcome = (
  thread: OrchestrationThreadShell,
  requestedAt: string,
): Exclude<OrchestrationLatestTurnState, "running"> | "needs-input" | undefined => {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-input";
  const turn = thread.latestTurn;
  if (turn?.requestedAt === requestedAt) {
    return turn.state === "running" ? undefined : turn.state;
  }
  if (thread.session?.status === "error" && thread.session.updatedAt === requestedAt) {
    return "error";
  }
  return undefined;
};

const threadCliUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

/** Reads the message argument, or stdin when it is `-`. */
const readMessage = Effect.fn("readThreadMessage")(function* (message: string) {
  const text =
    message === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : message;
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return yield* new ThreadPromptEmptyError();
  }
  return trimmed;
});

/** Connects to the running server. The session is revoked when the scope closes. */
const connectLiveServer = Effect.fn("connectThreadCliServer")(function* (
  config: ServerConfig.ServerConfig["Service"],
) {
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState) || !isProcessAlive(runtimeState.value.pid)) {
    return yield* new ThreadServerNotRunningError();
  }
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* Effect.acquireRelease(
    environmentAuth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      label: "t3 thread cli",
      // Bounds the leak if the process is killed before it can revoke.
      ttl: Duration.days(1),
    }),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: runtimeState.value.origin,
  });
  const headers = { authorization: `Bearer ${session.token}` };
  const call = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeout(THREAD_CLI_REQUEST_TIMEOUT),
      Effect.mapError(projectCommandErrorFromLiveServerRequest),
    );

  const shell = call(client.orchestration.shellSnapshot({ headers }));
  return {
    shell,
    /** Reads one thread from the shell snapshot. */
    threadShell: (threadId: ThreadId) =>
      shell.pipe(
        Effect.flatMap((snapshot) => {
          const thread = snapshot.threads.find((candidate) => candidate.id === threadId);
          return thread === undefined
            ? new ThreadNotFoundError({ threadId })
            : Effect.succeed(thread);
        }),
      ),
    /** Reads the messages of the latest `turns` user turns. */
    threadDetail: (threadId: ThreadId, turns: number) =>
      call(
        client.orchestration.threadSnapshot({
          headers,
          params: { threadId },
          payload: { turnLimit: turns },
        }),
      ).pipe(
        Effect.catchIf(
          (error) =>
            error._tag === "ProjectLiveServerDeclaredResponseError" && error.code === "not_found",
          () => new ThreadNotFoundError({ threadId }),
        ),
      ),
    dispatch: (command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>) =>
      call(client.orchestration.dispatch({ headers, payload: command })),
  };
});

type LiveServer = Effect.Success<ReturnType<typeof connectLiveServer>>;

/** Reads the thread every poll interval until `done` returns a value. */
const pollThread = <A>(
  server: LiveServer,
  threadId: ThreadId,
  done: (thread: OrchestrationThreadShell) => A | undefined,
) =>
  Effect.gen(function* () {
    for (;;) {
      const result = done(yield* server.threadShell(threadId));
      if (result !== undefined) return result;
      yield* Effect.sleep(THREAD_POLL_INTERVAL);
    }
  });

/** Runs `run` against the live server and prints what it returns. */
const runWithLiveServer = <E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json?: boolean },
  run: (server: LiveServer) => Effect.Effect<string, E, R>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    // Keep server logs out of output that scripts parse.
    const logLevel = flags.json === true ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      yield* Console.log(yield* run(yield* connectLiveServer(config)));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, logLevel)),
        ),
      ),
    );
  });

const threadIdArgument = Argument.String("thread").pipe(
  Argument.withSchema(ThreadId),
  Argument.withDescription("Thread id, from `t3 thread list`."),
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON."),
  Flag.withDefault(false),
);

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Only list threads in this project (id or path)."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List threads that are not archived, most recent first."),
  Command.withHandler((flags) =>
    runWithLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const snapshot = yield* server.shell;
        let projects = snapshot.projects;
        if (Option.isSome(flags.project)) {
          const path = yield* Path.Path;
          const wanted = flags.project.value.trim();
          const wantedPath = normalizeProjectPathForComparison(path.resolve(wanted));
          projects = projects.filter(
            (project) =>
              project.id === wanted ||
              normalizeProjectPathForComparison(project.workspaceRoot) === wantedPath,
          );
          if (projects.length === 0) {
            return yield* new ThreadProjectNotFoundError({ project: wanted });
          }
        }
        const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
        const lastActivity = (thread: OrchestrationThreadShell) =>
          thread.latestUserMessageAt ?? thread.createdAt;
        const threads = snapshot.threads
          .filter((thread) => thread.archivedAt === null && projectTitles.has(thread.projectId))
          .toSorted((a, b) => lastActivity(b).localeCompare(lastActivity(a)))
          .map((thread) => ({
            id: thread.id,
            title: thread.title,
            project: projectTitles.get(thread.projectId)!,
            status: threadStatus(thread),
            lastActivityAt: lastActivity(thread),
          }));
        if (flags.json) {
          return yield* encodeThreadList(threads);
        }
        if (threads.length === 0) {
          return "No threads.";
        }
        return threads
          .map((thread) => `${thread.id}  ${thread.status}  ${thread.project}  ${thread.title}`)
          .join("\n");
      }),
    ),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadIdArgument,
  turns: Flag.Int("turns").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    Flag.withDescription("How many of the latest turns to print."),
    Flag.withDefault(1),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Print the latest messages in a thread."),
  Command.withHandler((flags) =>
    runWithLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const { thread } = yield* server.threadDetail(flags.thread, flags.turns);
        const messages = thread.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt }));
        const status = thread.session?.status ?? "idle";
        if (flags.json) {
          return yield* encodeThreadShow({ id: thread.id, title: thread.title, status, messages });
        }
        return [
          `${thread.title} (${status})`,
          ...messages.map((message) => `\n[${message.role}]\n${message.text}`),
        ].join("\n");
      }),
    ),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadIdArgument,
  message: Argument.String("message").pipe(
    Argument.withDescription("Message to send, or `-` to read it from stdin."),
  ),
  wait: Flag.Boolean("wait").pipe(
    Flag.withDescription("Wait for the turn to end and print the agent's reply."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Send a message to a thread. If the agent is working, waits for its turn to end first.",
  ),
  Command.withHandler((flags) =>
    runWithLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const text = yield* readMessage(flags.message);
        let thread = yield* server.threadShell(flags.thread);
        // Sending to a busy thread steers its running turn, and some providers
        // interrupt the agent to do it. Queue behind the turn instead.
        if (isThreadBusy(thread)) {
          yield* Console.error("Waiting for the current turn to end...");
          thread = yield* pollThread(server, flags.thread, (candidate) =>
            isThreadBusy(candidate) ? undefined : candidate,
          );
        }
        if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
          return yield* new ThreadTurnEndedError({ outcome: "needs-input", detail: null });
        }

        const messageId = MessageId.make(yield* threadCliUuid);
        yield* server.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* threadCliUuid),
          threadId: thread.id,
          message: { messageId, role: "user", text, attachments: [] },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        if (!flags.wait) {
          return `Sent to ${thread.title}.`;
        }

        // The server replaces the command's createdAt with its own clock, so
        // read the stamp back from the message. Dispatch returns after the
        // projection commits, so the message is already there.
        const sent = (yield* server.threadDetail(thread.id, 1)).thread.messages.find(
          (message) => message.id === messageId,
        );
        if (sent === undefined) {
          return yield* Effect.die(
            new Error(`Sent message ${messageId} is missing from the thread.`),
          );
        }
        const ended = yield* pollThread(server, thread.id, (candidate) => {
          const outcome = turnOutcome(candidate, sent.createdAt);
          return outcome === undefined ? undefined : { outcome, thread: candidate };
        });
        if (ended.outcome !== "completed") {
          return yield* new ThreadTurnEndedError({
            outcome: ended.outcome,
            detail: ended.thread.session?.lastError ?? null,
          });
        }
        const turnId = ended.thread.latestTurn?.turnId;
        const { thread: detail } = yield* server.threadDetail(thread.id, 1);
        return (
          detail.messages.findLast(
            (message) => message.role === "assistant" && message.turnId === turnId,
          )?.text ?? ""
        );
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("List, read, and message threads on the running T3 Code server."),
  Command.withSubcommands([threadListCommand, threadShowCommand, threadSendCommand]),
);
