/**
 * The quick-fix feature end to end in the host: what the lightbulb offers and
 * what it costs to offer it, what an invoked action asks the chat view for, and
 * what happens when that view is not there.
 *
 * The zero-network property is the load-bearing one: provideCodeActions runs on
 * every cursor move in a file with diagnostics, so a request there would send
 * the user's code somewhere without them clicking anything. It is pinned twice
 * over - by msw's onUnhandledRequest: "error" and by a fetch spy, because a
 * request to an ALREADY-MOCKED endpoint would satisfy msw and still be a
 * request.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { QuickFixChatArgs } from "../../../../extension/features/quickFix/actionsProvider";
import { createQuickFixActionsProvider } from "../../../../extension/features/quickFix/actionsProvider";
import { runQuickFixChat } from "../../../../extension/features/quickFix/openChat";
import { createQuickFixProbe, wireQuickFix } from "../../../../extension/features/quickFix/wiring";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import type { Logger } from "../../../../shared/logger";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { makeLogger } from "../../../pureHelpers";
import { withConfig } from "../../../testUtils";

/** The settings that make the feature live against the msw-mocked server. */
const ENABLED_CONFIG = {
	"quickFix.enabled": true,
	"quickFix.model": { server: "alpha", model: "gpt-test" },
	servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }],
};

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: {
			get: () => Promise.resolve(undefined),
			store: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		} as unknown as vscode.SecretStorage,
	} as unknown as vscode.ExtensionContext;
}

function deps(logger?: Logger): Parameters<typeof runQuickFixChat>[1] {
	return {
		secrets: {
			get: () => Promise.resolve(undefined),
			store: () => Promise.resolve(),
			delete: () => Promise.resolve(),
		} as unknown as vscode.SecretStorage,
		logger: logger ?? makeLogger().logger,
		outputChannel: { show: () => {}, appendLine: () => {} } as unknown as vscode.OutputChannel,
		// The participant is live unless a test says otherwise; that is the state
		// the primary path exists for.
		isParticipantAvailable: () => true,
	};
}

function client(): OneShotClient {
	return new OneShotClient({ userAgent: "test-agent" });
}

function diagnostic(message: string, line: number, severity = vscode.DiagnosticSeverity.Error): vscode.Diagnostic {
	const item = new vscode.Diagnostic(new vscode.Range(line, 4, line, 9), message, severity);
	item.source = "ts";
	item.code = 2304;
	return item;
}

/** A document with a handful of lines, so the claimed range has room to pad into. */
async function sampleDocument(): Promise<vscode.TextDocument> {
	return vscode.workspace.openTextDocument({
		content: ["const a = 1;", "const b = 2;", "return total;", "const c = 3;", "const d = 4;"].join("\n"),
		language: "typescript",
	});
}

function actionContext(diagnostics: readonly vscode.Diagnostic[]): vscode.CodeActionContext {
	return {
		diagnostics,
		only: undefined,
		triggerKind: vscode.CodeActionTriggerKind.Automatic,
	} as unknown as vscode.CodeActionContext;
}

/** The command payload an action carries; the assertion surface for what an invocation would send. */
function argsOf(action: vscode.CodeAction): QuickFixChatArgs {
	const [first] = action.command?.arguments ?? [];
	assert.ok(first !== undefined, "the action carries no command payload");
	return first as QuickFixChatArgs;
}

/**
 * Run `fn` with global fetch counted, so an "instant" path can be proven to
 * have made no call at all. Synchronous on purpose: the property is that the
 * provider does its whole job inside this window, which a promise-returning
 * spy could not distinguish from one that fetches after the window closes.
 */
function withFetchSpy<T>(fn: () => T): { result: T; calls: number } {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		calls += 1;
		return original(...args);
	}) as typeof fetch;
	try {
		return { result: fn(), calls };
	} finally {
		globalThis.fetch = original;
	}
}

