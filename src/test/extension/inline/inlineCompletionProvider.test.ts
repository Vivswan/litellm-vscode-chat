import * as assert from "node:assert";
import { http } from "msw";
import * as vscode from "vscode";
import { CompletionCache } from "../../../extension/inline/completionCache";
import type { InlineCompletionRequest, InlineCompletionSend } from "../../../extension/inline/inlineCompletionProvider";
import {
	createInlineCompletionProvider,
	INLINE_COMPLETION_DEBOUNCE_MS,
} from "../../../extension/inline/inlineCompletionProvider";
import { COMPLETIONS_PATH, completionsUrl } from "../../../provider/transport/clients";
import {
	buildFimPrompt,
	FIM_PREFIX_BUDGET,
	FIM_SUFFIX_BUDGET,
	parseCompletionText,
} from "../../../provider/transport/fim";
import { COMPLETIONS_URL, completionJsonResponse, mswServer, TEST_BASE_URL, useMsw } from "../../mocks/handlers";
import { withConfig } from "../../testUtils";

/**
 * The inline-completions provider core, driven with an injected send: the
 * gate order (debounce, language filter, model ref, cache) and its silent
 * degradation, with the zero-send claims counted at the seam itself. The
 * happy path routes the send through a real fetch against msw, so the
 * /completions URL constants, the response helper, and parseCompletionText
 * are exercised together the way the production transport composes them.
 */

const MODEL_REF = { server: "Main", model: "codestral-fim" };

interface LoggedLine {
	readonly message: string;
	readonly data: unknown;
}

interface Harness {
	readonly provider: vscode.InlineCompletionItemProvider;
	readonly requests: InlineCompletionRequest[];
	readonly logs: LoggedLine[];
	readonly cache: CompletionCache;
}

/** A provider over a counted send; the default send fetches msw's /completions like the real transport. */
function makeHarness(send?: InlineCompletionSend): Harness {
	const requests: InlineCompletionRequest[] = [];
	const logs: LoggedLine[] = [];
	const cache = new CompletionCache();
	const fetchSend: InlineCompletionSend = async (request) => {
		const wire = buildFimPrompt({ prefix: request.prefix, suffix: request.suffix });
		const response = await fetch(completionsUrl(TEST_BASE_URL, undefined), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: request.modelRef.model,
				prompt: wire.prompt,
				...(wire.suffix !== undefined ? { suffix: wire.suffix } : {}),
				stream: false,
			}),
		});
		return parseCompletionText(await response.json());
	};
	const inner = send ?? fetchSend;
	const provider = createInlineCompletionProvider({
		send: (request) => {
			requests.push(request);
			return inner(request);
		},
		cache,
		log: (message, data) => {
			logs.push({ message, data });
		},
	});
	return { provider, requests, logs, cache };
}

async function invoke(
	harness: Harness,
	options: { content?: string; language?: string; token?: vscode.CancellationToken } = {}
): Promise<vscode.InlineCompletionItem[] | undefined> {
	const document = await vscode.workspace.openTextDocument({
		content: options.content ?? "function add(a, b) {\n",
		language: options.language ?? "typescript",
	});
	const position = document.positionAt(document.getText().indexOf("{") + 1);
	const context: vscode.InlineCompletionContext = {
		triggerKind: vscode.InlineCompletionTriggerKind.Automatic,
		selectedCompletionInfo: undefined,
	};
	const token = options.token ?? new vscode.CancellationTokenSource().token;
	const result = await harness.provider.provideInlineCompletionItems(document, position, context, token);
	return (result ?? undefined) as vscode.InlineCompletionItem[] | undefined;
}

