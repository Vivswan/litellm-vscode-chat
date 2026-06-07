import { normalizeNonNegativeNumber } from "../shared/numbers";

export interface TokenPricing {
	inputCostPerToken?: number;
	outputCostPerToken?: number;
}

export interface FinalizedResponseCost {
	costUsd: number;
	source: "stream" | "header" | "computed";
	estimated: boolean;
}

interface CostCandidate extends FinalizedResponseCost {
	priority: number;
}

const STREAM_PRIORITY = 3;
const HEADER_PRIORITY = 2;
const COMPUTED_PRIORITY = 1;

export function formatCostPerMillionTokens(costPerToken: unknown): string | undefined {
	const normalized = normalizeNonNegativeNumber(costPerToken);
	if (normalized === undefined) {
		return undefined;
	}
	return `$${(normalized * 1_000_000).toFixed(2)}/M`;
}

export function formatTokenPricing(inputCostPerToken: unknown, outputCostPerToken: unknown): string | undefined {
	const parts: string[] = [];
	const input = formatCostPerMillionTokens(inputCostPerToken);
	const output = formatCostPerMillionTokens(outputCostPerToken);

	if (input) {
		parts.push(`Input ${input}`);
	}
	if (output) {
		parts.push(`Output ${output}`);
	}

	return parts.length > 0 ? parts.join(", ") : undefined;
}

export function getHeaderCost(response: Response): unknown {
	const headers = (response as Response & { headers?: { get?: (name: string) => string | null } }).headers;
	return headers?.get?.("x-litellm-response-cost") ?? undefined;
}

function firstCostCandidate(values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null);
}

export class ResponseCostTracker {
	private _candidate?: CostCandidate;

	constructor(private readonly pricing: TokenPricing = {}) {}

	addHeaderCost(value: unknown): void {
		this.record(value, "header", false, HEADER_PRIORITY);
	}

	addStreamCost(value: unknown): void {
		this.record(value, "stream", false, STREAM_PRIORITY);
	}

	addUsage(usage: Record<string, unknown>): void {
		const explicitCost = firstCostCandidate([usage.response_cost, usage.cost, usage.total_cost]);
		if (explicitCost !== undefined) {
			this.addStreamCost(explicitCost);
			return;
		}

		const promptTokens = normalizeNonNegativeNumber(usage.prompt_tokens ?? usage.input_tokens);
		const completionTokens = normalizeNonNegativeNumber(usage.completion_tokens ?? usage.output_tokens);
		const inputCost = this.pricing.inputCostPerToken ?? 0;
		const outputCost = this.pricing.outputCostPerToken ?? 0;

		if (inputCost === 0 && outputCost === 0) {
			return;
		}

		let cost = 0;
		let hasBillableTokens = false;
		if (promptTokens !== undefined && inputCost > 0) {
			cost += promptTokens * inputCost;
			hasBillableTokens = true;
		}
		if (completionTokens !== undefined && outputCost > 0) {
			cost += completionTokens * outputCost;
			hasBillableTokens = true;
		}

		if (hasBillableTokens) {
			this.record(cost, "computed", true, COMPUTED_PRIORITY);
		}
	}

	addDelta(delta: Record<string, unknown>): void {
		const usage = delta.usage;
		if (usage && typeof usage === "object" && !Array.isArray(usage)) {
			this.addUsage(usage as Record<string, unknown>);
		}

		this.addStreamCost(
			firstCostCandidate([delta.response_cost, (delta as Record<string, unknown>)["x-litellm-response-cost"]])
		);
	}

	finalize(): FinalizedResponseCost | undefined {
		if (!this._candidate) {
			return undefined;
		}
		const { costUsd, source, estimated } = this._candidate;
		return { costUsd, source, estimated };
	}

	private record(value: unknown, source: FinalizedResponseCost["source"], estimated: boolean, priority: number): void {
		const costUsd = normalizeNonNegativeNumber(value);
		if (costUsd === undefined) {
			return;
		}
		if (!this._candidate || priority >= this._candidate.priority) {
			this._candidate = { costUsd, source, estimated, priority };
		}
	}
}
