/**
 * The effective-values inspector: a read-only slide-over stating what one
 * request to a model would carry. Everything here renders from the same pure
 * resolution the request path runs (projectEffectiveParameters, re-exported
 * through the protocol module), so the table cannot drift from the wire; the
 * two things a request adds that this page cannot know - runtime options and
 * the host-stored picker configuration - render as explicit caveats instead
 * of silent omissions.
 */

import * as l10n from "@vscode/l10n";
import type {
	DashboardModel,
	EffectiveParameterRow,
	ModelParametersRecord,
	ParameterDiagnostic,
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
		parts.push(
			l10n.t({
				message: "read {0}",
				args: [formatCost(model.cacheReadCost)],
				comment: ["cache read price; {0} is a dollar amount"],
			})
		);
	}
	if (model.cacheWriteCost !== undefined) {
		parts.push(
			l10n.t({
				message: "write {0}",
				args: [formatCost(model.cacheWriteCost)],
				comment: ["cache write price; {0} is a dollar amount"],
			})
		);
	}
	return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** The long-context pricing tier, only when it differs from the base price. */
function longContextPricing(model: DashboardModel): string | undefined {
	const parts: string[] = [];
	if (model.longContextInputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} in",
				args: [formatCost(model.longContextInputCost)],
				comment: ["price per million input tokens; {0} is a dollar amount"],
			})
		);
	}
	if (model.longContextOutputCost !== undefined) {
		parts.push(
			l10n.t({
				message: "{0} out",
				args: [formatCost(model.longContextOutputCost)],
				comment: ["price per million output tokens; {0} is a dollar amount"],
			})
		);
	}
	if (model.longContextCacheReadCost !== undefined) {
		parts.push(l10n.t("cache read {0}", formatCost(model.longContextCacheReadCost)));
	}
	if (model.longContextCacheWriteCost !== undefined) {
		parts.push(l10n.t("cache write {0}", formatCost(model.longContextCacheWriteCost)));
	}
	return parts.length > 0 ? parts.join(" / ") : undefined;
}

/** The Source column's naming: the layer that set the value plus its winning record key. */
function sourceName(ref: ParameterSourceRef, entryLabel: string): string {
	return ref.layer === "entry"
		? l10n.t('Server entry "{0}" - {1}', entryLabel, ref.key)
		: l10n.t("Settings - {0}", ref.key);
}

/** The not-sent annotations, resolved at call time (no module-level localized constants). */
function skipReasonText(reason: "underscore" | "provider-owned"): string {
	return reason === "underscore"
		? l10n.t("not sent: keys starting with _ are reserved for extension metadata")
		: l10n.t("not sent: a provider-owned request field, never overridable");
}

/**
 * One `_force` problem as prose, the capability inspector's diagnostics idiom:
 * classifications and the offending keys, never values.
 */
function parameterDiagnosticText(diagnostic: ParameterDiagnostic): string {
	const where =
		diagnostic.layer === "entry"
			? l10n.t("server entry key {0}", diagnostic.recordKey)
			: l10n.t("settings key {0}", diagnostic.recordKey);
	if (diagnostic.kind === "unforceable-key") {
		return l10n.t(
			'"{0}" cannot be forced and its mark is skipped: provider-owned fields and _ keys stay extension-owned ({1})',
			diagnostic.key,
			where
		);
	}
	// Deliberately "offending entries", not "ignored": the resolver salvages
	// the valid names of a partly bad list, so those fields stay forced.
	return l10n.t(
		'"{0}" must be true or a list of parameters the record sets, e.g. ["temperature"]; offending entries are ignored ({1})',
		diagnostic.key,
		where
	);
}

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
						? l10n.t("set by {0}", sourceName(maxTokens.configuredSource, entryLabel))
						: l10n.t("set in configuration"),
			};
		case "declared":
			return {
				value: maxTokens.value,
				reason: l10n.t("the server's declared output limit (nothing configured sets it)"),
			};
		case "capped-default":
			return {
				value: maxTokens.value,
				reason: l10n.t("min({0}, model max) - the limit is a default, not server-declared", DEFAULT_MAX_TOKENS_CAP),
			};
	}
}