suite("extension/features/quickFix wiring", () => {
	useMsw();

	// Toast promises stay pending until dismissed in a live host, which would
	// hang any await on showActionableMessage; the stubs record and resolve.
	const shownMessages: string[] = [];
	let origInfo: unknown;
	let origWarn: unknown;
	let origError: unknown;
	setup(() => {
		shownMessages.length = 0;
		const record = (message: string) => {
			shownMessages.push(message);
			return Promise.resolve(undefined);
		};
		origInfo = vscode.window.showInformationMessage;
		origWarn = vscode.window.showWarningMessage;
		origError = vscode.window.showErrorMessage;
		(vscode.window as Record<string, unknown>).showInformationMessage = record;
		(vscode.window as Record<string, unknown>).showWarningMessage = record;
		(vscode.window as Record<string, unknown>).showErrorMessage = record;
	});
	teardown(() => {
		(vscode.window as Record<string, unknown>).showInformationMessage = origInfo;
		(vscode.window as Record<string, unknown>).showWarningMessage = origWarn;
		(vscode.window as Record<string, unknown>).showErrorMessage = origError;
	});

	test("actions appear instantly, synchronously, and without a single request", async () => {
		const document = await sampleDocument();
		const provider = createQuickFixActionsProvider();
		const { result, calls } = withFetchSpy(() =>
			provider.provideCodeActions(
				document,
				new vscode.Range(2, 0, 2, 0),
				actionContext([diagnostic("Cannot find name 'total'.", 2)]),
				new vscode.CancellationTokenSource().token
			)
		);
		// Synchronous by contract: an await here would put this feature in the
		// editor's per-keystroke latency path.
		assert.ok(Array.isArray(result), "provideCodeActions must answer synchronously, not with a promise");
		const actions = result as vscode.CodeAction[];
		assert.strictEqual(actions.length, 2, "one Fix action and one Explain action");
		assert.strictEqual(calls, 0, "offering an action must cost zero requests");
		for (const action of actions) {
			assert.strictEqual(action.kind?.value, vscode.CodeActionKind.QuickFix.value);
			assert.strictEqual(action.diagnostics?.length, 1, "the action is attached to the diagnostic it claims");
			assert.notStrictEqual(action.isPreferred, true, "an AI action must never outrank a real quick fix");
		}
		assert.deepStrictEqual(
			actions.map((action) => argsOf(action).mode),
			["fix", "explain"]
		);
	});

	test("no diagnostics, no actions: clean code gets no LiteLLM entry in its lightbulb", async () => {
		const document = await sampleDocument();
		const actions = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(0, 0, 0, 0),
			actionContext([]),
			new vscode.CancellationTokenSource().token
		);
		assert.deepStrictEqual(actions, []);
	});

	test("the claimed range pads to whole lines and clamps to the document", async () => {
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(0, 0, 0, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 0)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		const { range } = argsOf(fix);
		assert.strictEqual(range.start.line, 0, "padding above line 0 clamps rather than going negative");
		assert.strictEqual(range.start.character, 0, "the range starts at the line, never mid-token");
		assert.strictEqual(range.end.line, 2, "two lines of context ride below");
		assert.strictEqual(range.end.character, document.lineAt(2).range.end.character);
	});

	test("an invoked action opens chat with the built query and the claimed lines attached", async () => {
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		let seen: { query: string; uri: vscode.Uri; range: vscode.Range } | undefined;
		await withConfig(ENABLED_CONFIG, () =>
			runQuickFixChat(
				client(),
				{
					...deps(),
					openChat: (query, uri, range) => {
						seen = { query, uri, range };
						return Promise.resolve(undefined);
					},
				},
				argsOf(fix)
			)
		);
		assert.ok(seen !== undefined, "the chat view is the primary path and must be tried first");
		assert.strictEqual(seen.query, "@litellm /fix Cannot find name 'total'.");
		assert.strictEqual(seen.uri.toString(), document.uri.toString());
		assert.strictEqual(seen.range.start.line, 0, "the attachment carries the padded claimed lines");
	});

	test("when the chat view refuses, the fallback answers into a new untitled markdown editor", async () => {
		const document = await sampleDocument();
		const [, explain] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(explain !== undefined);
		let prompt = "";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompt = body.messages[0]?.content ?? "";
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "## The fix\n\n`total`" } }] });
			})
		);
		const opened: vscode.TextDocument[] = [];
		const originalShow = vscode.window.showTextDocument;
		(vscode.window as Record<string, unknown>).showTextDocument = (shown: vscode.TextDocument) => {
			opened.push(shown);
			return Promise.resolve({} as vscode.TextEditor);
		};
		try {
			await withConfig(ENABLED_CONFIG, () =>
				runQuickFixChat(
					client(),
					{ ...deps(), openChat: () => Promise.reject(new Error("no chat extension installed")) },
					argsOf(explain)
				)
			);
		} finally {
			(vscode.window as Record<string, unknown>).showTextDocument = originalShow;
		}
		assert.strictEqual(opened.length, 1, "the answer opens as its own editor");
		assert.strictEqual(opened[0]?.languageId, "markdown");
		assert.strictEqual(opened[0]?.isUntitled, true, "nothing is ever written into the user's own file");
		assert.ok(opened[0]?.getText().includes("## The fix"), "the model's answer is what the editor holds");
		assert.ok(prompt.includes("Cannot find name 'total'."), "the diagnostic rides the fallback prompt");
		assert.ok(prompt.includes("return total;"), "so do the claimed lines");
	});

	test("a disabled invocation answers with the enable hint and reaches neither chat nor a model", async () => {
		// No msw handler for the chat endpoint: any request would fail the test
		// through onUnhandledRequest: "error".
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		let chatOpens = 0;
		await withConfig({ ...ENABLED_CONFIG, "quickFix.enabled": false }, () =>
			runQuickFixChat(
				client(),
				{
					...deps(),
					openChat: () => {
						chatOpens += 1;
						return Promise.resolve(undefined);
					},
				},
				argsOf(fix)
			)
		);
		assert.strictEqual(chatOpens, 0, "a disabled feature must not open chat either");
		assert.ok(
			shownMessages.some((message) => message.includes("quickFix.enabled")),
			`the enable hint names the setting, got ${JSON.stringify(shownMessages)}`
		);
	});

	test("the no-model advice names the cause: a disabled participant is not a broken chat view", async () => {
		// Before the readiness gate, runFallback was only ever reached by a real
		// chat.open failure, so one message could serve. Now it can be reached
		// because the user turned @litellm off, and telling them the chat view
		// broke would send them looking for a fault that is not there.
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		await withConfig({ ...ENABLED_CONFIG, "quickFix.model": null }, () =>
			runQuickFixChat(
				client(),
				{
					...deps(),
					isParticipantAvailable: () => false,
					openChat: () => Promise.reject(new Error("never reached")),
				},
				argsOf(fix)
			)
		);
		const message = shownMessages.join("\n");
		assert.ok(message.includes("chatParticipant.enabled"), `the advice offers the real fix, got ${message}`);
		assert.ok(message.includes("quickFix.model"), "and still names the model setting");
		assert.ok(!message.includes("could not be opened"), "the chat view did not fail; do not say it did");
		// The predicate answers one question - can @litellm answer - so the advice
		// must not assert WHICH half is missing; the setting may well be on.
		assert.ok(!message.includes("Re-enable"), `registration may have been refused with the setting on: ${message}`);
	});

	test("a chat failure with no model configured advises rather than silently doing nothing", async () => {
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		await withConfig({ ...ENABLED_CONFIG, "quickFix.model": null }, () =>
			runQuickFixChat(
				client(),
				{ ...deps(), openChat: () => Promise.reject(new Error("no chat extension installed")) },
				argsOf(fix)
			)
		);
		assert.ok(
			shownMessages.some((message) => message.includes("quickFix.model")),
			`the advice names the model setting, got ${JSON.stringify(shownMessages)}`
		);
	});

	test("a malformed payload is a logged no-op, never a throw out of a command handler", async () => {
		const { logger, lines } = makeLogger();
		const validRange = new vscode.Range(0, 0, 0, 1);
		const validUri = vscode.Uri.file("/tmp/sample.ts");
		const bad: unknown[] = [
			undefined,
			null,
			{},
			{ mode: "fix" },
			{ uri: "not-a-uri", range: 1, diagnostics: [] },
			// The array is present and the outer shape is right; its CONTENTS are
			// junk. Without per-element validation these reach selectDiagnostics and
			// throw a TypeError out of the command handler.
			{ uri: validUri, range: validRange, diagnostics: [null], mode: "fix" },
			{ uri: validUri, range: validRange, diagnostics: [{}], mode: "fix" },
			{ uri: validUri, range: validRange, diagnostics: [{ message: 1, range: validRange, severity: 0 }], mode: "fix" },
			// source and code are read by the prompt builder too, so the boundary
			// has to cover them or the "typed precondition" it promises is fiction.
			{
				uri: validUri,
				range: validRange,
				diagnostics: [{ message: "x", range: validRange, severity: 0, source: 5 }],
				mode: "fix",
			},
			{
				uri: validUri,
				range: validRange,
				diagnostics: [{ message: "x", range: validRange, severity: 0, code: { value: {} } }],
				mode: "fix",
			},
			// Nothing usable to ask about: the chat path would submit a bare
			// "@litellm /fix" and the fallback would pay for an empty question.
			{ uri: validUri, range: validRange, diagnostics: [], mode: "fix" },
			{
				uri: validUri,
				range: validRange,
				diagnostics: [new vscode.Diagnostic(validRange, "   ", vscode.DiagnosticSeverity.Error)],
				mode: "fix",
			},
		];
		let chatOpens = 0;
		let requests = 0;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => {
				requests += 1;
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "never" } }] });
			})
		);
		await withConfig(ENABLED_CONFIG, async () => {
			for (const payload of bad) {
				await runQuickFixChat(
					client(),
					{
						...deps(logger),
						openChat: () => {
							chatOpens += 1;
							return Promise.resolve(undefined);
						},
					},
					payload
				);
			}
		});
		assert.strictEqual(chatOpens, 0, "an unusable payload must not reach the chat view");
		assert.strictEqual(requests, 0, "nor a model");
		assert.strictEqual(
			lines.filter((line) => line.includes("without a usable payload")).length,
			bad.length,
			`each bad payload is classified once, got ${JSON.stringify(lines)}`
		);
	});

	test("with no live participant the chat path is skipped outright, not tried and believed", async () => {
		// chat.open SUBMITS the query. With no participant behind @litellm the
		// turn - diagnostics and attached code - goes out addressed to something
		// that is not there, and the command RESOLVES either way, so no try/catch
		// could notice. The only way to be right here is not to go. Driven through
		// the readiness predicate rather than the setting, because a refused
		// REGISTRATION is the case the setting cannot see.
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		let chatOpens = 0;
		let prompt = "";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompt = body.messages[0]?.content ?? "";
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "fallback answered" } }] });
			})
		);
		const originalShow = vscode.window.showTextDocument;
		(vscode.window as Record<string, unknown>).showTextDocument = () => Promise.resolve({} as vscode.TextEditor);
		try {
			await withConfig(ENABLED_CONFIG, () =>
				runQuickFixChat(
					client(),
					{
						...deps(),
						isParticipantAvailable: () => false,
						openChat: () => {
							chatOpens += 1;
							return Promise.resolve(undefined);
						},
					},
					argsOf(fix)
				)
			);
		} finally {
			(vscode.window as Record<string, unknown>).showTextDocument = originalShow;
		}
		assert.strictEqual(chatOpens, 0, "a participant that cannot answer must not be handed the turn");
		assert.ok(prompt.includes("Cannot find name 'total'."), "the fallback answers instead");
	});

	test("disabling the feature while the chat view is failing cancels the fallback", async () => {
		// The fallback runs after an await on another extension's command; a user
		// who turned quick fixes off in that window has said what they want, and
		// sending their code anyway would be the one thing the setting forbids.
		const document = await sampleDocument();
		const [fix] = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		assert.ok(fix !== undefined);
		let requests = 0;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () => {
				requests += 1;
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "should not happen" } }] });
			})
		);
		const { logger, lines } = makeLogger();
		// withConfig reads this object per get(), so mutating it mid-run is what
		// the user flipping the setting looks like from inside the extension.
		const liveConfig: Record<string, unknown> = { ...ENABLED_CONFIG };
		await withConfig(liveConfig, async () => {
			await runQuickFixChat(
				client(),
				{
					...deps(logger),
					// The setting flips WHILE the chat attempt is in flight, which is
					// exactly the window the second read exists for.
					openChat: () => {
						liveConfig["quickFix.enabled"] = false;
						return Promise.reject(new Error("no chat extension installed"));
					},
				},
				argsOf(fix)
			);
		});
		assert.strictEqual(requests, 0, "the fallback must re-read the enable gate, not assume it");
		assert.ok(
			lines.some((line) => line.includes("disabled while the chat view was failing")),
			`the skip is classified, got ${JSON.stringify(lines)}`
		);
	});

	test("Fix and Explain stay different questions on the fallback path", async () => {
		const document = await sampleDocument();
		const actions = createQuickFixActionsProvider().provideCodeActions(
			document,
			new vscode.Range(2, 0, 2, 0),
			actionContext([diagnostic("Cannot find name 'total'.", 2)]),
			new vscode.CancellationTokenSource().token
		) as vscode.CodeAction[];
		const prompts: string[] = [];
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompts.push(body.messages[0]?.content ?? "");
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "answer" } }] });
			})
		);
		const originalShow = vscode.window.showTextDocument;
		(vscode.window as Record<string, unknown>).showTextDocument = () => Promise.resolve({} as vscode.TextEditor);
		try {
			for (const action of actions) {
				await withConfig(ENABLED_CONFIG, () =>
					runQuickFixChat(
						client(),
						{ ...deps(), openChat: () => Promise.reject(new Error("no chat extension installed")) },
						argsOf(action)
					)
				);
			}
		} finally {
			(vscode.window as Record<string, unknown>).showTextDocument = originalShow;
		}
		assert.strictEqual(prompts.length, 2);
		// The progress notification promises an explanation for one and a fix for
		// the other; the prompt has to keep that promise.
		assert.ok(prompts[0]?.includes("propose a fix"), prompts[0] ?? "");
		assert.ok(!prompts[1]?.includes("propose a fix"), prompts[1] ?? "");
		assert.ok(prompts[1]?.includes("Explain rather than rewrite"), prompts[1] ?? "");
	});

	test("the provider is registered only while the feature is enabled, and the toggle follows", async () => {
		const registrations: { selector: vscode.DocumentSelector; disposed: boolean }[] = [];
		const configListeners: (() => void)[] = [];
		const originalRegister = vscode.languages.registerCodeActionsProvider;
		const originalOnDidChange = vscode.workspace.onDidChangeConfiguration;
		const originalRegisterCommand = vscode.commands.registerCommand;
		(vscode.languages as Record<string, unknown>).registerCodeActionsProvider = (selector: vscode.DocumentSelector) => {
			const record = { selector, disposed: false };
			registrations.push(record);
			return new vscode.Disposable(() => {
				record.disposed = true;
			});
		};
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
			listener: (event: vscode.ConfigurationChangeEvent) => void
		) => {
			configListeners.push(() => listener({ affectsConfiguration: () => true }));
			return new vscode.Disposable(() => {});
		};
		// The shared host already runs the activated extension, so a real
		// registration of the same command id would collide.
		(vscode.commands as Record<string, unknown>).registerCommand = () => new vscode.Disposable(() => {});
		try {
			const context = fakeContext();
			const wiringDeps = {
				oneShot: client(),
				outputChannel: { appendLine() {} } as unknown as vscode.OutputChannel,
				isParticipantAvailable: () => true,
			};
			await withConfig({ ...ENABLED_CONFIG, "quickFix.enabled": false }, () => {
				wireQuickFix(context, makeLogger().logger, wiringDeps);
			});
			assert.strictEqual(registrations.length, 0, "disabled must register no provider at all");

			await withConfig(ENABLED_CONFIG, () => {
				for (const fire of [...configListeners]) {
					fire();
				}
			});
			assert.strictEqual(registrations.length, 1, "enabling registers one");
			// file only: an unsaved buffer cannot have its code attached to a chat
			// turn, so an action there would ask a model to fix what it cannot see.
			assert.deepStrictEqual(registrations[0]?.selector, [{ scheme: "file" }]);

			await withConfig({ ...ENABLED_CONFIG, "quickFix.enabled": false }, () => {
				for (const fire of [...configListeners]) {
					fire();
				}
			});
			assert.strictEqual(registrations[0]?.disposed, true, "disabling disposes it");
		} finally {
			(vscode.languages as Record<string, unknown>).registerCodeActionsProvider = originalRegister;
			(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChange;
			(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		}
	});

	test("the dashboard probe sends the fallback's own prompt over a fixed sample, never the user's code", async () => {
		let prompt = "";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompt = body.messages[0]?.content ?? "";
				return HttpResponse.json({ choices: [{ message: { role: "assistant", content: "sample answer" } }] });
			})
		);
		const probe = createQuickFixProbe(deps().secrets, client(), () => {});
		const answer = await withConfig(ENABLED_CONFIG, () => probe({ server: "alpha", model: "gpt-test" }));
		assert.strictEqual(answer, "sample answer");
		assert.ok(prompt.includes("sample.ts"), "the probe's sample path rides the prompt");
		assert.ok(prompt.includes("Cannot find name 'total'."), "so does its fixed diagnostic");
	});
});
