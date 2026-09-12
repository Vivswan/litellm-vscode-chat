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
 * Anthropic allows four breakpoints and caches the prefix up to each, so the anchors (tools, system, first user, rolling last)
 * are the prefixes that stay byte-identical across an agent session's turns. Placement per role is what LiteLLM's Anthropic
 * adapter reads:
 *
 *   tool-role message -> message-level; the adapter wraps it in a tool_result block whose top level is the only cacheable spot
 *   any other message -> block-level on its last non-empty text block
 *   last tool def     -> tool-level, which the Anthropic and Bedrock adapters both read
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
 * locateCacheable. No site means the message cannot anchor: Anthropic rejects
 * `cache_control` on empty text blocks, and tool-call-only assistant turns
 * have no content block to mark.
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
