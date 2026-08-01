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
import { HELP_PARAMS_INSPECTOR } from "./helpText";
import { SlideOver } from "./slideOver";

/** The Source column's naming: the layer that set the value plus its winning record key. */
function sourceName(ref: ParameterSourceRef, entryLabel: string): string {
	return ref.layer === "entry" ? `Server entry "${entryLabel}" - ${ref.key}` : `Settings - ${ref.key}`;
}

const SKIP_REASON_TEXT = {
	underscore: "not sent: keys starting with _ are reserved for extension metadata",
	"provider-owned": "not sent: a provider-owned request field, never overridable",
} as const;

/** The max_tokens derivation, one sentence per branch of the request path's fallback chain. */
function maxTokensText(maxTokens: ProjectedMaxTokens, entryLabel: string): string {
	switch (maxTokens.source) {
		case "configured":
			return maxTokens.configuredSource !== undefined
				? `max_tokens ${maxTokens.value} - set by ${sourceName(maxTokens.configuredSource, entryLabel)}`
				: `max_tokens ${maxTokens.value} - set in configuration`;
		case "declared":
			return `max_tokens ${maxTokens.value} - the server's declared output limit, sent as-is because nothing you configured sets max_tokens`;
		case "capped-default":
			return `max_tokens ${maxTokens.value} - min(${DEFAULT_MAX_TOKENS_CAP}, the model's max output tokens), because the output limit is a default, not server-declared`;
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
					{model.name} <Help text={HELP_PARAMS_INSPECTOR} name="About effective parameters" />
					<DocsLink href={DOCS_LINK_PARAMS_INSPECTOR} label="Open the effective-parameters guide" />
				</h3>
				<p class="hint params-identity">
					{model.rawId} on {model.serverLabel}
					{scope !== undefined ? ` (${scope.baseUrlScope})` : ""}
				</p>
				<p class="hint">
					Always sent: model, messages, stream, stream_options, max_tokens - and tools with tool_choice when the request
					carries tools. These are the extension's own fields; configuration cannot override them.
				</p>
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
					<p class="hint params-empty">
						No configured parameters match this model, so only the always-sent fields go out.
					</p>
				) : null}
				{projection.replacedUnscoped !== undefined ? (
					<div class="params-replaced">
						<p class="hint">
							Not applied: Settings - {projection.replacedUnscoped.key}. A server-scoped key matched, and a scoped match
							replaces the whole unscoped record, key collisions or not.
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
				<p class="params-max-tokens">{maxTokensText(projection.maxTokens, entryLabel)}</p>
				<div class="params-caveats">
					<p class="hint">
						Runtime options - what the chat client (Copilot, or another extension calling the model) sets on the request
						itself - override any forwarded parameter above and cannot be known ahead of the request.
					</p>
					{model.reasoning ? (
						<p class="hint">
							This model's Configure Model pick (reasoning effort) also overrides these rows for reasoning_effort. VS
							Code stores that pick on its side, so it cannot be shown here.
						</p>
					) : null}
				</div>
			</div>
		</SlideOver>
	);
}