function ShadowedLine({ shadow, entryLabel }: { shadow: ShadowedParameterValue; entryLabel: string }) {
	return (
		<tr class="param-shadowed">
			<td />
			<td class="param-value">{formatJsonValue(shadow.value)}</td>
			<td>{l10n.t("overridden: {0}", sourceName(shadow, entryLabel))}</td>
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
					{row.skipReason !== undefined ? <span class="param-skip"> ({skipReasonText(row.skipReason)})</span> : null}
					{row.forced === true ? (
						<span class="param-skip"> ({l10n.t("forced: overrides runtime options and the picker")})</span>
					) : null}
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
					{model.name} <Help text={helpParamsInspector()} name={l10n.t("About effective parameters")} />
					<DocsLink href={DOCS_LINK_PARAMS_INSPECTOR} label={l10n.t("Open the effective-parameters guide")} />
				</h3>
				<p class="hint params-identity">
					{l10n.t({
						message: "{0} on {1}",
						args: [model.rawId, model.serverLabel],
						comment: ["{0} is a model ID, {1} is the server it is served from"],
					})}
					{scope !== undefined ? ` (${scope.baseUrlScope})` : ""}
				</p>
				<dl class="model-facts">
					<Fact label={l10n.t("Family")} value={model.family} />
					<Fact label={l10n.t("Capabilities")} value={capabilities(model) || l10n.t("none declared")} />
					<Fact label={l10n.t("Input tokens")} value={formatTokens(model.maxInputTokens)} />
					<Fact
						label={l10n.t("Output tokens")}
						value={
							model.outputLimitDeclared
								? formatTokens(model.maxOutputTokens)
								: l10n.t("{0} (default, not server-declared)", formatTokens(model.maxOutputTokens))
						}
					/>
					<Fact label={l10n.t("Pricing ($/M)")} value={formatPricing(model)} />
					{cachePricing(model) !== undefined ? (
						<Fact label={l10n.t("Cache ($/M)")} value={cachePricing(model) as string} />
					) : null}
					{longContextPricing(model) !== undefined ? (
						<Fact label={l10n.t("Long context ($/M)")} value={longContextPricing(model) as string} />
					) : null}
				</dl>
				<div class="params-fixed">
					<span class="params-caveat-label">{l10n.t("Always sent")}</span>
					{ALWAYS_SENT_FIELDS.map((field) => (
						<code key={field}>{field}</code>
					))}
					<span class="hint">{l10n.t("+ tools, tool_choice with tools; not overridable")}</span>
				</div>
				{projection.rows.length > 0 ? (
					<table class="params">
						<thead>
							<tr>
								<th>{l10n.t("Parameter")}</th>
								<th>{l10n.t("Value")}</th>
								<th>{l10n.t("Source")}</th>
							</tr>
						</thead>
						<tbody>
							{projection.rows.map((row) => (
								<ParameterRow key={row.name} row={row} entryLabel={entryLabel} />
							))}
						</tbody>
					</table>
				) : empty ? (
					<p class="hint params-empty">{l10n.t("No configured parameters match this model.")}</p>
				) : null}
				{projection.replacedUnscoped !== undefined ? (
					<div class="params-replaced">
						<p class="hint">
							{l10n.t(
								"Not applied - Settings {0}: a server-scoped match replaces the whole unscoped record.",
								projection.replacedUnscoped.key
							)}
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
				{projection.diagnostics.length > 0 ? (
					<div class="params-replaced">
						<p class="hint">{l10n.t("Configuration problems in the matched records:")}</p>
						<ul>
							{projection.diagnostics.map((diagnostic) => (
								<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.kind}/${diagnostic.key}`}>
									{parameterDiagnosticText(diagnostic)}
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
						<dt class="params-caveat-label">{l10n.t("Runtime options")}</dt>
						<dd class="hint">
							{projection.rows.some((row) => row.forced === true)
								? l10n.t("Set per request by the chat client; they override every row above except forced rows.")
								: l10n.t("Set per request by the chat client; they override every row above.")}
						</dd>
					</div>
					{model.reasoning ? (
						<div>
							<dt class="params-caveat-label">{l10n.t("Picker: reasoning effort")}</dt>
							<dd class="hint">
								{l10n.t("Chosen in Configure Model and stored by VS Code; overrides reasoning_effort here.")}
							</dd>
						</div>
					) : null}
				</dl>
			</div>
		</SlideOver>
	);
}
