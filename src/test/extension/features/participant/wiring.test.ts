/**
 * The @litellm participant's wiring: the enablement lifecycle (ON by default,
 * disposed and recreated as the setting flips) and the adapter that binds the
 * pure turn handler to the host's ChatRequestHandler. What the adapter must
 * get right is narrow but load-bearing: the REQUEST's own model does the
 * sending, the cancellation token rides along, streamed fragments reach the
 * response stream in order, and /models answers from the injected snapshots
 * without a single fetch (msw's onUnhandledRequest: "error" fails the suite on
 * any stray request).
 */
import * as assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SnapshotSource } from "../../../../extension/features/participant/snapshots";
import { wireChatParticipant } from "../../../../extension/features/participant/wiring";
import { PARTICIPANT_ID } from "../../../../shared/config/commandIds";
import { Logger } from "../../../../shared/logger";
import { useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";
import { REPO_ROOT } from "../../../util/repoRoot";

interface RecordedParticipant {
	readonly id: string;
	readonly handler: vscode.ChatRequestHandler;
	iconPath?: vscode.IconPath;
	followupProvider?: vscode.ChatFollowupProvider;
	disposed: boolean;
}

interface WiringSpies {
	readonly participants: RecordedParticipant[];
	fireConfigChange(): void;
}

/**
 * Run `fn` with vscode.chat.createChatParticipant and the configuration
 * watcher recorded instead of real: a second live participant under the same
 * id conflicts in the shared host, and the watcher is captured so tests fire
 * it deterministically.
 */
async function withWiringSpies<T>(fn: (spies: WiringSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const participants: RecordedParticipant[] = [];
	const configListeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];
	const originalCreate = vscode.chat.createChatParticipant;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;

	(vscode.chat as Record<string, unknown>).createChatParticipant = (id: string, handler: vscode.ChatRequestHandler) => {
		const record: RecordedParticipant = { id, handler, disposed: false };
		participants.push(record);
		return {
			id,
			requestHandler: handler,
			dispose: () => {
				record.disposed = true;
			},
			// The wiring assigns iconPath and followupProvider onto the returned
			// object, so the fake must let them land where the test can read them.
			set iconPath(value: vscode.IconPath) {
				record.iconPath = value;
			},
			set followupProvider(value: vscode.ChatFollowupProvider) {
				record.followupProvider = value;
			},
		} as unknown as vscode.ChatParticipant;
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
		listener: (event: vscode.ConfigurationChangeEvent) => void
	) => {
		configListeners.push(listener);
		return new vscode.Disposable(() => {});
	};

	try {
		return await fn({
			participants,
			fireConfigChange: () => {
				for (const listener of [...configListeners]) {
					listener({ affectsConfiguration: () => true });
				}
			},
		});
	} finally {
		(vscode.chat as Record<string, unknown>).createChatParticipant = originalCreate;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
	}
}

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		extensionUri: vscode.Uri.file(REPO_ROOT),
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): { logger: Logger; lines: string[] } {
	const lines: string[] = [];
	const logger = new Logger({
		info(message: string) {
			lines.push(message);
		},
		error() {},
	});
	return { logger, lines };
}

/** One recorded call into the request model's sendRequest. */
interface RecordedSend {
	readonly messages: readonly vscode.LanguageModelChatMessage[];
	readonly token: vscode.CancellationToken | undefined;
}

/**
 * A ChatRequest shaped like the host's, with a model whose sendRequest streams
 * `fragments` and records what it was handed. The whole point of the adapter
 * is that THIS model is what answers, so the fake is the assertion surface.
 */
function fakeRequest(
	options: {
		prompt?: string;
		command?: string | undefined;
		fragments?: readonly string[];
		fail?: Error;
		references?: readonly vscode.ChatPromptReference[];
	} = {}
): { request: vscode.ChatRequest; sends: RecordedSend[] } {
	const sends: RecordedSend[] = [];
	const fragments = options.fragments ?? ["one ", "two"];
	const model = {
		id: "test-model",
		sendRequest: (
			messages: readonly vscode.LanguageModelChatMessage[],
			_options: unknown,
			token: vscode.CancellationToken | undefined
		) => {
			sends.push({ messages, token });
			if (options.fail !== undefined) {
				return Promise.reject(options.fail);
			}
			return Promise.resolve({
				text: (async function* stream() {
					for (const fragment of fragments) {
						yield fragment;
					}
				})(),
			});
		},
	} as unknown as vscode.LanguageModelChat;
	const request = {
		prompt: options.prompt ?? "hello",
		command: options.command,
		references: options.references ?? [],
		toolReferences: [],
		model,
	} as unknown as vscode.ChatRequest;
	return { request, sends };
}

