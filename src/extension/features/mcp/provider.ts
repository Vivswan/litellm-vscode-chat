/**
 * The MCP publisher: every servers entry that opts in with `mcp` is published
 * to the editor as an MCP server, so a LiteLLM proxy's own tools reach chat
 * without a second place to configure the same host and the same credentials.
 *
 * The provide/resolve split is the whole security design, and the types carry
 * it (definitions.ts): provide runs EAGERLY - the editor calls it before any
 * chat turn, unprompted - so it reads the setting and nothing else, and what
 * it returns cannot hold headers. Credentials enter only in resolve, which the
 * editor calls when it is about to start a session, at which point composing
 * them is exactly as legitimate as composing them for a chat request.
 *
 * URL discipline: a configured URL may embed credentials (`https://u:p@host`),
 * so every echo of one - the log line below is the only one this module makes
 * - goes through the shared displayUrl redaction. The definitions themselves
 * carry the URL as written, because that is what the session must dial.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { getDiscoveryTimeout } from "../../../shared/config/settings";
import type { MirroredError } from "../../../shared/mirroredError";
import { localizedError } from "../../../shared/mirroredError";
import type { McpOptIn } from "../../../shared/serverEntry";
import { displayUrl } from "../../../shared/util/displayUrl";
import { entryConnectionFor } from "../../servers/entryConnection";
import type { DeclaredServer } from "../../servers/serverSync/setting";
import { parseServersSetting } from "../../servers/serverSync/setting";
import type { McpDefinitionDescriptor, McpEntryView } from "./definitions";
import { mcpDefinitionsOf } from "./definitions";
import type { McpVersionCounters } from "./versions";

/**
 * The token exchange an MCP resolve may trigger is auth plumbing, not a chat
 * call, so it is bounded by `discovery.timeout` and fails toward the discovery
 * surface - whose timeout advice names exactly that setting. The publisher
 * itself makes no LiteLLM API request, so it owns no error surface of its own.
 */
const MCP_AUTH_SURFACE = "discovery" as const;

export interface McpProviderDeps {
	readonly secrets: vscode.SecretStorage;
	readonly oneShot: Pick<OneShotClient, "authHeaders">;
	readonly versions: McpVersionCounters;
	/** Channel-only notes that recur per session start; they must not evict the issue report's errors. */
	readonly advisory: (message: string, data?: unknown) => void;
	/** Failures, through the shared classifier, so an MCP refusal becomes the issue report's latest error. */
	readonly logError: (message: string, error: unknown) => void;
}

/** A declared entry that opted in, with `mcp` proven present rather than asserted. */
type McpEntry = DeclaredServer & { readonly mcp: McpOptIn };

/** The opted-in entries of a raw servers-setting value, in setting order. */
function mcpEntriesOf(raw: unknown): McpEntry[] {
	return parseServersSetting(raw).entries.filter((entry): entry is McpEntry => entry.mcp !== undefined);
}

/** The opted-in entries of the servers setting as it reads right now. */
export function currentMcpEntries(): McpEntry[] {
	return mcpEntriesOf(vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY));
}

/**
 * Whether the endpoint is on the same origin as the entry's base URL, which is
 * what decides if the entry's credentials ride along. The feature publishes a
 * server's OWN MCP endpoint, and a stored secret is paired with the entry's
 * base URL (secretDestination): an endpoint at another origin is a destination
 * nothing authorized it for, so it is published WITHOUT credentials rather
 * than handed them because a URL was typed. Same origin, any path - the
 * documented case is a proxy serving /mcp somewhere other than the root.
 * Unparseable either side reads as "not the same", the fail-closed answer.
 */
function sameOrigin(endpoint: string, baseUrl: string): boolean {
	try {
		const origin = new URL(endpoint).origin;
		// Every non-special scheme reports the opaque origin "null", which would
		// make two unrelated destinations compare equal; it is not an origin.
		return origin !== "null" && origin === new URL(baseUrl).origin;
	} catch {
		return false;
	}
}

