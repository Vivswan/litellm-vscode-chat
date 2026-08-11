/**
 * Presentation helpers for capability fields, shared by the capability
 * inspector (webview, through protocol.ts) and the Diagnostics tab's
 * resolved-models figure: the friendly display labels for every consumed
 * field and the $/M rendering of the per-token cost fields. Pure and
 * webview-safe; @vscode/l10n is the one l10n API both runtimes share.
 *
 * Display only: the value vocabulary itself (which keys are consumed, how
 * their values validate) stays in capabilityResolution.ts.
 */

import * as l10n from "@vscode/l10n";

/**
 * The eight cost fields in display order: the base tier, then the
 * long-context tier, input before output and cache read before cache write
 * within each. Both pricing surfaces group and order by this list.
 */
export const COST_CAPABILITY_FIELDS = [
	"input_cost_per_token",
	"output_cost_per_token",
	"cache_read_input_token_cost",
	"cache_creation_input_token_cost",
	"long_context_input_cost_per_token",
	"long_context_output_cost_per_token",
	"long_context_cache_read_input_token_cost",
	"long_context_cache_creation_input_token_cost",
] as const;

export type CostCapabilityField = (typeof COST_CAPABILITY_FIELDS)[number];

const COST_FIELD_SET: ReadonlySet<string> = new Set(COST_CAPABILITY_FIELDS);

/** Whether a capability key is one of the eight per-token cost fields. */
export function isCostCapabilityField(name: string): name is CostCapabilityField {
	return COST_FIELD_SET.has(name);
}

/**
 * A capability field's human display label, resolved at call time (no
 * module-level localized constants): the core fields, the consumed booleans,
 * the params list, and the cost fields. Undefined for every other key - an
 * open field's wire key IS its name, and callers render it raw (monospace),
 * never localized.
 */
export function capabilityDisplayLabel(name: string): string | undefined {
	switch (name) {
		case "context_length":
			return l10n.t("Context length");
		case "max_input_tokens":
			return l10n.t("Max input tokens");
		case "max_output_tokens":
			return l10n.t("Max output tokens");
		case "supports_function_calling":
			return l10n.t("Tool calling");
		case "supports_vision":
			return l10n.t("Vision");
		case "supports_reasoning":
			return l10n.t("Reasoning");
		case "supports_audio_input":
			return l10n.t("Audio input");
		case "supports_prompt_caching":
			return l10n.t("Prompt caching");
		case "supports_pdf_input":
			return l10n.t("PDF input");
		case "supports_response_schema":
			return l10n.t("Response schema");
		case "supported_openai_params":
			return l10n.t("Supported parameters");
		case "input_cost_per_token":
			return l10n.t({ message: "Input", comment: ["Pricing row label: cost of input tokens"] });
		case "output_cost_per_token":
			return l10n.t({ message: "Output", comment: ["Pricing row label: cost of output tokens"] });
		case "cache_read_input_token_cost":
			return l10n.t({ message: "Cache read", comment: ["Pricing row label: cost of cached input tokens"] });
		case "cache_creation_input_token_cost":
			return l10n.t({ message: "Cache write", comment: ["Pricing row label: cost of writing the prompt cache"] });
		case "long_context_input_cost_per_token":
			return l10n.t({ message: "Long-context input", comment: ["Pricing row label: long-context tier"] });
		case "long_context_output_cost_per_token":
			return l10n.t({ message: "Long-context output", comment: ["Pricing row label: long-context tier"] });
		case "long_context_cache_read_input_token_cost":
			return l10n.t({ message: "Long-context cache read", comment: ["Pricing row label: long-context tier"] });
		case "long_context_cache_creation_input_token_cost":
			return l10n.t({ message: "Long-context cache write", comment: ["Pricing row label: long-context tier"] });
		default:
			return undefined;
	}
}

/**
 * The localized "N parameters" reading of a supported_openai_params list;
 * both surfaces show the count and keep the full list one hover away.
 */
export function parameterCountText(count: number): string {
	return count === 1 ? l10n.t("1 parameter") : l10n.t("{0} parameters", count);
}

/**
 * A per-token cost as dollars per million tokens: "$5.00", "$0.50", "$6.25",
 * "$37.50". Zero (LiteLLM's "genuinely free" after resolution) is "$0".
 *
 * Rounding rules, pinned by tests: values of a dollar and up round to cents
 * (exactly two decimals); sub-dollar values keep three significant digits,
 * then trim trailing zeros but never below two decimals, so sub-cent prices
 * like $0.0004 survive. Everything goes through toFixed-family math - wire
 * values arrive in scientific notation (5e-7) and String() would echo it.
 */
export function formatCostPerMillion(perTokenCost: number): string {
	const dollars = perTokenCost * 1e6;
	if (dollars === 0) {
		return "$0";
	}
	const sign = dollars < 0 ? "-" : "";
	const abs = Math.abs(dollars);
	// The scaling can overflow for astronomically priced nonsense (validated
	// costs are finite, but finite * 1e6 need not be); format the per-token
	// magnitude in plain digits rather than echoing an Infinity glyph.
	if (!Number.isFinite(abs)) {
		return `${sign}$${Math.abs(perTokenCost).toLocaleString("en-US", {
			useGrouping: false,
			maximumFractionDigits: 0,
		})}000000`;
	}
	// Beyond toFixed's plain-notation range (1e21) it goes exponential too;
	// Intl always writes digits. Costs this size are configuration nonsense,
	// but the formatter must never emit scientific notation for them.
	if (abs >= 1e15) {
		return `${sign}$${abs.toLocaleString("en-US", {
			useGrouping: false,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}
	// Decimals for three significant digits, floored at cents: $1+ rounds to
	// exactly two decimals, sub-dollar values extend ($0.0004 needs six). The
	// cap is toFixed's own limit; anything smaller than 1e-98 $/M renders as
	// a plain $0.00 (denormal-scale prices are not distinguishable in text).
	const magnitude = Math.floor(Math.log10(abs));
	const decimals = Math.min(100, Math.max(2, 2 - magnitude));
	let text = abs.toFixed(decimals);
	if (decimals > 2) {
		// Trim trailing zeros beyond the cents, then restore to at least two
		// decimals ("0.500" -> "0.5" -> "0.50").
		text = text.replace(/0+$/, "");
		const fraction = text.length - text.indexOf(".") - 1;
		if (fraction < 2) {
			text = text.padEnd(text.length + 2 - fraction, "0");
		}
	}
	return `${sign}$${text}`;
}
