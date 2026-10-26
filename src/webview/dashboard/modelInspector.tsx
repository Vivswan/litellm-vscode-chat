/**
 *   The model inspector -> ONE read-only slide-over per model row, sectioned Parameters / Capabilities / Pricing
 *   request/response-fed -> readModelParameters and readModelCapabilities, re-posted per state push
 *   the extension -> resolves both through the SAME machinery the request path and registration read
 *   no resolver logic or catalog data -> live in the webview
 *
 *   the winner       -> at full strength
 *   beaten values    -> struck out beneath it
 *   a loser must not read - or announce - as a peer
 *                    -> struck out beneath it
 *   provenance is not severity; the two must never share a color
 *                    -> one neutral badge
 *   Sections         -> never collapse
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
	isTokenCapabilityField,
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
import { capabilityField, isUserSetLevel } from "../../shared/config/capabilityResolution";
import type {
	EffectiveParameterRow,
	EffectiveParametersProjection,
	ParameterDiagnostic,
	ParameterSourceRef,
	ProjectedMaxTokens,
	ShadowedParameterValue,
} from "../../shared/config/parameterResolution";
import { DEFAULT_MAX_TOKENS_CAP } from "../../shared/config/parameterResolution";
import { FALLBACK_DIRECTIVE } from "../../shared/config/recordResolution";
import { DOCS_LINK_CAPS_INSPECTOR, DOCS_LINK_PARAMS_INSPECTOR } from "./docsLinks";
import { HoverTip } from "./help";
import { helpCapsInspector, helpParamsInspector } from "./helpText";
import { useRpc } from "./hooks";
import { tupleKey } from "./keys";
import { formatTokens } from "./models";
import type { MarkView, ProvenanceView } from "./provenance";
import {
	approxWidthCh,
	CellMarks,
	capabilityCellProvenance,
	capabilityProvenance,
	forceWord,
	Mark,
	Provenance,
	parameterCellProvenance,
	parameterProvenance,
} from "./provenance";
import { RecordChainFigure } from "./recordChain";
import { SlideOver } from "./slideOver";
import { AbsentDatum } from "./ui/absent";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Section, sectionId } from "./ui/section";

export type ModelParametersResponse = ResponseFor<"readModelParameters">;

export type ModelCapabilitiesResponse = ResponseFor<"readModelCapabilities">;

/** The panel's addressable sections; the Diagnostics table's jump links land on one. */
export type InspectorSection = "params" | "caps";

const SECTION_ID: Record<InspectorSection, string> = {
	params: "inspector-params",
	caps: "inspector-caps",
};

function skipReasonText(reason: "underscore" | "provider-owned"): string {
	return reason === "underscore"
		? l10n.t("Keys starting with _ are directives - instructions to the extension, never sent.")
		: l10n.t("A provider-owned request field: the extension owns it and never sends an override.");
}

/**
 * One parameter-record problem as prose, the capability side's diagnostics idiom: classifications and the offending
 * keys, never values.
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
			// Deliberately "offending entries", not "ignored": the resolver salvages the valid names of a partly bad
			// list, so those stay applied.
			return l10n.t(
				'"{0}" must be true or a list of fields the record sets, e.g. ["temperature"]; offending entries are ignored ({1})',
				diagnostic.key,
				where
			);
	}
}

/** The request fields the extension itself owns; rendered as code, never prose. */
const ALWAYS_SENT_FIELDS = ["model", "messages", "stream", "stream_options", "max_tokens"] as const;

function maxTokensParts(maxTokens: ProjectedMaxTokens): {
	value: number;
	source?: ProvenanceView;
	mark?: MarkView;
	reason?: string;
} {
	// No source, no badge: the projection can report a configured value whose layer it could not name, and minting a
	// settings badge for it would put the wrong layer on a value the server entry may well have set.
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
		case "limit":
			// "the model's", not "the server's" or "declared": a user record, a _fallback fill and a catalog guess already
			// under the cap all land here, so naming a source is a claim the panel cannot back up.
			return { value: maxTokens.value, reason: l10n.t("the model's output limit") };
		case "capped":
			return {
				value: maxTokens.value,
				reason: l10n.t("min({0}, model max) - a default, not declared", formatTokens(DEFAULT_MAX_TOKENS_CAP)),
			};
	}
}

const FIELD_ORDER: readonly string[] = [
	"context_length",
	"max_input_tokens",
	"max_output_tokens",
	"supports_function_calling",
	"supports_vision",
	"supports_reasoning",
	"supports_audio_input",
];

const CONSUMED_BOOLEAN_ORDER: readonly string[] = [
	"supports_prompt_caching",
	"supports_pdf_input",
	"supports_response_schema",
];

