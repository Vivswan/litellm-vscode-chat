/**
 * The model inspector: ONE read-only slide-over per model row, sectioned Parameters /
 * Capabilities / Pricing, request/response-fed (readModelParameters and
 * readModelCapabilities, re-posted per state push) - the extension resolves both through
 * the SAME machinery the request path and registration read, so nothing can drift from
 * the wire; no resolver logic or catalog data live in the webview. Every resolved field
 * renders as a RESOLUTION CHAIN: the winner at full strength, beaten values struck out
 * beneath it (a loser must not read - or announce - as a peer), each line carrying one
 * neutral badge (provenance is not severity; the two must never share a color).
 * Sections never collapse; the supported-parameters list stays a CAPABILITY on the wire
 * but renders in Parameters - what the model accepts belongs next to what we send.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef } from "react";
import type { ResponseFor } from "../../dashboard/endpoints";
import { capabilityList } from "../../dashboard/modelFilters";
import { formatJsonValue } from "../../dashboard/presenters";
import type { DashboardModel } from "../../dashboard/viewModels";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
	costUnitLabel,
	formatCostPerMillion,
	isCostCapabilityField,
	parameterCountText,
} from "../../shared/config/capabilityDisplay";
import type {
	CapabilityDiagnostic,
	CapabilityJsonValue,
	CapabilityLevel,
	EffectiveCapabilities,
	EffectiveCapabilityField,
	ShadowedCapabilityValue,
} from "../../shared/config/capabilityResolution";
import { capabilityField } from "../../shared/config/capabilityResolution";
import type {
	EffectiveParameterRow,
	ParameterDiagnostic,
	ParameterSourceRef,
	ProjectedMaxTokens,
	ShadowedParameterValue,
} from "../../shared/config/parameterResolution";
import { DEFAULT_MAX_TOKENS_CAP } from "../../shared/config/parameterResolution";
import { FALLBACK_DIRECTIVE, OPENROUTER_MODEL_DIRECTIVE } from "../../shared/config/recordResolution";
import { DOCS_LINK_CAPS_INSPECTOR, DOCS_LINK_PARAMS_INSPECTOR } from "./docsLinks";
import { HoverTip } from "./help";
import { helpCapsInspector, helpParamsInspector } from "./helpText";
import { useRpc } from "./hooks";
import { formatTokens } from "./models";
import type { MarkView, ProvenanceView } from "./provenance";
import {
	approxWidthCh,
	entryScope,
	fallbackWord,
	forceWord,
	inheritedWord,
	Mark,
	Provenance,
	serverScope,
	settingsScope,
} from "./provenance";
import { RecordChainFigure } from "./recordChain";
import { SlideOver } from "./slideOver";
import { AbsentDatum } from "./ui/absent";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Section } from "./ui/section";

/** The readModelParameters answer; the inspector's own useRpc instance correlates it. */
export type ModelParametersResponse = ResponseFor<"readModelParameters">;

/** The readModelCapabilities answer; the inspector's own useRpc instance correlates it. */
export type ModelCapabilitiesResponse = ResponseFor<"readModelCapabilities">;

/** The panel's addressable sections; the Diagnostics table's jump links land on one. */
export type InspectorSection = "params" | "caps";

/** The section element ids the anchors land on; Section derives them from its own id. */
const SECTION_ELEMENT_ID: Record<InspectorSection, string> = {
	params: "inspector-params-section",
	caps: "inspector-caps-section",
};

/** The parameter layers as a badge: the scope that set the value plus its winning record key. */
function parameterProvenance(ref: ParameterSourceRef): ProvenanceView {
	return { scope: ref.layer === "entry" ? entryScope() : settingsScope(), recordKey: ref.key };
}

/**
 * The capability walk's levels as a badge plus, where a directive did the work, its
 * mark: a `_fallback` fill is a record wearing a directive, not a level of its own, so
 * the badge names the source and the mark names the directive.
 */
function capabilityProvenance(
	level: CapabilityLevel,
	key: string | undefined
): { readonly source: ProvenanceView; readonly mark?: MarkView } {
	switch (level) {
		case "entry":
			return { source: { scope: entryScope(), recordKey: key } };
		case "global":
			return { source: { scope: settingsScope(), recordKey: key } };
		// The one mark that INVERTS the badge: an ordinary entry or settings
		// record beats the server's report, a `_fallback` fill loses to it. The
		// word cannot carry that, so the sentence rides its tip.
		case "entry-fallback":
			return { source: { scope: entryScope(), recordKey: key }, mark: fallbackMark() };
		case "global-fallback":
			return { source: { scope: settingsScope(), recordKey: key }, mark: fallbackMark() };
		case "server":
			return { source: { scope: serverScope() } };
		// The two catalog marks say exactly how the level was chosen, so neither carries a tip:
		// a tip here would be one Tab stop per row repeating identical text, and every field of
		// a server that reports nothing can land on these levels at once.
		case "directive":
			return {
				source: { scope: "OpenRouter", recordKey: key },
				mark: { word: OPENROUTER_MODEL_DIRECTIVE, mono: true },
			};
		case "catalog":
			return {
				source: { scope: "OpenRouter", recordKey: key },
				mark: {
					word: l10n.t({ message: "matched", comment: ["Directive mark: the catalog entry was matched, not named"] }),
				},
			};
		case "derived":
			return {
				source: {
					// Bare t(), matching the Diagnostics tree's own "derived".
					scope: l10n.t("derived"),
					tip: l10n.t("Context length minus max output tokens: nothing declared this field directly."),
				},
			};
		case "floor":
			return {
				source: {
					scope: l10n.t({
						message: "built-in default",
						comment: ["Provenance badge: nothing declared the field, so the extension's own floor applies"],
					}),
				},
			};
	}
}