/**
 * The descriptors a provide pass publishes: identity only, mapped by the pure
 * core from the opted-in entries and their rotation counters.
 */
export function mcpDescriptors(deps: Pick<McpProviderDeps, "versions">): McpDefinitionDescriptor[] {
	const views: McpEntryView[] = currentMcpEntries().map((entry) => ({
		label: entry.label,
		baseUrl: entry.baseUrl,
		mcp: entry.mcp,
		version: deps.versions.versionOf(entry.label),
	}));
	return mcpDefinitionsOf(views);
}

/** The published definition of one descriptor, with no headers: the eager pass carries identity alone. */
function definitionOf(descriptor: McpDefinitionDescriptor): vscode.McpHttpServerDefinition {
	// The version is a string on the wire and a rotation count here; the
	// conversion belongs at this boundary, not in the counter or the core.
	return new vscode.McpHttpServerDefinition(
		descriptor.label,
		vscode.Uri.parse(descriptor.uri),
		{},
		String(descriptor.version)
	);
}

/**
 * Why a resolve refused. A closed vocabulary rather than free text: each member
 * owns one honest sentence and one log classification. refusalError's switch
 * has no default and returns a non-optional type, so a fourth member does not
 * compile until it has a case, and localizedError will not take that case
 * without its English mirror. The classification is convention, not
 * construction - localizedError takes it optionally - so the tests pin all
 * three by name.
 */
type McpRefusal = "not-published" | "stale-secrets" | "changed-during-resolve";

/**
 * The refusal's user-facing error. English mirrors ride every construction (the
 * message reaches the output channel and public issue reports), and the
 * classification is the enum-only shape those surfaces record.
 */
function refusalError(reason: McpRefusal, label: string): MirroredError {
	switch (reason) {
		case "not-published":
			return localizedError(
				l10n.t('No servers entry publishes an MCP server labeled "{0}", so it cannot be started.', label),
				`No servers entry publishes an MCP server labeled "${label}", so it cannot be started.`,
				"Mcp(resolved label is not published)"
			);
		case "stale-secrets":
			return localizedError(
				l10n.t(
					'The stored secrets for "{0}" were saved for a different server. Store them again for this entry\'s current URL, then start its MCP server.',
					label
				),
				`The stored secrets for "${label}" were saved for a different server. Store them again for this entry's current URL, then start its MCP server.`,
				"Mcp(stored secrets stamped for another destination)"
			);
		case "changed-during-resolve":
			return localizedError(
				l10n.t('The servers entry "{0}" changed while its MCP server was starting. Try again.', label),
				`The servers entry "${label}" changed while its MCP server was starting. Try again.`,
				"Mcp(entry changed during resolve)"
			);
	}
}

/**
 * The provider VS Code registers. It is registered unconditionally: the opt-in
 * lives on the entries, so with none opted in the eager pass simply publishes
 * an empty list, and an entry gaining `mcp` needs no registration change.
 */
