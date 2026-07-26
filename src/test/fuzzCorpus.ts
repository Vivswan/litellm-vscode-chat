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

export const FUZZ_CORPUS: CorpusEntry[] = [];
