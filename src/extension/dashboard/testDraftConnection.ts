/**
 * Read-only by contract: no settings write, no provider-group or status mutation, no cross-probe caching, and the
 * resolved credential values flow into the probe's request headers only - never a log line, never a message.
 */

import * as l10n from "@vscode/l10n";
import type { RequestPayload } from "../../dashboard/endpoints";
import type { ExpectedDiscoveryFailures } from "../../provider/catalog/discovery";
import { parseGroupConfiguration } from "../../provider/catalog/groupModels";
import type { OAuthConfig, VirtualKeyConfig } from "../../provider/transport/auth";
import { ChatClient } from "../../provider/transport/chatClient";
import { RequestError } from "../../provider/transport/errorMapping";
import { transportClassificationOf } from "../../shared/errorClassification";
import type { NonChatMode, SecretFieldId } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { trimHttpWhitespace, usableHttpText } from "../../shared/util/headers";
import { recordFromKeys } from "../../shared/util/json";
import { collectKnownSecretValues, type KnownSecretCustody } from "../../shared/util/knownSecrets";
import { buildGroupArgs } from "../servers/serverSync/engine";
import { acceptedEntry } from "../servers/serverSync/setting";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardValidationError, rawServerEntries } from "./intents";
import { planResolves, readKeepSources, requireEntryShownByForm, secretPlans } from "./saveServer";

/** Values exist extension-side only; this shape is never logged. */
export interface DraftConnection {
	readonly baseUrl: string;
	/** The draft's trimmed label, when it has one: what discovery's endpoint-declaration hints may name. */
	readonly label?: string | undefined;
	/**
	 * The draft's apiVersion override; "" is a real value (append nothing). Absent when the draft leaves the mode on
	 * auto: the probe then tests the auto rule, exactly what a save without the field would use.
	 */
	readonly apiVersion?: string | undefined;
	/** Empty string for keyless drafts, matching ServerWithKey's convention. */
	readonly apiKey: string;
	readonly oauth?: OAuthConfig | undefined;
	readonly virtualKey?: VirtualKeyConfig | undefined;
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/**
	 * The draft's expectedFailures in discovery's per-endpoint shape: expected endpoints probe with a single attempt,
	 * like production.
	 */
	readonly expected?: ExpectedDiscoveryFailures | undefined;
	readonly includeModes?: readonly NonChatMode[] | undefined;
}

/**
 * A draft probe's outcome, for the success notice intents.ts composes. "connected" carries the total the saved entry
 * would register (discovered plus declared models discovery does not list); "expected-failure" means discovery failed
 * in a category the draft's expectedFailures declares, so the outcome is the declared models the entry would serve
 * anyway.
 */
export type DraftProbeOutcome =
	| { readonly kind: "connected"; readonly modelCount: number; readonly declaredCount: number }
	| { readonly kind: "expected-failure"; readonly declaredCount: number };

/**
 * The declared model IDs the SAVED entry would carry: the payload's list trimmed and deduplicated, exactly as the save
 * stores it. The probe tests the draft as typed, not the last-saved state.
 */
function draftDeclaredModelIds(payload: readonly string[]): readonly string[] {
	return [...new Set(payload.map((id) => trimHttpWhitespace(id)).filter((id) => id.length > 0))];
}

/**
 * The placeholder identity the parse-back entry carries: the parser needs a usable label and baseUrl, but only the
 * parsed credential fields are read.
 */
const PARSE_BACK_LABEL = "draft";

/**
 * A pairing failure surfaces as the field-routed message a save raises, because a partial OAuth unit would otherwise
 * probe unauthenticated and lie.
 *
 *   the save path's secret plans -> the shared auth assembler -> serverSync's parser -> buildGroupArgs
 *   -> parseGroupConfiguration, the credential units a sync pass bakes into the group
 */
