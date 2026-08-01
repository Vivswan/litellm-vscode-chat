/**
 * The effective-values inspector: a read-only slide-over stating what one
 * request to a model would carry. Everything here renders from the same pure
 * resolution the request path runs (projectEffectiveParameters, re-exported
 * through the protocol module), so the table cannot drift from the wire; the
 * two things a request adds that this page cannot know - runtime options and
 * the host-stored picker configuration - render as explicit caveats instead
 * of silent omissions.
 */

import type {
	DashboardModel,
	EffectiveParameterRow,
	ModelParametersRecord,
	ParameterSourceRef,
	ProjectedMaxTokens,
	RequestScope,
	ShadowedParameterValue,
} from "../../extension/dashboard/protocol";
import {
	DEFAULT_MAX_TOKENS_CAP,
	formatJsonValue,
	projectEffectiveParameters,
} from "../../extension/dashboard/protocol";
import { DOCS_LINK_PARAMS_INSPECTOR } from "./docsLinks";
import { DocsLink, Help } from "./help";
import { helpParamsInspector } from "./helpText";
import { capabilities, formatCost, formatPricing, formatTokens } from "./models";
import { SlideOver } from "./slideOver";

/** One row of the model-facts grid; rows with nothing to say do not render. */
function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt class="params-caveat-label">{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

/** Cache pricing as its own fact line, only when the model declares any. */
function cachePricing(model: DashboardModel): string | undefined {
	const parts: string[] = [];
	if (model.cacheReadCost !== undefined) {
		parts.push(`read ${formatCost(model.cacheReadCost)}`);
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(`write ${formatCost(model.cacheWriteCost)}`);
	}
	return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** The long-context pricing tier, only when it differs from the base price. */
function longContextPricing(model: DashboardModel): string | undefined {
	const parts: string[] = [];
	if (model.longContextInputCost !== undefined) {
		parts.push(`${formatCost(model.longContextInputCost)} in`);
	}
	if (model.longContextOutputCost !== undefined) {
		parts.push(`${formatCost(model.longContextOutputCost)} out`);
	}
	if (model.longContextCacheReadCost !== undefined) {
		parts.push(`cache read ${formatCost(model.longContextCacheReadCost)}`);
	}
	if (model.longContextCacheWriteCost !== undefined) {
		parts.push(`cache write ${formatCost(model.longContextCacheWriteCost)}`);
	}
	return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** The Source column's naming: the layer that set the value plus its winning record key. */
function sourceName(ref: ParameterSourceRef, entryLabel: string): string {
	return ref.layer === "entry" ? `Server entry "${entryLabel}" - ${ref.key}` : `Settings - ${ref.key}`;
}

const SKIP_REASON_TEXT = {
	underscore: "not sent: keys starting with _ are reserved for extension metadata",
	"provider-owned": "not sent: a provider-owned request field, never overridable",
} as const;

/** The request fields the extension itself owns; rendered as chips, never prose. */
const ALWAYS_SENT_FIELDS = ["model", "messages", "stream", "stream_options", "max_tokens"] as const;

/** The max_tokens derivation, split into the value and one short reason per branch. */
function maxTokensParts(maxTokens: ProjectedMaxTokens, entryLabel: string): { value: number; reason: string } {
	switch (maxTokens.source) {
		case "configured":
			return {
				value: maxTokens.value,
				reason:
					maxTokens.configuredSource !== undefined
						? `set by ${sourceName(maxTokens.configuredSource, entryLabel)}`
						: "set in configuration",
			};
		case "declared":
			return { value: maxTokens.value, reason: "the server's declared output limit (nothing configured sets it)" };
		case "capped-default":
			return {
				value: maxTokens.value,
				reason: `min(${DEFAULT_MAX_TOKENS_CAP}, model max) - the limit is a default, not server-declared`,
			};
	}
}

function ShadowedLine({ shadow, entryLabel }: { shadow: ShadowedParameterValue; entryLabel: string }) {
	return (
		<tr class="param-shadowed">
			<td />
			<td class="param-value">{formatJsonValue(shadow.value)}</td>
			<td>overridden: {sourceName(shadow, entryLabel)}</td>
		</tr>
	);
}

function ParameterRow({ row, entryLabel }: { row: EffectiveParameterRow; entryLabel: string }) {
	return (
		<>
			<tr class={row.sent ? undefined : "param-not-sent"}>
				<td class="param-name">{row.name}</td>
				<td class="param-value">{formatJsonValue(row.value)}</td>
				<td>
					{sourceName(row.source, entryLabel)}
					{row.skipReason !== undefined ? <span class="param-skip"> ({SKIP_REASON_TEXT[row.skipReason]})</span> : null}
				</td>
			</tr>
			{row.shadowed.map((shadow) => (
				<ShadowedLine key={`${shadow.layer}/${shadow.key}`} shadow={shadow} entryLabel={entryLabel} />
			))}
		</>
	);
}

export function ParamsInspector({
	model,
	scope,
	globalParameters,
	onClose,
}: {
	model: DashboardModel;
	/** The model's request scope from DashboardState.requestScopes; undefined only on a malformed push. */
	scope: RequestScope | undefined;
	/** The scope-merged modelParameters setting, as the request path reads it. */
	globalParameters: ModelParametersRecord;
	onClose: () => void;
}) {
	const projection = projectEffectiveParameters({
		rawModelId: model.rawId,
		globalParameters,
		serverScopes: scope !== undefined ? [scope.baseUrlScope] : [],
		entryParameters: scope?.entryParameters,
		maxOutputTokens: model.maxOutputTokens,
		outputLimitDeclared: model.outputLimitDeclared,
	});
	// Entry-layer rows exist only when the scope resolved a declared entry, so
	// the fallback label can never actually render; it satisfies the types.
	const entryLabel = scope?.entryLabel ?? model.serverLabel;
	// A configured max_tokens is real configuration even though it renders on
	// the derivation line instead of as a row, so it defeats the empty state.
	const empty =
		projection.rows.length === 0 &&
		projection.replacedUnscoped === undefined &&
		projection.maxTokens.source !== "configured";

	return (
		<SlideOver
			labelledBy="params-inspector-title"
			fallbackFocusId="models-section"
			confirming={false}
			onRequestClose={onClose}
			onKeepEditing={onClose}
			onDiscard={onClose}
		>
			<div class="params-inspector">
				<h3 id="params-inspector-title">
					{model.name} <Help text={helpParamsInspector()} name="About effective parameters" />
					<DocsLink href={DOCS_LINK_PARAMS_INSPECTOR} label="Open the effective-parameters guide" />
				</h3>
				<p class="hint params-identity">
					{model.rawId} on {model.serverLabel}
					{scope !== undefined ? ` (${scope.baseUrlScope})` : ""}
				</p>
				<dl class="model-facts">
					<Fact label="Family" value={model.family} />
					<Fact label="Capabilities" value={capabilities(model) || "none declared"} />
					<Fact label="Input tokens" value={formatTokens(model.maxInputTokens)} />
					<Fact
						label="Output tokens"
						value={`${formatTokens(model.maxOutputTokens)}${model.outputLimitDeclared ? "" : " (default, not server-declared)"}`}
					/>
					<Fact label="Pricing ($/M)" value={formatPricing(model)} />
					{cachePricing(model) !== undefined ? (
						<Fact label="Cache ($/M)" value={cachePricing(model) as string} />
					) : null}
					{longContextPricing(model) !== undefined ? (
						<Fact label="Long context ($/M)" value={longContextPricing(model) as string} />
					) : null}
				</dl>
				<div class="params-fixed">
					<span class="params-caveat-label">Always sent</span>
					{ALWAYS_SENT_FIELDS.map((field) => (
						<code key={field}>{field}</code>
					))}
					<span class="hint">+ tools, tool_choice with tools; not overridable</span>
				</div>
				{projection.rows.length > 0 ? (
					<table class="params">
						<thead>
							<tr>
								<th>Parameter</th>
								<th>Value</th>
								<th>Source</th>
							</tr>
						</thead>
						<tbody>
							{projection.rows.map((row) => (
								<ParameterRow key={row.name} row={row} entryLabel={entryLabel} />
							))}
						</tbody>
					</table>
				) : empty ? (
					<p class="hint params-empty">No configured parameters match this model.</p>
				) : null}
				{projection.replacedUnscoped !== undefined ? (
					<div class="params-replaced">
						<p class="hint">
							Not applied - Settings {projection.replacedUnscoped.key}: a server-scoped match replaces the whole
							unscoped record.
						</p>
						<ul>
							{Object.entries(projection.replacedUnscoped.record).map(([name, value]) => (
								<li key={name}>
									{name}: {formatJsonValue(value)}
								</li>
							))}
						</ul>
					</div>
				) : null}
				<p class="params-max-tokens">
					<code>max_tokens {maxTokensParts(projection.maxTokens, entryLabel).value}</code>
					<span class="hint"> {maxTokensParts(projection.maxTokens, entryLabel).reason}</span>
				</p>
				<dl class="params-caveats">
					<div>
						<dt class="params-caveat-label">Runtime options</dt>
						<dd class="hint">Set per request by the chat client; they override every row above.</dd>
					</div>
					{model.reasoning ? (
						<div>
							<dt class="params-caveat-label">Picker: reasoning effort</dt>
							<dd class="hint">Chosen in Configure Model and stored by VS Code; overrides reasoning_effort here.</dd>
						</div>
					) : null}
				</dl>
			</div>
		</SlideOver>
	);
}
