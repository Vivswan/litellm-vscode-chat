/**
 * The capability inspector: a read-only slide-over stating what one model can
 * do and where each fact came from. The paramsInspector's twin with one
 * structural difference: parameters project from data the state push already
 * carries, but capabilities resolve against extension-side stores (the server
 * baseline, the OpenRouter catalog), so this page is request/response-fed -
 * it posts readModelCapabilities on open and renders the
 * EffectiveCapabilities the extension resolves with the SAME walk
 * registration runs. No resolver logic and no catalog data live in the
 * webview; the answer is data.
 */

import * as l10n from "@vscode/l10n";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	CapabilityDiagnostic,
	CapabilityJsonValue,
	CapabilityLevel,
	DashboardModel,
	EffectiveCapabilities,
	EffectiveCapabilityField,
	ExtensionToWebviewMessage,
	ShadowedCapabilityValue,
} from "../../extension/dashboard/protocol";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
	capabilityField,
	FALLBACK_DIRECTIVE,
	formatCostPerMillion,
	isCostCapabilityField,
	parameterCountText,
} from "../../extension/dashboard/protocol";
import { DOCS_LINK_CAPS_INSPECTOR } from "./docsLinks";
import { DocsLink, Help, HoverTip } from "./help";
import { helpCapsInspector } from "./helpText";
import { formatTokens } from "./models";
import { RecordChainFigure } from "./recordChain";
import { SlideOver } from "./slideOver";
import { newRequestId, postMessage } from "./vscodeApi";

/** The latest modelCapabilities response; the inspector matches it against its own request ID. */
export type ModelCapabilitiesResponse = Extract<ExtensionToWebviewMessage, { type: "modelCapabilities" }>;

/**
 * The core fields in display order: the token trio, then the support flags.
 * The consumed booleans follow (CONSUMED_BOOLEAN_ORDER); pricing and the
 * params list get sections of their own, and every other field the resolution
 * carries (the vocabulary is open) renders under "Other fields", sorted by
 * key.
 */
const FIELD_ORDER: readonly string[] = [
	"context_length",
	"max_input_tokens",
	"max_output_tokens",
	"supports_function_calling",
	"supports_vision",
	"supports_reasoning",
	"supports_audio_input",
];

/** The consumed boolean flags beyond the core, in display order after it. */
const CONSUMED_BOOLEAN_ORDER: readonly string[] = [
	"supports_prompt_caching",
	"supports_pdf_input",
	"supports_response_schema",
];

/** The number fields that render as token counts; other numbers (costs aside) render plain. */
const TOKEN_FIELDS: ReadonlySet<string> = new Set(["context_length", "max_input_tokens", "max_output_tokens"]);

/**
 * Where the stylesheet's ellipsis can start clipping a value cell. The value
 * column is a FIXED 24% of the slide-over (html.ts), which is 680px wide but
 * shrinks to 94vw on narrow hosts: ~20ch of its monospace at full width,
 * ~9ch at a degenerate 360px window - the threshold sits at the practical
 * floor so any value the ellipsis could realistically touch carries the
 * focusable HoverTip (keyboards and assistive tech must reach the full text;
 * native title tooltips do not reliably render in the webview host, see
 * help.tsx). Short values (token counts, $/M prices, yes/no) stay plain text
 * outside the Tab order.
 */
const VALUE_CLIP_CH = 8;

/**
 * An approximate rendered width in ch: code points beyond Latin-1 (CJK,
 * emoji) count double, erring toward MORE tips - a wide-glyph value clips
 * well before its code-unit length reaches the ch box, and an ellipsized
 * value without the focusable tip would be unreachable without a pointer.
 */
function approxWidthCh(text: string): number {
	let width = 0;
	for (const ch of text) {
		width += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1;
	}
	return width;
}

/** One value cell: plain text while it surely fits, the focusable full-text tip once the ellipsis could clip it. */
function ValueCell({ text }: { text: string }) {
	return (
		<td class="param-value">
			{approxWidthCh(text) > VALUE_CLIP_CH ? (
				<HoverTip focusable tip={text}>
					<span class="param-value-clip">{text}</span>
				</HoverTip>
			) : (
				text
			)}
		</td>
	);
}

