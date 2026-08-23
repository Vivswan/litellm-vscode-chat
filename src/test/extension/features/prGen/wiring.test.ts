/**
 * The PR generation wiring: fail-closed by construction. The registration
 * decision is its own unit (createGhprRegistrar), driven here directly rather
 * than through the host's extension-change event, which is getter-only and
 * cannot be stubbed - the wiring binds that event to exactly this `apply`, so
 * driving it is driving the deferred path.
 */
import * as assert from "node:assert";
import { HttpResponse, http } from "msw";
import * as vscode from "vscode";
import type { API, Branch, Repository } from "../../../../extension/features/gitApi";
import type {
	GitHubPullRequestsApi,
	TitleAndDescriptionProvider,
} from "../../../../extension/features/prGen/githubPullRequestsApi";
import {
	createGhprProvider,
	createGhprRegistrar,
	createPrProbe,
	wirePrGeneration,
} from "../../../../extension/features/prGen/wiring";
import { RequestError } from "../../../../provider/transport/errorMapping";
import { OneShotClient } from "../../../../provider/transport/oneShotClient";
import { CMD, prGenerationProviderTitle } from "../../../../shared/config/commandIds";
import { Logger } from "../../../../shared/logger";
import { MirroredError } from "../../../../shared/mirroredError";
import { CHAT_COMPLETIONS_URL, mswServer, TEST_BASE_URL, useMsw } from "../../../mocks/handlers";
import { withConfig } from "../../../testUtils";

interface GhprRegistration {
	readonly title: string;
	readonly provider: TitleAndDescriptionProvider;
	disposed: boolean;
}

/** A fake GitHub Pull Requests API that records what it was handed. */
function fakeGhpr(registrations: GhprRegistration[]): GitHubPullRequestsApi {
	return {
		registerTitleAndDescriptionProvider: (title, provider) => {
			const record: GhprRegistration = { title, provider, disposed: false };
			registrations.push(record);
			return new vscode.Disposable(() => {
				record.disposed = true;
			});
		},
	};
}

const NO_PROVIDER: TitleAndDescriptionProvider = {
	provideTitleAndDescription: () => Promise.resolve(undefined),
};

/** The registrar under test, over mutable state the test drives between applies. */
function harness(initial: { wanted?: boolean; api?: GitHubPullRequestsApi | undefined } = {}) {
	const registrations: GhprRegistration[] = [];
	const logs: string[] = [];
	const state = {
		registrations,
		logs,
		wanted: initial.wanted ?? true,
		api: initial.api,
		resolveCalls: 0,
	};
	const registrar = createGhprRegistrar({
		wanted: () => state.wanted,
		resolveApi: () => {
			state.resolveCalls += 1;
			return Promise.resolve(state.api);
		},
		title: prGenerationProviderTitle,
		provider: () => NO_PROVIDER,
		log: (message) => logs.push(message),
	});
	// Assign onto `state` rather than spreading it: the registrar's callbacks
	// close over this exact object, so a test setting `.api` must be seen by them.
	return Object.assign(state, { registrar });
}

