/**
 * Presentation helpers for capability fields, shared by the capability inspector and the Diagnostics tab. Display only:
 * the value vocabulary itself (which keys are consumed, how their values validate) stays in capabilityResolution.ts.
 */

import * as l10n from "@vscode/l10n";
import { trimHttpWhitespace } from "../util/headers";
import type { ConsumedCapabilityField, CostCapabilityField } from "./capabilityResolution";
import { consumedFieldsOfKind } from "./capabilityResolution";

const COST_FIELD_DISPLAY_RANK = {
	input_cost_per_token: 0,
	output_cost_per_token: 1,
	cache_read_input_token_cost: 2,
	cache_creation_input_token_cost: 3,
	long_context_input_cost_per_token: 4,
	long_context_output_cost_per_token: 5,
	long_context_cache_read_input_token_cost: 6,
	long_context_cache_creation_input_token_cost: 7,
} as const satisfies Record<CostCapabilityField, number>;

/** The cost fields in display order; both pricing surfaces group and order by this list. */
export const COST_CAPABILITY_FIELDS: readonly CostCapabilityField[] = consumedFieldsOfKind("cost").sort(
	(a, b) => COST_FIELD_DISPLAY_RANK[a] - COST_FIELD_DISPLAY_RANK[b]
);

const COST_FIELD_SET: ReadonlySet<string> = new Set(COST_CAPABILITY_FIELDS);

export function isCostCapabilityField(name: string): name is CostCapabilityField {
	return COST_FIELD_SET.has(name);
}

/**
 * The token-count fields, derived from the consumed vocabulary's "number" kind (the same derivation the record
 * editors' inputs use), so a new number-kind field renders as a token count the day it is consumed.
 */
const TOKEN_FIELD_SET: ReadonlySet<string> = new Set(consumedFieldsOfKind("number"));

/** Whether a capability key's numbers render as token counts; other numbers (costs aside) render plain. */
export function isTokenCapabilityField(name: string): boolean {
	return TOKEN_FIELD_SET.has(name);
}

/**
 * Every consumed field's display label as a thunk, so the text resolves at call time (no module-level localized
 * constants).
 */
const CAPABILITY_DISPLAY_LABELS: Readonly<Record<ConsumedCapabilityField, () => string>> = {
	context_length: () => l10n.t("Context length"),
	max_input_tokens: () => l10n.t("Max input tokens"),
	max_output_tokens: () => l10n.t("Max output tokens"),
	supports_function_calling: () => l10n.t("Tool calling"),
	supports_vision: () => l10n.t("Vision"),
	supports_reasoning: () => l10n.t("Reasoning"),
	supports_audio_input: () => l10n.t("Audio input"),
	supports_prompt_caching: () => l10n.t("Prompt caching"),
	supports_pdf_input: () => l10n.t("PDF input"),
	supports_response_schema: () => l10n.t("Response schema"),
	supported_openai_params: () => l10n.t("Supported parameters"),
	reasoning_effort_levels: () => l10n.t("Reasoning effort levels"),
	input_cost_per_token: () => l10n.t({ message: "Input", comment: ["Pricing row label: cost of input tokens"] }),
	output_cost_per_token: () => l10n.t({ message: "Output", comment: ["Pricing row label: cost of output tokens"] }),
	cache_read_input_token_cost: () =>
		l10n.t({ message: "Cache read", comment: ["Pricing row label: cost of cached input tokens"] }),
	cache_creation_input_token_cost: () =>
		l10n.t({ message: "Cache write", comment: ["Pricing row label: cost of writing the prompt cache"] }),
	long_context_input_cost_per_token: () =>
		l10n.t({ message: "Long-context input", comment: ["Pricing row label: long-context tier"] }),
	long_context_output_cost_per_token: () =>
		l10n.t({ message: "Long-context output", comment: ["Pricing row label: long-context tier"] }),
	long_context_cache_read_input_token_cost: () =>
		l10n.t({ message: "Long-context cache read", comment: ["Pricing row label: long-context tier"] }),
	long_context_cache_creation_input_token_cost: () =>
		l10n.t({ message: "Long-context cache write", comment: ["Pricing row label: long-context tier"] }),
};

/**
 * Undefined for every key outside the consumed vocabulary - an open field's wire key IS its name, and callers render
 * it raw, never localized.
 */
export function capabilityDisplayLabel(name: string): string | undefined {
	return Object.hasOwn(CAPABILITY_DISPLAY_LABELS, name)
		? CAPABILITY_DISPLAY_LABELS[name as ConsumedCapabilityField]()
		: undefined;
}

export function parameterCountText(count: number): string {
	return count === 1 ? l10n.t("1 parameter") : l10n.t("{0} parameters", count);
}

export function formatCostPerMillion(perTokenCost: number, currencySymbol: string): string {
	const perMillion = perTokenCost * 1e6;
	if (perMillion === 0) {
		return `${currencySymbol}0`;
	}
	const sign = perMillion < 0 ? "-" : "";
	const abs = Math.abs(perMillion);
	// The scaling can overflow for astronomically priced nonsense (finite * 1e6 need not be finite); format the
	// per-token magnitude in plain digits rather than echoing an Infinity glyph.
	if (!Number.isFinite(abs)) {
		return `${sign}${currencySymbol}${Math.abs(perTokenCost).toLocaleString("en-US", {
			useGrouping: false,
			maximumFractionDigits: 0,
		})}000000`;
	}
	// Beyond toFixed's plain-notation range (1e21) it goes exponential too; Intl always writes digits. Costs this size
	// are configuration nonsense, but the formatter must never emit scientific notation for them.
	if (abs >= 1e15) {
		return `${sign}${currencySymbol}${abs.toLocaleString("en-US", {
			useGrouping: false,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		})}`;
	}
	// Decimals for three significant digits, floored at cents: $1+ rounds to exactly two decimals, sub-unit values
	// extend ($0.0004 needs six). The cap is toFixed's own limit.
	const magnitude = Math.floor(Math.log10(abs));
	const decimals = Math.min(100, Math.max(2, 2 - magnitude));
	let text = abs.toFixed(decimals);
	if (decimals > 2) {
		text = text.replace(/0+$/, "");
		const fraction = text.length - text.indexOf(".") - 1;
		if (fraction < 2) {
			text = text.padEnd(text.length + 2 - fraction, "0");
		}
	}
	return `${sign}${currencySymbol}${text}`;
}

/**
 * The unit label beside a block of per-million prices, shared by the models table's pricing tip and the inspector's
 * pricing section so the two never name the unit differently. The symbol is trimmed - "EUR " reads as "EUR per
 * million tokens" - and the empty symbol drops the currency claim entirely.
 */
export function costUnitLabel(currencySymbol: string): string {
	const symbol = trimHttpWhitespace(currencySymbol);
	return symbol.length === 0 ? l10n.t("per million tokens") : l10n.t("{0} per million tokens", symbol);
}