export function createMcpServerDefinitionProvider(
	deps: McpProviderDeps,
	onDidChangeMcpServerDefinitions: vscode.Event<void>
): vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
	return {
		onDidChangeMcpServerDefinitions,

		provideMcpServerDefinitions: () => mcpDescriptors(deps).map(definitionOf),

		/**
		 * Compose the session's credentials, at the one moment the editor is
		 * about to open a session. The headers are exactly what a request from
		 * this extension to the same server would carry (the shared auth
		 * overlay, OAuth exchange included), so the proxy sees one identity for
		 * chat and tools alike - but only for an endpoint on the entry's own
		 * origin (see sameOrigin), and only when the entry's stored secrets are
		 * stamped for it: credentials handed to the editor are past our reach,
		 * so an unproven pairing is refused rather than sent and watched.
		 *
		 * The definition the editor hands back is treated as a REQUEST, not as
		 * truth: it may predate an edit that retired the opt-in or moved the
		 * endpoint, and attaching current credentials to a stale definition
		 * would send them somewhere the setting no longer names. So the
		 * publication is re-derived from the setting - before the credential
		 * reads AND again after them, because an edit can land while the token
		 * exchange is in flight - and the whole descriptor must still match,
		 * version included: a rotation mid-exchange means the headers just
		 * composed are already the previous credential set.
		 */
		resolveMcpServerDefinition: async (server, token) => {
			// Set by refuse(), which logs its own throw. The class cannot be the
			// discriminator: RequestError extends MirroredError, so testing the
			// base class would swallow every real transport failure instead.
			let refused = false;
			/**
			 * Refuse without attaching anything. Each reason gets its OWN sentence,
			 * because they are different facts about the user's setup and only one
			 * of them is "there is no such server": an entry that moved mid-resolve
			 * IS published, and telling the user otherwise would send them looking
			 * for a missing entry.
			 */
			const refuse: (reason: McpRefusal) => never = (reason) => {
				refused = true;
				const error = refusalError(reason, server.label);
				deps.logError(`MCP resolve refused (${reason})`, error);
				throw error;
			};
			/** The descriptor for this label as the setting reads right now, or undefined. */
			const publishedNow = (): McpDefinitionDescriptor | undefined =>
				mcpDescriptors(deps).find((descriptor) => descriptor.label === server.label);

			const before = publishedNow();
			if (before === undefined) {
				refuse("not-published");
			}

			let headers: Record<string, string>;
			let baseUrl: string;
			try {
				const entry = currentMcpEntries().find((candidate) => candidate.label === before.label);
				const resolved = entry === undefined ? undefined : await entryConnectionFor(deps.secrets, before.label);
				if (entry === undefined || resolved === undefined) {
					refuse("not-published");
				}
				if (resolved.refusedSecrets.length > 0) {
					// The label's stored blob was paired with a different server (a
					// base URL edited after the secret was stored is the usual
					// cause). The chat path refuses such a pairing outright; this one
					// must too, because the credentials leave our process and no 401
					// of ours would ever come back to correct it.
					refuse("stale-secrets");
				}
				baseUrl = entry.baseUrl;
				headers = sameOrigin(before.uri, baseUrl)
					? await deps.oneShot.authHeaders(resolved.connection, MCP_AUTH_SURFACE, {
							timeoutMs: getDiscoveryTimeout(),
							token,
						})
					: {};
			} catch (error) {
				// This feature is its own logging boundary (the one-shot callers'
				// convention): the editor renders the failure to the user, but
				// without this the output channel and the issue-report buffer stay
				// silent about it. Cancellation is never logged, and a refusal
				// already logged itself.
				if (!refused && !(error instanceof vscode.CancellationError)) {
					deps.logError("MCP resolve failed", error);
				}
				throw error;
			}

			// The composed headers are only safe to hand over if the setting still
			// says the same thing: the same endpoint at the same rotation, and the
			// same base URL - which is what decided whether credentials rode along
			// at all, and can move while the endpoint URL does not.
			const after = publishedNow();
			const entryAfter = currentMcpEntries().find((candidate) => candidate.label === server.label);
			if (after === undefined || entryAfter === undefined) {
				// Gone rather than moved: "try again" would be false advice, since
				// the retry lands on the not-published refusal anyway.
				refuse("not-published");
			}
			if (after.uri !== before.uri || after.version !== before.version || entryAfter.baseUrl !== baseUrl) {
				refuse("changed-during-resolve");
			}
			server.uri = vscode.Uri.parse(after.uri);
			server.version = String(after.version);
			server.headers = headers;
			// Recurs on every session start, so channel-only: the issue-report ring
			// is small and informational lines evict the errors it exists to carry.
			deps.advisory("MCP server resolved", {
				label: server.label,
				uri: displayUrl(after.uri),
				credentialed: Object.keys(headers).length > 0,
			});
			return server;
		},
	};
}