/**
 * One name cell: consumed fields render their localized labels
 * (capabilityDisplayLabel), wrapping at their spaces, with the wire key one
 * focusable tip away - the label hides the very identifier a
 * models.capabilities record needs, and cost keys are not guessable the way
 * supports_vision is. An open field renders its raw wire key in the
 * monospace register (it IS a settings key), breakable only at its
 * underscores via <wbr> so the fixed slide-over never shatters it into
 * arbitrary fragments.
 */
function FieldName({ name }: { name: string }) {
	const label = capabilityDisplayLabel(name);
	if (label !== undefined) {
		return (
			<HoverTip focusable tip={name}>
				<span>{label}</span>
			</HoverTip>
		);
	}
	const parts = name.split(/(?<=_)/);
	return (
		<code>
			{parts.map((part, index) =>
				index === 0 ? (
					part
				) : (
					// Underscore positions are stable within one render; the index is the identity.
					<Fragment key={index}>
						<wbr />
						{part}
					</Fragment>
				)
			)}
		</code>
	);
}

/**
 * One capability value as the table shows it: booleans as yes/no, the token
 * trio as token counts, the cost fields as dollars per million tokens (their
 * section header names the unit), the params list as its count (the full
 * list renders whole on its own row, see ParamsSection), other numbers
 * plain, and everything else (strings, arrays, objects - open fields carry
 * any JSON) as compact JSON, truncated by the stylesheet rather than
 * chopped here.
 */
function formatValue(name: string, value: CapabilityJsonValue): string {
	if (typeof value === "boolean") {
		return value ? l10n.t("yes") : l10n.t("no");
	}
	if (typeof value === "number") {
		if (isCostCapabilityField(name)) {
			return formatCostPerMillion(value);
		}
		return TOKEN_FIELDS.has(name) ? formatTokens(value) : String(value);
	}
	if (name === "supported_openai_params" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
		// The count alone: the winning list renders in full on its own row
		// (ParamsSection), one element per name so boundaries survive without
		// JSON quoting; shadowed lists stay count-only (their record holds the
		// value).
		return parameterCountText(value.length);
	}
	return JSON.stringify(value) ?? "";
}

/** The Source column's naming: the precedence level that set the value plus its winning key. */
function levelName(level: CapabilityLevel, key: string | undefined): string {
	switch (level) {
		case "entry":
			return l10n.t("Server entry - {0}", key ?? "");
		case "global":
			return l10n.t("Settings - {0}", key ?? "");
		case "directive":
			return l10n.t("OpenRouter catalog (via _openrouter_model {0})", key ?? "");
		case "server":
			return l10n.t("Server-reported");
		case "entry-fallback":
			return l10n.t("Server entry fallback - {0}", key ?? "");
		case "global-fallback":
			return l10n.t("Settings fallback - {0}", key ?? "");
		case "catalog":
			return l10n.t("OpenRouter catalog match {0}", key ?? "");
		case "derived":
			return l10n.t("Derived (context length minus output tokens)");
		case "floor":
			return l10n.t("Built-in default");
	}
}

function ShadowedLine({ name, shadow }: { name: string; shadow: ShadowedCapabilityValue }) {
	return (
		<tr class="param-shadowed">
			<td />
			<ValueCell text={formatValue(name, shadow.value)} />
			<td>{l10n.t("overridden: {0}", levelName(shadow.level, shadow.key))}</td>
		</tr>
	);
}

function FieldRow({
	name,
	field,
	onEditField,
	plainValue = false,
}: {
	name: string;
	field: EffectiveCapabilityField;
	/** The per-row jump to the record that owns the value; renders only on record-sourced rows. */
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
	/** Skip the clip-tip on the value cell; the full detail renders elsewhere (the params list row). */
	plainValue?: boolean;
}) {
	const editable =
		onEditField !== undefined &&
		field.key !== undefined &&
		(field.level === "entry" ||
			field.level === "global" ||
			field.level === "entry-fallback" ||
			field.level === "global-fallback");
	return (
		<>
			<tr>
				<td class="param-name">
					<FieldName name={name} />
				</td>
				{plainValue ? (
					<td class="param-value param-plain">{formatValue(name, field.value)}</td>
				) : (
					<ValueCell text={formatValue(name, field.value)} />
				)}
				<td>
					{levelName(field.level, field.key)}
					{editable ? (
						<button
							type="button"
							class="quiet row-edit"
							aria-label={l10n.t('Edit record "{0}"', field.key ?? "")}
							onClick={() => onEditField?.(field.level, field.key ?? "")}
						>
							{l10n.t("edit")}
						</button>
					) : null}
					{field.inheritedFrom !== undefined ? (
						<span class="param-skip"> ({l10n.t("inherited from {0}", field.inheritedFrom)})</span>
					) : null}
				</td>
			</tr>
			{field.shadowed.map((shadow) => (
				<ShadowedLine key={`${shadow.level}/${shadow.key ?? ""}`} name={name} shadow={shadow} />
			))}
		</>
	);
}