/** The `_fallback` mark and the precedence rule the word alone cannot state. */
function fallbackMark(): MarkView {
	return {
		word: fallbackWord(),
		detail: l10n.t(
			"Fills the field only where the server reported nothing; the server's own value wins when it has one."
		),
	};
}

/** The not-sent annotations, resolved at call time (no module-level localized constants). */
function skipReasonText(reason: "underscore" | "provider-owned"): string {
	return reason === "underscore"
		? l10n.t("Keys starting with _ are directives - instructions to the extension, never sent.")
		: l10n.t("A provider-owned request field: the extension owns it and never sends an override.");
}

/**
 * One parameter-record problem as prose, the capability side's diagnostics
 * idiom: classifications and the offending keys, never values.
 */
function parameterDiagnosticText(diagnostic: ParameterDiagnostic): string {
	const where =
		diagnostic.layer === "entry"
			? l10n.t("server entry key {0}", diagnostic.recordKey)
			: l10n.t("settings key {0}", diagnostic.recordKey);
	switch (diagnostic.kind) {
		case "unforceable-key":
			return l10n.t(
				'"{0}" cannot be forced and its mark is skipped: provider-owned fields and _ keys stay extension-owned ({1})',
				diagnostic.key,
				where
			);
		case "invalid-matcher":
			return l10n.t(
				'"{0}" is not a valid matcher key and never matches: use an exact ID, a trailing-* glob, /regex/, or "*" ({1})',
				diagnostic.key,
				where
			);
		case "wrong-record-type":
			return l10n.t('"{0}" belongs to capability records and is ignored here ({1})', diagnostic.key, where);
		case "unknown-inherit-key":
			return l10n.t(
				'"_inherit_from" names "{0}", which is not a key of this record; the rest still applies ({1})',
				diagnostic.key,
				where
			);
		default:
			// Deliberately "offending entries", not "ignored": the resolver
			// salvages the valid names of a partly bad list, so those stay applied.
			return l10n.t(
				'"{0}" must be true or a list of fields the record sets, e.g. ["temperature"]; offending entries are ignored ({1})',
				diagnostic.key,
				where
			);
	}
}

/** The request fields the extension itself owns; rendered as code, never prose. */
const ALWAYS_SENT_FIELDS = ["model", "messages", "stream", "stream_options", "max_tokens"] as const;

/**
 * The max_tokens derivation: a configured value carries a badge like every other; the
 * two derived branches have no record to point at and say so in words.
 */
function maxTokensParts(maxTokens: ProjectedMaxTokens): {
	value: number;
	source?: ProvenanceView;
	mark?: MarkView;
	reason?: string;
} {
	// No source, no badge: the projection can report a configured value whose
	// layer it could not name, and minting a settings badge for it would put the
	// wrong layer on a value the server entry may well have set.
	const source = maxTokens.configuredSource === undefined ? undefined : parameterProvenance(maxTokens.configuredSource);
	const unattributed = l10n.t("set in configuration");
	switch (maxTokens.source) {
		case "forced":
			return {
				value: maxTokens.value,
				...(source === undefined ? { reason: unattributed } : { source }),
				mark: {
					word: forceWord(),
					detail: l10n.t("Overrides runtime options and the picker configuration; never clamped."),
				},
			};
		case "configured":
			return source === undefined
				? { value: maxTokens.value, reason: unattributed }
				: { value: maxTokens.value, source };
		case "declared":
			// "the model's", not "the server's": a user record and a _fallback fill both count as
			// declared here, so naming the server is a claim the panel cannot back up. Reaching
			// this branch already means nothing configured set it.
			return { value: maxTokens.value, reason: l10n.t("the model's declared output limit") };
		case "capped-default":
			return {
				value: maxTokens.value,
				reason: l10n.t("min({0}, model max) - a default, not declared", formatTokens(DEFAULT_MAX_TOKENS_CAP)),
			};
	}
}

/**
 * The capability fields in display order; pricing and the params list get sections of
 * their own, and every other field (the vocabulary is open) renders under "Other
 * fields", sorted by key.
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

/** The consumed list fields that close the capabilities section; the params list has a section of its own. */
const CONSUMED_LIST_ORDER: readonly string[] = ["reasoning_effort_levels"];

/** The number fields that render as token counts; other numbers (costs aside) render plain. */
const TOKEN_FIELDS: ReadonlySet<string> = new Set(["context_length", "max_input_tokens", "max_output_tokens"]);

/**
 * Where the stylesheet's ellipsis can start clipping a value cell. PAIRED WITH the
 * .res-col-value share in dashboard.css: move one and this moves too, or values clip
 * with no keyboard-reachable text. The threshold sits at the practical floor (~9ch at a
 * 360px window), so any value the ellipsis could touch carries the focusable HoverTip;
 * short values stay plain text outside the Tab order.
 */