suite("extension/features/prGen GitHub registration", () => {
	test("wanted with an API registers once, under a title that never says Copilot", async () => {
		const h = harness();
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 1, "exactly one provider is registered");
		assert.strictEqual(h.registrations[0]?.title, prGenerationProviderTitle());
		// The hardcoded slot in that extension is selected by a case-insensitive
		// "Copilot" substring; ours must never match it.
		assert.ok(!/copilot/i.test(h.registrations[0]?.title ?? ""), "the title must not claim the Copilot slot");
	});

	test("not wanted never even resolves the other extension, let alone activates it", async () => {
		const h = harness({ wanted: false });
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 0);
		assert.strictEqual(h.resolveCalls, 0, "a disabled or unconfigured feature must not reach for the other extension");
	});

	test("an absent or too-old extension registers nothing and does not throw", async () => {
		const h = harness();
		h.api = undefined;
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 0);
	});

	test("a registration that throws is swallowed and logged as a classification", async () => {
		const h = harness();
		h.api = {
			registerTitleAndDescriptionProvider: () => {
				throw new Error("refused");
			},
		};
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 0);
		assert.strictEqual(h.logs.length, 1);
		assert.match(h.logs[0] ?? "", /registering with the GitHub Pull Requests extension failed \(Error\)/);
		// Classification only: the other extension's message never reaches the log.
		assert.ok(!(h.logs[0] ?? "").includes("refused"));
	});

	test("the extension arriving later registers on the next apply - the deferred path", async () => {
		const h = harness();
		h.api = undefined;
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 0, "nothing to register against yet");
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 1);
	});

	test("re-applying against the same API does not stack a second provider", async () => {
		const h = harness();
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		await h.registrar.apply();
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 1, "re-deciding must not add a duplicate provider");
	});

	test("the extension going away releases the stale handle, and a reinstall registers afresh", async () => {
		const h = harness();
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 1);
		h.api = undefined;
		await h.registrar.apply();
		assert.strictEqual(h.registrations[0]?.disposed, true, "the handle against a dead API is released");
		// A reinstall mints a new API object, which must be registered against.
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 2);
		assert.strictEqual(h.registrations[1]?.disposed, false);
	});

	test("turning the feature off disposes the registration", async () => {
		const h = harness();
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		assert.strictEqual(h.registrations[0]?.disposed, false);
		h.wanted = false;
		await h.registrar.apply();
		assert.strictEqual(h.registrations[0]?.disposed, true);
	});

	test("dispose is terminal: no later apply can register again, whatever fires afterwards", async () => {
		// Terminal by construction rather than by subscription order: the two
		// change events this is bound to outlive nothing in particular.
		const h = harness();
		h.api = fakeGhpr(h.registrations);
		await h.registrar.apply();
		h.registrar.dispose();
		assert.strictEqual(h.registrations[0]?.disposed, true);
		await h.registrar.apply();
		await h.registrar.apply();
		assert.strictEqual(h.registrations.length, 1, "a disposed registrar never registers again");
	});

	test("disposing while an apply is in flight leaves nothing registered behind it", async () => {
		// The dangerous shape: apply() is awaiting the other extension's
		// activation when the extension host tears us down. A provider registered
		// after that is never disposed - and since that extension hands an
		// unqualified request to the FIRST registered provider, a dead one would
		// answer for the rest of the window.
		const registrations: GhprRegistration[] = [];
		let release: (() => void) | undefined;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registrar = createGhprRegistrar({
			wanted: () => true,
			resolveApi: async () => {
				await slow;
				return fakeGhpr(registrations);
			},
			title: prGenerationProviderTitle,
			provider: () => NO_PROVIDER,
			log: () => {},
		});
		const inFlight = registrar.apply();
		registrar.dispose();
		release?.();
		await inFlight;
		assert.strictEqual(registrations.length, 0, "a disposed registrar must never register");
	});

	test("a slow apply overtaken by a later one does not register behind its back", async () => {
		const registrations: GhprRegistration[] = [];
		let release: (() => void) | undefined;
		let wanted = true;
		const slow = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const registrar = createGhprRegistrar({
			wanted: () => wanted,
			resolveApi: async () => {
				if (first) {
					first = false;
					await slow;
				}
				return fakeGhpr(registrations);
			},
			title: prGenerationProviderTitle,
			provider: () => NO_PROVIDER,
			log: () => {},
		});
		const stale = registrar.apply();
		// The feature is turned off and re-decided while the first apply is still
		// waiting on the other extension.
		wanted = false;
		await registrar.apply();
		release?.();
		await stale;
		assert.strictEqual(registrations.length, 0, "the overtaken apply must not register what the later one refused");
	});
});

function fakeContext(): vscode.ExtensionContext {
	return {
		subscriptions: [] as vscode.Disposable[],
		secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
	} as unknown as vscode.ExtensionContext;
}

function quietLogger(): Logger {
	return new Logger({ info() {}, error() {} });
}