export async function applyTestServerDraft(
	intent: RequestPayload<"testServerDraft">,
	env: IntentEnvironment
): Promise<DraftProbeOutcome> {
	const label = trimHttpWhitespace(intent.server.label);
	const targetLabel = trimHttpWhitespace(intent.replace?.label ?? intent.server.label);
	const entries = rawServerEntries(env.readServersSetting());
	const sources = await readKeepSources(entries, label, targetLabel, (secretsLabel) =>
		env.readServerSecrets(secretsLabel)
	);
	// The entry the form was showing, resolved AND verified by the save path's own rule: gone or swapped refuses like a
	// save would, so the probe tests exactly the credentials the form displayed - never a retired label's leftovers,
	// never a replaced entry's own key, and never the credentials of an entry that took the label while the form was
	// open.
	const showing = requireEntryShownByForm(intent.replace, sources);
	const plans = secretPlans(intent.secrets, showing, sources.storedOld);
	const inlineValues: { -readonly [K in SecretFieldId]?: string } = {};
	const secureValues: { -readonly [K in SecretFieldId]?: string } = {};
	for (const field of SECRET_FIELD_IDS) {
		const plan = plans[field];
		switch (plan.kind) {
			case "set-inline":
			case "kept-inline":
				inlineValues[field] = plan.value;
				break;
			case "set-secure":
				secureValues[field] = plan.value;
				break;
			case "stored": {
				const stored = sources.storedOld[field];
				if (stored !== undefined) {
					secureValues[field] = stored;
				}
				break;
			}
			case "cleared":
			case "absent":
				break;
		}
	}
	const assembled = assembleEntryAuth(
		{ ...pickNonSecretOptionalFields(intent.server), ...inlineValues },
		recordFromKeys(SECRET_FIELD_IDS, (field) => planResolves(plans[field]))
	);
	if (assembled.failure !== undefined) {
		throw new DashboardValidationError(pairingFailureMessage(assembled.failure));
	}
	const parsed = acceptedEntry(
		[
			{
				label: PARSE_BACK_LABEL,
				baseUrl: "http://draft.invalid",
				...(assembled.auth !== undefined ? { auth: assembled.auth } : {}),
			},
		],
		PARSE_BACK_LABEL
	);
	if (parsed === undefined) {
		// Unreachable by construction (the assembler emits only shapes the parser accepts); fail closed rather than
		// probe a guessed shape.
		throw new DashboardValidationError(l10n.t("The draft's credentials do not form a valid server entry"));
	}
	// The credentials narrowed exactly as a sync pass bakes them into the group (entryCredentials.ts takes the same
	// route), so the probe sends what a save would send: a key or virtual key the platform's Headers would refuse is
	// dropped here too, never quoted back by the probe's error.
	const groupServer = parseGroupConfiguration(buildGroupArgs(parsed.entry, secureValues));
	if (groupServer === undefined) {
		throw new DashboardValidationError(l10n.t("The draft's credentials do not form a valid server entry"));
	}

	// Header values normalized to strings as the setting parser stores them.
	const draftHeaders: Readonly<Record<string, string>> = Object.fromEntries(
		Object.entries(intent.server.headers).map(([name, value]) => [name, String(value)])
	);

	const usableLabel = usableHttpText(intent.server.label);
	const connection: DraftConnection = {
		baseUrl: trimHttpWhitespace(intent.server.baseUrl),
		...(usableLabel !== undefined ? { label: usableLabel } : {}),
		...(intent.server.apiVersion !== undefined ? { apiVersion: trimHttpWhitespace(intent.server.apiVersion) } : {}),
		apiKey: groupServer.apiKey,
		...(Object.keys(draftHeaders).length > 0 ? { headers: draftHeaders } : {}),
		...(groupServer.oauth !== undefined ? { oauth: groupServer.oauth } : {}),
		...(groupServer.virtualKey !== undefined ? { virtualKey: groupServer.virtualKey } : {}),
		expected: {
			modelInfo: intent.server.expectedFailures.includes("modelInfo"),
			modelListing: intent.server.expectedFailures.includes("modelListing"),
		},
		...(intent.server.includeModes.length > 0 ? { includeModes: intent.server.includeModes } : {}),
	};
	try {
		const discovered = await env.probeDraftConnection(connection);
		const discoveredSet = new Set(discovered);
		const declaredCount = draftDeclaredModelIds(intent.server.declaredModels).filter(
			(rawId) => !discoveredSet.has(rawId)
		).length;
		return { kind: "connected", modelCount: discovered.length + declaredCount, declaredCount };
	} catch (error) {
		if (error instanceof RequestError) {
			if (intent.server.expectedFailures.includes("modelListing")) {
				return {
					kind: "expected-failure",
					declaredCount: draftDeclaredModelIds(intent.server.declaredModels).length,
				};
			}
			// The transport's message is user-facing by the same convention as a server row's error state and forwards
			// verbatim, both lines. Validation-kind because nothing durable changed (the probe is read-only), so the
			// form stays editable.
			//
			//   The classification (kind, status, setup hint - never text) rides along -> the form can link the
			//     matching troubleshooting-guide section
			throw new DashboardValidationError(error.message, { classification: transportClassificationOf(error) });
		}
		throw error;
	}
}