/** One record diagnostic as prose; classifications and the offending keys, never values. */
function diagnosticText(diagnostic: CapabilityDiagnostic): string {
	const where =
		diagnostic.layer === "entry"
			? l10n.t("server entry key {0}", diagnostic.recordKey)
			: l10n.t("settings key {0}", diagnostic.recordKey);
	switch (diagnostic.kind) {
		case "unrecognized-key":
			// Informational, not a problem: the field APPLIES as-is (open
			// vocabulary); the extension-side advisory filter already dropped
			// hints with no evidence behind them, so a surviving one only says
			// the key may be a typo.
			return l10n.t(
				'"{0}" is not a field this extension knows; it is applied as an override as-is ({1})',
				diagnostic.key,
				where
			);
		case "invalid-value":
			return l10n.t('"{0}" has an invalid value and is ignored ({1})', diagnostic.key, where);
		case "invalid-matcher":
			return l10n.t(
				'"{0}" is not a valid matcher key and never matches: use an exact ID, a trailing-* glob, /regex/, or "*" ({1})',
				diagnostic.key,
				where
			);
		case "wrong-record-type":
			return l10n.t('"{0}" belongs to parameters records and is ignored here ({1})', diagnostic.key, where);
		case "unknown-inherit-key":
			return l10n.t(
				'"_inherit_from" names "{0}", which is not a key of this record; the rest still applies ({1})',
				diagnostic.key,
				where
			);
		case "unforceable-key":
		case "invalid-directive":
			// `_fallback` gets its own copy: the same diagnostic covers a malformed
			// value and bad list entries (the valid ones still apply), so the
			// sentence names the rules without overclaiming.
			if (diagnostic.key === FALLBACK_DIRECTIVE) {
				return l10n.t(
					'"{0}" must be true or a list of fields the record sets, e.g. ["context_length"]; offending marks are ignored ({1})',
					diagnostic.key,
					where
				);
			}
			return l10n.t('"{0}" carries an invalid directive value and is ignored ({1})', diagnostic.key, where);
	}
}

function outputLimitNote(capabilities: EffectiveCapabilities): string {
	switch (capabilities.outputLimitSource) {
		case "user":
			return l10n.t("The output limit is user-set; requests send it uncapped.");
		case "provider":
			return l10n.t("The output limit is server-declared; requests send it uncapped.");
		case "defaults":
			return l10n.t("The output limit is a default; requests cap max_tokens at 4096.");
	}
}

/**
 * One provenance-table section: its own tbody, opened by a small muted header
 * band when labeled (scope="rowgroup": the header names the rows below it).
 * Renders nothing when the section has no fields, so headers never dangle
 * over empty sections.
 */
