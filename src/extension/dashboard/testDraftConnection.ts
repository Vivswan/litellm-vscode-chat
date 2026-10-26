/**
 * Read-only by contract: no settings write, no provider-group or status mutation, no cross-probe caching, and the
 * resolved credential values flow into the probe's request headers only - never a log line, never a message.
 */

import * as l10n from "@vscode/l10n";
import type { RequestPayload } from "../../dashboard/endpoints";
import type { ExpectedDiscoveryFailures } from "../../provider/catalog/discovery";
import type { GroupServer } from "../../provider/catalog/groupModels";
import { parseGroupConfiguration, refusedCredentialFields } from "../../provider/catalog/groupModels";
import type { OAuthConfig, VirtualKeyConfig } from "../../provider/transport/auth";
import { ChatClient } from "../../provider/transport/chatClient";
import { RequestError } from "../../provider/transport/transportErrors";
import { transportClassificationOf } from "../../shared/errorClassification";
import { rejectedCredentialKinds } from "../../shared/failureCause";
import type { NonChatMode, SecretFieldId } from "../../shared/serverEntry";
import { pickNonSecretOptionalFields, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { canonicalBaseUrl } from "../../shared/util/baseUrl";
import { type HeaderValue, headerValue, trimHttpWhitespace, usableHttpText } from "../../shared/util/headers";
import { recordFromKeys } from "../../shared/util/json";
import { buildGroupArgs } from "../servers/serverSync/engine";
import { acceptedEntry } from "../servers/serverSync/setting";
import { rawServerEntries } from "../settingsWriteTurn";
import { assembleEntryAuth, pairingFailureMessage } from "./entryAuth";
import type { IntentEnvironment } from "./intents";
import { DashboardValidationError } from "./intents";
import type { KeepSources, SecretPlan } from "./saveServer";
import { planResolves, readKeepSources, requireEntryShownByForm, secretPlans } from "./saveServer";

/** Values exist extension-side only; this shape is never logged. */
export interface DraftConnection {
	/** The canonical spelling the save will store, so a probe error names the URL the entry will show. */
	readonly baseUrl: string;

	/** The draft's trimmed label, when it has one: what discovery's endpoint-declaration hints may name. */
	readonly label?: string | undefined;

	/** The draft's apiVersion override; "" is a real value (append nothing), absent means the auto rule a save uses. */
	readonly apiVersion?: string | undefined;

	/** Empty string for keyless drafts, matching ServerWithKey's convention. */
	readonly apiKey: HeaderValue | "";

	/** The OAuth unit as the parser baked it, so the probe exchanges exactly what a sync pass would. */
	readonly oauth?: OAuthConfig | undefined;

	/** The virtual key unit as the parser baked it, like oauth. */
	readonly virtualKey?: VirtualKeyConfig | undefined;

	/** The draft's headers, minted by the request path's value rule; absent when the draft declares none. */
	readonly headers?: Readonly<Record<string, HeaderValue>> | undefined;

	/** The draft's expectedFailures in discovery's shape; an expected endpoint gets one attempt, as in production. */
	readonly expected?: ExpectedDiscoveryFailures | undefined;

	/** The draft's includeModes; absent when empty, so the probe lists exactly the modes the saved entry would. */
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

/** The parse-back entry's placeholder label: the parser needs one, but only the parsed credential fields are read. */
const PARSE_BACK_LABEL = "draft";

/** The draft as the testServerDraft payload carries it. */
type DraftServer = RequestPayload<"testServerDraft">["server"];

/** The plans' values by where they ride: inline ones into the parse-back entry, secure ones into the group args. */
function partitionPlanValues(
	plans: Readonly<Record<SecretFieldId, SecretPlan>>,
	storedOld: KeepSources["storedOld"]
): {
	readonly inlineValues: { -readonly [K in SecretFieldId]?: string };
	readonly secureValues: { -readonly [K in SecretFieldId]?: string };
} {
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
				const stored = storedOld[field];
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

	return { inlineValues, secureValues };
}

/**
 * The draft's credential units exactly as a sync pass bakes them into the group: the save path's secret plans through
 * the shared auth assembler, serverSync's parser, buildGroupArgs, and parseGroupConfiguration. A pairing failure
 * surfaces as the field-routed message a save raises, because a partial OAuth unit would otherwise probe
 * unauthenticated and lie; a key or virtual key the platform's Headers would refuse names its field, never its value.
 */
function draftGroupServer(
	server: DraftServer,
	plans: Readonly<Record<SecretFieldId, SecretPlan>>,
	storedOld: KeepSources["storedOld"]
): GroupServer {
	const { inlineValues, secureValues } = partitionPlanValues(plans, storedOld);
	const assembled = assembleEntryAuth(
		{ ...pickNonSecretOptionalFields(server), ...inlineValues },
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
				...(assembled.auth === undefined ? {} : { auth: assembled.auth }),
			},
		],
		PARSE_BACK_LABEL
	);
	if (parsed === undefined) {
		// Unreachable by construction (the assembler emits only shapes the parser accepts); fail closed rather than
		// probe a guessed shape.
		throw new DashboardValidationError(l10n.t("The draft's credentials do not form a valid server entry"));
	}
	const group = parseGroupConfiguration(buildGroupArgs(parsed.entry, secureValues));
	if (group === undefined) {
		throw new DashboardValidationError(l10n.t("The draft's credentials do not form a valid server entry"));
	}
	const refused = refusedCredentialFields(group.rejections);
	if (refused !== undefined) {
		throw new DashboardValidationError(
			l10n.t("The draft's {0} cannot be sent as an HTTP header", rejectedCredentialKinds(refused).display)
		);
	}

	return group.server;
}