/** A ChatResponseStream that records the markdown it is handed, in order. */
function recordingStream(): { stream: vscode.ChatResponseStream; reported: string[] } {
	const reported: string[] = [];
	const stream = {
		markdown: (value: string | vscode.MarkdownString) => {
			reported.push(typeof value === "string" ? value : value.value);
		},
	} as unknown as vscode.ChatResponseStream;
	return { stream, reported };
}

const EMPTY_CONTEXT = { history: [] } as unknown as vscode.ChatContext;

const SNAPSHOTS: readonly SnapshotSource[] = [
	{
		status: { label: "Team proxy", serverId: "srv-1", state: "ok" },
		models: [
			{ id: "srv-1/gpt-4o-mini", maxInputTokens: 128000, capabilities: { toolCalling: true, imageInput: true } },
			{ id: "srv-1/tiny", maxInputTokens: 4096, capabilities: {} },
		],
	},
];

suite("extension/features/participant wiring", () => {
	useMsw();

	test("enabled by default: one participant under the shared id, with an icon and a followup provider", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
			});
			assert.strictEqual(spies.participants.length, 1, "the participant registers without any opt-in");
			assert.strictEqual(spies.participants[0]?.id, PARTICIPANT_ID);
			assert.ok(spies.participants[0]?.iconPath !== undefined, "the participant carries an icon");
			assert.ok(spies.participants[0]?.followupProvider !== undefined, "the participant carries a followup provider");
		});
	});

	test("disabled wires nothing; the toggle disposes and re-creates around it", async () => {
		await withWiringSpies(async (spies) => {
			const wiring = await withConfig({ "chatParticipant.enabled": false }, () =>
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] })
			);
			assert.strictEqual(spies.participants.length, 0, "disabled must not create a participant");
			// The readiness predicate follows the same lifecycle, because the quick
			// fixes submit turns addressed to @litellm and must not do that into a
			// name with nothing behind it.
			assert.strictEqual(wiring.isRegistered(), false, "no participant means not ready");

			await withConfig({ "chatParticipant.enabled": true }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.participants.length, 1, "enabling creates one");
			assert.strictEqual(wiring.isRegistered(), true, "a live participant reads as ready");

			await withConfig({ "chatParticipant.enabled": false }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.participants[0]?.disposed, true, "disabling disposes it");
			assert.strictEqual(wiring.isRegistered(), false, "and readiness goes with it");

			await withConfig({ "chatParticipant.enabled": true }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.participants.length, 2, "re-enabling creates a fresh one");
			assert.strictEqual(spies.participants[1]?.disposed, false);
			assert.strictEqual(wiring.isRegistered(), true);
		});
	});

	test("a refusing host does not take activation down with it", async () => {
		// createChatParticipant runs on the activation path and inside a
		// configuration listener; a host that refuses the id must cost this
		// feature and nothing else.
		const originalCreate = vscode.chat.createChatParticipant;
		(vscode.chat as Record<string, unknown>).createChatParticipant = () => {
			throw new Error("id already registered");
		};
		const lines: string[] = [];
		const buffered: string[] = [];
		const logger = new Logger(
			{
				info(message: string) {
					lines.push(message);
				},
				error() {},
			},
			{ appendLog: (line) => buffered.push(line), recordError: () => {} }
		);
		let wiring: ReturnType<typeof wireChatParticipant> | undefined;
		try {
			await withConfig({}, () => {
				assert.doesNotThrow(() => {
					wiring = wireChatParticipant(fakeContext(), logger, { getSnapshots: () => [] });
				});
			});
		} finally {
			(vscode.chat as Record<string, unknown>).createChatParticipant = originalCreate;
		}
		assert.ok(
			lines.some((line) => line.includes("chat participant registration failed")),
			"the refusal is classified, not swallowed"
		);
		// Channel-only by design: applyEnablement reruns on every configuration
		// change, and a host that keeps refusing must not evict real errors from
		// the issue-report ring.
		assert.ok(
			buffered.every((line) => !line.includes("chat participant registration failed")),
			"the refusal advisory never reaches the issue-report buffer"
		);
		// The case the enable SETTING cannot see: it says on, and @litellm still
		// cannot answer. A predicate that read the setting would say true here and
		// send the quick fixes' turn nowhere.
		assert.strictEqual(wiring?.isRegistered(), false, "a refused registration must not read as ready");
	});

	test("a repeated toggle in the same direction is a no-op, never a second participant", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "chatParticipant.enabled": true }, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
				spies.fireConfigChange();
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.participants.length, 1);
		});
	});

	test("a plain turn sends through the REQUEST's model with the turn's token and streams every fragment", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => SNAPSHOTS });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({ prompt: "explain this", fragments: ["Hel", "lo"] });
			const { stream, reported } = recordingStream();
			const source = new vscode.CancellationTokenSource();
			try {
				await handler(request, EMPTY_CONTEXT, stream, source.token);
			} finally {
				source.dispose();
			}
			assert.strictEqual(sends.length, 1, "exactly one request, to the request's own model");
			assert.strictEqual(sends[0]?.token, source.token, "the turn's token must ride along so cancel works");
			assert.deepStrictEqual(reported, ["Hel", "lo"], "fragments forward in order, unmerged");
			const [message] = sends[0]?.messages ?? [];
			assert.strictEqual(message?.role, vscode.LanguageModelChatMessageRole.User);
		});
	});

	test("an attached file's CONTENT reaches the model, not just the reference as authored", async () => {
		// ChatRequest.prompt carries references as AUTHORED, so without resolving
		// them "write tests for the selected function" arrives with no function.
		const document = await vscode.workspace.openTextDocument({
			content: "export function add(a, b) {\n\treturn a + b;\n}\n",
			language: "typescript",
		});
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({
				prompt: "write tests for this",
				references: [{ id: "vscode.implicit.file", value: document.uri } as vscode.ChatPromptReference],
			});
			await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 1);
			const content = String((sends[0]?.messages[0]?.content[0] as { value?: unknown } | undefined)?.value ?? "");
			assert.ok(content.includes("write tests for this"), "the user's own text survives");
			assert.ok(content.includes("export function add(a, b)"), `the file content is missing from:\n${content}`);
		});
	});

	test("a Location reference sends only its range, labeled with the line numbers", async () => {
		const document = await vscode.workspace.openTextDocument({
			content: "line one\nline two\nline three\n",
			language: "plaintext",
		});
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({
				prompt: "explain",
				references: [
					{
						id: "vscode.implicit.selection",
						value: new vscode.Location(document.uri, new vscode.Range(1, 0, 1, 8)),
					} as vscode.ChatPromptReference,
				],
			});
			await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
			const content = String((sends[0]?.messages[0]?.content[0] as { value?: unknown } | undefined)?.value ?? "");
			assert.ok(content.includes("line two"), "the selected range rides along");
			assert.ok(!content.includes("line three"), "and nothing outside it does");
			assert.ok(/:2-2\b/.test(content), `the label should carry 1-based line numbers, got:\n${content}`);
		});
	});

	test("an outside-workspace attachment is labeled by its file name, never its absolute path", async () => {
		// asRelativePath hands back the ABSOLUTE path for a file no workspace
		// folder contains, so a raw call here used to ship /Users/<name>/... into
		// the prompt; the shared documentLabel pipeline answers the bare name.
		const dir = await mkdtemp(path.join(tmpdir(), "lvt-label-"));
		const filePath = path.join(dir, "outside-workspace.ts");
		await writeFile(filePath, "const outside = 1;\n");
		try {
			await withWiringSpies(async (spies) => {
				await withConfig({}, () => {
					wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
				});
				const handler = spies.participants[0]?.handler;
				assert.ok(handler !== undefined);
				const { request, sends } = fakeRequest({
					prompt: "explain this file",
					references: [{ id: "vscode.implicit.file", value: vscode.Uri.file(filePath) } as vscode.ChatPromptReference],
				});
				await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
				assert.strictEqual(sends.length, 1);
				const content = String((sends[0]?.messages[0]?.content[0] as { value?: unknown } | undefined)?.value ?? "");
				assert.ok(content.includes("const outside = 1;"), "the file's content still rides along");
				assert.ok(content.includes("outside-workspace.ts"), `the label names the file, got:\n${content}`);
				// fsPath is exactly the string the raw host API used to hand back
				// for an uncontained URI, so this is the leak, verbatim, per platform.
				assert.ok(
					!content.includes(vscode.Uri.file(filePath).fsPath),
					`the absolute path must never reach the prompt:\n${content}`
				);
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("multi-root: same-named attachments in different roots keep distinct labels", async () => {
		// A faithful stand-in for the host's multi-root asRelativePath: the
		// workspace-folder name is prepended for contained files unless the caller
		// opts out. If the shared label pipeline opted out, both attachments below
		// would collapse into one "src/index.ts" and the model could not tell the
		// user's two files apart in one turn.
		const original = vscode.workspace.asRelativePath;
		(vscode.workspace as Record<string, unknown>).asRelativePath = (
			pathOrUri: vscode.Uri | string,
			includeWorkspaceFolder?: boolean
		) => {
			const full = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.path;
			const match = /^\/(root-[ab])\/(.*)$/.exec(full);
			if (match === null) {
				return typeof pathOrUri === "string" ? pathOrUri : pathOrUri.fsPath;
			}
			return includeWorkspaceFolder === false ? (match[2] ?? full) : `${match[1] ?? ""}/${match[2] ?? ""}`;
		};
		try {
			await withWiringSpies(async (spies) => {
				await withConfig({}, () => {
					wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
				});
				const handler = spies.participants[0]?.handler;
				assert.ok(handler !== undefined);
				// Nonexistent on purpose: the unreadable branch still labels through
				// the shared pipeline, and it needs no files on disk to prove this.
				const { request, sends } = fakeRequest({
					prompt: "compare these",
					references: [
						{ id: "file-a", value: vscode.Uri.file("/root-a/src/index.ts") } as vscode.ChatPromptReference,
						{ id: "file-b", value: vscode.Uri.file("/root-b/src/index.ts") } as vscode.ChatPromptReference,
					],
				});
				await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
				assert.strictEqual(sends.length, 1);
				const content = String((sends[0]?.messages[0]?.content[0] as { value?: unknown } | undefined)?.value ?? "");
				assert.ok(content.includes("root-a/src/index.ts"), `the first root's file keeps its prefix:\n${content}`);
				assert.ok(content.includes("root-b/src/index.ts"), `and so does the second root's:\n${content}`);
			});
		} finally {
			(vscode.workspace as Record<string, unknown>).asRelativePath = original;
		}
	});

	test("an unreadable attachment is skipped and classified, and the rest of the turn still answers", async () => {
		await withWiringSpies(async (spies) => {
			const { logger, lines } = quietLogger();
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({
				prompt: "still answer me",
				references: [
					{
						id: "vscode.implicit.file",
						value: vscode.Uri.file("/nonexistent/does-not-exist.ts"),
					} as vscode.ChatPromptReference,
				],
			});
			await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 1, "a dead attachment must not fail the turn");
			const content = String((sends[0]?.messages[0]?.content[0] as { value?: unknown } | undefined)?.value ?? "");
			assert.ok(content.includes("still answer me"), "the question still goes out");
			assert.ok(
				content.includes("could not be read"),
				`the model must be told the attachment is missing, got:\n${content}`
			);
			assert.ok(content.includes("does-not-exist.ts"), "the unreadable attachment is still named");
			assert.ok(
				!content.includes(vscode.Uri.file("/nonexistent/does-not-exist.ts").fsPath),
				`even an unreadable outside-workspace file is named without its absolute path:\n${content}`
			);
			assert.ok(lines.some((line) => line.includes("could not read an attachment")));
		});
	});

	test("/models and the command listing never open an attachment", async () => {
		// Reading attachments costs document opens; a command that answers without
		// the user's code must not pay for context it discards.
		const document = await vscode.workspace.openTextDocument({ content: "some file", language: "plaintext" });
		const reference = { id: "vscode.implicit.file", value: document.uri } as vscode.ChatPromptReference;
		const originalOpen = vscode.workspace.openTextDocument;
		let opens = 0;
		(vscode.workspace as Record<string, unknown>).openTextDocument = (...args: unknown[]) => {
			opens += 1;
			return (originalOpen as (...a: unknown[]) => unknown)(...args);
		};
		try {
			await withWiringSpies(async (spies) => {
				await withConfig({}, () => {
					wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => SNAPSHOTS });
				});
				const handler = spies.participants[0]?.handler;
				assert.ok(handler !== undefined);
				for (const options of [{ prompt: "", command: "models" }, { prompt: "" }]) {
					const { request } = fakeRequest({ ...options, references: [reference] });
					await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
				}
				assert.strictEqual(opens, 0, "neither path may read an attachment");

				// And the positive control: a path that DOES use the code reads it,
				// EXACTLY once - "at least once" would still pass with memoization
				// removed, which is the property the thunk exists for.
				const { request } = fakeRequest({ prompt: "write tests", command: "tests", references: [reference] });
				await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
				assert.strictEqual(opens, 1, "a prompt-shaping command reads the attachment once");
			});
		} finally {
			(vscode.workspace as Record<string, unknown>).openTextDocument = originalOpen;
		}
	});

	test("a command asking twice, or concurrently, still opens the document once", async () => {
		// The seam F5 registers through can ask for attachments more than once;
		// the memo is what keeps that from re-reading every file per call.
		const document = await vscode.workspace.openTextDocument({ content: "shared", language: "plaintext" });
		const originalOpen = vscode.workspace.openTextDocument;
		let opens = 0;
		(vscode.workspace as Record<string, unknown>).openTextDocument = (...args: unknown[]) => {
			opens += 1;
			return (originalOpen as (...a: unknown[]) => unknown)(...args);
		};
		try {
			await withWiringSpies(async (spies) => {
				const wiring = await withConfig({}, () =>
					wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] })
				);
				let seen: readonly unknown[][] = [];
				wiring.slashCommands.register({
					name: "twice",
					description: "asks for its attachments more than once",
					run: async (turn) => {
						// Sequential and concurrent, both through the memo.
						const first = await turn.attachments();
						const [second, third] = await Promise.all([turn.attachments(), turn.attachments()]);
						seen = [[...first], [...second], [...third]];
					},
				});
				const handler = spies.participants[0]?.handler;
				assert.ok(handler !== undefined);
				const { request } = fakeRequest({
					prompt: "go",
					command: "twice",
					references: [{ id: "vscode.implicit.file", value: document.uri } as vscode.ChatPromptReference],
				});
				await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
				assert.strictEqual(opens, 1, "three asks, one read");
				assert.strictEqual(seen.length, 3);
				// The same resolved list every time, not three independent reads.
				assert.deepStrictEqual(seen[1], seen[0]);
				assert.deepStrictEqual(seen[2], seen[0]);
			});
		} finally {
			(vscode.workspace as Record<string, unknown>).openTextDocument = originalOpen;
		}
	});

	test("attachments do not make an empty prompt look like a question", async () => {
		const document = await vscode.workspace.openTextDocument({ content: "some file", language: "plaintext" });
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({
				prompt: "",
				references: [{ id: "vscode.implicit.file", value: document.uri } as vscode.ChatPromptReference],
			});
			const { stream, reported } = recordingStream();
			await handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 0, "@litellm with a file open must not ship the file nowhere");
			assert.ok(reported.join("").includes("/models"), "it lists the commands instead");
		});
	});

	test("/models answers from the seeded snapshots with raw ids and zero fetches", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => SNAPSHOTS });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({ prompt: "", command: "models" });
			const { stream, reported } = recordingStream();
			await handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 0, "/models must not reach a model");
			const markdown = reported.join("");
			assert.ok(markdown.includes("### Team proxy"), "the group's label heads its section");
			// The exposed id was namespaced with the server id; the answer shows
			// the RAW id, which is what the user writes in settings.
			assert.ok(markdown.includes("`gpt-4o-mini`"), `raw model id missing from:\n${markdown}`);
			assert.ok(!markdown.includes("srv-1/"), "the host-namespaced id must not leak into the answer");
			assert.ok(
				markdown.includes("128k context"),
				`the capability summary should carry the context window:\n${markdown}`
			);
			assert.ok(markdown.includes("tools"), "the capability summary carries tool support");
		});
	});

	test("an empty prompt lists the commands instead of sending an empty request", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({ prompt: "   " });
			const { stream, reported } = recordingStream();
			await handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 0);
			assert.ok(reported.join("").includes("/models"), "the listing names the built-in commands");
		});
	});

	test("a failed turn logs one classification, tells the user nothing about the error, and offers no followups", async () => {
		await withWiringSpies(async (spies) => {
			const { logger, lines } = quietLogger();
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), logger, { getSnapshots: () => [] });
			});
			const participant = spies.participants[0];
			assert.ok(participant !== undefined);
			const failure = Object.assign(new Error("upstream said: sk-secret-leaked"), {
				logClassification: "Timeout(15000ms)",
			});
			const { request } = fakeRequest({ fail: failure });
			const { stream, reported } = recordingStream();
			const result = await participant.handler(
				request,
				EMPTY_CONTEXT,
				stream,
				new vscode.CancellationTokenSource().token
			);
			const logged = lines.filter((line) => line.includes("chat participant turn failed"));
			assert.strictEqual(logged.length, 1, "one line from the one logging boundary");
			assert.ok(logged[0]?.includes("Timeout(15000ms)"), "the classification names the failure");
			assert.ok(!lines.join("\n").includes("sk-secret-leaked"), "response-derived text must never reach the log");
			assert.ok(!reported.join("").includes("sk-secret-leaked"), "nor the user-facing text");

			const followups = await participant.followupProvider?.provideFollowups(
				result as vscode.ChatResult,
				EMPTY_CONTEXT,
				new vscode.CancellationTokenSource().token
			);
			assert.deepStrictEqual(followups, [], "a failed turn invites no retries");
		});
	});

	test("cancellation rides out uncaught and unlogged", async () => {
		await withWiringSpies(async (spies) => {
			const { logger, lines } = quietLogger();
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), logger, { getSnapshots: () => [] });
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request } = fakeRequest({ fail: new vscode.CancellationError() });
			const { stream, reported } = recordingStream();
			await assert.rejects(
				Promise.resolve(handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token)),
				(error: unknown) => error instanceof vscode.CancellationError
			);
			assert.deepStrictEqual(reported, [], "a canceled turn writes no failure text");
			assert.ok(!lines.some((line) => line.includes("chat participant turn failed")));
		});
	});

	test("a throwing snapshot source fails the turn like any other, through the one error path", async () => {
		// Lazily read and inside the handler's own try, so a snapshot failure is
		// one friendly text plus one classification - not a half-answer pairing
		// "could not read the servers" with "no servers are connected".
		await withWiringSpies(async (spies) => {
			const { logger, lines } = quietLogger();
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), logger, {
					getSnapshots: () => {
						throw new RangeError("snapshot read blew up");
					},
				});
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({ prompt: "", command: "models" });
			const { stream, reported } = recordingStream();
			await handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(sends.length, 0);
			assert.strictEqual(reported.length, 1, "one message, not a contradictory pair");
			assert.ok(reported[0]?.includes("Something went wrong"), `unexpected answer: ${reported[0] ?? ""}`);
			const logged = lines.filter((line) => line.includes("chat participant turn failed"));
			assert.strictEqual(logged.length, 1);
			assert.ok(logged[0]?.includes("RangeError"), "the read failure is classified, not swallowed");
		});
	});

	test("a plain question never reads the snapshots at all", async () => {
		await withWiringSpies(async (spies) => {
			let reads = 0;
			await withConfig({}, () => {
				wireChatParticipant(fakeContext(), quietLogger().logger, {
					getSnapshots: () => {
						reads += 1;
						return [];
					},
				});
			});
			const handler = spies.participants[0]?.handler;
			assert.ok(handler !== undefined);
			const { request } = fakeRequest({ prompt: "explain this" });
			await handler(request, EMPTY_CONTEXT, recordingStream().stream, new vscode.CancellationTokenSource().token);
			assert.strictEqual(reads, 0, "only a command that asks for snapshots may read them");
		});
	});
	test("the registration seam survives the enablement toggle and reaches the handler", async () => {
		await withWiringSpies(async (spies) => {
			const wiring = await withConfig({ "chatParticipant.enabled": true }, () =>
				wireChatParticipant(fakeContext(), quietLogger().logger, { getSnapshots: () => [] })
			);
			wiring.slashCommands.register({
				name: "seamtest",
				description: "registered through the seam",
				run: (turn) => {
					turn.report("seam answered");
					return Promise.resolve();
				},
			});
			// A disable/enable cycle disposes the participant, not the table.
			await withConfig({ "chatParticipant.enabled": false }, () => {
				spies.fireConfigChange();
			});
			await withConfig({ "chatParticipant.enabled": true }, () => {
				spies.fireConfigChange();
			});
			const handler = spies.participants[spies.participants.length - 1]?.handler;
			assert.ok(handler !== undefined);
			const { request, sends } = fakeRequest({ prompt: "anything", command: "seamtest" });
			const { stream, reported } = recordingStream();
			await handler(request, EMPTY_CONTEXT, stream, new vscode.CancellationTokenSource().token);
			assert.deepStrictEqual(reported, ["seam answered"]);
			assert.strictEqual(sends.length, 0);
		});
	});
});
