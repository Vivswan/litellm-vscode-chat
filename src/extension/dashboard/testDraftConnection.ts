/**
 * The testServerDraft intent's apply path: resolve the draft's credentials
 * (secret directives included, so a "keep" reads the stored value exactly the
 * way a save would, through saveServer.ts's shared helpers) and run one
 * discovery probe against them.
 *
 * Read-only by contract: no settings write, no provider-group or status
 * mutation, no cross-probe caching, and the resolved credential values flow
 * into the probe's request headers only - never a log line, never a message.
 * The probe rides the production discovery machinery through a throwaway
 * ChatClient per call, so the OAuth exchange, virtual-key header, custom
 * headers, timeout, and retry budget are production's, and the per-instance
 * caches die with the call.
 */

import * as l10n from "@vscode/l10n";
import * as vscode from "vscode";
import type { RequestPayload } from "../../dashboard/endpoints";
import type { ExpectedDiscoveryFailures } from "../../provider/catalog/discovery";
import type { OAuthConfig, VirtualKeyConfig } from "../../provider/transport/auth";
import { ChatClient } from "../../provider/transport/chatClient";
import { RequestError } from "../../provider/transport/errorMapping";
import { transportClassificationOf } from "../../shared/errorClassification";
import type { SecretFieldId } from "../../shared/serverEntry";
import type { IntentEnvironment } from "./intents";
import { DashboardValidationError, rawServerEntries } from "./intents";
import { readKeepSources, resolveKeptSecret } from "./saveServer";

/**
 * One draft's connection material, fully resolved: what the probe needs and
 * nothing else. Values exist extension-side only; this shape is never logged.
 */
export interface DraftConnection {
	readonly baseUrl: string;
	/** The draft's trimmed label, when it has one: what discovery's endpoint-declaration hints may name. */
	readonly label?: string | undefined;
	/**
	 * The draft's apiVersion override; "" is a real value (append nothing).
	 * Absent when the draft leaves the mode on auto: the probe then tests the
	 * auto rule, exactly what a save without the field would use.
	 */
	readonly apiVersion?: string | undefined;
	/** Empty string for keyless drafts, matching ServerWithKey's convention. */
	readonly apiKey: string;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
	/** The draft's parsed header rows (empty means none), so the probe sends what a save would. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/** The draft's expectedFailures in discovery's per-endpoint shape: expected endpoints probe with a single attempt, like production. */
	readonly expected?: ExpectedDiscoveryFailures | undefined;
}

