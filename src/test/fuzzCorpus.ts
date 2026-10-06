/**
 * Entries replay at the start of every fuzz run, before the random iterations, so a bug found by a nightly seed stays
 * found after the generator itself changes. To add one, take the "minimal failing events" JSON from the failure report
 * and append it here with a name referencing the issue.
 */

export interface ExpectedToolCall {
	name: string;
	args: Record<string, unknown>;
}

/** Serializable, so failures can be shrunk, reported, and replayed verbatim. */
export interface FuzzEvent {
	label: string;
	chunks: unknown[];
	/** Visible text this event appends, in stream order. */
	text?: string;
	/** Asserted only when at least one event of the stream declares it. */
	thinking?: string;
	tools?: ExpectedToolCall[];
	/** True when the tool calls arrive on the delta channel (triggers the one-time space hint after text). */
	deltaToolChannel?: boolean;
	/** URL citation this event attaches; the extension emits one trailer at end of stream. */
	citation?: { url: string; title: string };
	/** Direct-mode only: the proxy rejects or rewrites these chunks, so they never run through it. */
	directOnly?: boolean;
}

export interface CorpusEntry {
	name: string;
	/**
	 * Direct-mode repros can carry shapes the proxy rejects outright, so a direct failure must never replay through
	 * the proxy.
	 */
	mode: "proxy" | "direct" | "both";
	events: FuzzEvent[];
}

/** One full chunk envelope in the shape the generator's chunkOf produces. */
function chunk(delta: Record<string, unknown>, finishReason?: string): unknown {
	return {
		id: "chatcmpl-fuzz",
		object: "chat.completion.chunk",
		choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
	};
}

function deltaCallStart(index: number, name: string, args: string): unknown {
	return chunk({
		tool_calls: [{ index, id: `call_fuzz_${index}`, type: "function", function: { name, arguments: args } }],
	});
}

function deltaCallArgs(index: number, args: string, finishReason?: string): unknown {
	return chunk({ tool_calls: [{ index, function: { arguments: args } }] }, finishReason);
}

