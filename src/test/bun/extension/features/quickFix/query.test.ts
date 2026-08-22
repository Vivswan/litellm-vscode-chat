import { describe, test } from "bun:test";
import * as assert from "node:assert";
import {
	buildChatQuery,
	buildFallbackPrompt,
	type FallbackPromptInput,
	MAX_CLAIMED_DIAGNOSTICS,
	MAX_PROMPT_DIAGNOSTIC_TEXT,
	MAX_PROMPT_EXCERPT_CHARS,
	MAX_QUERY_DIAGNOSTIC_TEXT,
	type QuickFixDiagnostic,
	type QuickFixPosition,
	type QuickFixRange,
	selectDiagnostics,
} from "../../../../../extension/features/quickFix/query";

function makeDiagnostic(
	message: string,
	overrides: Partial<QuickFixDiagnostic> & { line?: number } = {}
): QuickFixDiagnostic {
	const line = overrides.line ?? 0;
	const start: QuickFixPosition = { line, character: 0 };
	return {
		message,
		severity: overrides.severity ?? 0,
		range: overrides.range ?? { start, end: { line, character: 4 } },
		...(overrides.source === undefined ? {} : { source: overrides.source }),
		...(overrides.code === undefined ? {} : { code: overrides.code }),
	};
}

describe("extension/features/quickFix/query", () => {
	describe("selectDiagnostics", () => {
		test("empty input selects nothing", () => {
			assert.deepStrictEqual(selectDiagnostics([]), []);
		});

		test("returns the caller's own objects, not copies", () => {
			const diagnostic = makeDiagnostic("unused variable");
			assert.strictEqual(selectDiagnostics([diagnostic])[0], diagnostic);
		});

		test("preserves the caller's element type", () => {
			const tagged = [{ ...makeDiagnostic("x"), tag: "mine" }];
			const selected = selectDiagnostics(tagged);
			assert.strictEqual(selected[0]?.tag, "mine");
		});

		test("dedupes by message + range, keeping one", () => {
			const twin = makeDiagnostic("unused variable", { line: 3 });
			const selected = selectDiagnostics([twin, makeDiagnostic("unused variable", { line: 3 })]);
			assert.strictEqual(selected.length, 1);
			assert.strictEqual(selected[0]?.message, "unused variable");
		});

		test("dedupes on the normalized message, matching what renders", () => {
			const selected = selectDiagnostics([
				makeDiagnostic("unused  variable", { line: 3 }),
				makeDiagnostic("unused\nvariable", { line: 3 }),
			]);
			assert.strictEqual(selected.length, 1);
		});

		test("same message at a different range is not a duplicate", () => {
			const selected = selectDiagnostics([
				makeDiagnostic("unused variable", { line: 3 }),
				makeDiagnostic("unused variable", { line: 9 }),
			]);
			assert.strictEqual(selected.length, 2);
		});

		test("same range with a different message is not a duplicate", () => {
			const selected = selectDiagnostics([
				makeDiagnostic("unused variable", { line: 3 }),
				makeDiagnostic("missing semicolon", { line: 3 }),
			]);
			assert.strictEqual(selected.length, 2);
		});

		test("a duplicate reported at two severities survives as the higher one", () => {
			const selected = selectDiagnostics([
				makeDiagnostic("shadowed name", { line: 5, severity: 1 }),
				makeDiagnostic("shadowed name", { line: 5, severity: 0 }),
			]);
			assert.strictEqual(selected.length, 1);
			assert.strictEqual(selected[0]?.severity, 0);
		});

		test("orders by severity, errors first, stable within a level", () => {
			const selected = selectDiagnostics([
				makeDiagnostic("hint", { line: 1, severity: 3 }),
				makeDiagnostic("warn A", { line: 2, severity: 1 }),
				makeDiagnostic("error", { line: 3, severity: 0 }),
				makeDiagnostic("warn B", { line: 4, severity: 1 }),
				makeDiagnostic("info", { line: 5, severity: 2 }),
			]);
			assert.deepStrictEqual(
				selected.map((diagnostic) => diagnostic.message),
				["error", "warn A", "warn B", "info", "hint"]
			);
		});

		test("drops whitespace-only messages", () => {
			assert.deepStrictEqual(selectDiagnostics([makeDiagnostic(" \n\t ")]), []);
		});

		test("whitespace-only messages consume no claim slots", () => {
			const blanks = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS }, (_, index) =>
				makeDiagnostic("  ", { line: index })
			);
			const real = makeDiagnostic("real problem", { line: 30, severity: 3 });
			assert.deepStrictEqual(selectDiagnostics([...blanks, real]), [real]);
		});

		test("caps at MAX_CLAIMED_DIAGNOSTICS, dropping the lowest severities", () => {
			const diagnostics = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS + 2 }, (_, index) =>
				makeDiagnostic(`d${index}`, { line: index, severity: index % 4 })
			);
			const selected = selectDiagnostics(diagnostics);
			assert.strictEqual(selected.length, MAX_CLAIMED_DIAGNOSTICS);
			const maxSelected = Math.max(...selected.map((diagnostic) => diagnostic.severity));
			const dropped = diagnostics.filter((diagnostic) => !selected.includes(diagnostic));
			assert.strictEqual(dropped.length, 2);
			for (const diagnostic of dropped) {
				assert.ok(diagnostic.severity >= maxSelected);
			}
		});

		test("the cap applies after the dedupe, not before", () => {
			const twin: QuickFixRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } };
			const diagnostics = [
				...Array.from({ length: MAX_CLAIMED_DIAGNOSTICS }, () => makeDiagnostic("same", { range: twin })),
				makeDiagnostic("distinct", { line: 20, severity: 3 }),
			];
			const selected = selectDiagnostics(diagnostics);
			assert.deepStrictEqual(
				selected.map((diagnostic) => diagnostic.message),
				["same", "distinct"]
			);
		});

		test("is idempotent: re-selecting a selection changes nothing", () => {
			const diagnostics = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS + 3 }, (_, index) =>
				makeDiagnostic(`d${index}`, { line: index, severity: index % 4 })
			);
			const once = selectDiagnostics(diagnostics);
			assert.deepStrictEqual(selectDiagnostics(once), once);
		});
	});

	describe("buildChatQuery", () => {
		test("fix mode targets @litellm /fix", () => {
			const query = buildChatQuery("fix", [makeDiagnostic("Cannot find name 'foo'.")]);
			assert.strictEqual(query, "@litellm /fix Cannot find name 'foo'.");
		});

		test("explain mode targets @litellm /explain", () => {
			const query = buildChatQuery("explain", [makeDiagnostic("Cannot find name 'foo'.")]);
			assert.strictEqual(query, "@litellm /explain Cannot find name 'foo'.");
		});

		test("joins messages with a semicolon separator", () => {
			const query = buildChatQuery("fix", [makeDiagnostic("first"), makeDiagnostic("second", { line: 1 })]);
			assert.strictEqual(query, "@litellm /fix first; second");
		});

		test("collapses multi-line messages to one line", () => {
			const query = buildChatQuery("fix", [makeDiagnostic("first line\n\t  second line")]);
			assert.strictEqual(query, "@litellm /fix first line second line");
		});

		test("a message at exactly the budget passes through untouched", () => {
			const exact = "x".repeat(MAX_QUERY_DIAGNOSTIC_TEXT);
			const query = buildChatQuery("fix", [makeDiagnostic(exact)]);
			assert.strictEqual(query, `@litellm /fix ${exact}`);
		});

		test("one character over the budget truncates to the budget with a marker", () => {
			const over = "x".repeat(MAX_QUERY_DIAGNOSTIC_TEXT + 1);
			const query = buildChatQuery("fix", [makeDiagnostic(over)]);
			const text = query.slice("@litellm /fix ".length);
			assert.strictEqual(text.length, MAX_QUERY_DIAGNOSTIC_TEXT);
			assert.ok(text.endsWith("..."));
			assert.strictEqual(text.slice(0, -3), "x".repeat(MAX_QUERY_DIAGNOSTIC_TEXT - 3));
		});

		test("a cut landing mid-surrogate-pair drops the dangling half", () => {
			const message = `${"x".repeat(MAX_QUERY_DIAGNOSTIC_TEXT - 4)}\u{1F600}xxx`;
			const query = buildChatQuery("fix", [makeDiagnostic(message)]);
			assert.ok(query.isWellFormed());
			assert.ok(query.endsWith("..."));
			assert.ok(query.length <= "@litellm /fix ".length + MAX_QUERY_DIAGNOSTIC_TEXT);
		});

		test("no diagnostics yields the bare command, no trailing space", () => {
			assert.strictEqual(buildChatQuery("fix", []), "@litellm /fix");
		});

		test("whitespace-only messages contribute nothing", () => {
			assert.strictEqual(buildChatQuery("explain", [makeDiagnostic(" \n\t ")]), "@litellm /explain");
		});

		test("blank messages do not evict real ones from the cap", () => {
			const blanks = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS }, (_, index) =>
				makeDiagnostic(" ", { line: index })
			);
			const query = buildChatQuery("fix", [...blanks, makeDiagnostic("real problem", { line: 30, severity: 3 })]);
			assert.strictEqual(query, "@litellm /fix real problem");
		});

		test("re-applies the claim cap, so the query is bounded by construction", () => {
			const diagnostics = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS + 3 }, (_, index) =>
				makeDiagnostic(`d${index}`, { line: index })
			);
			const query = buildChatQuery("fix", diagnostics);
			assert.strictEqual(query.split("; ").length, MAX_CLAIMED_DIAGNOSTICS);
			assert.ok(!query.includes(`d${MAX_CLAIMED_DIAGNOSTICS}`));
		});

		test("a diagnostic cannot smuggle chat syntax into the submitted query", () => {
			// Diagnostic text routinely quotes workspace-controlled source, and this
			// query is SUBMITTED rather than shown for review, so a "#toolname" in a
			// message would otherwise resolve to a real tool reference on the turn.
			const query = buildChatQuery("fix", [
				makeDiagnostic("Cannot find #codebase or @workspace, see ##double and @@at"),
			]);
			assert.strictEqual(query, "@litellm /fix Cannot find codebase or workspace, see double and at");
			// Our own prefix is built here, not read from the message, so it stays.
			assert.ok(query.startsWith("@litellm /fix "));
		});

		test("defusing takes only the sigil, and only where it could name something", () => {
			// "#include not found" must still read as a diagnostic, and a sigil that
			// cannot begin a reference (mid-word, or standing alone) is left alone.
			assert.strictEqual(
				buildChatQuery("fix", [makeDiagnostic("#include not found in a@b.c and # alone")]),
				"@litellm /fix include not found in a@b.c and # alone"
			);
		});
	});

	describe("buildFallbackPrompt", () => {
		const base = {
			// The mode-invariant properties below are pinned on the fix prompt; the
			// two modes' own wording has its own test at the end of this suite.
			mode: "fix",
			path: "/work/src/example.ts",
			languageId: "typescript",
			excerpt: "const x: number = 'oops';",
		} satisfies Omit<FallbackPromptInput, "diagnostics">;

		test("requests a fix explanation over the named file", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("type mismatch")] });
			assert.ok(prompt.startsWith("Explain what causes the diagnostics below in `/work/src/example.ts`"));
			assert.ok(prompt.includes("propose a fix"));
		});

		test("a backtick in the path widens the code span instead of breaking it", () => {
			const prompt = buildFallbackPrompt({
				...base,
				path: "/work/we`ird.ts",
				diagnostics: [makeDiagnostic("d")],
			});
			assert.ok(prompt.includes("``/work/we`ird.ts``"));
		});

		test("an empty path reads as the current file, never an empty code span", () => {
			const prompt = buildFallbackPrompt({ ...base, path: "", diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.startsWith("Explain what causes the diagnostics below in the current file"));
			assert.ok(!prompt.split("\n")[0]?.includes("`"));
		});

		test("lists each diagnostic with severity label, origin, and location", () => {
			const prompt = buildFallbackPrompt({
				...base,
				diagnostics: [
					makeDiagnostic("Cannot find name 'foo'.", { line: 11, severity: 0, source: "ts", code: 2304 }),
					makeDiagnostic("unreachable code", { line: 2, severity: 1 }),
				],
			});
			assert.ok(prompt.includes("- Error ts(2304) at line 12: Cannot find name 'foo'."));
			assert.ok(prompt.includes("- Warning at line 3: unreachable code"));
		});

		test("a multi-line range renders as a one-based line span", () => {
			const range: QuickFixRange = { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } };
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("block issue", { range })] });
			assert.ok(prompt.includes("at lines 3-5:"));
		});

		test("origin renders from source alone, code alone, or the host's object code", () => {
			const hostCode: { value: number; target: { path: string } } = {
				value: 2532,
				target: { path: "/docs/ts2532" },
			};
			const prompt = buildFallbackPrompt({
				...base,
				diagnostics: [
					makeDiagnostic("source only", { line: 0, source: "biome" }),
					makeDiagnostic("code only", { line: 1, code: "E501" }),
					makeDiagnostic("object code", { line: 2, source: "ts", code: hostCode }),
				],
			});
			assert.ok(prompt.includes("- Error biome at line 1: source only"));
			assert.ok(prompt.includes("- Error (E501) at line 2: code only"));
			assert.ok(prompt.includes("- Error ts(2532) at line 3: object code"));
		});

		test("a null code renders no origin instead of throwing", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("nulled", { code: null })] });
			assert.ok(prompt.includes("- Error at line 1: nulled"));
		});

		test("a zero code still renders as an origin", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("zeroed", { code: 0 })] });
			assert.ok(prompt.includes("- Error (0) at line 1: zeroed"));
		});

		test("newlines in source or code collapse inside the bullet", () => {
			const prompt = buildFallbackPrompt({
				...base,
				diagnostics: [makeDiagnostic("messy origin", { source: "eslint\nrogue", code: "E5\r\n01" })],
			});
			assert.ok(prompt.includes("- Error eslint rogue(E5 01) at line 1: messy origin"));
		});

		test("oversized source and code truncate instead of flooding the bullet", () => {
			const prompt = buildFallbackPrompt({
				...base,
				diagnostics: [makeDiagnostic("big origin", { source: "s".repeat(300), code: "c".repeat(300) })],
			});
			const bullet = prompt.split("\n").find((line) => line.startsWith("- "));
			assert.ok(bullet !== undefined);
			assert.ok(bullet.length < 300);
			assert.ok(bullet.includes("s...("));
			assert.ok(bullet.includes("c...)"));
		});

		test("a blank code renders no empty parentheses, scalar or object form", () => {
			const blankObject: { value: string } = { value: "  " };
			const prompt = buildFallbackPrompt({
				...base,
				diagnostics: [
					makeDiagnostic("blank scalar", { line: 0, code: "" }),
					makeDiagnostic("blank object", { line: 1, source: "ts", code: blankObject }),
				],
			});
			assert.ok(prompt.includes("- Error at line 1: blank scalar"));
			assert.ok(prompt.includes("- Error ts at line 2: blank object"));
			assert.ok(!prompt.includes("()"));
		});

		test("an unknown severity number gets the generic label", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("odd", { severity: 7 })] });
			assert.ok(prompt.includes("- Diagnostic at line 1: odd"));
		});

		test("collapses multi-line messages inside a bullet", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("first\n\tsecond")] });
			assert.ok(prompt.includes("- Error at line 1: first second"));
		});

		test("a message at exactly the prompt budget passes through untouched", () => {
			const exact = "y".repeat(MAX_PROMPT_DIAGNOSTIC_TEXT);
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic(exact)] });
			assert.ok(prompt.includes(`: ${exact}\n`));
			assert.ok(!prompt.includes(`${exact}...`));
		});

		test("diagnostic messages truncate at the prompt budget", () => {
			const over = "y".repeat(MAX_PROMPT_DIAGNOSTIC_TEXT + 1);
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic(over)] });
			assert.ok(prompt.includes(`${"y".repeat(MAX_PROMPT_DIAGNOSTIC_TEXT - 3)}...`));
			assert.ok(!prompt.includes(over));
		});

		test("fences the excerpt under the language id", () => {
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [makeDiagnostic("type mismatch")] });
			assert.ok(prompt.includes("Code excerpt:\n```typescript\nconst x: number = 'oops';\n```"));
		});

		test("backticks and newlines in the language id never reach the fence info string", () => {
			const prompt = buildFallbackPrompt({
				...base,
				languageId: "type`script\r\nmalicious",
				diagnostics: [makeDiagnostic("d")],
			});
			assert.ok(prompt.includes("Code excerpt:\n```typescriptmalicious\nconst x: number = 'oops';\n```"));
		});

		test("the fence outgrows a plain markdown fence inside the excerpt", () => {
			const excerpt = "```md\nnested\n```";
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.includes(`\`\`\`\`typescript\n${excerpt}\n\`\`\`\``));
		});

		test("the fence outgrows longer backtick runs inside the excerpt", () => {
			const excerpt = "const s = ````raw````;";
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.includes(`\`\`\`\`\`typescript\n${excerpt}\n\`\`\`\`\``));
		});

		test("truncates the excerpt at the budget with the marker outside the fence", () => {
			const excerpt = "z".repeat(MAX_PROMPT_EXCERPT_CHARS + 10);
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.includes(`${"z".repeat(MAX_PROMPT_EXCERPT_CHARS)}\n\`\`\`\n(excerpt truncated)`));
			assert.ok(!prompt.includes("z".repeat(MAX_PROMPT_EXCERPT_CHARS + 1)));
		});

		test("an excerpt at exactly the budget carries no truncation marker", () => {
			const excerpt = "z".repeat(MAX_PROMPT_EXCERPT_CHARS);
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(!prompt.includes("(excerpt truncated)"));
		});

		test("the fence is measured on the kept text, not runs beyond the cut", () => {
			const kept = `${"z".repeat(MAX_PROMPT_EXCERPT_CHARS - 3)}\`\`\``;
			const excerpt = `${kept}\`\`\`\`\`\``;
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.includes(`\`\`\`\`typescript\n${kept}\n\`\`\`\`\n(excerpt truncated)`));
		});

		test("an excerpt inside the budget is passed through verbatim, with no truncation marker", () => {
			// The private helper this builder used to call trimmed a trailing lone
			// surrogate even when NOTHING was cut, which deleted a unit of the
			// user's own code and then appended a truncation marker to an excerpt
			// that had never been truncated. The marker now means exactly one
			// thing: the excerpt did not fit.
			// The lone unit must be LAST: the old helper only inspected the final
			// code unit, so a surrogate anywhere else would not discriminate.
			const excerpt = 'const s = "a\uD800';
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(!prompt.includes("(excerpt truncated)"), "nothing was cut, so nothing may claim it was");
			assert.ok(prompt.includes(excerpt), "the user's code reaches the model as they wrote it");
		});

		test("an excerpt cut mid-surrogate-pair stays well-formed", () => {
			const excerpt = `${"z".repeat(MAX_PROMPT_EXCERPT_CHARS - 1)}\u{1F600}z`;
			const prompt = buildFallbackPrompt({ ...base, excerpt, diagnostics: [makeDiagnostic("d")] });
			assert.ok(prompt.isWellFormed());
			assert.ok(prompt.includes("(excerpt truncated)"));
		});

		test("an empty excerpt omits the excerpt section", () => {
			const prompt = buildFallbackPrompt({ ...base, excerpt: "", diagnostics: [makeDiagnostic("d")] });
			assert.ok(!prompt.includes("Code excerpt:"));
			assert.ok(!prompt.includes("```"));
		});

		test("re-applies the claim cap to the diagnostics list", () => {
			const diagnostics = Array.from({ length: MAX_CLAIMED_DIAGNOSTICS + 2 }, (_, index) =>
				makeDiagnostic(`d${index}`, { line: index })
			);
			const prompt = buildFallbackPrompt({ ...base, diagnostics });
			assert.ok(prompt.includes(`d${MAX_CLAIMED_DIAGNOSTICS - 1}`));
			assert.ok(!prompt.includes(`d${MAX_CLAIMED_DIAGNOSTICS}`));
		});

		test("an empty selection yields a headed but empty diagnostics section", () => {
			// Phase 2 offers the action only when the selection is nonempty; this
			// pins the total-function shape rather than a supported call path.
			const prompt = buildFallbackPrompt({ ...base, diagnostics: [] });
			assert.ok(prompt.includes("Diagnostics:\n\nCode excerpt:"));
			assert.ok(!prompt.includes("- "));
		});

		test("the two modes ask different questions, as they do on the chat path", () => {
			// The fallback runs when the chat view is unavailable, which is not a
			// reason for Explain to start rewriting the user's code.
			const diagnostics = [makeDiagnostic("type mismatch")];
			const fix = buildFallbackPrompt({ ...base, mode: "fix", diagnostics });
			const explain = buildFallbackPrompt({ ...base, mode: "explain", diagnostics });
			assert.ok(fix.includes("propose a fix"));
			assert.ok(!explain.includes("propose a fix"));
			assert.ok(explain.includes("Explain rather than rewrite"));
			// Everything below the request line is the same material either way.
			assert.ok(explain.includes("- Error at line 1: type mismatch"));
			assert.ok(explain.includes("Code excerpt:"));
		});
	});
});