/** An optional payload field trimmed to content, or undefined; the save path's empty-means-absent rule. */
function trimmedOptional(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A draft probe's outcome, for the success notice intents.ts composes.
 * "connected" carries the total the saved entry would register (discovered
 * plus declared models discovery does not list); "expected-failure" means
 * discovery failed in a category the draft's expectedFailures declares, so
 * the outcome is the declared models the entry would serve anyway.
 */
export type DraftProbeOutcome =
	| { readonly kind: "connected"; readonly modelCount: number; readonly declaredCount: number }
	| { readonly kind: "expected-failure"; readonly declaredCount: number };

/**
 * The declared model IDs the SAVED entry would carry: the payload's list
 * trimmed and deduplicated, exactly as the save stores it. The probe tests
 * the draft as typed, not the last-saved state.
 */
function draftDeclaredModelIds(payload: readonly string[]): readonly string[] {
	return [...new Set(payload.map((id) => id.trim()).filter((id) => id.length > 0))];
}

/**
 * Apply one testServerDraft intent: resolve each secret directive to the
 * value the draft means (set: the typed value; clear: nothing; keep: the
 * stored value the entry `replaceLabel` names resolves, inline winning over
 * secure like the sync engine), enforce the same cross-field pairing rules a
 * save enforces (a partial OAuth or virtual-key configuration would probe
 * unauthenticated and report a lie), and hand the assembled connection to the
 * injected probe. A terminal discovery failure in a declared expectedFailures
 * category resolves to the expected-failure outcome instead of throwing;
 * every other transport failure is re-thrown as a validation-kind error
 * carrying the transport's user-facing message, so the panel boundary logs a
 * classification only, never response text.
 */
export async function applyTestServerDraft(
	intent: RequestPayload<"testServerDraft">,
	env: IntentEnvironment
): Promise<DraftProbeOutcome> {
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
			l10n.t("The entry being edited no longer exists in the servers setting; close the form and retry")
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
	// partial configurations silently, so probing one would report a verdict
	// for a configuration the saved entry would never send.
	const oauthExtras = oauthClientSecret !== undefined || oauthScopes !== undefined;
	if ((oauthClientId !== undefined || oauthExtras) && oauthTokenUrl === undefined) {
		// The "fieldId:" prefix stays an ASCII identifier outside the translation:
		// sectionFailureText routes the failure onto the right form section by it.
		throw new DashboardValidationError(`oauthTokenUrl: ${l10n.t("OAuth needs the token URL and client ID")}`);
	}
	if ((oauthTokenUrl !== undefined || oauthExtras) && oauthClientId === undefined) {
		throw new DashboardValidationError(`oauthClientId: ${l10n.t("OAuth needs the token URL and client ID")}`);
	}
	if (virtualKeyHeader !== undefined && virtualKeyValue === undefined) {
		throw new DashboardValidationError(`virtualKeyValue: ${l10n.t("enter the key sent in this header")}`);
	}
	if (virtualKeyHeader === undefined && virtualKeyValue !== undefined) {
		throw new DashboardValidationError(`virtualKeyHeader: ${l10n.t("name the header that carries the key")}`);
	}

	// Header values normalized to strings as the setting parser stores them.
	const draftHeaders: Readonly<Record<string, string>> = Object.fromEntries(
		Object.entries(intent.server.headers).map(([name, value]) => [name, String(value)])
	);

	const connection: DraftConnection = {
		baseUrl: intent.server.baseUrl.trim(),
		// The label rides only so discovery's declaration hints can name the
		// entry being edited; an unlabeled draft leaves it absent.
		...(trimmedOptional(intent.server.label) !== undefined ? { label: trimmedOptional(intent.server.label) } : {}),
		// "" is a real override (append nothing) and must ride the probe.
		...(intent.server.apiVersion !== undefined ? { apiVersion: intent.server.apiVersion.trim() } : {}),
		apiKey,
		...(Object.keys(draftHeaders).length > 0 ? { headers: draftHeaders } : {}),
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
		expected: {
			modelInfo: intent.server.expectedFailures.includes("modelInfo"),
			modelListing: intent.server.expectedFailures.includes("modelListing"),
		},
	};
	try {
		const discovered = await env.probeDraftConnection(connection);
		// Inertness matches registration: a declared ID discovery already lists
		// adds nothing, so only the others join the would-be-registered total.
		const discoveredSet = new Set(discovered);
		const declaredCount = draftDeclaredModelIds(intent.server.declaredModels).filter(
			(rawId) => !discoveredSet.has(rawId)
		).length;
		return { kind: "connected", modelCount: discovered.length + declaredCount, declaredCount };
	} catch (error) {
		if (error instanceof RequestError) {
			// A terminal discovery failure is a /models failure; when the draft
			// expects that category, the outcome mirrors production's non-silent
			// refresh contract - the declared models, as a note, not a failure.
			if (intent.server.expectedFailures.includes("modelListing")) {
				return {
					kind: "expected-failure",
					declaredCount: draftDeclaredModelIds(intent.server.declaredModels).length,
				};
			}
			// The transport's message is user-facing by the same convention as a
			// server row's error state and forwards verbatim, both lines.
			// Validation-kind because nothing durable changed (the probe is
			// read-only), so the form stays editable. The classification (kind,
			// status, setup hint - never text) rides along so the form can link
			// the matching troubleshooting-guide section.
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
 * the entry's custom headers, timeout, and retry behavior are all production
 * discovery's, while the instance's caches are discarded with the call.
 *
 * Deliberately NO logger: discovery's own debug lines carry endpoint URLs and
 * truncated response snippets, which would land in the issue-report buffer
 * that opens public GitHub issues. The panel boundary logs the outcome
 * classification once instead.
 */
export function createDraftConnectionProbe(
	context: vscode.ExtensionContext
): (connection: DraftConnection) => Promise<readonly string[]> {
	// The same User-Agent activation composes for the provider; recomputed here
	// because activation does not export it.
	const extVersion: string = context.extension.packageJSON?.version ?? "unknown";
	const userAgent = `litellm-vscode-chat/${extVersion} VSCode/${vscode.version}`;
	return async (connection) => {
		const client = new ChatClient({
			userAgent,
			...(connection.headers !== undefined ? { getEntryHeaders: () => connection.headers } : {}),
			...(connection.apiVersion !== undefined ? { getEntryApiVersion: () => connection.apiVersion } : {}),
		});
		const { models } = await client.fetchModels(
			{
				id: DRAFT_PROBE_SERVER_ID,
				label: DRAFT_PROBE_SERVER_ID,
				baseUrl: connection.baseUrl,
				apiKey: connection.apiKey,
				// The DRAFT's label - what a declaration hint may name. Empty means
				// "no nameable entry" (FetchModelsRequest.entryLabel); the synthetic
				// probe ID must never surface in a user-facing message.
				entryLabel: connection.label ?? "",
				...(connection.oauth !== undefined ? { oauth: connection.oauth } : {}),
				...(connection.virtualKey !== undefined ? { virtualKey: connection.virtualKey } : {}),
			},
			connection.expected
		);
		return models.map((model) => model.id);
	};
}
