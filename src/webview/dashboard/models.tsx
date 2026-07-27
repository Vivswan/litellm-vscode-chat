import type { DashboardModel } from "../../extension/dashboard/protocol";

function formatTokens(count: number): string {
	return count.toLocaleString();
}

function formatPricing(model: DashboardModel): string {
	if (model.inputCost === undefined && model.outputCost === undefined) {
		return "";
	}
	const parts: string[] = [];
	if (model.inputCost !== undefined) {
		parts.push(`$${model.inputCost} in`);
	}
	if (model.outputCost !== undefined) {
		parts.push(`$${model.outputCost} out`);
	}
	return parts.join(" / ");
}

function pricingTitle(model: DashboardModel): string {
	const parts: string[] = ["USD per million tokens"];
	if (model.cacheReadCost !== undefined) {
		parts.push(`cache read $${model.cacheReadCost}`);
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(`cache write $${model.cacheWriteCost}`);
	}
	return parts.join(", ");
}

function Badges({ model }: { model: DashboardModel }) {
	return (
		<span>
			{model.toolCalling ? <span class="badge">tools</span> : null}
			{model.imageInput ? <span class="badge">vision</span> : null}
			{model.promptCaching ? <span class="badge">caching</span> : null}
			{model.reasoning ? <span class="badge">reasoning</span> : null}
		</span>
	);
}

export function ModelsSection({ models, serverCount }: { models: readonly DashboardModel[]; serverCount: number }) {
	// Keyed to the server count, not the distinct labels: two groups can share
	// a label, and their models must stay attributable.
	const showServerColumn = serverCount > 1;
	return (
		<section>
			<h2>Models ({models.length})</h2>
			{models.length === 0 ? (
				<p class="empty">No models discovered yet. Run Sync Models Now once a server is configured.</p>
			) : (
				<table>
					<thead>
						<tr>
							<th>Model</th>
							<th>Family</th>
							{showServerColumn ? <th>Server</th> : null}
							<th class="num">Input tokens</th>
							<th class="num">Output tokens</th>
							<th>Pricing ($/M)</th>
							<th>Capabilities</th>
						</tr>
					</thead>
					<tbody>
						{models.map((model, index) => (
							// Rows rebuild wholesale on every state push; the positional index is the identity.
							<tr key={index}>
								<td>{model.name}</td>
								<td>{model.family}</td>
								{showServerColumn ? <td>{model.serverLabel}</td> : null}
								<td class="num">{formatTokens(model.maxInputTokens)}</td>
								<td class="num">{formatTokens(model.maxOutputTokens)}</td>
								<td title={pricingTitle(model)}>{formatPricing(model)}</td>
								<td>
									<Badges model={model} />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}
