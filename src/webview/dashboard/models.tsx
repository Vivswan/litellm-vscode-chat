import { useState } from "preact/hooks";
import type { DashboardModel } from "../../extension/dashboard/protocol";
import { Help } from "./help";
import { HELP_MODELS_SECTION } from "./helpText";

function formatTokens(count: number): string {
	return count.toLocaleString();
}

/**
 * A cost in dollars per million tokens, trimmed to three significant digits:
 * enough to compare models at a glance, and binary-fraction noise never
 * renders.
 */
function formatCost(cost: number): string {
	return `$${Number(cost.toPrecision(3))}`;
}

function formatPricing(model: DashboardModel): string {
	if (model.inputCost === undefined && model.outputCost === undefined) {
		return "-";
	}
	const parts: string[] = [];
	if (model.inputCost !== undefined) {
		parts.push(`${formatCost(model.inputCost)} in`);
	}
	if (model.outputCost !== undefined) {
		parts.push(`${formatCost(model.outputCost)} out`);
	}
	return parts.join(" / ");
}

function pricingTitle(model: DashboardModel): string {
	const parts: string[] = ["USD per million tokens"];
	if (model.cacheReadCost !== undefined) {
		parts.push(`cache read ${formatCost(model.cacheReadCost)}`);
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(`cache write ${formatCost(model.cacheWriteCost)}`);
	}
	const longContext: string[] = [];
	if (model.longContextInputCost !== undefined) {
		longContext.push(`${formatCost(model.longContextInputCost)} in`);
	}
	if (model.longContextOutputCost !== undefined) {
		longContext.push(`${formatCost(model.longContextOutputCost)} out`);
	}
	if (model.longContextCacheReadCost !== undefined) {
		longContext.push(`cache read ${formatCost(model.longContextCacheReadCost)}`);
	}
	if (model.longContextCacheWriteCost !== undefined) {
		longContext.push(`cache write ${formatCost(model.longContextCacheWriteCost)}`);
	}
	if (longContext.length > 0) {
		parts.push(`long-context tier: ${longContext.join(", ")}`);
	}
	return parts.join(", ");
}

/** The capabilities column at fleet scale: dimmed plain text, no chrome per cell. */
function capabilities(model: DashboardModel): string {
	const caps: string[] = [];
	if (model.toolCalling) {
		caps.push("tools");
	}
	if (model.imageInput) {
		caps.push("vision");
	}
	if (model.promptCaching) {
		caps.push("caching");
	}
	if (model.reasoning) {
		caps.push("reasoning");
	}
	return caps.join(", ");
}

function matches(model: DashboardModel, needle: string): boolean {
	return (
		model.name.toLowerCase().includes(needle) ||
		model.id.toLowerCase().includes(needle) ||
		model.family.toLowerCase().includes(needle) ||
		model.serverLabel.toLowerCase().includes(needle)
	);
}

export function ModelsSection({ models, serverCount }: { models: readonly DashboardModel[]; serverCount: number }) {
	const [filter, setFilter] = useState("");
	// Keyed to the server count, not the distinct labels: two groups can share
	// a label, and their models must stay attributable.
	const showServerColumn = serverCount > 1;
	const needle = filter.trim().toLowerCase();
	const visible = needle.length === 0 ? models : models.filter((model) => matches(model, needle));
	return (
		<section>
			<h2>
				Models <span class="count">{models.length}</span> <Help text={HELP_MODELS_SECTION} />
			</h2>
			{models.length === 0 ? (
				<p class="empty">No models discovered yet. Add a server above, then run Sync models.</p>
			) : (
				<>
					<div class="filterbar">
						<input
							type="text"
							placeholder="Filter by name, family, or server"
							aria-label="Filter models"
							value={filter}
							onInput={(event) => setFilter(event.currentTarget.value)}
						/>
						<span class="hint">
							showing {visible.length} of {models.length}
						</span>
					</div>
					<div class="table-scroll">
						<table>
							<thead>
								<tr>
									<th>Model</th>
									<th>Family</th>
									{showServerColumn ? <th>Server</th> : null}
									<th class="num">Input tokens</th>
									<th class="num">Output tokens</th>
									<th class="num">Pricing ($/M)</th>
									<th>Capabilities</th>
								</tr>
							</thead>
							<tbody>
								{visible.map((model, index) => (
									// Rows rebuild wholesale on every state push; the positional index is the identity.
									<tr key={index}>
										<td>{model.name}</td>
										<td>{model.family}</td>
										{showServerColumn ? <td>{model.serverLabel}</td> : null}
										<td class="num">{formatTokens(model.maxInputTokens)}</td>
										<td class="num">{formatTokens(model.maxOutputTokens)}</td>
										<td class="num" title={pricingTitle(model)}>
											{formatPricing(model)}
										</td>
										<td class="caps">{capabilities(model)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{visible.length === 0 ? <p class="empty">No models match the filter.</p> : null}
				</>
			)}
		</section>
	);
}
