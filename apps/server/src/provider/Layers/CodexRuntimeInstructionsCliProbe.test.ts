/**
 * Runs the installed Codex against a local Responses endpoint, without credentials.
 * T3_CODEX_PROMPT_PROBE=1 vp test run src/provider/Layers/CodexRuntimeInstructionsCliProbe.test.ts
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const models = [
  { slug: "gpt-5.3-codex", name: "First Probe Model", isCustom: false, capabilities: null },
  { slug: "gpt-5.4", name: "Second Probe Model", isCustom: false, capabilities: null },
];
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      input: Schema.Array(
        Schema.Struct({
          role: Schema.optionalKey(Schema.String),
          content: Schema.optionalKey(
            Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
          ),
        }),
      ),
    }),
  ),
);

describe.runIf(process.env.T3_CODEX_PROMPT_PROBE === "1")(
  "Codex runtime instructions CLI probe",
  () => {
    it.effect(
      "delivers runtime identity when catalog prompts override collaboration instructions",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const home = NodePath.join(directory, "codex");
          yield* fs.makeDirectory(home);
          const requests = yield* Queue.unbounded<string>();
          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              Queue.offerUnsafe(requests, Buffer.concat(chunks).toString("utf8"));
              response.writeHead(200, { "Content-Type": "text/event-stream" });
              const result = {
                id: "resp_probe",
                object: "response",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              };
              for (const event of [
                { type: "response.created", response: { ...result, status: "in_progress" } },
                { type: "response.completed", response: result },
              ]) {
                response.write(`data: ${encodeJson(event)}\n\n`);
              }
              response.end();
            });
          });
          yield* Effect.promise(
            () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
          );
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
          );
          const address = server.address();
          if (!address || typeof address === "string")
            return yield* Effect.die("Missing probe port");
          const catalogPath = NodePath.join(directory, "models.json");
          yield* fs.writeFileString(
            catalogPath,
            encodeJson({
              models: models.map((model) => ({
                slug: model.slug,
                display_name: model.name,
                description: "Test model",
                default_reasoning_level: "medium",
                supported_reasoning_levels: [{ effort: "medium", description: "Test effort" }],
                shell_type: "unified_exec",
                visibility: "list",
                supported_in_api: true,
                priority: 1,
                model_messages: {
                  instructions_template: "You are a test assistant.",
                  collaboration_modes: {
                    default: "Catalog default mode instructions.",
                    plan: "Catalog plan mode instructions.",
                  },
                },
                support_verbosity: false,
                experimental_supported_tools: [],
                truncation_policy: { mode: "tokens", limit: 10000 },
              })),
            }),
          );
          yield* fs.writeFileString(
            NodePath.join(home, "config.toml"),
            `model = "gpt-5.3-codex"
model_provider = "probe"
model_catalog_json = ${encodeJson(catalogPath)}
[model_providers.probe]
name = "Local probe"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
supports_websockets = false
[analytics]
enabled = false
`,
          );
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make("runtime-prompt-probe"),
            binaryPath: process.env.CODEX_BIN ?? "codex",
            homePath: home,
            cwd: directory,
            runtimeMode: "full-access",
            environment: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: home },
            models: Effect.succeed(models),
          });
          const completed = yield* Queue.unbounded<void>();
          yield* runtime.events.pipe(
            Stream.filter((event) => event.method === "turn/completed"),
            Stream.runForEach(() => Queue.offer(completed, undefined)),
            Effect.forkScoped,
          );
          yield* runtime.start();
          for (const [index, model] of models.entries()) {
            yield* runtime.sendTurn({
              input: "Say OK.",
              model: model.slug,
              effort: "medium",
              interactionMode: index === 0 ? "default" : "plan",
            });
            yield* Queue.take(completed);
            const request = decodeRequest(yield* Queue.take(requests));
            const instructions = request.input
              .filter((item) => item.role === "developer")
              .flatMap((item) => item.content ?? [])
              .map((item) => item.text ?? "")
              .join("\n");
            expect(instructions).toContain("<runtime_info>");
            const runtimeInfo = [
              ...instructions.matchAll(/<runtime_info>(.*?)<\/runtime_info>/g),
            ].at(-1)?.[1];
            expect(runtimeInfo).toContain(model.name);
            expect(runtimeInfo).toContain(request.model);
            expect(runtimeInfo).toContain("medium reasoning effort");
            expect(instructions).toContain("<pull_request_linking>");
          }
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
