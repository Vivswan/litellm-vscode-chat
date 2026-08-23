/**
 * The pure mapping from MCP-opted-in server entries to the definition
 * descriptors a provide pass publishes. A descriptor is identity only - label,
 * endpoint URI, credential-rotation version - and `headers?: never` makes that
 * structural: a value carrying headers is not a descriptor, so the eager
 * secretless provide cannot regress into carrying credentials. The URI is
 * identity data, not a credential channel, but like any user-written URL it
 * may embed credentials - echoes of it belong in the shared URL redaction
 * pipeline, never raw in logs or reports.
 */

import type { McpOptIn } from "../../../shared/serverEntry";
import { mcpEndpointOf } from "../../../shared/util/baseUrl";

/**
 * The view of one opted-in entry this mapping consumes, injected by the
 * caller: parsing the servers setting and counting credential rotations both
 * stay outside this module. `mcp` is the entry's opt-in as the settings parser
 * accepted it - `true` derives the default endpoint, the object form may name
 * the exact URL, kept as written beyond edge-trimming, since a URL the user
 * wrote is not second-guessed.
 */
export type McpEntryView = {
	readonly label: string;
	readonly baseUrl: string;
	readonly mcp: McpOptIn;
	/**
	 * The entry's credential-rotation counter. Firing the definitions change
	 * event is what actually re-provides; this stamp rides the definition so
	 * the host can see that a rotation happened.
	 */
	readonly version: number;
};

/** The identity every MCP definition shape shares: which server, where, at which rotation. */
type McpDefinitionIdentity = {
	readonly label: string;
	readonly uri: string;
	readonly version: number;
};

/**
 * What a provide pass may publish: identity only. `headers?: never` makes the
 * no-headers-in-provide invariant structural - a value carrying headers is
 * not a descriptor, so the eager secretless provide cannot regress silently.
 */
export type McpDefinitionDescriptor = McpDefinitionIdentity & { readonly headers?: never };

/**
 * Map opted-in entries to definition descriptors, in entry order. The label is
 * the definition's identity - resolve finds the entry's credentials by label -
 * so uniqueness is load-bearing: the servers-setting parser already rejects a
 * label an earlier entry used, and this mapping backstops the same first-wins
 * rule rather than inventing a second one.
 */
export function mcpDefinitionsOf(entries: readonly McpEntryView[]): McpDefinitionDescriptor[] {
	const seen = new Set<string>();
	const descriptors: McpDefinitionDescriptor[] = [];
	for (const entry of entries) {
		if (seen.has(entry.label)) {
			continue;
		}
		seen.add(entry.label);
		descriptors.push({ label: entry.label, uri: mcpUriOf(entry), version: entry.version });
	}
	return descriptors;
}

/**
 * The definition's URI: a usable explicit `url` wins as written (edge-trimmed,
 * like every settings-string boundary; a blank one reads as absent); otherwise
 * the shared derivation, which the server form shows the user by name so the
 * promise and the published address cannot drift.
 */
function mcpUriOf(entry: McpEntryView): string {
	if (entry.mcp !== true && entry.mcp.url !== undefined) {
		const url = entry.mcp.url.trim();
		if (url !== "") {
			return url;
		}
	}
	return mcpEndpointOf(entry.baseUrl);
}