export const FUZZ_CORPUS: CorpusEntry[] = [
	{
		// The #456 shape: a provider's finish_reason arrives while a delta-channel call's arguments are still streaming.
		// The finish_reason must not finalize the call; each event is one placement of it.
		name: "issue-456-arguments-after-finish-reason",
		mode: "both",
		events: [
			{
				label: "split-delta-tool-before-last",
				deltaToolChannel: true,
				tools: [{ name: "get_weather", args: { seq: 0, city: "berlin" } }],
				chunks: [
					deltaCallStart(0, "get_weather", '{"seq":0,"city":'),
					chunk({}, "tool_calls"),
					deltaCallArgs(0, '"berlin"}'),
				],
			},
			{
				label: "split-delta-tool-same-chunk",
				deltaToolChannel: true,
				tools: [{ name: "search_docs", args: { seq: 1, q: "docs" } }],
				chunks: [deltaCallStart(1, "search_docs", '{"seq":1,"q":'), deltaCallArgs(1, '"docs"}', "tool_calls")],
			},
			{
				label: "split-delta-tool-empty-delta-between",
				deltaToolChannel: true,
				tools: [{ name: "run_query", args: { seq: 2 } }],
				chunks: [deltaCallStart(2, "run_query", '{"seq":2'), chunk({}, "stop"), chunk({}), deltaCallArgs(2, "}")],
			},
			{
				label: "split-delta-tool-text-after",
				deltaToolChannel: true,
				text: "done ",
				tools: [{ name: "get_weather", args: { seq: 3, n: 4 } }],
				chunks: [
					deltaCallStart(3, "get_weather", '{"seq":3,"n":'),
					chunk({}, "tool_calls"),
					deltaCallArgs(3, "4}"),
					chunk({ content: "done " }),
				],
			},
		],
	},
	{
		// The #476 shape: a finish_reason placed among an inline call's content chunks, which the text parser's held
		// call must survive. Same placements as the delta-channel entry.
		name: "issue-476-inline-call-split-around-finish-reason",
		mode: "both",
		events: [
			{
				label: "split-inline-tool-before-last",
				text: "ok ",
				tools: [{ name: "get_weather", args: { seq: 0, a: 1 } }],
				chunks: [
					chunk({ content: 'ok <|tool_call_begin|>get_weather:0<|tool_call_argument_begin|>{"seq":0,"a":' }),
					chunk({}, "stop"),
					chunk({ content: "1}<|tool_call_end|>" }),
				],
			},
			{
				label: "split-inline-tool-same-chunk",
				tools: [{ name: "run_query", args: { seq: 1, q: "x" } }],
				chunks: [
					chunk({ content: '<|tool_call_begin|>run_query:1<|tool_call_argument_begin|>{"seq":1,' }),
					chunk({ content: '"q":"x"}<|tool_call_end|>' }, "tool_calls"),
				],
			},
			{
				label: "split-inline-tool-empty-delta-between",
				tools: [{ name: "search_docs", args: { seq: 2 } }],
				chunks: [
					chunk({ content: '<|tool_call_begin|>search_docs:2<|tool_call_argument_begin|>{"seq":2' }),
					chunk({}, "stop"),
					chunk({}),
					chunk({ content: "}<|tool_call_end|>" }),
				],
			},
			{
				label: "split-inline-tool-text-after",
				text: " after",
				tools: [{ name: "get_weather", args: { seq: 3, n: 4 } }],
				chunks: [
					chunk({ content: '<|tool_call_begin|>get_weather:3<|tool_call_argument_begin|>{"seq":3,"n":' }),
					chunk({}, "stop"),
					chunk({ content: "4}<|tool_call_end|>" }),
					chunk({ content: " after" }),
				],
			},
		],
	},
	{
		// The #215 guard's false-positive direction: a stream that is nothing but reasoning must resolve cleanly, never
		// trip the reasoning-only error, and never leak reasoning into visible text. All three delta shapes ride along.
		name: "issue-215-reasoning-only",
		mode: "both",
		events: [
			{ label: "reasoning", thinking: "step one ", chunks: [chunk({ reasoning_content: "step one " })] },
			{ label: "reasoning-field", thinking: "step two ", chunks: [chunk({ reasoning: "step two " })] },
			{
				label: "thinking-blocks",
				thinking: "step three",
				chunks: [
					chunk({
						reasoning_content: "step three",
						thinking_blocks: [{ type: "thinking", thinking: "step three", signature: "sig-215" }],
					}),
				],
			},
		],
	},
	{
		// The exact wire shape the #215 report used: reasoning deltas with no top-level id/object and no choice index,
		// replayed over a real socket. Direct only: the proxy normalizes chunk envelopes.
		name: "issue-215-reasoning-no-chunk-id",
		mode: "direct",
		events: [
			{
				label: "bare-reasoning",
				thinking: "step one step two",
				chunks: [
					{ choices: [{ delta: { reasoning_content: "step one " } }] },
					{ choices: [{ delta: { reasoning_content: "step two" } }] },
				],
			},
		],
	},
	{
		// Emission accounting: a stream whose only reportable output is a tool call (after reasoning) must resolve with
		// the call, not trip the reasoning-only error.
		name: "issue-215-reasoning-then-tool-call-only",
		mode: "both",
		events: [
			{
				label: "reasoning",
				thinking: "deciding which tool ",
				chunks: [chunk({ reasoning_content: "deciding which tool " })],
			},
			{
				label: "delta-tool",
				deltaToolChannel: true,
				tools: [{ name: "get_weather", args: { seq: 0 } }],
				chunks: [
					chunk({
						tool_calls: [
							{
								index: 0,
								id: "call_fuzz_0",
								type: "function",
								function: { name: "get_weather", arguments: '{"seq":0}' },
							},
						],
					}),
				],
			},
		],
	},
	{
		// The common real-model shape behind #215: reasoning first, then the answer. Visible text must be exactly the
		// content deltas, with no reasoning prepended, interleaved, or duplicated.
		name: "issue-215-reasoning-then-text",
		mode: "both",
		events: [
			{ label: "reasoning", thinking: "silent planning ", chunks: [chunk({ reasoning_content: "silent planning " })] },
			{ label: "reasoning-field", thinking: "more planning ", chunks: [chunk({ reasoning: "more planning " })] },
			{ label: "text", text: "the visible answer", chunks: [chunk({ content: "the visible answer" })] },
		],
	},
	{
		// A genuinely empty stream (role chunk + stop finish only) resolves silently; the #215 guard must not fire
		// through the real host.
		name: "issue-215-empty-stream",
		mode: "both",
		events: [{ label: "empty", chunks: [] }],
	},
];

/**
 * Corpus for the settings-redesign migration fuzzer: old-world configuration snapshots that once failed an invariant,
 * replayed before the random iterations. To add one, take the shrunken counterexample's snapshot from the failure
 * report and append it with a name referencing the issue.
 */
export interface MigrationCorpusEntry {
	name: string;
	/** Setting id -> configured layers, exactly the pure transform's snapshot shape. */
	snapshot: Record<string, { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown }>;
}

export const MIGRATION_FUZZ_CORPUS: MigrationCorpusEntry[] = [];

/**
 * Corpus for the dashboard request-schema fuzzer: webview envelopes that parseDashboardRequest once ACCEPTED and must
 * refuse, replayed by the schema property suite before its random mutation runs so the hole stays covered after the
 * generators change. To add one, take the shrunken counterexample's mutant request from the failure report and append
 * it with a name referencing the seed or issue.
 */
export interface RefusedDashboardRequestEntry {
	name: string;
	/** The full envelope, exactly as the mutation run posted it. */
	request: unknown;
}

export const REFUSED_DASHBOARD_REQUESTS: RefusedDashboardRequestEntry[] = [
	{
		// Seed -1876246623: a setLanguageFilter patch naming both fields. Each dashboard row sends only its own half,
		// so the wire shape is exactly one field per patch; the optional-fields schema this slipped through also
		// admitted the empty patch.
		name: "setLanguageFilter-both-fields",
		request: { kind: "request", id: " ", method: "setLanguageFilter", payload: { mode: "block", languages: [] } },
	},
];
