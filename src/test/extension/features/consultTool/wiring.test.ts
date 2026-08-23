/**
 * The consult tool's host surface: registration is fail-closed on BOTH the
 * enable boolean and the model ref, and the registered tool answers a real
 * vscode.lm.invokeTool round trip through the msw-mocked server - schema
 * validation, budget truncation, and the result text included. Anything the
 * pure core already pins (prompt assembly, the bisection, result shaping)
 * lives in its own suite; this one pins what only the host can prove.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import {
	CONTEXT_TRUNCATION_MARKER,
	REPLY_TRUNCATION_MARKER,
} from "../../../../extension/features/consultTool/invocation";
import {
	CONSULT_PROMPT_CHAR_LIMIT,
	createConsultProbe,
	PROBE_QUESTION,
	wireConsultTool,
} from "../../../../extension/features/consultTool/wiring";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { CONSULT_TOOL_READY_CONTEXT_KEY, TOOL_NAME } from "../../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../../shared/config/settingSpec";
import { Logger } from "../../../../shared/logger";
import { MirroredError } from "../../../../shared/mirroredError";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";

const MODEL_REF = { server: "alpha", model: "gpt-test" };
const SERVER_ENTRY = { label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } };

/** The settings that make the tool live against the msw-mocked server. */
const ENABLED_CONFIG = {
	"consultTool.enabled": true,
	"consultTool.model": MODEL_REF,
	servers: [SERVER_ENTRY],
};

interface RecordedRegistration {
	readonly name: string;
	readonly tool: vscode.LanguageModelTool<unknown>;
	disposed: boolean;
}

interface WiringSpies {
	readonly registrations: RecordedRegistration[];
	/** Every value the wiring published for the readiness context key, in order. */
	readonly readyStates: boolean[];
	fireConfigChange(): void;
}

/**
 * Run `fn` with the wiring's host surfaces recorded instead of real: the tool
 * registration (a real one would collide with the activated extension's own
 * under the same name), the readiness context key (a real setContext would
 * leak into the live-host suite below, whose contribution gates on it), and
 * the configuration watcher, captured so tests fire it deterministically.
 */
async function withWiringSpies<T>(fn: (spies: WiringSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const registrations: RecordedRegistration[] = [];
	const readyStates: boolean[] = [];
	const configListeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];
	const originalRegisterTool = vscode.lm.registerTool;
	const originalExecuteCommand = vscode.commands.executeCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;

	(vscode.lm as Record<string, unknown>).registerTool = (name: string, tool: vscode.LanguageModelTool<unknown>) => {
		const record: RecordedRegistration = { name, tool, disposed: false };
		registrations.push(record);
		return new vscode.Disposable(() => {
			record.disposed = true;
		});
	};
	(vscode.commands as Record<string, unknown>).executeCommand = (command: string, ...args: unknown[]) => {
		if (command === "setContext" && args[0] === CONSULT_TOOL_READY_CONTEXT_KEY) {
			readyStates.push(args[1] === true);
			return Promise.resolve(undefined);
		}
		return (originalExecuteCommand as (command: string, ...args: unknown[]) => Thenable<unknown>)(command, ...args);
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
		listener: (event: vscode.ConfigurationChangeEvent) => void
	) => {
		configListeners.push(listener);
		return new vscode.Disposable(() => {});
	};

	try {
		return await fn({
			registrations,
			readyStates,
			fireConfigChange: () => {
				for (const listener of [...configListeners]) {
					listener({ affectsConfiguration: () => true });
				}
			},
		});
	} finally {
		(vscode.lm as Record<string, unknown>).registerTool = originalRegisterTool;
		(vscode.commands as Record<string, unknown>).executeCommand = originalExecuteCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
	}
}

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

/** The single-choice non-streaming reply shape the one-shot chat path parses. */
function chatReply(content: string): Response {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content } }] });
}

/** Invoke the recorded tool the way the host does, with no tokenization options unless given. */
function invokeRecorded(
	spies: WiringSpies,
	input: unknown,
	tokenizationOptions?: vscode.LanguageModelToolTokenizationOptions
): Promise<vscode.LanguageModelToolResult> {
	const tool = spies.registrations.at(-1)?.tool;
	assert.ok(tool !== undefined, "the tool is registered");
	const options = {
		toolInvocationToken: undefined,
		input,
		...(tokenizationOptions !== undefined ? { tokenizationOptions } : {}),
	} as vscode.LanguageModelToolInvocationOptions<unknown>;
	return Promise.resolve(tool.invoke(options, new vscode.CancellationTokenSource().token)).then((result) => {
		assert.ok(result != null, "the tool answered with a result");
		return result;
	});
}

