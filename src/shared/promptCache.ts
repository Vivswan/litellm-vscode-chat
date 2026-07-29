import type {
	EphemeralCacheControl,
	OpenAIAssistantMessage,
	OpenAIChatContentBlock,
	OpenAIChatMessage,
	OpenAIFunctionToolDef,
	OpenAIPromptMessage,
	OpenAIToolMessage,
} from "./wire";

/**
 * Prompt-cache breakpoint pass. Runs after message and tool conversion, owns
 * every `cache_control` marker on the request, and never mutates its input.
 *
 * Anthropic caches the request prefix up to each breakpoint and allows at
 * most four per request. The pass spends that budget on the four prefixes
 * that stay byte-identical across the turns of an agent session:
 *
 * - the last tool definition (the whole tools block),
 * - the system message,
 * - the first user message (stable session anchor), and
 * - the last text-bearing message (rolling anchor; in agent sessions this is
 *   routinely a tool-result message).
 *
 * The budget is enforced structurally rather than counted: the three message
 * anchors collapse into a Set of indices (colliding anchors deduplicate, e.g.
 * a single user message is both the first-user and the rolling anchor), each
 * anchored message receives exactly one marker, and the tools array receives
 * at most one. Applying the pass to its own output is a no-op.
 *
 * Marker placement follows what LiteLLM's Anthropic adapter reads from
 * OpenAI-shaped requests, and the form differs by role. Tool-role messages
 * take a message-level marker: the adapter wraps them in a tool_result block
 * and only `message.cache_control` lands on that top-level block, which is
 * the only cacheable position (Anthropic rejects caching on the nested
 * sub-content, where a block-level marker would end up). Every other role
 * takes a block-level marker on its last non-empty text block, so string
 * content converts to the array-of-blocks form. Uncached messages keep
 * string content. The tools anchor is a tool-level marker on the last tool
 * definition, which both the Anthropic and Bedrock adapters read (caching
 * the whole tools block up to the marked tool).
 */

const CACHE_CONTROL: EphemeralCacheControl = Object.freeze({ type: "ephemeral" });

export interface PromptCacheRequest {
	messages: readonly OpenAIChatMessage[];
	tools?: readonly OpenAIFunctionToolDef[] | undefined;
}

export interface PromptCachedRequest {
	messages: OpenAIChatMessage[];
	tools?: OpenAIFunctionToolDef[] | undefined;
}

/**
 * Where one message's marker would go, parsed once per message by
 * locateCacheable and carrying everything markCacheable needs: tool-role
 * messages take the message-level marker (the adapter's only cacheable
 * position there), string content converts to a single marked text block, and
 * array content is marked on its last non-empty text block. No site means the
 * message cannot anchor: Anthropic rejects `cache_control` on empty text
 * blocks, and tool-call-only assistant turns have no content block to mark.
 */
type CacheableSite =
	| { kind: "message"; message: OpenAIToolMessage }
	| { kind: "string"; message: OpenAIPromptMessage | OpenAIAssistantMessage; text: string }
	| {
			kind: "block";
			message: OpenAIPromptMessage | OpenAIAssistantMessage;
			blocks: OpenAIChatContentBlock[];
			index: number;
	  };

/** The one cacheability parse; anchor selection and marker placement both consume its result. */
function locateCacheable(message: OpenAIChatMessage): CacheableSite | undefined {
	if (message.role === "tool") {
		// The string check re-proves what the type declares: this pass must stay
		// total (a widened tool content would still have .length and mismark).
		return typeof message.content === "string" && message.content.length > 0 ? { kind: "message", message } : undefined;
	}
	const { content } = message;
	if (typeof content === "string") {
		return content.length > 0 ? { kind: "string", message, text: content } : undefined;
	}
	if (!Array.isArray(content)) {
		return undefined;
	}
	const index = content.findLastIndex((block) => block.type === "text" && block.text.length > 0);
	return index === -1 ? undefined : { kind: "block", message, blocks: content, index };
}

/** A copy of the site's message carrying the marker; total because the site proves placement. */
function markCacheable(site: CacheableSite): OpenAIChatMessage {
	switch (site.kind) {
		case "message":
			return { ...site.message, cache_control: CACHE_CONTROL };
		case "string":
			return { ...site.message, content: [{ type: "text", text: site.text, cache_control: CACHE_CONTROL }] };
		case "block":
			return {
				...site.message,
				content: site.blocks.map((block, i) =>
					i === site.index && block.type === "text" ? { ...block, cache_control: CACHE_CONTROL } : block
				),
			};
	}
}

/** The deduplicated message anchors: system, first user, rolling last. */
function anchorIndices(
	messages: readonly OpenAIChatMessage[],
	sites: readonly (CacheableSite | undefined)[]
): Set<number> {
	const anchors = new Set<number>();
	const system = messages.findIndex((m, i) => m.role === "system" && sites[i] !== undefined);
	if (system !== -1) {
		anchors.add(system);
	}
	const firstUser = messages.findIndex((m, i) => m.role === "user" && sites[i] !== undefined);
	if (firstUser !== -1) {
		anchors.add(firstUser);
	}
	const rolling = sites.findLastIndex((site) => site !== undefined);
	if (rolling !== -1) {
		anchors.add(rolling);
	}
	return anchors;
}

/**
 * Place up to four `cache_control` breakpoints on a converted request. Pure
 * and idempotent; callers gate it on the prompt-caching setting and the
 * model's capability.
 */
export function applyPromptCacheBreakpoints(request: PromptCacheRequest): PromptCachedRequest {
	const sites = request.messages.map((message) => locateCacheable(message));
	const anchors = anchorIndices(request.messages, sites);
	const messages = request.messages.map((message, i) => {
		const site = sites[i];
		return anchors.has(i) && site !== undefined ? markCacheable(site) : message;
	});
	const { tools } = request;
	if (tools === undefined || tools.length === 0) {
		return { messages, tools: tools === undefined ? undefined : [...tools] };
	}
	return {
		messages,
		tools: tools.map((tool, i) => (i === tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool)),
	};
}
