/**
 * The MCP publisher: every servers entry that opts in with `mcp` is published to the editor as an MCP server, so a
 * LiteLLM proxy's own tools reach chat without a second place to configure the same host and the same credentials.
 * URL discipline: a configured URL may embed credentials (`https://u:p@host`), so every echo of one - the log line
 * below is the only one this module makes - goes through the shared displayUrl redaction.
 *
 *   The provide/resolve split is the whole security design -> the types carry it (definitions.ts)
 *   provide runs EAGERLY - the editor calls it before any chat turn, unprompted -> what it returns cannot hold headers
 *   Credentials enter only in resolve, which the editor calls when it is about to start a session
 *     -> composing them is exactly as legitimate as composing them for a chat request
 *   what the session must dial -> The definitions themselves carry the URL in its one spelling
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import { type FailureSink, logFailure } from "../../../provider/catalog/discoveryLog";
import type { OneShotClient } from "../../../provider/transport/oneShotClient";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../../shared/config/settingSpec";
import { getDiscoveryTimeout } from "../../../shared/config/settings";
import { rejectedCredentialKinds } from "../../../shared/failureCause";
import type { MirroredError } from "../../../shared/mirroredError";
import { localizedError } from "../../../shared/mirroredError";
import type { McpOptIn, RejectedCredentialField } from "../../../shared/serverEntry";
import { displayUrl } from "../../../shared/util/displayUrl";
import type { HeaderValue } from "../../../shared/util/headers";
import type { EntryConnectionRefused } from "../../servers/entryConnection";
import { entryConnectionFor } from "../../servers/entryConnection";
import type { DeclaredServer } from "../../servers/serverSync/setting";
import { parseServersSetting } from "../../servers/serverSync/setting";
import type { McpDefinitionDescriptor, McpEntryView } from "./definitions";
import { mcpDefinitionsOf } from "./definitions";
import type { McpVersionCounters } from "./versions";

/**
 * The token exchange an MCP resolve may trigger is auth plumbing, not a chat call, so it is bounded by
 * `discovery.timeout` and fails toward the discovery surface - whose timeout advice names exactly that setting. The
 * publisher itself makes no LiteLLM API request, so it owns no error surface of its own.
 */
const MCP_AUTH_SURFACE = "discovery" as const;

export interface McpProviderDeps {
	readonly secrets: vscode.SecretStorage;
	readonly oneShot: Pick<OneShotClient, "authHeaders">;
	readonly versions: McpVersionCounters;
	/** Channel-only notes that recur per session start; they must not evict the issue report's errors. */
	readonly advisory: (message: string, data?: unknown) => void;
	/** A refusal of this module's own, whose text names only the configured label; it becomes the report's latest error. */
	readonly logError: (message: string, error: unknown) => void;
	/** A failure caught from the token exchange, whose text can quote the identity provider's answer. */
	readonly logFailure: FailureSink;
}

type McpEntry = DeclaredServer & { readonly mcp: McpOptIn };

function mcpEntriesOf(raw: unknown): McpEntry[] {
	return parseServersSetting(raw).entries.filter((entry): entry is McpEntry => entry.mcp !== undefined);
}

export function currentMcpEntries(): McpEntry[] {
	return mcpEntriesOf(vscode.workspace.getConfiguration(CONFIG_SECTION).get(SERVERS_SETTING_KEY));
}

/**
 * secretDestination pairs a stored proxy key with the entry's base URL and the OAuth client secret with its token
 * URL and client id, so an endpoint at another origin is a destination nothing authorized it for and is published
 * WITHOUT credentials. Any path on that origin counts, because a proxy may serve /mcp away from the root.
 */
function sameOrigin(endpoint: string, baseUrl: string): boolean {
	const origin = new URL(endpoint).origin;
	// the opaque origin "null" -> would make two unrelated destinations compare equal; it is not an origin
	return origin !== "null" && origin === new URL(baseUrl).origin;
}

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
	// The version is a string on the wire and a rotation count here; the conversion belongs at this boundary, not in
	// the counter or the core.
	return new vscode.McpHttpServerDefinition(
		descriptor.label,
		vscode.Uri.parse(descriptor.uri),
		{},
		String(descriptor.version)
	);
}

/**
 * A closed vocabulary rather than free text: each member owns one honest sentence and one log classification. The
 * classification is convention, not construction - localizedError takes it optionally - so a test pins a classification
 * by name, never by deriving it.
 *
 *   refusalError's switch has no default and returns a non-optional type
 *     -> a new member does not compile until it has a case, and localizedError will not take that case without its
 *        English mirror
 */
type McpRefusal =
	| { readonly kind: "not-published" | "stale-secrets" | "secrets-unreadable" | "changed-during-resolve" }
	| {
			readonly kind: "refused-credentials";
			readonly fields: readonly [RejectedCredentialField, ...RejectedCredentialField[]];
	  };

/** Total over the connection refusals, so a new one does not compile until it says which sentence it gets. */
function mcpRefusalOf(refusal: EntryConnectionRefused): McpRefusal {
	switch (refusal.kind) {
		case "noEntry":
			return { kind: "not-published" };
		case "secretsMismatched":
			return { kind: "stale-secrets" };
		case "secretsUnreadable":
			return { kind: "secrets-unreadable" };
		case "credentialsRefused":
			return { kind: "refused-credentials", fields: refusal.fields };
	}
}

/**
 * English mirrors ride every construction (the message reaches the output channel and public issue reports), and the
 * classification is the enum-only shape those surfaces record.
 */