suite("extension/features/prGen wiring", () => {
	test("the command is registered even while the feature is off - executeCommand and keybindings do not read when-clauses", async () => {
		const commandIds: string[] = [];
		const originalRegisterCommand = vscode.commands.registerCommand;
		const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
		(vscode.commands as Record<string, unknown>).registerCommand = (id: string) => {
			commandIds.push(id);
			return new vscode.Disposable(() => {});
		};
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
		try {
			await withConfig({ "prGeneration.enabled": false }, () => {
				wirePrGeneration(fakeContext(), quietLogger(), {
					oneShot: {} as never,
					outputChannel: { appendLine() {} } as unknown as vscode.OutputChannel,
				});
			});
			assert.ok(commandIds.includes(CMD.generatePrDescription), "the palette command must exist regardless");
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
			(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		}
	});
});

/** A git API answering with one repository whose branch lookup returns `branch`. */
function fakeGit(branch: Branch | undefined): () => Promise<API | undefined> {
	const repo = {
		getBranch: (name: string) =>
			branch !== undefined && branch.name === name ? Promise.resolve(branch) : Promise.reject(new Error("no branch")),
	} as unknown as Repository;
	return () => Promise.resolve({ repositories: [repo] });
}

suite("extension/features/prGen activation-failure logging", () => {
	const MODEL_CONFIG = {
		"prGeneration.enabled": true,
		"prGeneration.model": { server: "alpha", model: "gpt-test" },
	};

	/** Let the wiring's fire-and-forget registration decision run to completion. */
	async function settle(): Promise<void> {
		for (let i = 0; i < 8; i++) {
			await Promise.resolve();
		}
	}

	/**
	 * The latch is per-WIRING, not per module: it exists so a broken GitHub
	 * install cannot evict real history from the 50-entry issue-report ring on
	 * every settings change, and it must not silence a second wiring's first
	 * failure (a shared test host wires more than once).
	 */
	async function wireAgainstFailingGhpr(): Promise<{ lines: string[]; fireConfigChange: () => Promise<void> }> {
		const lines: string[] = [];
		const listeners: ((event: vscode.ConfigurationChangeEvent) => void)[] = [];
		const originalRegisterCommand = vscode.commands.registerCommand;
		const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
		const originalGetExtension = vscode.extensions.getExtension;
		(vscode.commands as Record<string, unknown>).registerCommand = () => new vscode.Disposable(() => {});
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = (
			listener: (event: vscode.ConfigurationChangeEvent) => void
		) => {
			listeners.push(listener);
			return new vscode.Disposable(() => {});
		};
		// vscode.extensions.onDidChange is getter-only and cannot be stubbed; the
		// real one never fires here, so the wiring's subscription is harmless.
		(vscode.extensions as Record<string, unknown>).getExtension = (id: string) =>
			id === "GitHub.vscode-pull-request-github"
				? { isActive: false, exports: undefined, activate: () => Promise.reject(new Error("broken install")) }
				: undefined;
		try {
			await withConfig(MODEL_CONFIG, async () => {
				wirePrGeneration(fakeContext(), new Logger({ info: (line) => lines.push(line), error: () => {} }), {
					oneShot: {} as never,
					outputChannel: { appendLine() {} } as unknown as vscode.OutputChannel,
				});
				await settle();
			});
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
			(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
			(vscode.extensions as Record<string, unknown>).getExtension = originalGetExtension;
		}
		return {
			lines,
			fireConfigChange: async () => {
				for (const listener of listeners) {
					listener({ affectsConfiguration: () => true });
				}
				await settle();
			},
		};
	}

	const failures = (lines: readonly string[]): number =>
		lines.filter((line) => line.includes("failed to activate")).length;

	test("a broken GitHub install logs its activation failure once per wiring, not once per settings change", async () => {
		const first = await wireAgainstFailingGhpr();
		assert.strictEqual(failures(first.lines), 1, "the first decision reports");
		await first.fireConfigChange();
		await first.fireConfigChange();
		assert.strictEqual(failures(first.lines), 1, "re-deciding must not repeat the line into the report buffer");
	});

	test("a second wiring reports its own first failure - the latch is not module-wide", async () => {
		await wireAgainstFailingGhpr();
		const second = await wireAgainstFailingGhpr();
		assert.strictEqual(failures(second.lines), 1, "module-level state would have silenced this one");
	});
});

suite("extension/features/prGen GitHub-context provider", () => {
	const MODEL = { server: "alpha", model: "gpt-test" };
	const ENABLED = { "prGeneration.enabled": true, "prGeneration.model": MODEL };

	/** The prompt the provider assembled, captured through the injected send. */
	async function promptFor(
		context: Parameters<TitleAndDescriptionProvider["provideTitleAndDescription"]>[0],
		resolveGit: () => Promise<API | undefined>
	): Promise<string> {
		let seen = "";
		const provider = createGhprProvider(
			(_model, prompt) => {
				seen = prompt;
				return Promise.resolve("Title: t\nDescription:\nd");
			},
			() => MODEL,
			() => {},
			resolveGit
		);
		// The provider re-reads the enable gate per call, so the suite must run
		// with the feature actually on.
		await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(context, new vscode.CancellationTokenSource().token)
		);
		return seen;
	}

	test("a newest-first list from an unpushed branch is reversed before the prompt is built", async () => {
		const prompt = await promptFor(
			{ commitMessages: ["newest", "middle", "oldest"], patches: ["@@ x"], compareBranch: "feature" },
			fakeGit({ name: "feature" })
		);
		assert.ok(
			prompt.includes("oldest\n\nmiddle\n\nnewest"),
			`the commit list should read oldest first, got:\n${prompt}`
		);
	});

	test("an oldest-first list from a pushed, undiverged branch is left alone", async () => {
		const prompt = await promptFor(
			{ commitMessages: ["oldest", "middle", "newest"], patches: ["@@ x"], compareBranch: "feature" },
			fakeGit({ name: "feature", upstream: { remote: "origin", name: "feature" } })
		);
		assert.ok(prompt.includes("oldest\n\nmiddle\n\nnewest"), `the commit list order should be kept, got:\n${prompt}`);
	});

	test("a branch nothing can resolve leaves the list exactly as it arrived", async () => {
		// Unknown is not "no upstream": reversing on a guess would be worse than
		// passing the list through.
		const prompt = await promptFor(
			{ commitMessages: ["first", "second"], patches: ["@@ x"], compareBranch: "feature" },
			() => Promise.resolve(undefined)
		);
		assert.ok(prompt.includes("first\n\nsecond"), `the list should pass through untouched, got:\n${prompt}`);
	});

	test("no configured model answers 'could not' instead of sending a request", async () => {
		let sends = 0;
		const provider = createGhprProvider(
			() => {
				sends += 1;
				return Promise.resolve("Title: t");
			},
			() => undefined,
			() => {},
			fakeGit(undefined)
		);
		const result = await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: [], patches: [] },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(result, undefined);
		assert.strictEqual(sends, 0, "an unconfigured model must never reach the wire");
	});

	test("a call arriving after the feature was turned off sends nothing, model setting or not", async () => {
		// Teardown is asynchronous, so a call can land between the setting change
		// and the registration's disposal; no repository content may leave on it.
		let sends = 0;
		const provider = createGhprProvider(
			() => {
				sends += 1;
				return Promise.resolve("Title: t");
			},
			() => MODEL,
			() => {},
			fakeGit(undefined)
		);
		const result = await withConfig({ "prGeneration.enabled": false, "prGeneration.model": MODEL }, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: ["feat: x"], patches: ["@@ secret"] },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(result, undefined);
		assert.strictEqual(sends, 0, "a disabled feature must never reach the wire");
	});

	test("a transport failure is caught at this boundary: a classification is logged, nothing escapes", async () => {
		// The caller is ANOTHER extension, which logs whatever it catches; a
		// RequestError's message carries server-derived text, so it must not
		// travel. The upstream API's own "could not" value goes back instead.
		const logs: string[] = [];
		const provider = createGhprProvider(
			() => Promise.reject(new RequestError("LiteLLM 500: SERVER-BODY-DETAIL", "http", { englishMessage: "boom" })),
			() => MODEL,
			(message) => logs.push(message),
			fakeGit(undefined)
		);
		const result = await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: ["feat: x"], patches: ["@@ x"] },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(result, undefined, "a failure answers 'could not', it does not throw at the other extension");
		assert.strictEqual(logs.length, 1);
		assert.ok(!(logs[0] ?? "").includes("SERVER-BODY-DETAIL"), `response text reached the log: ${logs[0]}`);
	});

	test("a rejecting git resolver is caught too - the whole handler sits inside the boundary", async () => {
		const logs: string[] = [];
		const provider = createGhprProvider(
			() => Promise.resolve("Title: t"),
			() => MODEL,
			(message) => logs.push(message),
			() => Promise.reject(new Error("vscode.git failed to activate"))
		);
		const result = await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: ["feat: x"], patches: ["@@ x"], compareBranch: "feature" },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(result, undefined, "nothing may escape into the other extension");
		assert.strictEqual(logs.length, 1);
	});

	test("cancellation is silent at this boundary too", async () => {
		const logs: string[] = [];
		const provider = createGhprProvider(
			() => Promise.reject(new vscode.CancellationError()),
			() => MODEL,
			(message) => logs.push(message),
			fakeGit(undefined)
		);
		const result = await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: ["feat: x"], patches: ["@@ x"] },
				new vscode.CancellationTokenSource().token
			)
		);
		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(logs, [], "cancellation is never logged");
	});

	test("the repository standing on the compare branch decides the order, not merely the first one", async () => {
		// A multi-root workspace with the same branch name in two repositories:
		// only the tracking state of the one actually on that branch says
		// anything about how the upstream extension collected its list.
		const wrong = {
			state: { HEAD: { name: "other" } },
			getBranch: () => Promise.resolve({ name: "feature" }),
		} as unknown as Repository;
		const right = {
			state: { HEAD: { name: "feature" } },
			getBranch: () => Promise.resolve({ name: "feature", upstream: { remote: "origin", name: "feature" } }),
		} as unknown as Repository;
		let seen = "";
		const provider = createGhprProvider(
			(_model, prompt) => {
				seen = prompt;
				return Promise.resolve("Title: t");
			},
			() => MODEL,
			() => {},
			() => Promise.resolve({ repositories: [wrong, right] })
		);
		await withConfig(ENABLED, () =>
			provider.provideTitleAndDescription(
				{ commitMessages: ["oldest", "newest"], patches: ["@@ x"], compareBranch: "feature" },
				new vscode.CancellationTokenSource().token
			)
		);
		// The right repository has an undiverged upstream, so the list is
		// oldest-first already and must NOT be reversed.
		assert.ok(seen.includes("oldest\n\nnewest"), `the wrong repository decided the order:\n${seen}`);
	});
});

