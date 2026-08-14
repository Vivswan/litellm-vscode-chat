/**
 * Transport error classification shared across the layers. The kinds live
 * here rather than in provider/transport because consumers sit on both sides
 * of the layering boundary: ServerStatus (shared) and the dashboard protocol
 * (webview-reachable) may not import the provider layer. The module is pure
 * classification - enum ids and a status number, never message text - so its
 * values are safe on every surface: logs, the panel protocol, persistence.
 */

export const TRANSPORT_ERROR_KINDS = [
	"auth",
	"http",
	"certificate",
	"connection",
	"network",
	"timeout",
	"aborted",
] as const;
export type TransportErrorKind = (typeof TRANSPORT_ERROR_KINDS)[number];

/**
 * Setup-hint ids, assigned ONLY at RequestError construction sites that know
 * the advice is right. Never derive one from kind+status: the same pair means
 * different failures at different sites (an OAuth token-endpoint 404 is not a
 * wrong LiteLLM base URL; an upstream-auth 401 is not this client's key).
 */
export const SETUP_HINT_KINDS = ["check-base-url", "proxy-not-running", "configure-api-key"] as const;
export type SetupHintKind = (typeof SETUP_HINT_KINDS)[number];

/**
 * The failure shapes that read as "this server does not serve the endpoint":
 * a hang until the discovery timeout, or an HTTP 404/405. Discovery classifies
 * each endpoint's failure against this vocabulary to tell an unserved
 * endpoint (declare it in the entry's expectedFailures) from a genuinely slow
 * or broken one (retry, or raise the timeout).
 */
export type UnservedEndpointEvidence = "timeout" | "status";

/** Classification only - kind, HTTP status, and hint id; never message text. */
export interface TransportErrorClassification {
	readonly kind: TransportErrorKind;
	readonly status?: number | undefined;
	readonly setupHint?: SetupHintKind | undefined;
	/**
	 * Discovery-only, assigned at the construction site like setupHint: the
	 * models listing failed like an unserved endpoint while the model-info
	 * probe answered (or was itself declared expected), so declaring
	 * expectedFailures: ["modelListing"] on the entry fits better than
	 * retrying. UI surfaces read it to offer that declaration as an action.
	 */
	readonly unsupportedEndpoint?: "modelListing" | undefined;
}

function isTransportErrorKind(value: unknown): value is TransportErrorKind {
	return (TRANSPORT_ERROR_KINDS as readonly unknown[]).includes(value);
}

function isSetupHintKind(value: unknown): value is SetupHintKind {
	return (SETUP_HINT_KINDS as readonly unknown[]).includes(value);
}

/**
 * Extract a classification from an unknown thrown value. Duck-typed, not
 * instanceof: RequestError lives in the provider layer, and this extractor
 * serves callers behind `unknown` boundaries that may not import it (the
 * extension layer's issue reporter and dashboard panel; the provider's own
 * statusErrorTexts delegates here too, so there is exactly one extraction).
 * Total against hostile getters (same hardening as classificationOf in
 * shared/logger.ts); every field is validated - kind and setupHint against
 * the const arrays above, status as an integer - so junk values drop the
 * field, never poison a consumer.
 */
export function transportClassificationOf(error: unknown): TransportErrorClassification | undefined {
	try {
		const candidate = error as
			| { kind?: unknown; status?: unknown; setupHint?: unknown; unsupportedEndpoint?: unknown }
			| null
			| undefined;
		const kind = candidate?.kind;
		if (!isTransportErrorKind(kind)) {
			return undefined;
		}
		const status = candidate?.status;
		const setupHint = candidate?.setupHint;
		const unsupportedEndpoint = candidate?.unsupportedEndpoint;
		return {
			kind,
			...(typeof status === "number" && Number.isInteger(status) ? { status } : {}),
			...(isSetupHintKind(setupHint) ? { setupHint } : {}),
			...(unsupportedEndpoint === "modelListing" ? { unsupportedEndpoint } : {}),
		};
	} catch {
		// A hostile kind/status/setupHint getter must not break classification.
		return undefined;
	}
}
