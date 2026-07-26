import type { LanguageModelChatInformation } from "vscode";
import { fingerprint } from "../shared/fingerprint";

/**
 * Support for VS Code-managed provider groups. The host stores one
 * configuration object per named group and passes it to
 * provideLanguageModelChatInformation; it also hands the exact
 * LanguageModelChatInformation objects a provider returned back to
 * provideLanguageModelChatResponse and provideTokenCount, so the resolved
 * server rides on the model objects themselves instead of a route map.
 */

/** Connection details resolved from a provider group's configuration. */
export interface GroupServer {
	baseUrl: string;
	apiKey: string;
}

interface GroupModelInfo extends LanguageModelChatInformation {
	readonly litellmServer: GroupServer;
	readonly litellmSupportsPromptCaching: boolean;
}

/** Client-cache IDs for group servers, disjoint from registry server IDs. */
const GROUP_CLIENT_ID_PREFIX = "group:";

/**
 * Two groups may point at one base URL with different keys, so group identity
 * includes a non-secret fingerprint of the key. Rotating a group's key
 * therefore mints a new identity: the group double-counts in the status
 * window for one cycle until the old identity ages out, which self-heals.
 */
export function groupClientId(server: GroupServer): string {
	return `${GROUP_CLIENT_ID_PREFIX}${fingerprint(server.apiKey)}:${server.baseUrl}`;
}

/**
 * Accepts unknown because callers also classify persisted status entries,
 * which older extension versions may have written with arbitrary shapes.
 */
export function isGroupClientId(serverId: unknown): boolean {
	return typeof serverId === "string" && serverId.startsWith(GROUP_CLIENT_ID_PREFIX);
}

/**
 * Narrow a group configuration to a usable server. Returns undefined when the
 * configuration is not an object or has no usable baseUrl; a missing or
 * non-string apiKey means a keyless server.
 */
export function parseGroupConfiguration(configuration: unknown): GroupServer | undefined {
	if (typeof configuration !== "object" || configuration === null) {
		return undefined;
	}
	const { baseUrl: rawBaseUrl, apiKey: rawApiKey } = configuration as { baseUrl?: unknown; apiKey?: unknown };
	if (typeof rawBaseUrl !== "string") {
		return undefined;
	}
	const baseUrl = rawBaseUrl.trim().replace(/\/+$/, "");
	if (!baseUrl) {
		return undefined;
	}
	return { baseUrl, apiKey: typeof rawApiKey === "string" ? rawApiKey : "" };
}

/**
 * Attach the resolved server and the model's prompt-caching support to a model
 * entry. The detail field is dropped so the host fills it with the group name.
 */
export function attachGroupServer(
	info: LanguageModelChatInformation,
	server: GroupServer,
	supportsPromptCaching: boolean
): GroupModelInfo {
	const { detail: _detail, ...rest } = info;
	return { ...rest, litellmServer: server, litellmSupportsPromptCaching: supportsPromptCaching };
}

export function getGroupServer(model: LanguageModelChatInformation): GroupServer | undefined {
	const candidate = (model as Partial<GroupModelInfo>).litellmServer;
	if (candidate !== undefined && typeof candidate.baseUrl === "string" && typeof candidate.apiKey === "string") {
		return candidate;
	}
	return undefined;
}

export function groupModelSupportsPromptCaching(model: LanguageModelChatInformation): boolean {
	return (model as Partial<GroupModelInfo>).litellmSupportsPromptCaching === true;
}

/** Display label for a group server; there is no group name on the extension side, so the URL host stands in. */
export function groupServerLabel(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}