const CONSUMED_LIST_ORDER: readonly string[] = ["reasoning_effort_levels"];

const VALUE_CLIP_CH = 8;

/**
 * `numeric` earns right alignment - right-aligning a word only pushes it away from the name it belongs to.
 *
 * VALUE_CLIP_CH is PAIRED WITH the .res-col-value share in dashboard.css: move one and the other moves too, or values
 * clip with no keyboard-reachable text. The threshold sits at the practical floor (~9ch at a 360px window), so any
 * value the ellipsis could touch carries the focusable HoverTip; short values stay plain text outside the Tab order.
 */
function ValueCell({ text, numeric = false, struck = false }: { text: string; numeric?: boolean; struck?: boolean }) {
	const body = struck ? <del>{text}</del> : text;
	return (
		// `num` is the stylesheet's existing name for a right-aligned numeric cell; a second name for one concept is
		// how a vocabulary rots.
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
 * One capability name cell: consumed fields render localized labels with the wire key one focusable tip away (the label
 * hides the identifier a models.capabilities record needs).
 *
 *   An open field -> renders its raw wire key in monospace
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
					// biome-ignore lint/suspicious/noArrayIndexKey: underscore positions are stable within one render
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
 * One capability value as the table shows it; everything outside the known kinds renders as compact JSON, truncated by
 * the stylesheet rather than chopped here.
 */
function formatValue(name: string, value: CapabilityJsonValue, currencySymbol: string): string {
	if (typeof value === "boolean") {
		return value ? l10n.t("yes") : l10n.t("no");
	}
	if (typeof value === "number") {
		if (isCostCapabilityField(name)) {
			return formatCostPerMillion(value, currencySymbol);
		}
		return isTokenCapabilityField(name) ? formatTokens(value) : String(value);
	}
	if (name === "supported_openai_params" && Array.isArray(value) && value.every((item) => typeof item === "string")) {
		// The count alone: the winning list renders in full in its own block (SupportedParamsBlock), one element per
		// name so boundaries survive without JSON quoting; shadowed lists stay count-only (their record holds the
		// value).
		return parameterCountText(value.length);
	}
	if (
		name === "reasoning_effort_levels" &&
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => typeof item === "string")
	) {
		// A user-written empty list (no levels) falls through to its JSON form rather than a blank cell.
		return value.join(", ");
	}
	return JSON.stringify(value) ?? "";
}

/**
 * <del> alone carries the semantics unevenly across screen readers, so the row opens with a clipped word. The value is
 * right-aligned by the SHADOW's own type (`numeric`), not the winner's: pass-through values are unvalidated, so a
 * string can lose to a number and should sit where its own kind sits.
 */
function ShadowedRow({
	value,
	numeric,
	source,
	mark,
}: {
	value: string;
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
				<Provenance source={source} /> {mark === undefined ? null : <Mark mark={mark} />}
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
 *   every visible layer word sits inside a badge -> A capability row's edit label names the LAYER
 */
function capabilityEditLabel(level: CapabilityLevel, key: string, serverLabel: string): string {
	return level === "entry" || level === "entry-fallback"
		? l10n.t('Edit in server entry "{0}"', serverLabel)
		: l10n.t('Edit record "{0}" in settings', key);
}

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
	onEditSource?: ((source: ParameterSourceRef) => void) | undefined;
}) {
	const { source, marks } = parameterCellProvenance({
		layer: row.source.layer,
		key: row.source.key,
		forced: row.forced,
		inheritedBy: row.inheritedBy,
	});
	return (
		<>
			<tr className={row.sent ? undefined : "res-not-sent"}>
				<td className="res-name">{row.name}</td>
				<ValueCell text={formatJsonValue(row.value)} numeric={typeof row.value === "number"} />
				<td className="res-source">
					<Provenance source={source} /> <CellMarks marks={marks} />{" "}
					{row.skipReason === undefined ? null : (
						<span className="mark-quiet">
							<HoverTip tip={skipReasonText(row.skipReason)}>
								<span>{l10n.t("not sent")}</span>
							</HoverTip>
						</span>
					)}
					{onEditSource === undefined ? null : (
						<RowEdit
							label={
								row.source.layer === "entry"
									? l10n.t('Edit in server entry "{0}"', row.source.entryLabel)
									: l10n.t('Edit record "{0}" in settings', row.source.key)
							}
							onClick={() => onEditSource(row.source)}
						/>
					)}
				</td>
			</tr>
			{row.shadowed.map((shadow) => (
				<ParamShadowedLine key={tupleKey(shadow.layer, shadow.key)} shadow={shadow} />
			))}
		</>
	);
}

function CapShadowedLine({
	name,
	shadow,
	currencySymbol,
}: {
	name: string;
	shadow: ShadowedCapabilityValue;
	currencySymbol: string;
}) {
	// A beaten value keeps its directive too: a fallback fill or a catalog match that lost still has to say WHY it was
	// in the running at all.
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
	/** The capability's wire name; FieldName shows its display label where one exists, and formatValue reads it. */
	name: string;

	/** The resolved field: the winning value with its level, and the shadowed losers rendered under it. */
	field: EffectiveCapabilityField;

	/** Names the entry an entry-level row belongs to, for the jump's accessible label. */
	serverLabel: string;

	/** The configured cost prefix (usage.currencySymbol); the cost rows' values read it. */
	currencySymbol: string;

	/** The pencil's jump; offered only when the winner is a record level (entry, global, or their fallbacks) with a key. */
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const { source, marks } = capabilityCellProvenance({
		level: field.level,
		key: field.key,
		inheritedBy: field.inheritedBy,
	});
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
					<Provenance source={source} /> <CellMarks marks={marks} />
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
					key={tupleKey(shadow.level, shadow.key)}
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
			// Informational, not a problem: the field APPLIES as-is (open vocabulary); the extension-side advisory
			// filter already dropped hints with no evidence behind them, so a surviving one only says the key may be a
			// typo.
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
			//   the same diagnostic covers a malformed value and bad list entries -> `_fallback` gets its own copy
			//   bad list entries                                                   -> the valid ones still apply
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
 * The output limit as a labelled fact, and nothing else: what the REQUEST does about it is conditional and belongs on
 * the max_tokens derivation line - stating it here too produced "capped at 4,096" directly under a max_tokens line
 * reading 10,000. A server level whose default sits under its value had a floor-filled contributor in its collapse.
 */
function outputLimitNote(capabilities: EffectiveCapabilities): string {
	const limit = capabilities.fields.max_output_tokens;
	if (isUserSetLevel(limit.level)) {
		return l10n.t("User-set.");
	}
	return limit.level === "server" && capabilities.defaultMaxTokens === limit.value
		? l10n.t("Server-declared.")
		: l10n.t("A default.");
}

/**
 * The column tracks are fixed shares carried by a colgroup, so every table aligns down the page and a long value clips
 * into its tip instead of shoving the badge column off the edge. The head names the columns once - a badge column
 * that never says "source" reads as decoration.
 *
 *   numericValues -> every value in the column is a number (the pricing table), so its head follows them to the right
 */
function ResolutionTable({
	nameHead,
	valueHead,
	numericValues = false,
	children,
}: {
	nameHead: string;
	valueHead: string;
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

function Subhead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
	return (
		<div className="inspector-subhead">
			<h5>{title}</h5>
			{meta === undefined ? null : <span className="section-meta">{meta}</span>}
			{action}
		</div>
	);
}

/**
 * The Supported parameters block, in the PARAMETERS section (what the model accepts beside what we send) while staying
 * a capability on the wire. The list is nothing but quiet monospace names in columns: thirty pills are a wall, thirty
 * words are a list.
 */
function SupportedParamsBlock({
	fields,
	serverLabel,
	currencySymbol,
	onEditField,
}: {
	/** Every resolved capability field; the block reads only supported_openai_params and renders nothing without it. */
	fields: EffectiveCapabilities["fields"];

	/** Names the entry an entry-level value belongs to, for the jump's accessible label. */
	serverLabel: string;

	/** Threaded so every capability value renders through the one formatter. */
	currencySymbol: string;

	/** The pencil's jump for the one field, offered on the same terms as FieldRow's. */
	onEditField?: ((level: CapabilityLevel, key: string) => void) | undefined;
}) {
	const field = capabilityField(fields, "supported_openai_params");
	if (field === undefined) {
		return null;
	}
	// Sorted for scanning: the wire order of supported_openai_params carries no meaning (it is a set), and 30 names are
	// findable only alphabetically. Code-unit sort - these are wire identifiers, not display text.
	const items = (
		Array.isArray(field.value) ? field.value.filter((item): item is string => typeof item === "string") : []
	).sort();
	const { source, marks } = capabilityCellProvenance({
		level: field.level,
		key: field.key,
		inheritedBy: field.inheritedBy,
	});
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
						<CellMarks marks={marks} />
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
				<p className="params-shadow" key={tupleKey(shadow.level, shadow.key)}>
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

function AbsentNote({ reason }: { reason: string }) {
	return (
		<AbsentDatum className="absent">
			<span>{reason}</span>
		</AbsentDatum>
	);
}

/** Jump into a global record editor: focus record `key` of `kind`, or create an exact-ID draft when `create`. */
type RecordEditJump = (kind: "parameters" | "capabilities", key: string, create: boolean) => void;

/**
 * The two feeds' latest answers: undefined until the first lands and while another model's request is in flight; a
 * same-model refresh keeps the standing answer until the new one lands (useRpc's rule).
 */
interface InspectorFeeds {
	readonly params: ModelParametersResponse | undefined;
	readonly caps: ModelCapabilitiesResponse | undefined;
}

/** What every section reads: the model, the feeds, and the jumps the owner wired. */
interface InspectorContext {
	readonly model: DashboardModel;
	readonly currencySymbol: string;
	readonly feeds: InspectorFeeds;
	readonly onEditRecord: RecordEditJump | undefined;
	readonly onEditEntry: ((label: string) => void) | undefined;
	readonly editParamSource: ((source: ParameterSourceRef) => void) | undefined;
	readonly editCapField: ((level: CapabilityLevel, key: string) => void) | undefined;
}

/** The capability section partition over the resolved bag. */
interface CapabilityPartition {
	readonly capabilityNames: readonly string[];
	readonly pricingNames: readonly string[];
	readonly extraNames: readonly string[];
	readonly advisories: readonly CapabilityDiagnostic[];
	readonly problems: readonly CapabilityDiagnostic[];
}

interface CapabilityRowsProps {
	readonly ctx: InspectorContext;
	readonly fields: EffectiveCapabilities["fields"];
	readonly names: readonly string[];
}

interface RecordProblemsProps {
	readonly title: string;
	readonly diagnostics: readonly CapabilityDiagnostic[];
	readonly notes: boolean;
}

/** A section or body that renders from the inspector's shared context alone. */
interface InspectorContextProps {
	readonly ctx: InspectorContext;
}

interface ConfigureButtonProps {
	readonly disabled: boolean;
	readonly label: string;
	readonly onClick: () => void;
}

interface FeedStatusProps {
	readonly text: string;
}

interface InspectorHeadProps {
	readonly model: DashboardModel;
}

interface MaxTokensLineProps {
	readonly projection: EffectiveParametersProjection;
}

interface InspectorNotesProps {
	readonly projection: EffectiveParametersProjection | undefined;
	readonly reasoning: boolean;
}

interface CapabilitiesBodyProps {
	readonly ctx: InspectorContext;
	readonly caps: EffectiveCapabilities;
	readonly partition: CapabilityPartition;
}

interface CapabilitiesSectionProps {
	readonly ctx: InspectorContext;
	readonly partition: CapabilityPartition;
}

interface PricingSectionProps {
	readonly ctx: InspectorContext;
	readonly pricingNames: readonly string[];
}

/**
 * The two feeds are two independent hook instances: each holds its own in-flight id, so a slow capabilities answer
 * never orphans a fast parameters one.
 *
 * One request pair per inspected model AND per state push: the push means the stores may have moved (a settings edit,
 * a discovery pass), and an open inspector must follow instead of showing the pre-edit values. A re-send orphans the
 * stale answer (latest wins inside the hook).
 */
function useInspectorFeeds(model: DashboardModel, stateSeq: number): InspectorFeeds {
	const paramsRpc = useRpc("readModelParameters");
	const capsRpc = useRpc("readModelCapabilities");
	const { scopeKey, rawId } = model;
	const sendParams = paramsRpc.send;
	const sendCaps = capsRpc.send;
	// biome-ignore lint/correctness/useExhaustiveDependencies: stateSeq is the deliberate re-request key (see above)
	useEffect(() => {
		sendParams({ scopeKey, rawId });
		sendCaps({ scopeKey, rawId });
	}, [scopeKey, rawId, stateSeq, sendParams, sendCaps]);
	return { params: paramsRpc.data, caps: capsRpc.data };
}

/**
 * The Diagnostics jump's landing: move focus once (the slide-over's first-field focus must not win, later re-runs must
 * not yank), then re-scroll as each answer lands - content filling in above the target moves it. Re-scrolls stop FOR
 * GOOD once both feeds answered once: a reader who scrolled away must not be yanked back by whatever re-renders the
 * panel minutes later.
 */
function useAnchorLanding(anchor: InspectorSection | undefined, feeds: InspectorFeeds): void {
	const paramsReady = feeds.params !== undefined;
	const capsReady = feeds.caps !== undefined;
	const anchorFocused = useRef(false);
	const anchorSettled = useRef(false);
	useEffect(() => {
		if (anchor === undefined || anchorSettled.current) {
			return;
		}
		const target = document.getElementById(sectionId(SECTION_ID[anchor]));
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
}

/**
 * The parameter rows' jump: an entry-layer source opens the entry's form, a global one the record editor. The
 * capability twin: entry-level values are owned by the entry's record (entry records apply only when labels align, so
 * the group's label addresses the entry), the rest by the named global capabilities record.
 */
function editJumps(
	model: DashboardModel,
	onEditRecord: RecordEditJump | undefined,
	onEditEntry: ((label: string) => void) | undefined
): Pick<InspectorContext, "editParamSource" | "editCapField"> {
	if (onEditRecord === undefined) {
		return { editParamSource: undefined, editCapField: undefined };
	}
	return {
		editParamSource: (source) => {
			if (source.layer === "entry") {
				onEditEntry?.(source.entryLabel);
			} else {
				onEditRecord("parameters", source.key, false);
			}
		},
		editCapField: (level, key) => {
			if (level === "entry" || level === "entry-fallback") {
				onEditEntry?.(model.serverLabel);
			} else {
				onEditRecord("capabilities", key, false);
			}
		},
	};
}

/**
 * The capability section partition over the resolved bag (open extras in code-unit order - wire identifiers).
 * Object.keys reads own properties only, and per-name reads go through capabilityField: a field named "toString" must
 * read from the bag, never Object.prototype.
 */
function capabilityPartition(caps: EffectiveCapabilities | undefined): CapabilityPartition {
	const present = new Set(caps === undefined ? [] : Object.keys(caps.fields));
	const capabilityNames = [...FIELD_ORDER, ...CONSUMED_BOOLEAN_ORDER, ...CONSUMED_LIST_ORDER].filter((name) =>
		present.has(name)
	);
	const pricingNames = COST_CAPABILITY_FIELDS.filter((name) => present.has(name));
	const sectioned = new Set([...capabilityNames, ...pricingNames, "supported_openai_params"]);
	const diagnostics = caps === undefined ? [] : caps.diagnostics;
	return {
		capabilityNames,
		pricingNames,
		extraNames: [...present].filter((name) => !sectioned.has(name)).sort(),
		advisories: diagnostics.filter((d) => d.kind === "unrecognized-key"),
		problems: diagnostics.filter((d) => d.kind !== "unrecognized-key"),
	};
}

/** A section's quiet count, only while there is something to count. */
function metaProps(count: number, text: string): { meta?: string } {
	return count > 0 ? { meta: text } : {};
}

/**
 * The record this model's Configure button opens: the most specific matching global record when one exists, otherwise
 * a fresh draft keyed by the exact model ID.
 */
function configureRecord(
	kind: "parameters" | "capabilities",
	globalRecordKey: string | undefined,
	rawId: string,
	onEditRecord: RecordEditJump
): void {
	if (globalRecordKey === undefined) {
		onEditRecord(kind, rawId, true);
	} else {
		onEditRecord(kind, globalRecordKey, false);
	}
}

/** A section's Configure action; disabled until its feed has answered, so the record key it reuses is known. */
function ConfigureButton({ disabled, label, onClick }: ConfigureButtonProps) {
	return (
		<Button variant="secondary" size="compact" className="section-action" disabled={disabled} onClick={onClick}>
			{label}
		</Button>
	);
}

/** The status line a feed shows before its answer, or when the model left the list under the open panel. */
function FeedStatus({ text }: FeedStatusProps) {
	return (
		<p className="hint" role="status">
			{text}
		</p>
	);
}

/** The panel's head: the name, the identity line, and the orientation facts (the token limits deliberately do NOT repeat here - the capabilities table below carries them with provenance). */
function InspectorHead({ model }: InspectorHeadProps) {
	const chips = capabilityList(model);
	return (
		<>
			<h3 id="model-inspector-title">{model.name}</h3>
			<p className="inspector-identity">
				{l10n.t({
					message: "{0} on {1}",
					args: [model.rawId, model.serverLabel],
					comment: ["{0} is a model ID, {1} is the server it is served from"],
				})}
			</p>
			<dl className="inspector-orientation">
				<dt>{l10n.t("Family")}</dt>
				<dd>
					<code>{model.family}</code>
				</dd>
				<dt>{l10n.t("Capabilities")}</dt>
				<dd>
					{chips.length > 0 ? (
						chips.map((cap) => (
							<Badge className="cap-chip" key={cap}>
								{cap}
							</Badge>
						))
					) : (
						<span className="hint">{l10n.t("none declared")}</span>
					)}
				</dd>
			</dl>
		</>
	);
}

/**
 * The parameters table or its absence. A configured or forced max_tokens is real configuration even though it renders
 * on the derivation line, not as a row, so an empty table says nothing while one stands.
 */
function ParametersBody({ ctx }: InspectorContextProps) {
	const answer = ctx.feeds.params;
	if (answer === undefined) {
		return <FeedStatus text={l10n.t("Resolving parameters...")} />;
	}
	const projection = answer.projection;
	if (projection === undefined) {
		return <FeedStatus text={l10n.t("The model list changed; close and reopen the inspector.")} />;
	}
	if (projection.rows.length > 0) {
		return (
			<ResolutionTable nameHead={l10n.t("Parameter")} valueHead={l10n.t("Value")}>
				<tbody>
					{projection.rows.map((row) => (
						<ParameterRow key={row.name} row={row} onEditSource={ctx.editParamSource} />
					))}
				</tbody>
			</ResolutionTable>
		);
	}
	const paramsEmpty = projection.maxTokens.source !== "configured" && projection.maxTokens.source !== "forced";
	return paramsEmpty ? <AbsentNote reason={l10n.t("No configured parameters match this model.")} /> : null;
}

/** The derivation line for max_tokens, formatted like every other token count on the panel: the same number in two renderings on one screen reads as two numbers. */
function MaxTokensLine({ projection }: MaxTokensLineProps) {
	const maxTokens = maxTokensParts(projection.maxTokens);
	return (
		<p className="max-tokens">
			<code className="max-tokens-name">max_tokens</code>{" "}
			<span className="max-tokens-value">{formatTokens(maxTokens.value)}</span>{" "}
			{maxTokens.source === undefined ? null : <Provenance source={maxTokens.source} />}{" "}
			{maxTokens.mark === undefined ? null : <Mark mark={maxTokens.mark} />}
			{maxTokens.reason === undefined ? null : <span className="hint">{maxTokens.reason}</span>}
		</p>
	);
}

/**
 * Fixed truth about the extension, not about this answer: the grid renders while the projection is still in flight,
 * because "Resolving parameters..." followed by nothing at all reads as a section that failed to load.
 *
 * "Sent with tools" is its own row rather than a qualifier trailing the always-sent line: "tools" appeared twice on
 * that line, three words apart and in two registers, leaving the reader to work out which one qualified which.
 *
 * max_tokens is forced from the derivation line, not from a row, and runtime options lose to it just the same - so the
 * runtime exception has to count it or this line contradicts the forced value rendered directly above it.
 */
function InspectorNotes({ projection, reasoning }: InspectorNotesProps) {
	const anyForced =
		projection !== undefined &&
		(projection.rows.some((row) => row.forced === true) || projection.maxTokens.source === "forced");
	return (
		<dl className="inspector-notes">
			<div>
				<dt>{l10n.t("Always sent")}</dt>
				<dd>
					{/* Separated by real whitespace, not by the margin alone: without it a screen reader
					    reads one run-together token. */}
					{ALWAYS_SENT_FIELDS.map((field, index) => (
						<Fragment key={field}>
							{index > 0 ? " " : null}
							<code>{field}</code>
						</Fragment>
					))}
				</dd>
			</div>
			<div>
				<dt>{l10n.t("Sent with tools")}</dt>
				<dd>
					<code>tools</code> <code>tool_choice</code>
				</dd>
			</div>
			<div>
				<dt>{l10n.t("Runtime options")}</dt>
				<dd className="hint">
					{anyForced
						? l10n.t("Overrides every table row above except forced rows.")
						: l10n.t("Overrides every table row above.")}
				</dd>
			</div>
			{reasoning ? (
				<div>
					{/* The label names the command that owns the pick, which is the only pointer to where
					    the value actually lives. */}
					<dt>{l10n.t("Configure Model pick")}</dt>
					<dd className="hint">{l10n.t("Overrides reasoning_effort here.")}</dd>
				</div>
			) : null}
		</dl>
	);
}

function ParametersSection({ ctx }: InspectorContextProps) {
	const { model, onEditRecord } = ctx;
	const answer = ctx.feeds.params;
	const projection = answer?.projection;
	const caps = ctx.feeds.caps?.capabilities;
	const sentCount = projection === undefined ? 0 : projection.rows.filter((row) => row.sent).length;
	return (
		<Section
			id={SECTION_ID.params}
			level={4}
			title={l10n.t("Parameters")}
			help={helpParamsInspector()}
			docs={{ href: DOCS_LINK_PARAMS_INSPECTOR, label: l10n.t("Open the effective-parameters guide") }}
			{...metaProps(sentCount, sentCount === 1 ? l10n.t("1 sent") : l10n.t("{0} sent", sentCount))}
			actions={
				onEditRecord === undefined ? undefined : (
					<ConfigureButton
						disabled={answer === undefined}
						label={l10n.t("Configure parameters for this model")}
						onClick={() => configureRecord("parameters", answer?.globalRecordKey, model.rawId, onEditRecord)}
					/>
				)
			}
		>
			<ParametersBody ctx={ctx} />
			{projection !== undefined && projection.diagnostics.length > 0 ? (
				<div className="record-problems">
					<h5 className="hint">{l10n.t("Record problems")}</h5>
					<ul>
						{projection.diagnostics.map((diagnostic) => (
							<li key={tupleKey(diagnostic.layer, diagnostic.recordKey, diagnostic.kind, diagnostic.key)}>
								{parameterDiagnosticText(diagnostic)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{/* What the model accepts, right beside what we send. Still a capability on the wire, so it rides
			    the capability feed and renders as soon as THAT answer lands. */}
			{caps === undefined ? null : (
				<SupportedParamsBlock
					fields={caps.fields}
					serverLabel={model.serverLabel}
					currencySymbol={ctx.currencySymbol}
					onEditField={ctx.editCapField}
				/>
			)}
			{projection === undefined ? null : <MaxTokensLine projection={projection} />}
			<InspectorNotes projection={projection} reasoning={model.reasoning} />
			<RecordChainFigure
				chains={answer?.chains}
				onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("parameters", key, false)}
				onEditEntry={ctx.onEditEntry}
			/>
		</Section>
	);
}

/** One FieldRow per present name, through capabilityField so a field named "toString" reads from the bag. */
function CapabilityRows({ ctx, fields, names }: CapabilityRowsProps) {
	return (
		<>
			{names.map((name) => {
				const field = capabilityField(fields, name);
				return field === undefined ? null : (
					<FieldRow
						key={name}
						name={name}
						field={field}
						serverLabel={ctx.model.serverLabel}
						currencySymbol={ctx.currencySymbol}
						onEditField={ctx.editCapField}
					/>
				);
			})}
		</>
	);
}

/** A record-problem list, or the quieter record-notes list for advisories; nothing while empty. */
function RecordProblems({ title, diagnostics, notes }: RecordProblemsProps) {
	if (diagnostics.length === 0) {
		return null;
	}
	return (
		<div className={notes ? "record-problems record-notes" : "record-problems"}>
			<h5 className="hint">{title}</h5>
			<ul>
				{diagnostics.map((diagnostic) => (
					<li
						key={tupleKey(diagnostic.layer, diagnostic.recordKey, diagnostic.key)}
						className={notes ? "hint" : undefined}
					>
						{capabilityDiagnosticText(diagnostic)}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The resolved capabilities once the feed answered. The declared/directive notes gate how the table reads, so they
 * stay ahead of it; the directive note is a standing note about the configuration, not an event: status, never alert,
 * so a push that re-renders the panel does not re-announce it.
 */
function CapabilitiesBody({ ctx, caps, partition }: CapabilitiesBodyProps) {
	const { capabilityNames, extraNames } = partition;
	return (
		<>
			{ctx.model.declared === true ? (
				<p className="hint">
					{l10n.t("Declared model: created by the entry's declared list, not discovered on the server.")}
				</p>
			) : null}
			{caps.directive?.kind === "not-found" ? (
				<p className="state-warn" role="status">
					{l10n.t(
						'OpenRouter model "{0}" was not found in the catalog; its fields fill from the remaining levels.',
						caps.directive.id
					)}
				</p>
			) : null}
			{capabilityNames.length > 0 || extraNames.length > 0 ? (
				<ResolutionTable nameHead={l10n.t("Capability")} valueHead={l10n.t("Value")}>
					<tbody>
						<CapabilityRows ctx={ctx} fields={caps.fields} names={capabilityNames} />
					</tbody>
					{extraNames.length > 0 ? (
						<tbody>
							<tr className="res-group">
								<th colSpan={3} scope="rowgroup">
									{l10n.t("Other fields")}
								</th>
							</tr>
							<CapabilityRows ctx={ctx} fields={caps.fields} names={extraNames} />
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
			<RecordProblems title={l10n.t("Record problems")} diagnostics={partition.problems} notes={false} />
			<RecordProblems title={l10n.t("Record notes")} diagnostics={partition.advisories} notes={true} />
		</>
	);
}

function CapabilitiesSection({ ctx, partition }: CapabilitiesSectionProps) {
	const { model, onEditRecord } = ctx;
	const answer = ctx.feeds.caps;
	const caps = answer?.capabilities;
	const fieldCount = partition.capabilityNames.length + partition.extraNames.length;
	let body: ReactNode;
	if (answer === undefined) {
		body = <FeedStatus text={l10n.t("Resolving capabilities...")} />;
	} else if (caps === undefined) {
		body = <FeedStatus text={l10n.t("The model list changed; close and reopen the inspector.")} />;
	} else {
		body = <CapabilitiesBody ctx={ctx} caps={caps} partition={partition} />;
	}
	return (
		<Section
			id={SECTION_ID.caps}
			level={4}
			title={l10n.t("Capabilities")}
			help={helpCapsInspector()}
			docs={{ href: DOCS_LINK_CAPS_INSPECTOR, label: l10n.t("Open the effective-capabilities guide") }}
			{...metaProps(fieldCount, fieldCount === 1 ? l10n.t("1 field") : l10n.t("{0} fields", fieldCount))}
			actions={
				onEditRecord === undefined ? undefined : (
					<ConfigureButton
						disabled={answer === undefined}
						label={l10n.t("Configure capabilities for this model")}
						onClick={() => configureRecord("capabilities", answer?.globalRecordKey, model.rawId, onEditRecord)}
					/>
				)
			}
		>
			{body}
			<RecordChainFigure
				chains={answer?.chains}
				onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("capabilities", key, false)}
				onEditEntry={ctx.onEditEntry}
			/>
		</Section>
	);
}

/**
 * The Pricing section stands whether or not the answer has landed: a pricing section that simply is not there while
 * capabilities resolve is the same vanishing act the absence state exists to prevent. Absence is a state, not a
 * missing section: a server that reports no prices (or the 0/0 pair that means the same thing) says so, and no number
 * is invented to fill the gap.
 */
function PricingSection({ ctx, pricingNames }: PricingSectionProps) {
	const answer = ctx.feeds.caps;
	const caps = answer?.capabilities;
	let body: ReactNode;
	if (answer === undefined) {
		body = <FeedStatus text={l10n.t("Resolving capabilities...")} />;
	} else if (caps === undefined) {
		body = <FeedStatus text={l10n.t("The model list changed; close and reopen the inspector.")} />;
	} else if (pricingNames.length > 0) {
		body = (
			<ResolutionTable nameHead={l10n.t("Tokens")} valueHead={l10n.t("Price")} numericValues>
				<tbody>
					<CapabilityRows ctx={ctx} fields={caps.fields} names={pricingNames} />
				</tbody>
			</ResolutionTable>
		);
	} else {
		body = <AbsentNote reason={l10n.t("No prices declared for this model, so spend cannot be estimated.")} />;
	}
	return (
		<Section id="inspector-pricing" level={4} title={l10n.t("Pricing")} meta={costUnitLabel(ctx.currencySymbol)}>
			{body}
		</Section>
	);
}

/** The model inspector: ONE read-only slide-over per model row, sectioned Parameters / Capabilities / Pricing. */
export function ModelInspector({
	model,
	stateSeq,
	currencySymbol,
	anchor,
	fallbackFocusId = sectionId("models"),
	onClose,
	onEditRecord,
	onEditEntry,
}: {
	/** The inspected row; its scopeKey and rawId address both feeds' requests. */
	model: DashboardModel;

	/** The configured cost prefix (usage.currencySymbol); every price on the panel renders through it. */
	currencySymbol: string;

	/** Bumped per state push; the inspector re-requests both feeds, so an open panel follows configuration edits. */
	stateSeq: number;

	/** Which section the panel scrolls to on open (the Diagnostics jump links); absent, it opens at the top. */
	anchor?: InspectorSection | undefined;

	/** Where focus lands on close when the opener is gone; the owner names a visible element (the active tab). */
	fallbackFocusId?: string;

	/** The close request; the panel is a SlideOver, so Esc, the scrim, and the X all post it. */
	onClose: () => void;

	/** The jump into a global record editor (RecordEditJump). */
	onEditRecord?: RecordEditJump | undefined;

	/** Jump into a server entry's edit form (the owner of entry-layer values). */
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	const feeds = useInspectorFeeds(model, stateSeq);
	useAnchorLanding(anchor, feeds);
	const ctx: InspectorContext = {
		model,
		currencySymbol,
		feeds,
		onEditRecord,
		onEditEntry,
		...editJumps(model, onEditRecord, onEditEntry),
	};
	const partition = capabilityPartition(feeds.caps?.capabilities);
	return (
		<SlideOver labelledBy="model-inspector-title" fallbackFocusId={fallbackFocusId} onRequestClose={onClose}>
			<div className="model-inspector">
				<InspectorHead model={model} />
				<ParametersSection ctx={ctx} />
				<CapabilitiesSection ctx={ctx} partition={partition} />
				<PricingSection ctx={ctx} pricingNames={partition.pricingNames} />
			</div>
		</SlideOver>
	);
}