function CapsSection({
	label,
	names,
	fields,
	onEditField,
}: {
	label?: string | undefined;
	names: readonly string[];
	fields: EffectiveCapabilities["fields"];
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	if (names.length === 0) {
		return null;
	}
	return (
		<tbody>
			{label !== undefined ? (
				<tr class="caps-section">
					<th colSpan={3} scope="rowgroup">
						{label}
					</th>
				</tr>
			) : null}
			{names.map((name) => {
				const field = capabilityField(fields, name);
				return field === undefined ? null : <FieldRow key={name} name={name} field={field} onEditField={onEditField} />;
			})}
		</tbody>
	);
}

/**
 * The Supported parameters section: the standard provenance row carries the
 * count (plain, no clip-tip), and the winning list renders in full on a row
 * of its own spanning the table - the panel is the detail surface, so the
 * list never hides behind a tip. One element per name keeps boundaries
 * unambiguous without JSON quoting.
 */
function ParamsSection({
	fields,
	onEditField,
}: {
	fields: EffectiveCapabilities["fields"];
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const field = capabilityField(fields, "supported_openai_params");
	if (field === undefined) {
		return null;
	}
	const items = Array.isArray(field.value)
		? field.value.filter((item): item is string => typeof item === "string")
		: [];
	return (
		<tbody>
			<tr class="caps-section">
				<th colSpan={3} scope="rowgroup">
					{l10n.t("Supported parameters")}
				</th>
			</tr>
			<FieldRow name="supported_openai_params" field={field} onEditField={onEditField} plainValue />
			{items.length > 0 ? (
				<tr class="caps-params-row">
					<td colSpan={3}>
						<ul class="caps-params-list" aria-label={l10n.t("Supported parameters")}>
							{items.map((item) => (
								<li key={item}>
									<code>{item}</code>
								</li>
							))}
						</ul>
					</td>
				</tr>
			) : null}
		</tbody>
	);
}

/**
 * The inspector body once the response landed: the provenance table, the
 * directive outcome, and the diagnostics.
 */
function CapsBody({
	capabilities,
	declared,
	onEditField,
}: {
	capabilities: EffectiveCapabilities;
	declared: boolean;
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	// The section partition over the resolved bag: the capabilities (core order
	// plus the consumed booleans), the pricing fields (base tier then
	// long-context), the params list, and the open extras sorted by wire key
	// (code-unit order - these are wire identifiers, and locale collation would
	// reorder them per display language). Object.keys reads own properties
	// only, and the per-name reads go through capabilityField: a field named
	// "toString" must read from the bag, never from Object.prototype.
	const present = new Set(Object.keys(capabilities.fields));
	const capabilityNames = [...FIELD_ORDER, ...CONSUMED_BOOLEAN_ORDER].filter((name) => present.has(name));
	const pricingNames = COST_CAPABILITY_FIELDS.filter((name) => present.has(name));
	const paramsNames = present.has("supported_openai_params") ? ["supported_openai_params"] : [];
	const sectioned = new Set([...capabilityNames, ...pricingNames, ...paramsNames]);
	const extraNames = [...present].filter((name) => !sectioned.has(name)).sort();
	// The capabilities band is labeled only when another section renders beside
	// it; alone under the column header it would restate the table's own name.
	const sectionCount = [capabilityNames, pricingNames, paramsNames, extraNames].filter(
		(names) => names.length > 0
	).length;
	const advisories = capabilities.diagnostics.filter((diagnostic) => diagnostic.kind === "unrecognized-key");
	const problems = capabilities.diagnostics.filter((diagnostic) => diagnostic.kind !== "unrecognized-key");
	return (
		<>
			{declared ? (
				<p class="hint">
					{l10n.t("Declared model: created by the entry's declared list, not discovered on the server.")}
				</p>
			) : null}
			{capabilities.directive?.kind === "not-found" ? (
				<p class="state-warn" role="alert">
					{l10n.t(
						'OpenRouter model "{0}" was not found in the catalog; its fields fill from the remaining levels.',
						capabilities.directive.id
					)}
				</p>
			) : null}
			<table class="params">
				<thead>
					<tr>
						<th>{l10n.t("Capability")}</th>
						<th>{l10n.t("Value")}</th>
						<th>{l10n.t("Source")}</th>
					</tr>
				</thead>
				{sectionCount > 1 ? (
					<CapsSection
						label={l10n.t("Capabilities")}
						names={capabilityNames}
						fields={capabilities.fields}
						onEditField={onEditField}
					/>
				) : (
					<CapsSection names={capabilityNames} fields={capabilities.fields} onEditField={onEditField} />
				)}
				<CapsSection
					label={l10n.t({
						message: "Pricing ($/M tokens)",
						comment: ["Section header; $/M is US dollars per million tokens"],
					})}
					names={pricingNames}
					fields={capabilities.fields}
					onEditField={onEditField}
				/>
				<ParamsSection fields={capabilities.fields} onEditField={onEditField} />
				<CapsSection
					label={l10n.t("Other fields")}
					names={extraNames}
					fields={capabilities.fields}
					onEditField={onEditField}
				/>
			</table>
			<p class="params-max-tokens">
				<span class="hint">{outputLimitNote(capabilities)}</span>
			</p>
			{problems.length > 0 ? (
				<div class="params-replaced">
					<p class="hint">{l10n.t("Configuration problems in the matched records:")}</p>
					<ul>
						{problems.map((diagnostic) => (
							<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.key}`}>
								{diagnosticText(diagnostic)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{advisories.length > 0 ? (
				<div class="params-replaced params-advisories">
					<p class="hint">{l10n.t("Notes on the matched records:")}</p>
					<ul>
						{advisories.map((diagnostic) => (
							<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.key}`} class="hint">
								{diagnosticText(diagnostic)}
							</li>
						))}
					</ul>
				</div>
			) : null}
		</>
	);
}

export function CapsInspector({
	model,
	response,
	stateSeq,
	fallbackFocusId = "models-section",
	onClose,
	onEditRecord,
	onEditEntry,
}: {
	model: DashboardModel;
	/** The latest modelCapabilities response App holds; matched against this inspector's own requestId. */
	response: ModelCapabilitiesResponse | undefined;
	/** Bumped on every state push; the inspector re-requests so an open panel follows configuration edits. */
	stateSeq: number;
	/** Where focus lands on close when the opener is gone; the overlay's owner names a visible element (the active tab). */
	fallbackFocusId?: string;
	onClose: () => void;
	/** Jump into the global capabilities editor: focus record `key`, or create an exact-ID draft when `create`. */
	onEditRecord?: ((key: string, create: boolean) => void) | undefined;
	/** Jump into a server entry's edit form (the owner of entry-layer values). */
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	const [requestId, setRequestId] = useState<string | undefined>(undefined);

	// One request per inspected model AND per state push: a configuration or
	// discovery change re-pushes state, and an open inspector must follow the
	// fresh resolution instead of showing pre-edit values; a stale response is
	// ignored by its requestId.
	const { scopeKey, rawId } = model;
	useEffect(() => {
		const id = newRequestId();
		setRequestId(id);
		postMessage({ type: "readModelCapabilities", scopeKey, rawId, requestId: id });
	}, [scopeKey, rawId, stateSeq]);

	const answered = requestId !== undefined && response?.requestId === requestId ? response : undefined;
	// The per-row jump: an entry-level value is owned by the server entry's own
	// record (edited in its form; entry records apply only when labels align,
	// so the group's label addresses the entry), a global one by the settings
	// record named in the row.
	const editField =
		onEditRecord === undefined
			? undefined
			: (level: CapabilityLevel, key: string) => {
					if (level === "entry" || level === "entry-fallback") {
						onEditEntry?.(model.serverLabel);
					} else {
						onEditRecord(key, false);
					}
				};
	return (
		<SlideOver
			labelledBy="caps-inspector-title"
			fallbackFocusId={fallbackFocusId}
			confirming={false}
			onRequestClose={onClose}
			onKeepEditing={onClose}
			onDiscard={onClose}
		>
			<div class="params-inspector caps-inspector">
				<h3 id="caps-inspector-title">
					{model.name} <Help text={helpCapsInspector()} name={l10n.t("About effective capabilities")} />{" "}
					<DocsLink href={DOCS_LINK_CAPS_INSPECTOR} label={l10n.t("Open the effective-capabilities guide")} />
				</h3>
				<p class="hint params-identity">
					{l10n.t({
						message: "{0} on {1}",
						args: [model.rawId, model.serverLabel],
						comment: ["{0} is a model ID, {1} is the server it is served from"],
					})}
				</p>
				<RecordChainFigure
					chains={answered?.chains}
					onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord(key, false)}
					onEditEntry={onEditEntry}
				/>
				{onEditRecord !== undefined ? (
					<p class="params-configure">
						<button
							type="button"
							class="secondary"
							disabled={answered === undefined}
							onClick={() => {
								// Reuse the most specific matching global record when one
								// exists; otherwise a fresh draft keyed by the exact model ID.
								const key = answered?.globalRecordKey;
								if (key !== undefined) {
									onEditRecord(key, false);
								} else {
									onEditRecord(model.rawId, true);
								}
							}}
						>
							{l10n.t("Configure capabilities for this model")}
						</button>
					</p>
				) : null}
				{answered === undefined ? (
					<p class="hint" role="status">
						{l10n.t("Resolving capabilities...")}
					</p>
				) : answered.capabilities === undefined ? (
					<p class="hint" role="status">
						{l10n.t("The model list changed; close and reopen the inspector.")}
					</p>
				) : (
					<CapsBody capabilities={answered.capabilities} declared={model.declared === true} onEditField={editField} />
				)}
			</div>
		</SlideOver>
	);
}
