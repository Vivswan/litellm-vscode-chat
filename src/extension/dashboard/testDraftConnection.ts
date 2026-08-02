/**
 * The testServerDraft intent's apply path: resolve the draft's credentials
 * (secret directives included, so a "keep" reads the stored value exactly the
 * way a save would - the shared readKeepSources/resolveKeptSecret helpers in
 * saveServer.ts) and run one discovery probe against them.
 *
 * Read-only by contract: no settings write, no provider-group or status
 * mutation, no cross-probe caching, and the resolved credential values flow
 * into the probe's request headers only - never a log line, never a message.
 * The probe itself (createDraftConnectionProbe) rides the production
 * discovery machinery: a throwaway ChatClient per call, which brings the
 * OAuth token exchange, the virtual-key header, the configured custom
 * headers, the discoveryTimeout hard bound, and the idempotent-GET retry
 * budget - and whose per-instance caches die with the call.
 */

import * as vscode from "vscode";
import type { OAuthConfig, VirtualKeyConfig } from "../../provider/transport/auth";
import { ChatClient } from "../../provider/transport/chatClient";
import { RequestError } from "../../provider/transport/errorMapping";
import { getTokenDefaults } from "../../shared/config/settings";
import { transportClassificationOf } from "../../shared/errorClassification";
import type { DashboardIntent } from "./intentSchema";
import type { IntentEnvironment } from "./intents";
import { DashboardValidationError, rawServerEntries } from "./intents";
import type { SecretFieldId } from "./protocol";
import { readKeepSources, resolveKeptSecret } from "./saveServer";

/**
 * One draft's connection material, fully resolved: what the probe needs and
 * nothing else. Values exist extension-side only; this shape is never logged.
 */
export interface DraftConnection {
	readonly baseUrl: string;
	/** Empty string for keyless drafts, matching ServerWithKey's convention. */
	readonly apiKey: string;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
}

