import type { EphemeralCacheControl, OpenAIChatContentBlock, OpenAIChatMessage, OpenAIFunctionToolDef } from "./wire";

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
 * A message can carry a marker only when it has non-empty text: Anthropic
 * rejects `cache_control` on empty text blocks, and tool-call-only assistant
 * turns have no content block to mark.
 */
function hasCacheableText(message: OpenAIChatMessage): boolean {
	const { content } = message;
	if (typeof content === "string") {
		return content.length > 0;
	}
	return Array.isArray(content) && content.some((block) => block.type === "text" && block.text.length > 0);
}

/**
 * A copy of `message` carrying the marker. Tool-role messages are marked at
 * the message level and keep their content form; other roles get the marker
 * on their last non-empty text block (see the module comment for why).
 */
function withCacheControl(message: OpenAIChatMessage): OpenAIChatMessage {
	if (message.role === "tool") {
		return { ...message, cache_control: CACHE_CONTROL };
	}
	const { content } = message;
	if (typeof content === "string") {
		return { ...message, content: [{ type: "text", text: content, cache_control: CACHE_CONTROL }] };
	}
	if (!Array.isArray(content)) {
		return message;
	}
	const lastText = content.findLastIndex((block) => block.type === "text" && block.text.length > 0);
	if (lastText === -1) {
		return message;
	}
	const blocks: OpenAIChatContentBlock[] = content.map((block, i) =>
		i === lastText && block.type === "text" ? { ...block, cache_control: CACHE_CONTROL } : block
	);
	return { ...message, content: blocks };
}

/** The deduplicated message anchors: system, first user, rolling last. */
function anchorIndices(messages: readonly OpenAIChatMessage[]): Set<number> {
	const anchors = new Set<number>();
	const system = messages.findIndex((m) => m.role === "system" && hasCacheableText(m));
	if (system !== -1) {
		anchors.add(system);
	}
	const firstUser = messages.findIndex((m) => m.role === "user" && hasCacheableText(m));
	if (firstUser !== -1) {
		anchors.add(firstUser);
	}
	const rolling = messages.findLastIndex((m) => hasCacheableText(m));
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
	const anchors = anchorIndices(request.messages);
	const messages = request.messages.map((message, i) => (anchors.has(i) ? withCacheControl(message) : message));
	const { tools } = request;
	if (tools === undefined || tools.length === 0) {
		return { messages, tools: tools === undefined ? undefined : [...tools] };
	}
	return {
		messages,
		tools: tools.map((tool, i) => (i === tools.length - 1 ? { ...tool, cache_control: CACHE_CONTROL } : tool)),
	};
}