suite("extension/features/prGen dashboard probe", () => {
	test("the probe runs the real parse and returns the title, never the whole reply", async () => {
		const probe = createPrProbe(() => Promise.resolve("Title: Add a retry\nDescription:\nBecause uploads flake."));
		assert.strictEqual(await probe({ server: "alpha", model: "gpt-test" }), "Add a retry");
	});

	test("an unparseable reply reads as no answer, so the empty-answer hint shows", async () => {
		const probe = createPrProbe(() => Promise.resolve("   "));
		assert.strictEqual(await probe({ server: "alpha", model: "gpt-test" }), undefined);
	});

	test("the probe sends a canned branch, never anything read from the user's repository", async () => {
		let prompt = "";
		const probe = createPrProbe((_model, sent) => {
			prompt = sent;
			return Promise.resolve("Title: t");
		});
		await probe({ server: "alpha", model: "gpt-test" });
		assert.ok(prompt.includes("feat: add a retry to the upload path"), "the canned commit list rides the probe");
		assert.ok(prompt.includes("upload.ts"), "the canned patch rides the probe");
	});

	test("the probe disposes its cancellation source, success and failure alike", async () => {
		const originalDispose = vscode.CancellationTokenSource.prototype.dispose;
		let disposals = 0;
		vscode.CancellationTokenSource.prototype.dispose = function (this: vscode.CancellationTokenSource) {
			disposals += 1;
			return originalDispose.call(this);
		};
		try {
			await createPrProbe(() => Promise.resolve("Title: t"))({ server: "alpha", model: "gpt-test" });
			assert.strictEqual(disposals, 1, "a resolved probe releases its source");
			await assert.rejects(
				createPrProbe(() => Promise.reject(new Error("boom")))({ server: "alpha", model: "gpt-test" })
			);
			assert.strictEqual(disposals, 2, "a rejected probe releases its source too");
		} finally {
			vscode.CancellationTokenSource.prototype.dispose = originalDispose;
		}
	});
});

