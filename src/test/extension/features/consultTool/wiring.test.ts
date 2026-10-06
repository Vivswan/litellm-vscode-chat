/**
 * Anything the pure core already pins (prompt assembly, the bisection, result shaping) lives in its own suite; this
 * one pins what only the host can prove.
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
import { updateServerSecret } from "../../../../extension/servers/serverSync/secrets";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { CONSULT_TOOL_READY_CONTEXT_KEY, TOOL_NAME } from "../../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../../shared/config/settingSpec";
import { MirroredError } from "../../../../shared/mirroredError";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";
import { withDisposalCount } from "../disposalCount";
import type { WiringSpies } from "../wiringSpies";
import { fakeContext, memorySecretStorage, quietLogger, withWiringSpies } from "../wiringSpies";

const MODEL_REF = { server: "alpha", model: "gpt-test" };
const SERVER_ENTRY = { label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } };

const ENABLED_CONFIG = {
	"consultTool.enabled": true,
	"consultTool.model": MODEL_REF,
	servers: [SERVER_ENTRY],
};

function readyStates(spies: WiringSpies): unknown[] {
	return spies.contextStates.get(CONSULT_TOOL_READY_CONTEXT_KEY) ?? [];
}

function chatReply(content: string): Response {
	return HttpResponse.json({ choices: [{ message: { role: "assistant", content } }] });
}

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
			// The contribution's when-clause reads this key, so the tool picker tracks REGISTRATION rather than the
			// enable boolean alone - the half-configured state (enabled, no model) must read false.
			assert.deepStrictEqual(readyStates(spies), [true, false, true, false]);
		});
	});

	test("the readiness key stays false through the half-configured state", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "consultTool.enabled": true, "consultTool.model": null, servers: [SERVER_ENTRY] }, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.deepStrictEqual(readyStates(spies), [false]);
		});
	});

	test("disposal releases the name and takes the tool out of the picker", async () => {
		await withWiringSpies(async (spies) => {
			const context = fakeContext();
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(context, quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			assert.deepStrictEqual(readyStates(spies), [true]);
			for (const subscription of context.subscriptions) {
				subscription.dispose();
			}
			assert.strictEqual(spies.registrations[0]?.disposed, true, "disposal releases the registration");
			assert.deepStrictEqual(readyStates(spies), [true, false], "and clears the key the contribution gates on");
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
			assert.strictEqual(resultText(result), "Use a queue.");
		});
		assert.ok(seenBody);
		// The one-shot body is exactly what OneShotChatRequest declares: no max_tokens, no parameters record field,
		// nothing else injected.
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["messages", "model", "stream"]);
		assert.strictEqual(seenBody.model, MODEL_REF.model);
		assert.strictEqual(seenBody.stream, false);
		const messages = seenBody.messages as { role: string; content: string }[];
		assert.strictEqual(messages.length, 1);
		assert.strictEqual(messages[0]?.role, "user");
		assert.ok(messages[0]?.content.includes("How should I batch these writes?"));
		assert.ok(messages[0]?.content.includes("A busy write path."));
	});

	test("the host's token budget bounds the REPLY, which is what it governs, and marks the cut", async () => {
		// tokenBudget is documented as the maximum the tool may emit in its RESULT - the only thing this tool adds to
		// the calling model's context - so it is the reply that must fit, not the outgoing prompt.
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
		// A generous host budget must NOT license an unbounded body, and a small one must not shrink it: the outgoing
		// cap is the code's own.
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
		// No msw handler for the chat URL is registered: any request would fail the suite through onUnhandledRequest:
		// "error".
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

	/**
	 * The refusals entryConnectionFor hands the shared chat send, each with the stored text that must never ride the
	 * error: the sync engine and the usage poller refuse the same pairings, and the feature boundaries log and notify
	 * with what they are thrown.
	 */
	const SECRET_REFUSALS: readonly {
		readonly name: string;
		/** The declared entry; the default declares no credential unit. */
		readonly servers?: readonly Record<string, unknown>[];
		readonly secrets: () => Promise<vscode.SecretStorage>;
		readonly classification: string;
		readonly storedText: string;
		/** The refusal sentence the English mirror must carry, when the refusal names its field. */
		readonly englishText?: string;
	}[] = [
		{
			name: "a key stored for another host never follows a base URL edit",
			secrets: async () => {
				const secrets = memorySecretStorage();
				await updateServerSecret(secrets, "alpha", "apiKey", "sk-retired", "http://retired.test");
				return secrets;
			},
			classification: "ConsultTool(stored secrets stamped for another destination)",
			storedText: "sk-retired",
		},
		{
			name: "a secret storage read failure",
			secrets: async () => ({
				...memorySecretStorage(),
				get: () => Promise.reject(new Error("storage-read-sentinel http://retired.test sk-retired")),
			}),
			classification: "ConsultTool(stored secrets unreadable)",
			storedText: "storage-read-sentinel",
		},
		{
			name: "a stored API key the header rule refuses",
			secrets: async () => {
				const secrets = memorySecretStorage();
				await updateServerSecret(secrets, "alpha", "apiKey", "sk-a\nb", TEST_BASE_URL);
				return secrets;
			},
			classification: "ConsultTool(configured credential cannot be sent as a header)",
			storedText: "sk-a",
			englishText:
				"but its API key cannot be sent as an HTTP header, so nothing was sent. Enter the value again from the server row on the dashboard.",
		},
		{
			name: "a stored virtual key the header rule refuses",
			servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { virtualKey: { header: "x-vk" } } }],
			secrets: async () => {
				const secrets = memorySecretStorage();
				await updateServerSecret(secrets, "alpha", "virtualKeyValue", "vk-a\nb", TEST_BASE_URL);
				return secrets;
			},
			classification: "ConsultTool(configured credential cannot be sent as a header)",
			storedText: "vk-a",
			englishText:
				"but its virtual key cannot be sent as an HTTP header, so nothing was sent. Enter the value again from the server row on the dashboard.",
		},
	];

	for (const refusal of SECRET_REFUSALS) {
		test(`${refusal.name}: no request leaves, the classified error carries none of the stored text`, async () => {
			const secrets = await refusal.secrets();
			let seenAuthorization: string | null | undefined;
			mswServer.use(
				http.post(CHAT_COMPLETIONS_URL, ({ request }) => {
					seenAuthorization = request.headers.get("authorization");
					return chatReply("leaked");
				})
			);
			const servers = refusal.servers ?? [{ label: "alpha", baseUrl: TEST_BASE_URL }];
			await withWiringSpies(async (spies) => {
				await withConfig({ ...ENABLED_CONFIG, servers }, async () => {
					wireConsultTool(fakeContext(secrets), quietLogger(), {
						oneShot: new OneShotClient({ userAgent: "test-agent" }),
					});
					const outcome = await invokeRecorded(spies, { question: "anything?" }).then(
						() => "sent",
						(error: unknown) => error
					);
					assert.strictEqual(seenAuthorization, undefined, `a request left carrying ${seenAuthorization}`);
					assert.ok(outcome instanceof MirroredError, `expected the classified error, got ${String(outcome)}`);
					assert.strictEqual(outcome.logClassification, refusal.classification);
					if (refusal.englishText !== undefined) {
						assert.ok(
							outcome.englishMessage?.includes(refusal.englishText),
							`the refusal names the field: ${outcome.englishMessage}`
						);
					}
					assert.ok(
						!outcome.message.includes(refusal.storedText) && !outcome.englishMessage?.includes(refusal.storedText),
						"the stored text never rides the error"
					);
				});
			});
		});
	}

	test("a disable racing an in-flight turn is refused by the invoke itself, not just by registration", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig(ENABLED_CONFIG, () => {
				wireConsultTool(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) });
			});
			// The registration happened while enabled; the settings then changed under it without the watcher having
			// run.
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
				// Read-only tool: a confirmation prompt would interrupt every agent turn for nothing.
				assert.strictEqual(prepared.confirmationMessages, undefined);
			});
		});
	});

	test("the dashboard probe sends the fixed question and disposes its source, success and failure alike", async () => {
		await withDisposalCount(async (count) => {
			let asked: string | undefined;
			const okProbe = createConsultProbe(async ({ input }) => {
				asked = input.question;
				return "ok";
			});
			assert.strictEqual(await okProbe(MODEL_REF), "ok");
			// A fixed question, never anything of the user's.
			assert.strictEqual(asked, PROBE_QUESTION);
			assert.strictEqual(count(), 1, "a resolved probe releases its source");
			const failProbe = createConsultProbe(async () => {
				throw new Error("boom");
			});
			await assert.rejects(failProbe(MODEL_REF));
			assert.strictEqual(count(), 2, "a rejected probe releases its source too");
		});
	});

	/**
	 * The contributed inputSchema does NOT bind the host (the finding this suite exists for), so an input missing
	 * the required question arrives at invoke as-is and the tool's own parse is all that stands between an agent's
	 * malformed call and a prompt reading "Question: undefined". Only `consultTool.enabled` is written for real and
	 * the real `consultTool.model` stays null, so the production wiring registers nothing and this suite owns the name.
	 */
	suite("live host registration", () => {
		const config = () => vscode.workspace.getConfiguration("litellm-vscode-chat");
		let disposeWiring: () => void = () => {};

		suiteSetup(async () => {
			// Wait for the configuration event ITSELF, not a macrotask that hopes to outlast it and not
			// vscode.lm.tools, which lists the CONTRIBUTION whether or not anything is registered under it. With the
			// real model setting null the production wiring registers nothing, so the name is free, and if that stops
			// holding the registerTool below throws on the duplicate name rather than quietly shadowing.
			//
			//   event lands inside a withConfig stub -> the production listener reads this suite's model ref and
			//                                           registers the same name; which tool answers is a coin toss
			//   event lands late                     -> this suite's listener fires outside a stub, reads the real
			//                                           null model, and disposes its registration
			const settled = new Promise<void>((resolve) => {
				const listener = vscode.workspace.onDidChangeConfiguration((event) => {
					if (event.affectsConfiguration(`${CONFIG_SECTION}.consultTool.enabled`)) {
						listener.dispose();
						resolve();
					}
				});
				// A bounded fallback: an event the host coalesces away must not hang the suite, and a late one is
				// caught by the duplicate-name throw.
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
			// Order matters: release the name before the setting that gates the production wiring goes back, so nothing
			// races over it.
			disposeWiring();
			await config().update("consultTool.enabled", undefined, vscode.ConfigurationTarget.Global);
		});

		test("the tool registers under the contributed name and answers an lm.invokeTool call", async () => {
			mswServer.use(http.post(CHAT_COMPLETIONS_URL, () => chatReply("Batch them.")));
			// The round trip IS the registration proof: the host resolves TOOL_NAME to something that answered, and
			// what came back is the msw-backed reply this suite's wiring fetched.
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
			// No msw handler for the chat URL: a consultation escaping the parse would fail the suite through
			// onUnhandledRequest: "error" - which is exactly how the missing host-side validation was found.
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
						// The host flattens a thrown error across the extension-host boundary, so the message is what
						// survives to the caller.
						assert.match(String((error as Error).message), /needs a question/);
						return true;
					}
				);
			});
		});
	});
});
