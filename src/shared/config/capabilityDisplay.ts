/**
 * Presentation helpers for capability fields, shared by the capability
 * inspector and the Diagnostics tab. Display only: the value vocabulary itself
 * (which keys are consumed, how their values validate) stays in
 * capabilityResolution.ts.
 */

import * as l10n from "@vscode/l10n";
import { CONSUMED_CAPABILITY_FIELDS } from "./capabilityResolution";

/**
 * The eight cost fields in display order: the base tier, then the long-context
 * tier, input before output and cache read before cache write within each.
 * Both pricing surfaces group and order by this list.
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
 * The token-count fields, derived from the consumed vocabulary's "number" kind
 * (the same derivation the record editors' inputs use), so a new number-kind
 * field renders as a token count the day it is consumed.
 */
const TOKEN_FIELD_SET: ReadonlySet<string> = new Set(
	Object.entries(CONSUMED_CAPABILITY_FIELDS)
		.filter(([, kind]) => kind === "number")
		.map(([name]) => name)
);

/** Whether a capability key's numbers render as token counts; other numbers (costs aside) render plain. */
export function isTokenCapabilityField(name: string): boolean {
	return TOKEN_FIELD_SET.has(name);
}

/**
 * A capability field's human display label, resolved at call time (no
 * module-level localized constants). Undefined for every other key - an open
 * field's wire key IS its name, and callers render it raw, never localized.
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
		case "reasoning_effort_levels":
			return l10n.t("Reasoning effort levels");
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

/** The localized "N parameters" reading of a supported_openai_params list. */
export function parameterCountText(count: number): string {
	return count === 1 ? l10n.t("1 parameter") : l10n.t("{0} parameters", count);
}

/**
 * A per-token cost per million tokens. Zero is "$0". The symbol is the
 * configured usage.currencySymbol, prefixed verbatim after the sign.
 *
 * Rounding rules, pinned by tests: values of a unit and up round to cents
 * (exactly two decimals); sub-unit values keep three significant digits, then
 * trim trailing zeros but never below two decimals, so sub-cent prices like
 * $0.0004 survive. Everything goes through toFixed-family math - wire values
 * arrive in scientific notation (5e-7) and String() would echo it.
 */
export function formatCostPerMillion(perTokenCost: number, currencySymbol: string): string {
	const perMillion = perTokenCost * 1e6;
	if (perMillion === 0) {
		return `${currencySymbol}0`;
	}
	const sign = perMillion < 0 ? "-" : "";
	const abs = Math.abs(perMillion);
	// The scaling can overflow for astronomically priced nonsense (finite * 1e6
	// need not be finite); format the per-token magnitude in plain digits
	// rather than echoing an Infinity glyph.
	if (!Number.isFinite(abs)) {
		return `${sign}${currencySymbol}${Math.abs(perTokenCost).toLocaleString("en-US", {
			useGrouping: false,
			maximumFractionDigits: 0,
		})}000000`;
	}
	// Beyond toFixed's plain-notation range (1e21) it goes exponential too;
	// Intl always writes digits. Costs this size are configuration nonsense,
	// but the formatter must never emit scientific notation for them.
	if (abs >= 1e15) {
		return `${sign}${currencySymbol}${abs.toLocaleString("en-US", {
			useGrouping: false,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}
	// Decimals for three significant digits, floored at cents: $1+ rounds to
	// exactly two decimals, sub-unit values extend ($0.0004 needs six). The cap
	// is toFixed's own limit; anything smaller renders as a plain $0.00.
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
	return `${sign}${currencySymbol}${text}`;
}

/**
 * The unit label beside a block of per-million prices, shared by the models
 * table's pricing tip and the inspector's pricing section so the two never
 * name the unit differently. The symbol is trimmed - "EUR " reads as "EUR per
 * million tokens" - and the empty symbol drops the currency claim entirely.
 */
export function costUnitLabel(currencySymbol: string): string {
	const symbol = currencySymbol.trim();
	return symbol.length === 0 ? l10n.t("per million tokens") : l10n.t("{0} per million tokens", symbol);
}