/** An optional payload field trimmed to content, or undefined; the save path's empty-means-absent rule. */
function trimmedOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Apply one testServerDraft intent: resolve each secret directive to the
 * value the draft means (set: the typed value; clear: nothing; keep: the
 * stored value the entry `replaceLabel` names resolves, inline winning over
 * secure like the sync engine), enforce the same cross-field pairing rules a
 * save enforces (a partial OAuth or virtual-key configuration would probe
 * unauthenticated and report a lie), and hand the assembled connection to the
 * injected probe. Resolves to the discovered model count; transport failures
 * are re-thrown as validation-kind errors carrying the transport's specific
 * user-facing message (the same text a server row's error state renders), so
 * the panel boundary logs a classification only, never response text.
 */
export async function applyTestServerDraft(
	intent: Extract<DashboardIntent, { type: "testServerDraft" }>,
	env: IntentEnvironment
): Promise<number> {
	const label = intent.server.label.trim();
	const targetLabel = (intent.replaceLabel ?? intent.server.label).trim();
	const entries = rawServerEntries(env.readServersSetting());
	const sources = await readKeepSources(entries, label, targetLabel, (secretsLabel) =>
		env.readServerSecrets(secretsLabel)
	);
	if (intent.replaceLabel !== undefined && sources.accepted === undefined) {
		// Same refusal as the save path: with the edited entry gone, "keep"
		// resolves nothing and the probe would test a different configuration
		// than the one the form shows.
		throw new DashboardValidationError(
			vscode.l10n.t("The entry being edited no longer exists in the servers setting; close the form and retry")
		);
	}
	const existing = sources.accepted?.entry;
	const resolveDirective = (field: SecretFieldId): string | undefined => {
		const directive = intent.secrets[field];
		switch (directive.action) {
			case "set":
				return directive.value;
			case "clear":
				return undefined;
			case "keep":
				return resolveKeptSecret(existing, sources.storedEffective, field)?.value;
		}
	};
	const apiKey = resolveDirective("apiKey") ?? "";
	const oauthClientSecret = resolveDirective("oauthClientSecret");
	const virtualKeyValue = resolveDirective("virtualKeyValue");
	const oauthTokenUrl = trimmedOptional(intent.server.oauthTokenUrl);
	const oauthClientId = trimmedOptional(intent.server.oauthClientId);
	const oauthScopes = trimmedOptional(intent.server.oauthScopes);
	const virtualKeyHeader = trimmedOptional(intent.server.virtualKeyHeader);

	// The save path's pairing rules verbatim (applySaveServerSetting): OAuth is
	// one unit and the virtual key is both-or-neither. The request path drops
	// partial configurations silently, so probing one would report a PASS or
	// FAIL for a configuration the saved entry would never send.
	const oauthExtras = oauthClientSecret !== undefined || oauthScopes !== undefined;
	if ((oauthClientId !== undefined || oauthExtras) && oauthTokenUrl === undefined) {
		// The "fieldId:" prefix stays an ASCII identifier outside the
		// translation: sectionFailureText matches it against the internal field
		// names to route the failure onto the right form section.
		throw new DashboardValidationError(`oauthTokenUrl: ${vscode.l10n.t("OAuth needs the token URL and client ID")}`);
	}
	if ((oauthTokenUrl !== undefined || oauthExtras) && oauthClientId === undefined) {
		throw new DashboardValidationError(`oauthClientId: ${vscode.l10n.t("OAuth needs the token URL and client ID")}`);
	}
	if (virtualKeyHeader !== undefined && virtualKeyValue === undefined) {
		throw new DashboardValidationError(`virtualKeyValue: ${vscode.l10n.t("enter the key sent in this header")}`);
	}
	if (virtualKeyHeader === undefined && virtualKeyValue !== undefined) {
		throw new DashboardValidationError(`virtualKeyHeader: ${vscode.l10n.t("name the header that carries the key")}`);
	}

	const connection: DraftConnection = {
		baseUrl: intent.server.baseUrl.trim(),
		apiKey,
		...(oauthTokenUrl !== undefined && oauthClientId !== undefined
			? {
					oauth: {
						tokenUrl: oauthTokenUrl,
						clientId: oauthClientId,
						clientSecret: oauthClientSecret ?? "",
						...(oauthScopes !== undefined ? { scopes: oauthScopes } : {}),
					},
				}
			: {}),
		...(virtualKeyHeader !== undefined && virtualKeyValue !== undefined
			? { virtualKey: { header: virtualKeyHeader, value: virtualKeyValue } }
			: {}),
	};
	try {
		return await env.probeDraftConnection(connection);
	} catch (error) {
		if (error instanceof RequestError) {
			// The transport's message is user-facing by the same convention as a
			// server row's error state; validation-kind because nothing durable
			// changed (the probe is read-only), so the form stays editable. The
			// classification (kind, status, setup hint - never text) rides along
			// so the form can link the matching troubleshooting-guide section
			// next to the message.
			throw new DashboardValidationError(error.message, { classification: transportClassificationOf(error) });
		}
		throw error;
	}
}

/** The one-off probe's server ID; each probe uses a fresh throwaway client, so the ID never collides with a cache. */
const DRAFT_PROBE_SERVER_ID = "dashboard-draft-probe";

/**
 * The real probe implementation panel.ts wires into the intent environment:
 * one discovery pass through a throwaway ChatClient, so the OAuth exchange,
 * headers, timeout, and retry behavior are exactly production discovery's,
 * while the instance's client and token caches are discarded with the call.
 *
 * Deliberately NO logger: discovery's own debug lines carry endpoint URLs and
 * truncated response snippets, which would land in the issue-report buffer
 * that opens public GitHub issues. The probe is not the provider's refresh
 * boundary, so it logs nothing here; the panel boundary logs the outcome
 * classification once (a validation-kind failure), exactly as it does for the
 * intent layer's other errors.
 */
export function createDraftConnectionProbe(
	context: vscode.ExtensionContext
): (connection: DraftConnection) => Promise<number> {
	// The same User-Agent activation composes for the provider; recomputed here
	// because the probe outlives no request and activation does not export it.
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const userAgent = `litellm-vscode-chat/${extVersion} VSCode/${vscode.version}`;
	return async (connection) => {
		const client = new ChatClient({ userAgent });
		const { models } = await client.fetchModels(
			{
				id: DRAFT_PROBE_SERVER_ID,
				label: DRAFT_PROBE_SERVER_ID,
				baseUrl: connection.baseUrl,
				apiKey: connection.apiKey,
				...(connection.oauth !== undefined ? { oauth: connection.oauth } : {}),
				...(connection.virtualKey !== undefined ? { virtualKey: connection.virtualKey } : {}),
			},
			getTokenDefaults()
		);
		return models.length;
	};
}