const VALUE_CLIP_CH = 8;

/**
 * One value cell: plain text while it surely fits, the focusable full-text tip once the
 * ellipsis could clip it. `numeric` earns right alignment - right-aligning a word only
 * pushes it away from the name it belongs to.
 */
function ValueCell({ text, numeric = false, struck = false }: { text: string; numeric?: boolean; struck?: boolean }) {
	const body = struck ? <del>{text}</del> : text;
	return (
		// `num` is the stylesheet's existing name for a right-aligned numeric
		// cell; a second name for one concept is how a vocabulary rots.
		<td className={numeric ? "res-value num" : "res-value"}>
			{approxWidthCh(text) > VALUE_CLIP_CH ? (
				<HoverTip tip={text}>
					<span className="res-value-clip">{body}</span>
				</HoverTip>
			) : (
				body
			)}
		</td>
	);
}

/**
 * One capability name cell: consumed fields render localized labels with the wire key
 * one focusable tip away (the label hides the identifier a models.capabilities record
 * needs). An open field renders its raw wire key in monospace, breakable only at its
 * underscores via <wbr>.
 */
function FieldName({ name }: { name: string }) {
	const label = capabilityDisplayLabel(name);
	if (label !== undefined) {
		return (
			<HoverTip tip={name}>
				<span className="res-label">{label}</span>
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
					// biome-ignore lint/suspicious/noArrayIndexKey: underscore positions are stable within one render; the index is the identity
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
 * One capability value as the table shows it; everything outside the known kinds
 * renders as compact JSON, truncated by the stylesheet rather than chopped here.
 */
function formatValue(name: string, value: CapabilityJsonValue, currencySymbol: string): string {
	if (typeof value === "boolean") {
		return value ? l10n.t("yes") : l10n.t("no");
	}
	if (typeof value === "number") {
		if (isCostCapabilityField(name)) {
			return formatCostPerMillion(value, currencySymbol);
		}
		return TOKEN_FIELDS.has(name) ? formatTokens(value) : String(value);
	}
	if (name === "supported_openai_params" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
		// The count alone: the winning list renders in full in its own block
		// (SupportedParamsBlock), one element per name so boundaries survive
		// without JSON quoting; shadowed lists stay count-only (their record
		// holds the value).
		return parameterCountText(value.length);
	}
	if (
		name === "reasoning_effort_levels" &&
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string")
	) {
		// Short enough to render whole: the menu's levels, comma-joined in menu
		// order, without JSON quoting. A user-written empty list (no levels)
		// falls through to its JSON form rather than a blank cell.
		return value.join(", ");
	}
	return JSON.stringify(value) ?? "";
}

/**
 * A beaten value: struck out, dimmed, and announced as what it is. <del> alone carries
 * the semantics unevenly across screen readers, so the row opens with a clipped word.
 */
function ShadowedRow({
	value,
	numeric,
	source,
	mark,
}: {
	value: string;
	/**
	 * Right-aligned by the SHADOW's own type, not the winner's: pass-through values are
	 * unvalidated, so a string can lose to a number and should sit where its own kind sits.
	 */
	numeric?: boolean;
	source: ProvenanceView;
	mark?: MarkView | undefined;
}) {
	return (
		<tr className="res-shadow">
			<td className="res-name">
				<span className="visually-hidden">{l10n.t("Overridden value")}</span>
			</td>
			<ValueCell text={value} numeric={numeric === true} struck />
			<td className="res-source">
				<Provenance source={source} /> {mark !== undefined ? <Mark mark={mark} /> : null}
			</td>
		</tr>
	);
}

function ParamShadowedLine({ shadow }: { shadow: ShadowedParameterValue }) {
	return (
		<ShadowedRow
			value={formatJsonValue(shadow.value)}
			numeric={typeof shadow.value === "number"}
			source={parameterProvenance(shadow)}
		/>
	);
}

/**
 * A capability row's edit label names the LAYER: every visible layer word sits inside a
 * badge, so for a screen reader this label is the only place the layer is stated.
 */
function capabilityEditLabel(level: CapabilityLevel, key: string, serverLabel: string): string {
	return level === "entry" || level === "entry-fallback"
		? l10n.t('Edit in server entry "{0}"', serverLabel)
		: l10n.t('Edit record "{0}" in settings', key);
}

/** The per-row jump to the record that owns a value, in the source cell's trailing slot. */
function RowEdit({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<Button
			variant="secondary"
			size="compact"
			className="row-edit [--btn-mx:-0.125rem] px-0.5 py-0"
			aria-label={label}
			onClick={onClick}
		>
			{l10n.t("edit")}
		</Button>
	);
}

function ParameterRow({
	row,
	onEditSource,
}: {
	row: EffectiveParameterRow;
	/** The per-row jump to the record that owns the value; absent, no affordance renders. */
	onEditSource?: ((source: ParameterSourceRef) => void) | undefined;
}) {
	return (
		<>
			<tr className={row.sent ? undefined : "res-not-sent"}>
				<td className="res-name">{row.name}</td>
				<ValueCell text={formatJsonValue(row.value)} numeric={typeof row.value === "number"} />
				<td className="res-source">
					<Provenance source={parameterProvenance(row.source)} />{" "}
					{row.inheritedFrom !== undefined ? (
						<Mark mark={{ word: inheritedWord() }}>
							{" "}
							<code>{row.inheritedFrom}</code>
						</Mark>
					) : null}{" "}
					{row.forced === true ? (
						<Mark
							mark={{
								word: forceWord(),
								detail: l10n.t("Overrides runtime options and the picker configuration."),
							}}
						/>
					) : null}{" "}
					{row.skipReason !== undefined ? (
						<span className="mark-quiet">
							<HoverTip tip={skipReasonText(row.skipReason)}>
								<span>{l10n.t("not sent")}</span>
							</HoverTip>
						</span>
					) : null}
					{onEditSource !== undefined ? (
						<RowEdit
							label={
								row.source.layer === "entry"
									? l10n.t('Edit in server entry "{0}"', row.source.entryLabel)
									: l10n.t('Edit record "{0}" in settings', row.source.key)
							}
							onClick={() => onEditSource(row.source)}
						/>
					) : null}
				</td>
			</tr>
			{row.shadowed.map((shadow) => (
				<ParamShadowedLine key={`${shadow.layer}/${shadow.key}`} shadow={shadow} />
			))}
		</>
	);
}

/** The capability Source column's naming: the precedence level that set the value plus its winning key. */
function CapShadowedLine({
	name,
	shadow,
	currencySymbol,
}: {
	name: string;
	shadow: ShadowedCapabilityValue;
	currencySymbol: string;
}) {
	// A beaten value keeps its directive too: a fallback fill or a catalog match
	// that lost still has to say WHY it was in the running at all.
	const { source, mark } = capabilityProvenance(shadow.level, shadow.key);
	return (
		<ShadowedRow
			value={formatValue(name, shadow.value, currencySymbol)}
			numeric={typeof shadow.value === "number"}
			source={source}
			mark={mark}
		/>
	);
}

function FieldRow({
	name,
	field,
	serverLabel,
	currencySymbol,
	onEditField,
}: {
	name: string;
	field: EffectiveCapabilityField;
	/** Names the entry an entry-level row belongs to, for the jump's accessible label. */
	serverLabel: string;
	/** The configured cost prefix (usage.currencySymbol); the cost rows' values read it. */
	currencySymbol: string;
	/** The per-row jump to the record that owns the value; renders only on record-sourced rows. */
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const { source, mark } = capabilityProvenance(field.level, field.key);
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
				<td className="res-name">
					<FieldName name={name} />
				</td>
				<ValueCell text={formatValue(name, field.value, currencySymbol)} numeric={typeof field.value === "number"} />
				<td className="res-source">
					<Provenance source={source} /> {mark !== undefined ? <Mark mark={mark} /> : null}{" "}
					{field.inheritedFrom !== undefined ? (
						<Mark mark={{ word: inheritedWord() }}>
							{" "}
							<code>{field.inheritedFrom}</code>
						</Mark>
					) : null}
					{editable ? (
						<RowEdit
							label={capabilityEditLabel(field.level, field.key ?? "", serverLabel)}
							onClick={() => onEditField?.(field.level, field.key ?? "")}
						/>
					) : null}
				</td>
			</tr>
			{field.shadowed.map((shadow) => (
				<CapShadowedLine
					key={`${shadow.level}/${shadow.key ?? ""}`}
					name={name}
					shadow={shadow}
					currencySymbol={currencySymbol}
				/>
			))}
		</>
	);
}

/** One capability-record diagnostic as prose; classifications and the offending keys, never values. */
function capabilityDiagnosticText(diagnostic: CapabilityDiagnostic): string {
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

/**
 * The output limit as a labelled fact, and nothing else: what the REQUEST does about it
 * is conditional and belongs on the max_tokens derivation line - stating it here too
 * produced "capped at 4,096" directly under a max_tokens line reading 10,000.
 */
function outputLimitNote(capabilities: EffectiveCapabilities): string {
	switch (capabilities.outputLimitSource) {
		case "user":
			return l10n.t("User-set.");
		case "provider":
			return l10n.t("Server-declared.");
		case "defaults":
			return l10n.t("A default.");
	}
}

/**
 * One resolution table: name, value, provenance. The column tracks are fixed shares
 * carried by a colgroup, so every table aligns down the page and a long value clips
 * into its tip instead of shoving the badge column off the edge. The head names the
 * columns once - a badge column that never says "source" reads as decoration.
 */
function ResolutionTable({
	nameHead,
	valueHead,
	numericValues = false,
	children,
}: {
	nameHead: string;
	valueHead: string;
	/** Every value in the column is a number (the pricing table), so its head follows them to the right. */
	numericValues?: boolean;
	children: ReactNode;
}) {
	return (
		<table className="resolution">
			<colgroup>
				<col className="res-col-name" />
				<col className="res-col-value" />
				<col />
			</colgroup>
			<thead>
				<tr>
					<th>{nameHead}</th>
					<th className={numericValues ? "num" : undefined}>{valueHead}</th>
					<th>{l10n.t("Source")}</th>
				</tr>
			</thead>
			{children}
		</table>
	);
}

/** A section's sub-heading line: the sentence-case title, its summary, and its one action. */
function Subhead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
	return (
		<div className="inspector-subhead">
			<h5>{title}</h5>
			{meta !== undefined ? <span className="section-meta">{meta}</span> : null}
			{action}
		</div>
	);
}

/**
 * The Supported parameters block, in the PARAMETERS section (what the model accepts
 * beside what we send) while staying a capability on the wire. The list is nothing but
 * quiet monospace names in columns: thirty pills are a wall, thirty words are a list.
 */
function SupportedParamsBlock({
	fields,
	serverLabel,
	currencySymbol,
	onEditField,
}: {
	fields: EffectiveCapabilities["fields"];
	/** Names the entry an entry-level value belongs to, for the jump's accessible label. */
	serverLabel: string;
	/** Threaded so every capability value renders through the one formatter. */
	currencySymbol: string;
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const field = capabilityField(fields, "supported_openai_params");
	if (field === undefined) {
		return null;
	}
	// Sorted for scanning: the wire order of supported_openai_params carries
	// no meaning (it is a set), and 30 names are findable only alphabetically.
	// Code-unit sort - these are wire identifiers, not display text.
	const items = (
		Array.isArray(field.value) ? field.value.filter((item): item is string => typeof item === "string") : []
	).sort();
	const { source, mark } = capabilityProvenance(field.level, field.key);
	const editable =
		onEditField !== undefined &&
		field.key !== undefined &&
		(field.level === "entry" ||
			field.level === "global" ||
			field.level === "entry-fallback" ||
			field.level === "global-fallback");
	return (
		<div className="supported-params">
			<Subhead
				title={l10n.t("Supported parameters")}
				meta={
					<>
						<span className="params-count">{parameterCountText(items.length)}</span> <Provenance source={source} />{" "}
						{mark !== undefined ? <Mark mark={mark} /> : null}
					</>
				}
				action={
					editable ? (
						<RowEdit
							label={capabilityEditLabel(field.level, field.key ?? "", serverLabel)}
							onClick={() => onEditField?.(field.level, field.key ?? "")}
						/>
					) : undefined
				}
			/>
			{field.shadowed.map((shadow) => (
				<p className="params-shadow" key={`${shadow.level}/${shadow.key ?? ""}`}>
					<span className="visually-hidden">{l10n.t("Overridden value")}</span>{" "}
					<del>{formatValue("supported_openai_params", shadow.value, currencySymbol)}</del>{" "}
					<Provenance source={capabilityProvenance(shadow.level, shadow.key).source} />
				</p>
			))}
			{items.length > 0 ? (
				<ul className="params-names" aria-label={l10n.t("Supported parameters")}>
					{items.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/** A field the panel has nothing to show for: the Absent primitive in this panel's own register, the reason visible in place. */
function AbsentNote({ reason }: { reason: string }) {
	return (
		<AbsentDatum className="absent">
			<span>{reason}</span>
		</AbsentDatum>
	);
}

export function ModelInspector({
	model,
	stateSeq,
	currencySymbol,
	anchor,
	fallbackFocusId = "models-section",
	onClose,
	onEditRecord,
	onEditEntry,
}: {
	model: DashboardModel;
	/** The configured cost prefix (usage.currencySymbol); every price on the panel renders through it. */
	currencySymbol: string;
	/** Bumped on every state push; the inspector re-requests both feeds so an open panel follows configuration edits. */
	stateSeq: number;
	/** Which section the panel scrolls to on open (the Diagnostics jump links); absent, it opens at the top. */
	anchor?: InspectorSection | undefined;
	/** Where focus lands on close when the opener is gone; the overlay's owner names a visible element (the active tab). */
	fallbackFocusId?: string;
	onClose: () => void;
	/** Jump into a global record editor: focus record `key` of `kind`, or create an exact-ID draft when `create`. */
	onEditRecord?: ((kind: "parameters" | "capabilities", key: string, create: boolean) => void) | undefined;
	/** Jump into a server entry's edit form (the owner of entry-layer values). */
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	// The two feeds are two independent hook instances: each holds its own
	// in-flight id, so a slow capabilities answer never orphans a fast
	// parameters one.
	const paramsRpc = useRpc("readModelParameters");
	const capsRpc = useRpc("readModelCapabilities");

	// One request pair per inspected model AND per state push: the push means
	// the stores may have moved (a settings edit, a discovery pass), and an
	// open inspector must follow instead of showing the pre-edit values. A
	// re-send orphans the stale answer (latest wins inside the hook).
	const { scopeKey, rawId } = model;
	const sendParams = paramsRpc.send;
	const sendCaps = capsRpc.send;
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateSeq is the deliberate re-request key (see above), not a read
	useEffect(() => {
		sendParams({ scopeKey, rawId });
		sendCaps({ scopeKey, rawId });
	}, [scopeKey, rawId, stateSeq, sendParams, sendCaps]);

	const answeredParams = paramsRpc.data;
	const answeredCaps = capsRpc.data;
	const projection = answeredParams?.projection;
	const caps = answeredCaps?.capabilities;

	// The Diagnostics jump's landing: move focus once (the slide-over's first-field focus
	// must not win, later re-runs must not yank), then re-scroll as each answer lands -
	// content filling in above the target moves it. Re-scrolls stop FOR GOOD once both
	// feeds answered once: readiness flips false on every push, and a reader who scrolled
	// away must not be yanked back by a configuration change minutes later.
	// minutes later.
	const paramsReady = answeredParams !== undefined;
	const capsReady = answeredCaps !== undefined;
	const anchorFocused = useRef(false);
	const anchorSettled = useRef(false);
	useEffect(() => {
		if (anchor === undefined || anchorSettled.current) {
			return;
		}
		const target = document.getElementById(SECTION_ELEMENT_ID[anchor]);
		if (target === null) {
			return;
		}
		if (!anchorFocused.current) {
			anchorFocused.current = true;
			target.focus();
		}
		target.scrollIntoView();
		if (paramsReady && capsReady) {
			anchorSettled.current = true;
		}
	}, [anchor, paramsReady, capsReady]);

	// The per-row jump: an entry-layer value is owned by the server entry's own
	// record (edited in its form, addressed by the ref's own label), everything
	// else by a global settings record of the row's kind.
	const editParamSource =
		onEditRecord === undefined
			? undefined
			: (source: ParameterSourceRef) => {
					if (source.layer === "entry") {
						onEditEntry?.(source.entryLabel);
					} else {
						onEditRecord("parameters", source.key, false);
					}
				};
	// The capability twin: entry-level values are owned by the entry's record
	// (entry records apply only when labels align, so the group's label
	// addresses the entry), the rest by the named global capabilities record.
	const editCapField =
		onEditRecord === undefined
			? undefined
			: (level: CapabilityLevel, key: string) => {
					if (level === "entry" || level === "entry-fallback") {
						onEditEntry?.(model.serverLabel);
					} else {
						onEditRecord("capabilities", key, false);
					}
				};
	// A configured max_tokens is real configuration even though it renders on
	// the derivation line instead of as a row, so it defeats the empty state.
	const paramsEmpty =
		projection !== undefined && projection.rows.length === 0 && projection.maxTokens.source !== "configured";
	const sentCount = projection === undefined ? 0 : projection.rows.filter((row) => row.sent).length;
	// The derivation line's parts, resolved once: the value always goes out, so
	// the line renders whenever a projection has landed.
	const maxTokens = projection === undefined ? undefined : maxTokensParts(projection.maxTokens);

	// The capability section partition over the resolved bag (open extras in code-unit
	// order - wire identifiers). Object.keys reads own properties only, and per-name reads
	// go through capabilityField: a field named "toString" must read from the bag, never
	// Object.prototype.
	const present = new Set(caps === undefined ? [] : Object.keys(caps.fields));
	const capabilityNames = [...FIELD_ORDER, ...CONSUMED_BOOLEAN_ORDER, ...CONSUMED_LIST_ORDER].filter((name) =>
		present.has(name)
	);
	const pricingNames = COST_CAPABILITY_FIELDS.filter((name) => present.has(name));
	const sectioned = new Set([...capabilityNames, ...pricingNames, "supported_openai_params"]);
	const extraNames = [...present].filter((name) => !sectioned.has(name)).sort();
	const advisories = caps === undefined ? [] : caps.diagnostics.filter((d) => d.kind === "unrecognized-key");
	const problems = caps === undefined ? [] : caps.diagnostics.filter((d) => d.kind !== "unrecognized-key");
	const capabilityChips = capabilityList(model);
	const fieldCount = capabilityNames.length + extraNames.length;

	return (
		<SlideOver labelledBy="model-inspector-title" fallbackFocusId={fallbackFocusId} onRequestClose={onClose}>
			<div className="model-inspector">
				<h3 id="model-inspector-title">{model.name}</h3>
				<p className="inspector-identity">
					{l10n.t({
						message: "{0} on {1}",
						args: [model.rawId, model.serverLabel],
						comment: ["{0} is a model ID, {1} is the server it is served from"],
					})}
				</p>
				{/* The token limits deliberately do NOT repeat here - the
				    capabilities table below carries them with provenance. */}
				<dl className="inspector-orientation">
					<dt>{l10n.t("Family")}</dt>
					<dd>
						<code>{model.family}</code>
					</dd>
					<dt>{l10n.t("Capabilities")}</dt>
					<dd>
						{capabilityChips.length > 0 ? (
							capabilityChips.map((cap) => (
								<Badge className="cap-chip" key={cap}>
									{cap}
								</Badge>
							))
						) : (
							<span className="hint">{l10n.t("none declared")}</span>
						)}
					</dd>
				</dl>
				<Section
					id="inspector-params"
					level={4}
					title={l10n.t("Parameters")}
					help={helpParamsInspector()}
					docs={{ href: DOCS_LINK_PARAMS_INSPECTOR, label: l10n.t("Open the effective-parameters guide") }}
					{...(sentCount > 0 ? { meta: sentCount === 1 ? l10n.t("1 sent") : l10n.t("{0} sent", sentCount) } : {})}
					actions={
						onEditRecord !== undefined ? (
							<Button
								variant="secondary"
								size="compact"
								className="section-action"
								disabled={answeredParams === undefined}
								onClick={() => {
									// Reuse the most specific matching global record when one
									// exists; otherwise a fresh draft keyed by the exact model ID.
									const key = answeredParams?.globalRecordKey;
									if (key !== undefined) {
										onEditRecord("parameters", key, false);
									} else {
										onEditRecord("parameters", model.rawId, true);
									}
								}}
							>
								{l10n.t("Configure parameters for this model")}
							</Button>
						) : undefined
					}
				>
					{answeredParams === undefined ? (
						<p className="hint" role="status">
							{l10n.t("Resolving parameters...")}
						</p>
					) : projection === undefined ? (
						<p className="hint" role="status">
							{l10n.t("The model list changed; close and reopen the inspector.")}
						</p>
					) : projection.rows.length > 0 ? (
						<ResolutionTable nameHead={l10n.t("Parameter")} valueHead={l10n.t("Value")}>
							<tbody>
								{projection.rows.map((row) => (
									<ParameterRow key={row.name} row={row} onEditSource={editParamSource} />
								))}
							</tbody>
						</ResolutionTable>
					) : paramsEmpty ? (
						<AbsentNote reason={l10n.t("No configured parameters match this model.")} />
					) : null}
					{projection !== undefined && projection.diagnostics.length > 0 ? (
						<div className="record-problems">
							<h5 className="hint">{l10n.t("Record problems")}</h5>
							<ul>
								{projection.diagnostics.map((diagnostic) => (
									<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.kind}/${diagnostic.key}`}>
										{parameterDiagnosticText(diagnostic)}
									</li>
								))}
							</ul>
						</div>
					) : null}
					{/* What the model accepts, right beside what we send. Still a
					    capability on the wire, so it rides the capability feed and
					    renders as soon as THAT answer lands. */}
					{caps !== undefined ? (
						<SupportedParamsBlock
							fields={caps.fields}
							serverLabel={model.serverLabel}
							currencySymbol={currencySymbol}
							onEditField={editCapField}
						/>
					) : null}
					{maxTokens !== undefined ? (
						<p className="max-tokens">
							<code className="max-tokens-name">max_tokens</code>{" "}
							{/* Formatted like every other token count on the panel: the same
							    number in two renderings on one screen reads as two numbers. */}
							<span className="max-tokens-value">{formatTokens(maxTokens.value)}</span>{" "}
							{maxTokens.source !== undefined ? <Provenance source={maxTokens.source} /> : null}{" "}
							{maxTokens.mark !== undefined ? <Mark mark={maxTokens.mark} /> : null}
							{maxTokens.reason !== undefined ? <span className="hint">{maxTokens.reason}</span> : null}
						</p>
					) : null}
					{/* Fixed truth about the extension, not about this answer: the grid
					    renders while the projection is still in flight, because
					    "Resolving parameters..." followed by nothing at all reads as a
					    section that failed to load. */}
					<dl className="inspector-notes">
						<div>
							<dt>{l10n.t("Always sent")}</dt>
							<dd>
								{/* Separated by real whitespace, not by the margin alone: without
								    it a screen reader reads one run-together token. */}
								{ALWAYS_SENT_FIELDS.map((field, index) => (
									<Fragment key={field}>
										{index > 0 ? " " : null}
										<code>{field}</code>
									</Fragment>
								))}
							</dd>
						</div>
						{/* Its own row rather than a qualifier trailing the always-sent
						    line: "tools" appeared twice on that line, three words apart and
						    in two registers, leaving the reader to work out which one
						    qualified which. */}
						<div>
							<dt>{l10n.t("Sent with tools")}</dt>
							<dd>
								<code>tools</code> <code>tool_choice</code>
							</dd>
						</div>
						<div>
							<dt>{l10n.t("Runtime options")}</dt>
							<dd className="hint">
								{/* max_tokens is forced from the derivation line, not from a
								    row, and runtime options lose to it just the same - so the
								    exception has to count it or this line contradicts the
								    forced value rendered directly above it. */}
								{projection !== undefined &&
								(projection.rows.some((row) => row.forced === true) || projection.maxTokens.source === "forced")
									? l10n.t("Overrides every table row above except forced rows.")
									: l10n.t("Overrides every table row above.")}
							</dd>
						</div>
						{model.reasoning ? (
							<div>
								{/* The label names the command that owns the pick, which is the
								    only pointer to where the value actually lives. */}
								<dt>{l10n.t("Configure Model pick")}</dt>
								<dd className="hint">{l10n.t("Overrides reasoning_effort here.")}</dd>
							</div>
						) : null}
					</dl>
					<RecordChainFigure
						chains={answeredParams?.chains}
						onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("parameters", key, false)}
						onEditEntry={onEditEntry}
					/>
				</Section>
				<Section
					id="inspector-caps"
					level={4}
					title={l10n.t("Capabilities")}
					help={helpCapsInspector()}
					docs={{ href: DOCS_LINK_CAPS_INSPECTOR, label: l10n.t("Open the effective-capabilities guide") }}
					{...(fieldCount > 0 ? { meta: fieldCount === 1 ? l10n.t("1 field") : l10n.t("{0} fields", fieldCount) } : {})}
					actions={
						onEditRecord !== undefined ? (
							<Button
								variant="secondary"
								size="compact"
								className="section-action"
								disabled={answeredCaps === undefined}
								onClick={() => {
									// Reuse the most specific matching global record when one
									// exists; otherwise a fresh draft keyed by the exact model ID.
									const key = answeredCaps?.globalRecordKey;
									if (key !== undefined) {
										onEditRecord("capabilities", key, false);
									} else {
										onEditRecord("capabilities", model.rawId, true);
									}
								}}
							>
								{l10n.t("Configure capabilities for this model")}
							</Button>
						) : undefined
					}
				>
					{answeredCaps === undefined ? (
						<p className="hint" role="status">
							{l10n.t("Resolving capabilities...")}
						</p>
					) : caps === undefined ? (
						<p className="hint" role="status">
							{l10n.t("The model list changed; close and reopen the inspector.")}
						</p>
					) : (
						<>
							{/* The declared/directive notes gate how the table reads, so
							    they stay ahead of it. */}
							{model.declared === true ? (
								<p className="hint">
									{l10n.t("Declared model: created by the entry's declared list, not discovered on the server.")}
								</p>
							) : null}
							{caps.directive?.kind === "not-found" ? (
								<p className="state-warn" role="alert">
									{l10n.t(
										'OpenRouter model "{0}" was not found in the catalog; its fields fill from the remaining levels.',
										caps.directive.id
									)}
								</p>
							) : null}
							{capabilityNames.length > 0 || extraNames.length > 0 ? (
								<ResolutionTable nameHead={l10n.t("Capability")} valueHead={l10n.t("Value")}>
									<tbody>
										{capabilityNames.map((name) => {
											const field = capabilityField(caps.fields, name);
											return field === undefined ? null : (
												<FieldRow
													key={name}
													name={name}
													field={field}
													serverLabel={model.serverLabel}
													currencySymbol={currencySymbol}
													onEditField={editCapField}
												/>
											);
										})}
									</tbody>
									{extraNames.length > 0 ? (
										<tbody>
											<tr className="res-group">
												<th colSpan={3} scope="rowgroup">
													{l10n.t("Other fields")}
												</th>
											</tr>
											{extraNames.map((name) => {
												const field = capabilityField(caps.fields, name);
												return field === undefined ? null : (
													<FieldRow
														key={name}
														name={name}
														field={field}
														serverLabel={model.serverLabel}
														currencySymbol={currencySymbol}
														onEditField={editCapField}
													/>
												);
											})}
										</tbody>
									) : null}
								</ResolutionTable>
							) : null}
							<dl className="inspector-notes output-limit">
								<div>
									<dt>{l10n.t("Output limit")}</dt>
									<dd className="hint">{outputLimitNote(caps)}</dd>
								</div>
							</dl>
							{problems.length > 0 ? (
								<div className="record-problems">
									<h5 className="hint">{l10n.t("Record problems")}</h5>
									<ul>
										{problems.map((diagnostic) => (
											<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.key}`}>
												{capabilityDiagnosticText(diagnostic)}
											</li>
										))}
									</ul>
								</div>
							) : null}
							{advisories.length > 0 ? (
								<div className="record-problems record-notes">
									<h5 className="hint">{l10n.t("Record notes")}</h5>
									<ul>
										{advisories.map((diagnostic) => (
											<li key={`${diagnostic.layer}/${diagnostic.recordKey}/${diagnostic.key}`} className="hint">
												{capabilityDiagnosticText(diagnostic)}
											</li>
										))}
									</ul>
								</div>
							) : null}
						</>
					)}
					<RecordChainFigure
						chains={answeredCaps?.chains}
						onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("capabilities", key, false)}
						onEditEntry={onEditEntry}
					/>
				</Section>
				{/* The section stands whether or not the answer has landed: a pricing
				    section that simply is not there while capabilities resolve is the
				    same vanishing act the absence state exists to prevent. */}
				<Section id="inspector-pricing" level={4} title={l10n.t("Pricing")} meta={costUnitLabel(currencySymbol)}>
					{answeredCaps === undefined ? (
						<p className="hint" role="status">
							{l10n.t("Resolving capabilities...")}
						</p>
					) : caps === undefined ? (
						<p className="hint" role="status">
							{l10n.t("The model list changed; close and reopen the inspector.")}
						</p>
					) : pricingNames.length > 0 ? (
						<ResolutionTable nameHead={l10n.t("Tokens")} valueHead={l10n.t("Price")} numericValues>
							<tbody>
								{pricingNames.map((name) => {
									const field = capabilityField(caps.fields, name);
									return field === undefined ? null : (
										<FieldRow
											key={name}
											name={name}
											field={field}
											serverLabel={model.serverLabel}
											currencySymbol={currencySymbol}
											onEditField={editCapField}
										/>
									);
								})}
							</tbody>
						</ResolutionTable>
					) : (
						// Absence is a state, not a missing section: a server that
						// reports no prices (or the 0/0 pair that means the same
						// thing) says so, and no number is invented to fill the gap.
						<AbsentNote reason={l10n.t("No prices declared for this model, so spend cannot be estimated.")} />
					)}
				</Section>
			</div>
		</SlideOver>
	);
}
