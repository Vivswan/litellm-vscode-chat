import type { McpOptIn } from "../../../shared/serverEntry";
import { mcpEndpointOf } from "../../../shared/util/baseUrl";

/**
 * The view of one opted-in entry this mapping consumes, injected by the caller: parsing the servers setting and
 * counting credential rotations both stay outside this module. `mcp` is the entry's opt-in as the settings parser
 * accepted it - `true` derives the default endpoint, the object form names the exact URL in its one spelling.
 */
export type McpEntryView = {
	readonly label: string;
	readonly baseUrl: string;
	readonly mcp: McpOptIn;
	/**
	 * The entry's credential-rotation counter. Firing the definitions change event is what actually re-provides; this
	 * stamp rides the definition so the host can see that a rotation happened.
	 */
	readonly version: number;
};

type McpDefinitionIdentity = {
	readonly label: string;
	readonly uri: string;
	readonly version: number;
};

export type McpDefinitionDescriptor = McpDefinitionIdentity & { readonly headers?: never };

/**
 * The label is the definition's identity - resolve finds the entry's credentials by label - so uniqueness is
 * load-bearing: the servers-setting parser already rejects a label an earlier entry used, and this mapping backstops
 * the same first-wins rule rather than inventing a second one.
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
 * The definition's URI: an explicit `url` wins; otherwise the shared derivation, which the server form shows the user
 * by name so the promise and the published address cannot drift.
 */
function mcpUriOf(entry: McpEntryView): string {
	return entry.mcp !== true && entry.mcp.url !== undefined ? entry.mcp.url : mcpEndpointOf(entry.baseUrl);
}