/**
 * The send itself: which error surface it claims, which timeout bounds it, and
 * what it throws for an unresolvable label. Nothing else pins these - the
 * surface literal typechecks as any member of the union, so a copy-edit to a
 * sibling's name would silently render that sibling's advice for every PR
 * failure.
 */
suite("extension/features/prGen send", () => {
	useMsw();

	const SEND_CONFIG = {
		"prGeneration.enabled": true,
		"prGeneration.model": { server: "alpha", model: "gpt-test" },
		servers: [{ label: "alpha", baseUrl: TEST_BASE_URL, auth: { apiKey: "sk-test" } }],
	};

	/** Wire the feature with a real client and hand back only its send. */
	function sendOf(): ReturnType<typeof wirePrGeneration>["prSend"] {
		const originalRegisterCommand = vscode.commands.registerCommand;
		const originalOnDidChangeConfiguration = vscode.workspace.onDidChangeConfiguration;
		(vscode.commands as Record<string, unknown>).registerCommand = () => new vscode.Disposable(() => {});
		(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = () => new vscode.Disposable(() => {});
		try {
			return wirePrGeneration(fakeContext(), quietLogger(), {
				oneShot: new OneShotClient({ userAgent: "test-agent" }),
				outputChannel: { appendLine() {} } as unknown as vscode.OutputChannel,
			}).prSend;
		} finally {
			(vscode.commands as Record<string, unknown>).registerCommand = originalRegisterCommand;
			(vscode.workspace as Record<string, unknown>).onDidChangeConfiguration = originalOnDidChangeConfiguration;
		}
	}

	test("a label matching no entry throws the classified error, zero fetches", async () => {
		// No msw handler is registered for the chat URL: any request would fail
		// the suite through onUnhandledRequest: "error".
		await withConfig({ ...SEND_CONFIG, servers: [] }, async () => {
			const send = sendOf();
			await assert.rejects(
				send({ server: "alpha", model: "gpt-test" }, "prompt", new vscode.CancellationTokenSource().token),
				(error: unknown) => {
					assert.ok(error instanceof MirroredError);
					assert.strictEqual(error.logClassification, "PrGeneration(configured server label matches no entry)");
					return true;
				}
			);
		});
	});

	test("a failure renders the PR generation surface's copy, not a sibling feature's", async () => {
		// The one guard on the surface literal: 404 advice is per-surface, so a
		// copy-edit to "commitGeneration" would show commit-message wording here.
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, () =>
				HttpResponse.json({ error: { message: "model gone", type: "invalid_request_error" } }, { status: 404 })
			)
		);
		await withConfig(SEND_CONFIG, async () => {
			const send = sendOf();
			await assert.rejects(
				send({ server: "alpha", model: "gpt-test" }, "prompt", new vscode.CancellationTokenSource().token),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /pull request description request/);
					assert.ok(!/commit message/.test(error.message), error.message);
					return true;
				}
			);
		});
	});

	test("the request body carries only the provider-owned fields", async () => {
		let body: Record<string, unknown> | undefined;
		mswServer.use(
			http.post(CHAT_COMPLETIONS_URL, async ({ request }) => {
				body = (await request.json()) as Record<string, unknown>;
				return HttpResponse.json({ choices: [{ message: { content: "Title: t" } }] });
			})
		);
		await withConfig(SEND_CONFIG, async () => {
			const send = sendOf();
			await send({ server: "alpha", model: "gpt-test" }, "the prompt", new vscode.CancellationTokenSource().token);
		});
		assert.deepStrictEqual(body?.messages, [{ role: "user", content: "the prompt" }]);
		assert.strictEqual(body?.model, "gpt-test");
		// The pass-through invariant: this path sets no max_tokens and injects
		// no parameters of its own.
		for (const key of ["temperature", "top_p", "max_tokens", "tools", "tool_choice"]) {
			assert.ok(!(key in (body ?? {})), `unexpected ${key} in the body`);
		}
	});
});
