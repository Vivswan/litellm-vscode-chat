/**
 * The inline-completions wiring: opt-in by construction. Disabled means NO
 * provider registration, no language status row, and no toggle-command side
 * effects; enabled-without-model means everything registers but zero fetches
 * leave the process (msw's onUnhandledRequest: "error" would fail the test on
 * any stray request). The returned fimSend is the probe's pipeline, so its
 * template application and zero-injection body are pinned here end to end.
 */
import * as assert from "node:assert";
import { http } from "msw";
import * as vscode from "vscode";
import { liveInlineLanguageStatusRows } from "../../../../extension/features/inline/languageStatus";
import { createFimProbe, wireInlineCompletions } from "../../../../extension/features/inline/wiring";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { Logger } from "../../../../shared/logger";
import { MirroredError } from "../../../../shared/mirroredError";
import { COMPLETIONS_URL, completionJsonResponse, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";

interface RecordedRegistration {
	readonly selector: vscode.DocumentSelector;
	readonly provider: vscode.InlineCompletionItemProvider;
	disposed: boolean;
}

interface RecordedStatusItem {
	id: string;
	disposed: boolean;
}

interface WiringSpies {
	readonly registrations: RecordedRegistration[];
	readonly statusItems: RecordedStatusItem[];
	readonly commandIds: string[];
	fireConfigChange(): void;
}

/**
 * Run `fn` with the wiring's VS Code surfaces recorded instead of real: the
 * provider registration, the language status item, the toggle command (a real
 * registration would collide across tests in the shared host), and the
 * configuration watcher (captured so tests fire it deterministically).
 */
async function withWiringSpies<T>(fn: (spies: WiringSpies) => T | Promise<T>): Promise<Awaited<T>> {
	const registrations: RecordedRegistration[] = [];
	const statusItems: RecordedStatusItem[] = [];
	const commandIds: string[] = [];
	const configListeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];

	const originalRegister = vscode.languages.registerInlineCompletionItemProvider;
	const originalCreateStatus = vscode.languages.createLanguageStatusItem;
	const originalRegisterCommand = vscode.commands.registerCommand;
	const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
	const originalOnDidChangeActiveTextEditor = vscode.window.onDidChangeActiveTextEditor;

	(vscode.languages as Record<string, unknown>).registerInlineCompletionItemProvider = (
		selector: vscode.DocumentSelector,
		provider: vscode.InlineCompletionItemProvider
	) => {
		const record: RecordedRegistration = { selector, provider, disposed: false };
		registrations.push(record);
		return new vscode.Disposable(() => {
			record.disposed = true;
		});
	};
	(vscode.languages as Record<string, unknown>).createLanguageStatusItem = (id: string) => {
		const record: RecordedStatusItem = { id, disposed: false };
		statusItems.push(record);
		return {
			id,
			name: "",
			text: "",
			detail: undefined,
			severity: 0,
			command: undefined,
			busy: false,
			selector: { pattern: "**" },
			accessibilityInformation: undefined,
			dispose: () => {
				record.disposed = true;
			},
		} as unknown as vscode.LanguageStatusItem;
	};
	(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
		commandIds.push(id);
		return new vscode.Disposable(() => {});
	};
	(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
		listener: (event: vscode.ConfigurationChangeEvent) => void
	) => {
		configListeners.push(listener);
		return new vscode.Disposable(() => {});
	};
	(vscode.window as Record<string, unknown>).onDidChangeActiveTextEditor = () => new vscode.Disposable(() => {});

	try {
		return await fn({
			registrations,
			statusItems,
			commandIds,
			fireConfigChange: () => {
				for (const listener of [...configListeners]) {
					listener({ affectsConfiguration: () => true });
				}
			},
		});
	} finally {
		(vscode.languages as Record<string, unknown>).registerInlineCompletionItemProvider = originalRegister;
		(vscode.languages as Record<string, unknown>).createLanguageStatusItem = originalCreateStatus;
		(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		(vscode.window as Record<string, unknown>).onDidChangeActiveTextEditor = originalOnDidChangeActiveTextEditor;
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

const MODEL_REF = { server: "Main", model: "codestral-fim" };
const SERVER_ENTRY = { label: "Main", baseUrl: TEST_BASE_URL };

suite("extension/features/inline wiring", () => {
	useMsw();

	test("disabled wires nothing: no provider registration, no status row", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "inlineCompletions.enabled": false }, () => {
				wireInlineCompletions(fakeContext(), quietLogger(), {
					oneShot: new OneShotClient({ userAgent: "test-agent" }),
				});
			});
			assert.strictEqual(spies.registrations.length, 0);
			assert.strictEqual(spies.statusItems.length, 0);
			// The toggle command registers unconditionally (registration cannot
			// follow the flag without races); it is inert without the row.
			assert.deepStrictEqual(spies.commandIds, ["litellm.toggleInlineCompletionsLanguage"]);
		});
	});

	test("enabled registers the ** provider and the status row; disable disposes both", async () => {
		await withWiringSpies(async (spies) => {
			await withConfig({ "inlineCompletions.enabled": true }, () => {
				wireInlineCompletions(fakeContext(), quietLogger(), {
					oneShot: new OneShotClient({ userAgent: "test-agent" }),
				});
			});
			assert.strictEqual(spies.registrations.length, 1);
			assert.deepStrictEqual(spies.registrations[0]?.selector, { pattern: "**" });
			assert.strictEqual(spies.statusItems.length, 1);
			assert.strictEqual(spies.statusItems[0]?.id, "litellm.inlineCompletions");
			assert.strictEqual(liveInlineLanguageStatusRows(), 1, "the slot holds exactly one live row");

			await withConfig({ "inlineCompletions.enabled": false }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.registrations[0]?.disposed, true, "disable must dispose the registration");
			assert.strictEqual(spies.statusItems[0]?.disposed, true, "disable must dispose the status row");
			assert.strictEqual(liveInlineLanguageStatusRows(), 0, "disposal releases the slot");

			await withConfig({ "inlineCompletions.enabled": true }, () => {
				spies.fireConfigChange();
			});
			assert.strictEqual(spies.registrations.length, 2, "re-enable registers a fresh provider");
			assert.strictEqual(liveInlineLanguageStatusRows(), 1, "re-enable reclaims the one slot");
		});
	});

	test("enabled without a model makes zero fetches: the provider answers nothing and sends nothing", async () => {
		// No msw handler for the completions URL is registered: any request
		// would fail the suite through onUnhandledRequest: "error".
		await withWiringSpies(async (spies) => {
			await withConfig({ "inlineCompletions.enabled": true }, async () => {
				wireInlineCompletions(fakeContext(), quietLogger(), {
					oneShot: new OneShotClient({ userAgent: "test-agent" }),
				});
				const provider = spies.registrations[0]?.provider;
				assert.ok(provider !== undefined);
				const document = await vscode.workspace.openTextDocument({ content: "let x = ", language: "typescript" });
				const result = await provider.provideInlineCompletionItems(
					document,
					document.positionAt(8),
					{ triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
					new vscode.CancellationTokenSource().token
				);
				assert.strictEqual(result ?? undefined, undefined);
			});
		});
	});

	test("the send resolves the entry, applies _fim_template from the resolution, and pins the wire keys", async () => {
		let seenBody: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				return completionJsonResponse("filled-in");
			})
		);
		const entryWithTemplate = {
			...SERVER_ENTRY,
			models: { parameters: { "codestral-fim": { _fim_template: "<p>{prefix}</p><s>{suffix}</s>" } } },
		};
		await withWiringSpies(async () => {
			const { fimSend } = await withConfig({ "inlineCompletions.enabled": true, servers: [entryWithTemplate] }, () =>
				wireInlineCompletions(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) })
			);
			const result = await withConfig({ servers: [entryWithTemplate] }, () =>
				fimSend({
					modelRef: MODEL_REF,
					prefix: "PRE",
					suffix: "SUF",
					token: new vscode.CancellationTokenSource().token,
				})
			);
			assert.strictEqual(result, "filled-in");
		});
		assert.ok(seenBody);
		// Template applied: the prompt carries both sides and the wire suffix is
		// omitted; nothing beyond the provider-owned keys rides along.
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "model", "prompt", "stream"]);
		assert.strictEqual(seenBody.prompt, "<p>PRE</p><s>SUF</s>");
		assert.strictEqual(seenBody.max_tokens, 256);
		assert.strictEqual(seenBody.stream, false);
	});

	test("the native path keeps prompt+suffix, and a parameters field never rides along", async () => {
		let seenBody: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(COMPLETIONS_URL, async ({ request }) => {
				seenBody = (await request.json()) as Record<string, unknown>;
				return completionJsonResponse("native");
			})
		);
		const entryWithParams = {
			...SERVER_ENTRY,
			models: { parameters: { "codestral-fim": { temperature: 0.2, top_p: 0.9 } } },
		};
		await withWiringSpies(async () => {
			const { fimSend } = await withConfig({ "inlineCompletions.enabled": false, servers: [entryWithParams] }, () =>
				wireInlineCompletions(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) })
			);
			await withConfig({ servers: [entryWithParams] }, () =>
				fimSend({
					modelRef: MODEL_REF,
					prefix: "PRE",
					suffix: "SUF",
					token: new vscode.CancellationTokenSource().token,
				})
			);
		});
		assert.ok(seenBody);
		// models.parameters records do NOT apply to /completions: temperature and
		// top_p stay off the wire, and only the native five keys go out.
		assert.deepStrictEqual(Object.keys(seenBody).sort(), ["max_tokens", "model", "prompt", "stream", "suffix"]);
		assert.strictEqual(seenBody.prompt, "PRE");
		assert.strictEqual(seenBody.suffix, "SUF");
	});

	test("a label matching no entry throws the classified error, zero fetches", async () => {
		await withWiringSpies(async () => {
			const { fimSend } = await withConfig({ "inlineCompletions.enabled": false, servers: [] }, () =>
				wireInlineCompletions(fakeContext(), quietLogger(), { oneShot: new OneShotClient({ userAgent: "test-agent" }) })
			);
			await withConfig({ servers: [] }, () =>
				assert.rejects(
					fimSend({
						modelRef: MODEL_REF,
						prefix: "p",
						suffix: "s",
						token: new vscode.CancellationTokenSource().token,
					}),
					(error: unknown) => {
						assert.ok(error instanceof MirroredError);
						assert.strictEqual(error.logClassification, "InlineCompletions(configured server label matches no entry)");
						return true;
					}
				)
			);
		});
	});

	test("the dashboard probe disposes its cancellation source deterministically, success and failure alike", async () => {
		const originalDispose = vscode.CancellationTokenSource.prototype.dispose;
		let disposals = 0;
		vscode.CancellationTokenSource.prototype.dispose = function (this: vscode.CancellationTokenSource) {
			disposals += 1;
			return originalDispose.call(this);
		};
		try {
			const okProbe = createFimProbe(async () => "ok");
			assert.strictEqual(await okProbe({ server: "Main", model: "codestral-fim" }), "ok");
			assert.strictEqual(disposals, 1, "a resolved probe releases its source");
			const failProbe = createFimProbe(async () => {
				throw new Error("boom");
			});
			await assert.rejects(failProbe({ server: "Main", model: "codestral-fim" }));
			assert.strictEqual(disposals, 2, "a rejected probe releases its source too");
		} finally {
			vscode.CancellationTokenSource.prototype.dispose = originalDispose;
		}
	});
});