/** The one-off probe's server ID; each probe uses a fresh throwaway client, so the ID never collides with a cache. */
const DRAFT_PROBE_SERVER_ID = "dashboard-draft-probe";

/** The connection's values through the configured-value collector, so a draft's key counts like a saved one. */
function draftSecretValues(connection: DraftConnection): readonly string[] {
	return collectKnownSecretValues(
		[
			{
				urls: [connection.baseUrl, ...(connection.oauth !== undefined ? [connection.oauth.tokenUrl] : [])],
				secrets: [connection.apiKey, connection.oauth?.clientSecret, connection.virtualKey?.value].filter(
					(value): value is string => value !== undefined
				),
				headers: connection.headers ?? {},
				carriers: connection.virtualKey !== undefined ? [connection.virtualKey.header] : [],
			},
		],
		[]
	);
}

/**
 * A throwaway ChatClient, so the OAuth exchange, custom headers, timeout, and retries are production discovery's
 * while the caches die with the call. Deliberately NO logger, because discovery's debug lines carry endpoint URLs
 * and response snippets, which feed the public issue-report buffer. The draft's credentials are known values for
 * exactly the probe's lifetime: a 4xx body echoing a key typed into the form, not yet saved, is redacted like a
 * configured one.
 */
export function createDraftConnectionProbe(
	userAgent: string,
	knownSecrets: KnownSecretCustody
): (connection: DraftConnection) => Promise<readonly string[]> {
	return async (connection) => {
		const draftValues = draftSecretValues(connection);
		for (const value of draftValues) {
			knownSecrets.mint(value);
		}
		const client = new ChatClient({
			userAgent,
			knownSecrets,
			...(connection.headers !== undefined ? { getEntryHeaders: () => connection.headers } : {}),
			...(connection.apiVersion !== undefined ? { getEntryApiVersion: () => connection.apiVersion } : {}),
		});
		try {
			const { models } = await client.fetchModels(
				{
					id: DRAFT_PROBE_SERVER_ID,
					label: DRAFT_PROBE_SERVER_ID,
					baseUrl: connection.baseUrl,
					apiKey: connection.apiKey,
					// The DRAFT's label - what a declaration hint may name. Empty means "no nameable entry"
					// (FetchModelsRequest.entryLabel); the synthetic probe ID must never surface in a user-facing message.
					entryLabel: connection.label ?? "",
					...(connection.oauth !== undefined ? { oauth: connection.oauth } : {}),
					...(connection.virtualKey !== undefined ? { virtualKey: connection.virtualKey } : {}),
				},
				connection.expected,
				connection.includeModes
			);
			return models.map((model) => model.id);
		} finally {
			client.dispose();
			for (const value of draftValues) {
				knownSecrets.retire(value);
			}
		}
	};
}