suite("extension/inline/inlineCompletionProvider", () => {
	useMsw();

	test("the completions URL helper and the msw constant agree on the wire path", () => {
		assert.strictEqual(completionsUrl(TEST_BASE_URL, undefined), COMPLETIONS_URL);
		assert.ok(COMPLETIONS_URL.endsWith(COMPLETIONS_PATH));
	});

	test("the happy path yields one item from the msw-served completion text", async () => {
		mswServer.use(http.post(COMPLETIONS_URL, () => completionJsonResponse("\n\treturn a + b;")));
		const harness = makeHarness();
		const started = Date.now();
		const items = await withConfig({ "inlineCompletions.model": MODEL_REF }, () => invoke(harness));
		// Coarse lower bound only: timers never fire meaningfully early, and an
		// upper bound would flake on loaded CI hosts.
		assert.ok(Date.now() - started >= INLINE_COMPLETION_DEBOUNCE_MS - 50, "the debounce ran before any work");
		assert.strictEqual(items?.length, 1);
		assert.strictEqual(items[0]?.insertText, "\n\treturn a + b;");
		assert.strictEqual(harness.requests.length, 1);
		assert.deepStrictEqual(harness.requests[0]?.modelRef, MODEL_REF);
	});

	test("an identical retype is served from the cache: one send across two invocations", async () => {
		mswServer.use(http.post(COMPLETIONS_URL, () => completionJsonResponse("cached")));
		const harness = makeHarness();
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			const first = await invoke(harness);
			assert.strictEqual(first?.[0]?.insertText, "cached");
			const second = await invoke(harness);
			assert.strictEqual(second?.[0]?.insertText, "cached");
		});
		assert.strictEqual(harness.requests.length, 1, "the second invocation must not reach the send");
	});

	test("an empty completion is cached and stays no-suggestion without a second send", async () => {
		mswServer.use(http.post(COMPLETIONS_URL, () => completionJsonResponse("")));
		const harness = makeHarness();
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			assert.strictEqual(await invoke(harness), undefined);
			assert.strictEqual(await invoke(harness), undefined);
		});
		assert.strictEqual(harness.requests.length, 1);
	});

	test("an undefined send result (malformed body) is NOT cached: the next keystroke retries", async () => {
		const harness = makeHarness(async () => undefined);
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			assert.strictEqual(await invoke(harness), undefined);
			assert.strictEqual(await invoke(harness), undefined);
		});
		assert.strictEqual(harness.requests.length, 2, "a transient malformed response must not poison the cache");
	});

	test("a cancellation after the send suppresses the item but keeps the cached result", async () => {
		const source = new vscode.CancellationTokenSource();
		const harness = makeHarness(async () => {
			source.cancel();
			return "late";
		});
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			assert.strictEqual(await invoke(harness, { token: source.token }), undefined, "stale results render nothing");
			const retry = await invoke(harness);
			assert.strictEqual(retry?.[0]?.insertText, "late", "the retype is served from the cache");
		});
		assert.strictEqual(harness.requests.length, 1);
	});

	test("a token cancelled before the debounce elapses means zero sends", async () => {
		const harness = makeHarness();
		const source = new vscode.CancellationTokenSource();
		source.cancel();
		const items = await withConfig({ "inlineCompletions.model": MODEL_REF }, () =>
			invoke(harness, { token: source.token })
		);
		assert.strictEqual(items, undefined);
		assert.strictEqual(harness.requests.length, 0);
	});

	test("a blocked language means zero sends, and block beats allow", async () => {
		const harness = makeHarness();
		const config = {
			"inlineCompletions.model": MODEL_REF,
			"inlineCompletions.allowedLanguages": ["plaintext"],
			"inlineCompletions.blockedLanguages": ["plaintext"],
		};
		const items = await withConfig(config, () => invoke(harness, { language: "plaintext" }));
		assert.strictEqual(items, undefined);
		assert.strictEqual(harness.requests.length, 0);
	});

	test("a language outside a non-empty allow list means zero sends", async () => {
		const harness = makeHarness();
		const config = { "inlineCompletions.model": MODEL_REF, "inlineCompletions.allowedLanguages": ["python"] };
		const items = await withConfig(config, () => invoke(harness));
		assert.strictEqual(items, undefined);
		assert.strictEqual(harness.requests.length, 0);
	});

	test("an unset model ref means zero sends and one advisory log per session", async () => {
		const harness = makeHarness();
		await withConfig({}, async () => {
			assert.strictEqual(await invoke(harness), undefined);
			assert.strictEqual(await invoke(harness), undefined);
		});
		assert.strictEqual(harness.requests.length, 0);
		const advisories = harness.logs.filter((line) => line.message.includes("inlineCompletions.model"));
		assert.strictEqual(advisories.length, 1, "the advisory logs once, not per keystroke");
	});

	test("a failing send degrades to no suggestion with one terse log line per failure class", async () => {
		let failure: Error = new Error("boom with response text that must not surface");
		const harness = makeHarness(async () => {
			throw failure;
		});
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			assert.strictEqual(await invoke(harness), undefined);
			assert.strictEqual(await invoke(harness), undefined, "a second failure of the same class stays silent");
			failure = new TypeError("different class");
			assert.strictEqual(await invoke(harness), undefined);
		});
		assert.strictEqual(harness.requests.length, 3);
		assert.deepStrictEqual(
			harness.logs.map((line) => line.data),
			[{ error: "Error" }, { error: "TypeError" }],
			"one line per failure class, the class name only, never the message"
		);
		assert.ok(!JSON.stringify(harness.logs).includes("boom"), "no response-derived text reaches the log");
	});

	test("a malformed language-list setting advises once per list, not per keystroke", async () => {
		const harness = makeHarness(async () => "unused");
		const config = {
			"inlineCompletions.model": MODEL_REF,
			"inlineCompletions.allowedLanguages": "typescript",
			"inlineCompletions.blockedLanguages": "markdown",
		};
		await withConfig(config, async () => {
			await invoke(harness);
			await invoke(harness);
		});
		const advisories = harness.logs.filter((line) => line.message.includes("language list"));
		assert.strictEqual(advisories.length, 2, "one line per broken list, session-deduplicated");
	});

	test("hostile error shapes still log a safe label instead of throwing or leaking", async () => {
		const throwingGetter = {};
		Object.defineProperty(throwingGetter, "logClassification", {
			get() {
				throw new Error("trap");
			},
		});
		const multiLine = new Error("x");
		multiLine.name = "leak\nSECRET-RESPONSE-BODY";
		const longClassification = Object.assign(new Error("y"), { logClassification: "z".repeat(500) });
		const throwingPrototype = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error("prototype trap");
				},
			}
		);
		for (const [hostile, expected] of [
			[throwingGetter, "unreadable-error"],
			[multiLine, "object"],
			[longClassification, "Error"],
			[throwingPrototype, "unreadable-error"],
		] as const) {
			const harness = makeHarness(async () => {
				throw hostile;
			});
			const items = await withConfig({ "inlineCompletions.model": MODEL_REF }, () => invoke(harness));
			assert.strictEqual(items, undefined);
			assert.deepStrictEqual(harness.logs[0]?.data, { error: expected });
			assert.ok(!JSON.stringify(harness.logs).includes("SECRET-RESPONSE-BODY"));
		}
	});

	test("a cancellation thrown by the send is never logged", async () => {
		const harness = makeHarness(async () => {
			throw new vscode.CancellationError();
		});
		const items = await withConfig({ "inlineCompletions.model": MODEL_REF }, () => invoke(harness));
		assert.strictEqual(items, undefined);
		assert.deepStrictEqual(harness.logs, []);
	});

	test("the send receives budget-truncated context, never the whole document", async () => {
		const harness = makeHarness(async () => "ignored");
		const content = `${"x".repeat(20000)}CURSOR${"y".repeat(20000)}`;
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			const document = await vscode.workspace.openTextDocument({ content, language: "typescript" });
			const position = document.positionAt(content.indexOf("CURSOR"));
			const token = new vscode.CancellationTokenSource().token;
			await harness.provider.provideInlineCompletionItems(
				document,
				position,
				{ triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
				token
			);
		});
		const request = harness.requests[0];
		assert.ok(request !== undefined);
		assert.strictEqual(request.prefix.length, FIM_PREFIX_BUDGET);
		assert.ok(request.prefix.endsWith("x"), "the prefix keeps the tail nearest the cursor");
		assert.strictEqual(request.suffix.length, FIM_SUFFIX_BUDGET);
		assert.ok(request.suffix.startsWith("CURSOR"), "the suffix keeps the head nearest the cursor");
	});

	test("a budget boundary inside astral text never sends a severed surrogate", async () => {
		const harness = makeHarness(async () => "ignored");
		// Pure astral content: any boundary parity is one code unit away from a
		// severed pair, so both windows exercise the shared truncation pipeline.
		const emoji = "\u{1F600}";
		const content = emoji.repeat(12000);
		await withConfig({ "inlineCompletions.model": MODEL_REF }, async () => {
			const document = await vscode.workspace.openTextDocument({ content, language: "typescript" });
			const position = document.positionAt(12000);
			const token = new vscode.CancellationTokenSource().token;
			await harness.provider.provideInlineCompletionItems(
				document,
				position,
				{ triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
				token
			);
		});
		const request = harness.requests[0];
		assert.ok(request !== undefined);
		assert.ok(request.prefix.isWellFormed(), "the prefix window repaired its cut");
		assert.ok(request.suffix.isWellFormed(), "the suffix window repaired its cut");
		assert.ok(request.prefix.length >= FIM_PREFIX_BUDGET - 1 && request.prefix.length <= FIM_PREFIX_BUDGET);
		assert.ok(request.suffix.length >= FIM_SUFFIX_BUDGET - 1 && request.suffix.length <= FIM_SUFFIX_BUDGET);
	});
});