/** The one text part a consult result carries. */
function resultText(result: vscode.LanguageModelToolResult): string {
	assert.strictEqual(result.content.length, 1, "the tool answers with exactly one part");
	const part = result.content[0];
	assert.ok(part instanceof vscode.LanguageModelTextPart, "the one part is plain text");
	return part.value;
}

suite("extension/features/consultTool wiring", () => {
	useMsw();

	test("disabled registers nothing, whatever the model setting says", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ ...ENABLED_CONFIG, "consultTool.enabled": false }, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.strictEqual(spies.registrations.length, 0);
		});
	});

	test("enabled without a model registers nothing: an agent is never offered a tool with nothing to ask", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "consultTool.enabled": true, "consultTool.model": null, servers: [SERVER_ENTRY] }, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.strictEqual(spies.registrations.length, 0);
		});
	});

	test("both halves set registers under TOOL_NAME; losing either disposes, restoring re-registers", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.strictEqual(spies.registrations.length, 1);
			assert.strictEqual(spies.registrations[0]?.name, TOOL_NAME);

			// Clearing the model alone is enough to take the tool away.
			await withConfig({ ...ENABLED_CONFIG, "consultTool.model": null }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.registrations[0]?.disposed, true, "losing the model must dispose the registration");

			await withConfig(ENABLED_CONFIG, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.registrations.length, 2, "restoring both halves registers a fresh tool");

			await withConfig({ ...ENABLED_CONFIG, "consultTool.enabled": false }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.registrations[1]?.disposed, true, "disabling must dispose the registration");
			// The contribution's when-clause reads this key, so the tool picker
			// tracks REGISTRATION rather than the enable boolean alone - the
			// half-configured state (enabled, no model) must read false.
			assert.deepStrictEqual(spies.readyStates, [true, false, true, false]);
		});
	});

	test("the readiness key stays false through the half-configured state", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "consultTool.enabled": true, "consultTool.model": null, servers: [SERVER_ENTRY] }, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.deepStrictEqual(spies.readyStates, [false]);
		});
	});

	test("disposal releases the name and takes the tool out of the picker", async () => {
		await withWiringSpies(async (spies) => {
			const context = fakeContext();
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(context, quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.deepStrictEqual(spies.readyStates, [true]);
			for (const subscription of context.subscriptions) {
				subscription.dispose();
			}
			assert.strictEqual(spies.registrations[0]?.disposed, true, "disposal releases the registration");
			assert.deepStrictEqual(spies.readyStates, [true, false], "and clears the key the contribution gates on");
		});
	});

	test("the assembled prompt goes out and the reply comes back as one text part", async () => {
		let seenBody: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				return chatReply("  Use a queue.  ");
			})
		);
		await withWiringSpies(async (spies) => {
			const result = await withConfig(ENABLED_CONFIG, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				return invokeRecorded(spies, { question: "How should I batch these writes?", context: "A busy write path." });
			});
			// The reply is trimmed and travels whole; nothing is summarized.
			assert.strictEqual(resultText(result), "Use a queue.");
		});
		assert.ok(seenBody);
		// The one-shot body is exactly what OneShotChatRequest declares: no
		// max_tokens, no parameters record field, nothing else injected.
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["messages", "model", "stream"]);
		assert.strictEqual(seenBody.model, MODEL_REF.model);
		assert.strictEqual(seenBody.stream, false);
		const messages = seenBody.messages as { role: string; content: string }[];
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0]?.role, "user");
		// Both halves of the caller's input reached the consulted model.
		assert.ok(messages[0]?.content.includes("How should I batch these writes?"));
		assert.ok(messages[0]?.content.includes("A busy write path."));
	});

	test("the host's token budget bounds the REPLY, which is what it governs, and marks the cut", async () => {
		// tokenBudget is documented as the maximum the tool may emit in its
		// RESULT - the only thing this tool adds to the calling model's context -
		// so it is the reply that must fit, not the outgoing prompt.
		const reply = "R".repeat(5000);
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply(reply)));
		const tokenizationOptions: vscode.LanguageModelToolTokenizationOptions = {
			tokenBudget: 400,
			countTokens: (text: string) => Promise.resolve(text.length),
		};
		const result = await withWiringSpies(async (spies) =>
			withConfig(ENABLED_CONFIG, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				return invokeRecorded(spies, { question: "Is this safe?" }, tokenizationOptions);
			})
		);
		const text = resultText(result);
		assert.ok(text.length <= 400, `the emitted result fits the budget the host advertised: ${text.length}`);
		assert.ok(text.includes(REPLY_TRUNCATION_MARKER), "the cut is marked so the caller knows the answer is partial");
		assert.ok(text.startsWith("RRR"), "the answer is cut from the end, keeping its opening");
	});

	test("no tokenization options means no known budget: the reply travels whole rather than under a guessed one", async () => {
		const reply = "R".repeat(5000);
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply(reply)));
		const result = await withWiringSpies(async (spies) =>
			withConfig(ENABLED_CONFIG, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				return invokeRecorded(spies, { question: "Is this safe?" });
			})
		);
		assert.strictEqual(resultText(result), reply);
	});

	test("the outgoing prompt has its own fixed cap, independent of the host's budget", async () => {
		let prompt = "";
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				const body = (await request.json()) as { messages: { content: string }[] };
				prompt = body.messages[0]?.content ?? "";
				return chatReply("noted");
			})
		);
		// A generous host budget must NOT license an unbounded body, and a small
		// one must not shrink it: the outgoing cap is the code's own.
		const context = "X".repeat(CONSULT_PROMPT_CHAR_LIMIT * 2);
		await withWiringSpies(async (spies) =>
			withConfig(ENABLED_CONFIG, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				return invokeRecorded(spies, { question: "Is this safe?", context }, {
					tokenBudget: 50,
					countTokens: (text: string) => Promise.resolve(text.length),
				} as vscode.LanguageModelToolTokenizationOptions);
			})
		);
		assert.ok(prompt.length > 50, "the tiny result budget did not shrink the outgoing prompt");
		assert.ok(prompt.length <= CONSULT_PROMPT_CHAR_LIMIT, `the prompt fits its own cap: ${prompt.length}`);
		assert.ok(prompt.includes(CONTEXT_TRUNCATION_MARKER), "the cut is marked so the consulted model knows");
		assert.ok(prompt.includes("Is this safe?"), "the question survives; the context absorbs the overflow");
	});

	test("a counting failure costs the budget, never the answer", async () => {
		mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("the whole answer")));
		const result = await withWiringSpies(async (spies) =>
			withConfig(ENABLED_CONFIG, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				return invokeRecorded(spies, { question: "Is this safe?" }, {
					tokenBudget: 5,
					countTokens: () => Promise.reject(new Error("tokenizer unavailable")),
				} as vscode.LanguageModelToolTokenizationOptions);
			})
		);
		// The answer is already in hand: an unbudgeted best effort beats losing it.
		assert.strictEqual(resultText(result), "the whole answer");
	});

	test("a label matching no entry throws the classified error, zero fetches", async () => {
		// No msw handler for the chat URL is registered: any request would fail
		// the suite through onUnhandledRequest: "error".
		await withWiringSpies(async (spies) => {
			await withConfig({ ...ENABLED_CONFIG, servers: [] }, async () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				await assert.rejects(invokeRecorded(spies, { question: "anything?" }), (error: unknown) => {
					assert.ok(error instanceof MirroredError);
					assert.strictEqual(error.logClassification, "ConsultTool(configured server label matches no entry)");
					return true;
				});
			});
		});
	});

	test("a disable racing an in-flight turn is refused by the invoke itself, not just by registration", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			// The registration happened while enabled; the settings then changed
			// under it without the watcher having run.
			await withConfig({ ...ENABLED_CONFIG, "consultTool.enabled": false }, async () => {
				await assert.rejects(invokeRecorded(spies, { question: "anything?" }), (error: unknown) => {
					assert.ok(error instanceof MirroredError);
					assert.strictEqual(error.logClassification, "ConsultTool(disabled)");
					return true;
				});
			});
		});
	});

	test("prepareInvocation names the configured model and asks for no confirmation", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
				const tool = spies.registrations[0]?.tool;
				assert.ok(tool?.prepareInvocation !== undefined, "the tool customizes its progress message");
				const prepared = tool.prepareInvocation(
					{ input: { question: "q" } },
					new vscode.CancellationTokenSource().token
				) as vscode.PreparedToolInvocation;
				assert.ok(String(prepared.invocationMessage).includes(MODEL_REF.model));
				// Read-only tool: a confirmation prompt would interrupt every agent
				// turn for nothing.
				assert.strictEqual(prepared.confirmationMessages, undefined);
			});
		});
	});

	test("the dashboard probe sends the fixed question and disposes its source, success and failure alike", async () => {
		const originalDispose = vscode.CancellationTokenSource.prototype.dispose;
		let disposals = 0;
		vscode.CancellationTokenSource.prototype.dispose = function (this: vscode.CancellationTokenSource) {
			disposals += 1;
			return originalDispose.call(this);
		};
		try {
			let asked: string | undefined;
			const okProbe = createConsultProbe(async ({ input }) => {
				asked = input.question;
				return "ok";
			});
			assert.strictEqual(await okProbe(MODEL_REF), "ok");
			// A fixed question, never anything of the user's.
			assert.strictEqual(asked, PROBE_QUESTION);
			assert.strictEqual(disposals, 1, "a resolved probe releases its source");
			const failProbe = createConsultProbe(async () => {
				throw new Error("boom");
			});
			await assert.rejects(failProbe(MODEL_REF));
			assert.strictEqual(disposals, 2, "a rejected probe releases its source too");
		} finally {
			vscode.CancellationTokenSource.prototype.dispose = originalDispose;
		}
	});

	/**
	 * The real host round trip: a REAL vscode.lm.registerTool over the
	 * contributed manifest entry, driven through vscode.lm.invokeTool. Only a
	 * live host can prove the manifest entry is well-formed enough to register
	 * under, that the when-clause does not block an invocation, and - the
	 * finding this suite exists for - that the contributed inputSchema does NOT
	 * bind the host: an input missing the required question arrives at invoke
	 * as-is, so the tool's own parse is the only thing standing between an
	 * agent's malformed call and a prompt reading "Question: undefined".
	 *
	 * The activated extension's own wiring must NOT also register the name:
	 * only `consultTool.enabled` is written for real (the when-clause's input),
	 * and the real `consultTool.model` stays null, which keeps the production
	 * registration fail-closed while this suite owns the name. The settings the
	 * pipeline reads ride the withConfig stub as everywhere else.
	 */
	suite("live host registration", () => {
		const config = () => vscode.workspace.getConfiguration("litellm-vscode-chat");
		let disposeWiring: () => void = () => {};

		suiteSetup(async () => {
			// Wait for the configuration event ITSELF, not a macrotask that hopes
			// to outlast it. It must reach the production wiring's listener BEFORE
			// any withConfig stub is installed: inside the stub that listener would
			// read this suite's model ref and register the same name, and whose
			// tool then answered invokeTool would be a coin toss. Late delivery is
			// the mirror hazard - this suite's own listener would then fire outside
			// a stub, read the real null model, and dispose its registration. With
			// the real model setting still null the production wiring registers
			// nothing, so the name is free; if that ever stops holding, the
			// registerTool below throws on the duplicate name rather than quietly
			// shadowing. (vscode.lm.tools is NOT the oracle for this: it lists the
			// CONTRIBUTION, which exists whether or not anything is registered
			// under it, and is itself gated by the very context key under test.)
			const settled = new Promise<void>((resolve) => {
				const listener = vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration(`${CONFIG_SECTION}.consultTool.enabled`)) {
						listener.dispose();
						resolve();
					}
				});
				// A bounded fallback: an event the host coalesces away must not hang
				// the suite, and a late one is caught by the duplicate-name throw.
				setTimeout(() => {
					listener.dispose();
					resolve();
				}, 2000);
			});
			await config().update("consultTool.enabled", true, vscode.ConfigurationTarget.Global);
			await settled;
			const context = fakeContext();
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(context, quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			disposeWiring = () => {
				for (const subscription of context.subscriptions) {
					subscription.dispose();
				}
			};
		});

		suiteTeardown(async () => {
			// Order matters: release the name before the setting that gates the
			// production wiring goes back, so nothing races over it.
			disposeWiring();
			await config().update("consultTool.enabled", undefined, vscode.ConfigurationTarget.Global);
		});

		test("the tool registers under the contributed name and answers an lm.invokeTool call", async () => {
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Batch them.")));
			// The round trip IS the registration proof: the host resolves
			// TOOL_NAME to something that answered, and what came back is the
			// msw-backed reply this suite's wiring fetched.
			const result = await withConfig(ENABLED_CONFIG, () =>
				Promise.resolve(
					vscode.lm.invokeTool(
						TOOL_NAME,
						{ toolInvocationToken: undefined, input: { question: "How should I batch these writes?" } },
						new vscode.CancellationTokenSource().token
					)
				)
			);
			assert.strictEqual(resultText(result), "Batch them.");
		});

		test("an input the schema calls invalid still reaches invoke, and the tool's own parse refuses it", async () => {
			// No msw handler for the chat URL: a consultation escaping the parse
			// would fail the suite through onUnhandledRequest: "error" - which is
			// exactly how the missing host-side validation was found.
			await withConfig(ENABLED_CONFIG, async () => {
				await assert.rejects(
					Promise.resolve(
						vscode.lm.invokeTool(
							TOOL_NAME,
							{ toolInvocationToken: undefined, input: { context: "no question at all" } },
							new vscode.CancellationTokenSource().token
						)
					),
					(error: unknown) => {
						// The host flattens a thrown error across the extension-host
						// boundary, so the message is what survives to the caller.
						assert.match(String((error as Error).message), /needs a question/);
						return true;
					}
				);
			});
		});
	});
});