/**
 * The draft's headers minted by the rule the request path sends through (the save validation checks names only on
 * this intent): a value the rule refuses names its header here, so the probe never hands the platform's Headers a
 * value it would throw on, quoting it.
 */
function draftHeadersOf(headers: DraftServer["headers"]): Record<string, HeaderValue> {
	const draftHeaders: Record<string, HeaderValue> = {};
	for (const [name, raw] of Object.entries(headers)) {
		const value = headerValue(String(raw));
		if (value === undefined) {
			throw new DashboardValidationError(
				`headers: ${l10n.t('the value of "{0}" cannot be sent as an HTTP header', name)}`
			);
		}
		draftHeaders[name] = value;
	}

	return draftHeaders;
}

/**
 * The connection the probe sends: the spelling the save will store, so an error names the URL the entry will show (the
 * intent validation already refused anything canonicalUrl refuses), the parsed credential units, and the draft's own
 * fields.
 */
function draftConnectionOf(server: DraftServer, groupServer: GroupServer): DraftConnection {
	const baseUrl = canonicalBaseUrl(server.baseUrl);
	if (baseUrl === undefined) {
		throw new DashboardValidationError(`baseUrl: ${l10n.t("not a usable http(s) URL")}`);
	}
	const draftHeaders = draftHeadersOf(server.headers);
	const usableLabel = usableHttpText(server.label);
	return {
		baseUrl,
		...(usableLabel === undefined ? {} : { label: usableLabel }),
		...(server.apiVersion === undefined ? {} : { apiVersion: trimHttpWhitespace(server.apiVersion) }),
		apiKey: groupServer.apiKey,
		...(Object.keys(draftHeaders).length > 0 ? { headers: draftHeaders } : {}),
		...(groupServer.oauth === undefined ? {} : { oauth: groupServer.oauth }),
		...(groupServer.virtualKey === undefined ? {} : { virtualKey: groupServer.virtualKey }),
		expected: {
			modelInfo: server.expectedFailures.includes("modelInfo"),
			modelListing: server.expectedFailures.includes("modelListing"),
		},
		...(server.includeModes.length > 0 ? { includeModes: server.includeModes } : {}),
	};
}

/**
 * The outcome of a probe that threw. A listing failure the draft declares expected is the declared-models outcome; any
 * other transport failure forwards verbatim, both lines, as the field-routed refusal a server row's error state uses.
 * Validation-kind because nothing durable changed (the probe is read-only), so the form stays editable, and the
 * classification (kind, status, setup hint, never text) rides along so the form can link the matching
 * troubleshooting-guide section.
 */
function draftProbeFailure(error: unknown, server: DraftServer): DraftProbeOutcome {
	if (!(error instanceof RequestError)) {
		throw error;
	}
	if (server.expectedFailures.includes("modelListing")) {
		return { kind: "expected-failure", declaredCount: draftDeclaredModelIds(server.declaredModels).length };
	}
	throw new DashboardValidationError(error.message, { classification: transportClassificationOf(error) });
}

/**
 * The probe tests exactly the credentials the form displayed: the entry the form was showing is resolved AND verified
 * by the save path's own rule, so gone or swapped refuses like a save would, never a retired label's leftovers, never
 * a replaced entry's own key, and never the credentials of an entry that took the label while the form was open.
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
	const showing = requireEntryShownByForm(intent.replace, sources);
	const plans = secretPlans(intent.secrets, showing, sources.storedOld);
	const groupServer = draftGroupServer(intent.server, plans, sources.storedOld);
	const connection = draftConnectionOf(intent.server, groupServer);

	try {
		const discovered = await env.probeDraftConnection(connection);
		const discoveredSet = new Set(discovered);
		const declaredCount = draftDeclaredModelIds(intent.server.declaredModels).filter(
			(rawId) => !discoveredSet.has(rawId)
		).length;
		return { kind: "connected", modelCount: discovered.length + declaredCount, declaredCount };
	} catch (error) {
		return draftProbeFailure(error, intent.server);
	}
}

/** The one-off probe's server ID; each probe uses a fresh throwaway client, so the ID never collides with a cache. */
const DRAFT_PROBE_SERVER_ID = "dashboard-draft-probe";

/**
 * A throwaway ChatClient, so the OAuth exchange, custom headers, timeout, and retries are production discovery's
 * while the caches die with the call. Deliberately NO logger, because discovery's debug lines carry endpoint URLs
 * and response snippets, which feed the public issue-report buffer.
 */
export function createDraftConnectionProbe(
	userAgent: HeaderValue
): (connection: DraftConnection) => Promise<readonly string[]> {
	return async (connection) => {
		const client = new ChatClient({
			userAgent,
			...(connection.headers === undefined ? {} : { getEntryHeaders: () => connection.headers }),
			...(connection.apiVersion === undefined ? {} : { getEntryApiVersion: () => connection.apiVersion }),
		});
		const { models } = await client.fetchModels(
			{
				id: DRAFT_PROBE_SERVER_ID,
				label: DRAFT_PROBE_SERVER_ID,
				baseUrl: connection.baseUrl,
				apiKey: connection.apiKey,
				// The DRAFT's label - what a declaration hint may name. Empty means "no nameable entry"
				// (FetchModelsRequest.entryLabel); the synthetic probe ID must never surface in a user-facing message.
				entryLabel: connection.label ?? "",
				...(connection.oauth === undefined ? {} : { oauth: connection.oauth }),
				...(connection.virtualKey === undefined ? {} : { virtualKey: connection.virtualKey }),
			},
			connection.expected,
			connection.includeModes
		);
		return models.map((model) => model.id);
	};
}
