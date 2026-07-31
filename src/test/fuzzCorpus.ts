/**
 * Corpus of generated streams that once failed the fuzzer. Entries replay at
 * the start of every fuzz run, before the random iterations, so a bug found
 * by a nightly seed stays found after the generator itself changes.
 *
 * To add an entry: take the "minimal failing events" JSON from the failure
 * report (the fuzzer shrinks failures automatically) and append it here with
 * a name referencing the issue.
 */

export interface ExpectedToolCall {
	name: string;
	args: Record<string, unknown>;
}

/**
 * One generated stream event: the SSE chunks it contributes plus its exact
 * expected effect on the response. Serializable, so failures can be shrunk,
 * reported, and replayed verbatim.
 */
export interface FuzzEvent {
	label: string;
	chunks: unknown[];
	/** Visible text this event appends, in stream order. */
	text?: string;
	/**
	 * Thinking text this event must surface as thinking parts (the pinned
	 * host exposes the thinking-part class, so reasoning deltas emit them).
	 * Asserted only when at least one event of the stream declares it.
	 */
	thinking?: string;
	/** Tool calls this event must produce. */
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
	 * Which fuzz target may replay this entry. Direct-mode repros can carry
	 * shapes the proxy rejects outright (lone surrogates, malformed chunks),
	 * so a direct failure must never replay through the proxy.
	 */
	mode: "proxy" | "direct" | "both";
	events: FuzzEvent[];
}

/** One full chunk envelope in the shape the generator's chunkOf produces. */
function chunk(delta: Record<string, unknown>): unknown {
	return { id: "chatcmpl-fuzz", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
}

export const FUZZ_CORPUS: CorpusEntry[] = [
	{
		// The #215 guard's false-positive direction, end to end: a stream that is
		// nothing but reasoning must resolve cleanly (the pinned host displays
		// thinking parts), never trip the reasoning-only error, and never leak
		// reasoning into visible text. All three delta shapes ride along.
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
		// The exact wire shape the #215 report used: reasoning deltas with no
		// top-level id/object and no choice index. parseChunk's leniency on this
		// shape is pinned as unit examples; this replays it over a real socket.
		// Direct only: the proxy normalizes chunk envelopes, so an id-less repro
		// must never replay through it.
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
		// Emission accounting: a stream whose only reportable output is a tool
		// call (after reasoning) must resolve with the call, not trip the
		// reasoning-only error. assemble() appends finish_reason "tool_calls".
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
		// The common real-model shape behind #215: reasoning first, then the
		// answer. Visible text must be exactly the content deltas, with no
		// reasoning prepended, interleaved, or duplicated.
		name: "issue-215-reasoning-then-text",
		mode: "both",
		events: [
			{ label: "reasoning", thinking: "silent planning ", chunks: [chunk({ reasoning_content: "silent planning " })] },
			{ label: "reasoning-field", thinking: "more planning ", chunks: [chunk({ reasoning: "more planning " })] },
			{ label: "text", text: "the visible answer", chunks: [chunk({ content: "the visible answer" })] },
		],
	},
	{
		// A genuinely empty stream (role chunk + stop finish only) resolves
		// silently; the #215 guard must not fire through the real host.
		name: "issue-215-empty-stream",
		mode: "both",
		events: [{ label: "empty", chunks: [] }],
	},
];