function refusalError(reason: McpRefusal, label: string): MirroredError {
	switch (reason.kind) {
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
		case "secrets-unreadable":
			return localizedError(
				l10n.t('Reading the stored secrets for "{0}" failed, so its MCP server cannot be started. Try again.', label),
				`Reading the stored secrets for "${label}" failed, so its MCP server cannot be started. Try again.`,
				"Mcp(stored secrets unreadable)"
			);
		case "refused-credentials": {
			const kinds = rejectedCredentialKinds(reason.fields);
			return localizedError(
				l10n.t(
					'The stored {1} for "{0}" cannot be sent as an HTTP header, so its MCP server cannot be started. Enter the value again from the server row on the dashboard.',
					label,
					kinds.display
				),
				`The stored ${kinds.english} for "${label}" cannot be sent as an HTTP header, so its MCP server cannot be started. Enter the value again from the server row on the dashboard.`,
				"Mcp(configured credential cannot be sent as a header)"
			);
		}
		case "changed-during-resolve":
			return localizedError(
				l10n.t('The servers entry "{0}" changed while its MCP server was starting. Try again.', label),
				`The servers entry "${label}" changed while its MCP server was starting. Try again.`,
				"Mcp(entry changed during resolve)"
			);
	}
}

/**
 * It is registered unconditionally: the opt-in lives on the entries, so with none opted in the eager pass simply
 * publishes an empty list, and an entry gaining `mcp` needs no registration change.
 */
export function createMcpServerDefinitionProvider(
	deps: McpProviderDeps,
	onDidChangeMcpServerDefinitions: vscode.Event<void>
): vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
	return {
		onDidChangeMcpServerDefinitions,

		provideMcpServerDefinitions: () => mcpDescriptors(deps).map(definitionOf),

		/**
		 * The editor's definition is a REQUEST that may predate an edit, never truth, so credentials attach only
		 * to a publication re-derived from the setting. Credentials handed to the editor are past our reach.
		 *
		 *   re-derive from the setting -> read the credentials -> re-derive again -> whole descriptor must match
		 *
		 *   What holds -> same label, same endpoint, same origin, all three re-read from the setting
		 */
		resolveMcpServerDefinition: async (server, token) => {
			// Set by refuse(), which logs its own throw. The class cannot be the discriminator: RequestError extends
			// MirroredError, so testing the base class would swallow every real transport failure instead.
			let refused = false;
			/**
			 * Each reason gets its OWN sentence, because they are different facts about the user's setup and only one
			 * of them is "there is no such server": an entry that moved mid-resolve IS published, and telling the user
			 * otherwise would send them looking for a missing entry.
			 */
			const refuse: (reason: McpRefusal) => never = (reason) => {
				refused = true;
				const error = refusalError(reason, server.label);
				deps.logError(`MCP resolve refused (${reason.kind})`, error);
				throw error;
			};
			const publishedNow = (): McpDefinitionDescriptor | undefined =>
				mcpDescriptors(deps).find((descriptor) => descriptor.label === server.label);

			const before = publishedNow();
			if (before === undefined) {
				refuse({ kind: "not-published" });
			}

			let headers: Record<string, HeaderValue>;
			let baseUrl: string;
			try {
				const entry = currentMcpEntries().find((candidate) => candidate.label === before.label);
				if (entry === undefined) {
					refuse({ kind: "not-published" });
				}
				baseUrl = entry.baseUrl;
				// Credentials ride only to the entry's own origin, so they are resolved only there: an endpoint on another
				// origin is published bare, and a stale, unreadable, or refused credential has nothing to refuse for it.
				if (sameOrigin(before.uri, baseUrl)) {
					const resolved = await entryConnectionFor(deps.secrets, before.label);
					if (resolved.kind !== "resolved") {
						refuse(mcpRefusalOf(resolved));
					}
					headers = await deps.oneShot.authHeaders(resolved.connection, MCP_AUTH_SURFACE, {
						timeout: { ms: getDiscoveryTimeout(), setting: "discovery.timeout" },
						token,
					});
				} else {
					headers = {};
				}
			} catch (error) {
				// This feature is its own logging boundary (the one-shot callers' convention): the editor renders the
				// failure to the user, but without this the output channel and the issue-report buffer stay silent
				// about it. Cancellation is never logged, and a refusal already logged itself.
				if (!refused && !(error instanceof vscode.CancellationError)) {
					logFailure(deps.logFailure, "MCP resolve failed", error);
				}
				throw error;
			}

			// The composed headers are only safe to hand over if the setting still says the same thing: the same
			// endpoint at the same rotation, and the same base URL - which is what decided whether credentials rode
			// along at all, and can move while the endpoint URL does not.
			const after = publishedNow();
			const entryAfter = currentMcpEntries().find((candidate) => candidate.label === server.label);
			if (after === undefined || entryAfter === undefined) {
				// Gone rather than moved: "try again" would be false advice, since the retry lands on the not-published
				// refusal anyway.
				refuse({ kind: "not-published" });
			}
			if (after.uri !== before.uri || after.version !== before.version || entryAfter.baseUrl !== baseUrl) {
				refuse({ kind: "changed-during-resolve" });
			}
			server.uri = vscode.Uri.parse(after.uri);
			server.version = String(after.version);
			server.headers = headers;
			// Recurs on every session start, so channel-only: the issue-report ring is small and informational lines
			// evict the errors it exists to carry.
			deps.advisory("MCP server resolved", {
				label: server.label,
				uri: displayUrl(after.uri),
				credentialed: Object.keys(headers).length > 0,
			});
			return server;
		},
	};
}
