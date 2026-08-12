/**
 * The model inspector: ONE read-only slide-over per model row, sectioned
 * Parameters / Capabilities / Pricing, replacing the former separate
 * parameters and capabilities panels. Request/response-fed on both feeds: it
 * posts readModelParameters AND readModelCapabilities on open (and on every
 * state push) and renders each section when its own answer lands - the
 * extension resolves both through the SAME shared machinery the request path
 * and registration read, so neither section can drift from the wire. No
 * resolver logic and no catalog data live in the webview; the answers are
 * data.
 *
 * Placement decisions worth naming: answers first, machinery last - each
 * section leads with its table (what we send, what the model can do) and
 * closes with the fixed caveats and the record-path figure behind a collapsed
 * "Record paths" disclosure, because a reader opens Inspect for the values and
 * only sometimes for why they won. The supported-parameters list is still a
 * CAPABILITY on the wire (it resolves with the capability walk and its rows
 * jump into capability records), but it renders in the Parameters section -
 * what the model accepts belongs next to what we send. Pricing renders
 * exactly once, in its provenance-aware section; the old params-side pricing
 * fact lines are gone, and the header keeps only the orientation line (family
 * and capability chips) - the token limits live in the capabilities table
 * with provenance instead of repeating above it.
 */

import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { ResponseFor } from "../../dashboard/endpoints";
import { formatJsonValue } from "../../dashboard/presenters";
import type { DashboardModel, RecordChainView } from "../../dashboard/viewModels";
import {
	COST_CAPABILITY_FIELDS,
	capabilityDisplayLabel,
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
import { capabilityField, FALLBACK_DIRECTIVE } from "../../shared/config/capabilityResolution";
import type {
	EffectiveParameterRow,
	ParameterDiagnostic,
	ParameterSourceRef,
	ProjectedMaxTokens,
	ShadowedParameterValue,
} from "../../shared/config/parameterResolution";
import { DEFAULT_MAX_TOKENS_CAP } from "../../shared/config/parameterResolution";
import { DOCS_LINK_CAPS_INSPECTOR, DOCS_LINK_PARAMS_INSPECTOR } from "./docsLinks";
import { DocsLink, Help, HoverTip } from "./help";
import { helpCapsInspector, helpParamsInspector } from "./helpText";
import { useRpc } from "./hooks";
import { capabilityList, formatTokens } from "./models";
import { chainsWithStory, RecordChainFigure } from "./recordChain";
import { SlideOver } from "./slideOver";
import { Button } from "./ui/button";

/** The readModelParameters answer; the inspector's own useRpc instance correlates it. */
export type ModelParametersResponse = ResponseFor<"readModelParameters">;

/** The readModelCapabilities answer; the inspector's own useRpc instance correlates it. */
export type ModelCapabilitiesResponse = ResponseFor<"readModelCapabilities">;

/** The panel's addressable sections; the Diagnostics table's jump links land on one. */
export type InspectorSection = "params" | "caps";

/** The parameter Source column's naming: the layer that set the value plus its winning record key. */
function sourceName(ref: ParameterSourceRef): string {
	return ref.layer === "entry"
		? l10n.t('Server entry "{0}" - {1}', ref.entryLabel, ref.key)
		: l10n.t("Settings - {0}", ref.key);
}

/** The not-sent annotations, resolved at call time (no module-level localized constants). */
function skipReasonText(reason: "underscore" | "provider-owned"): string {
	return reason === "underscore"
		? l10n.t("not sent: keys starting with _ are directives - instructions to the extension, never sent")
		: l10n.t("not sent: a provider-owned request field, never overridable");
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

/** The request fields the extension itself owns; rendered as chips, never prose. */
const ALWAYS_SENT_FIELDS = ["model", "messages", "stream", "stream_options", "max_tokens"] as const;

/** The max_tokens derivation, split into the value and one short reason per branch. */
function maxTokensParts(maxTokens: ProjectedMaxTokens): { value: number; reason: string } {
	switch (maxTokens.source) {
		case "forced":
			return {
				value: maxTokens.value,
				reason:
					maxTokens.configuredSource !== undefined
						? l10n.t("forced by {0}; overrides runtime options and the picker", sourceName(maxTokens.configuredSource))
						: l10n.t("forced in configuration; overrides runtime options and the picker"),
			};
		case "configured":
			return {
				value: maxTokens.value,
				reason:
					maxTokens.configuredSource !== undefined
						? l10n.t("set by {0}", sourceName(maxTokens.configuredSource))
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

function ParamShadowedLine({ shadow }: { shadow: ShadowedParameterValue }) {
	return (
		<tr className="param-shadowed">
			<td />
			<td className="param-value">{formatJsonValue(shadow.value)}</td>
			<td>{l10n.t("overridden: {0}", sourceName(shadow))}</td>
		</tr>
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
			<tr className={row.sent ? undefined : "param-not-sent"}>
				<td className="param-name">{row.name}</td>
				<td className="param-value">{formatJsonValue(row.value)}</td>
				<td>
					{sourceName(row.source)}
					{onEditSource !== undefined ? (
						<Button
							variant="quiet"
							className="row-edit px-0.5 py-0"
							aria-label={
								row.source.layer === "entry"
									? l10n.t('Edit in server entry "{0}"', row.source.entryLabel)
									: l10n.t('Edit record "{0}" in settings', row.source.key)
							}
							onClick={() => onEditSource(row.source)}
						>
							{l10n.t("edit")}
						</Button>
					) : null}
					{row.inheritedFrom !== undefined ? (
						<span className="param-skip"> ({l10n.t("inherited from {0}", row.inheritedFrom)})</span>
					) : null}
					{row.skipReason !== undefined ? (
						<span className="param-skip"> ({skipReasonText(row.skipReason)})</span>
					) : null}
					{row.forced === true ? (
						<span className="param-skip"> ({l10n.t("forced: overrides runtime options and the picker")})</span>
					) : null}
				</td>
			</tr>
			{row.shadowed.map((shadow) => (
				<ParamShadowedLine key={`${shadow.layer}/${shadow.key}`} shadow={shadow} />
			))}
		</>
	);
}

/**
 * The capability fields in display order after the token trio and support
 * flags come the consumed booleans (CONSUMED_BOOLEAN_ORDER); pricing and the
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
		<td className="param-value">
			{approxWidthCh(text) > VALUE_CLIP_CH ? (
				<HoverTip focusable tip={text}>
					<span className="param-value-clip">{text}</span>
				</HoverTip>
			) : (
				text
			)}
		</td>
	);
}

/**
 * One capability name cell: consumed fields render their localized labels
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
 * One capability value as the table shows it: booleans as yes/no, the token
 * trio as token counts, the cost fields as dollars per million tokens (their
 * section header names the unit), the params list as its count (the full
 * list renders whole on its own row, see SupportedParamsBlock), other numbers
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
		// (SupportedParamsBlock), one element per name so boundaries survive
		// without JSON quoting; shadowed lists stay count-only (their record
		// holds the value).
		return parameterCountText(value.length);
	}
	return JSON.stringify(value) ?? "";
}

/** The capability Source column's naming: the precedence level that set the value plus its winning key. */
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

function CapShadowedLine({ name, shadow }: { name: string; shadow: ShadowedCapabilityValue }) {
	return (
		<tr className="param-shadowed">
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
				<td className="param-name">
					<FieldName name={name} />
				</td>
				{plainValue ? (
					<td className="param-value param-plain">{formatValue(name, field.value)}</td>
				) : (
					<ValueCell text={formatValue(name, field.value)} />
				)}
				<td>
					{levelName(field.level, field.key)}
					{editable ? (
						<Button
							variant="quiet"
							className="row-edit px-0.5 py-0"
							aria-label={l10n.t('Edit record "{0}"', field.key ?? "")}
							onClick={() => onEditField?.(field.level, field.key ?? "")}
						>
							{l10n.t("edit")}
						</Button>
					) : null}
					{field.inheritedFrom !== undefined ? (
						<span className="param-skip"> ({l10n.t("inherited from {0}", field.inheritedFrom)})</span>
					) : null}
				</td>
			</tr>
			{field.shadowed.map((shadow) => (
				<CapShadowedLine key={`${shadow.level}/${shadow.key ?? ""}`} name={name} shadow={shadow} />
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
 * The capability tables' shared column tracks: fixed shares matching the old
 * thead-width rules, carried by a colgroup so the header-less tables (the
 * pricing and supported-params blocks) keep the same fixed layout as the
 * headed one and every provenance table in the panel aligns.
 */
function CapsColumns() {
	return (
		<colgroup>
			<col className="caps-col-name" />
			<col className="caps-col-value" />
			<col />
		</colgroup>
	);
}

/**
 * A visually collapsed header row for the band-labeled tables (pricing,
 * supported params): the band above carries the visible label, but each
 * table is its own element, so assistive tech needs its own column headers -
 * the ths collapse to nothing on screen (the caps-head-hidden rule) while
 * their clipped spans keep the names readable.
 */
function HiddenColumnHeads() {
	return (
		<thead className="caps-head-hidden">
			<tr>
				<th>
					<span className="visually-hidden">{l10n.t("Capability")}</span>
				</th>
				<th>
					<span className="visually-hidden">{l10n.t("Value")}</span>
				</th>
				<th>
					<span className="visually-hidden">{l10n.t("Source")}</span>
				</th>
			</tr>
		</thead>
	);
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
				<tr className="caps-section">
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
 * The Supported parameters block, rendered in the PARAMETERS section next to
 * the effective sends (what the model accepts beside what we send) while the
 * field stays a capability on the wire: the standard provenance row carries
 * the count (plain, no clip-tip), and the winning list renders in full on a
 * row of its own spanning the table - the panel is the detail surface, so the
 * list never hides behind a tip. One element per name keeps boundaries
 * unambiguous without JSON quoting.
 */
function SupportedParamsBlock({
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
	// Sorted for scanning: the wire order of supported_openai_params carries
	// no meaning (it is a set), and 30 pills are findable only alphabetically.
	// Code-unit sort - these are wire identifiers, not display text.
	const items = (
		Array.isArray(field.value) ? field.value.filter((item): item is string => typeof item === "string") : []
	).sort();
	return (
		<div className="caps-inspector">
			<table className="params">
				<CapsColumns />
				<HiddenColumnHeads />
				<tbody>
					<tr className="caps-section">
						<th colSpan={3} scope="rowgroup">
							{l10n.t("Supported parameters")}
						</th>
					</tr>
					<FieldRow name="supported_openai_params" field={field} onEditField={onEditField} plainValue />
					{items.length > 0 ? (
						<tr className="caps-params-row">
							<td colSpan={3}>
								<ul className="caps-params-list" aria-label={l10n.t("Supported parameters")}>
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
			</table>
		</div>
	);
}

/**
 * One section's header band: the caps-section idiom lifted to the panel level,
 * with its glyphs beside the label and the section's one action (the
 * configure-jump) right-aligned on the same line. The anchor id and the
 * focusable heading stay on the h4 itself - the Diagnostics jump lands there.
 */
function SectionTitle({
	id,
	label,
	help,
	helpName,
	docs,
	action,
}: {
	id: string;
	label: string;
	help?: string;
	/** The help glyph's accessible name ("About effective parameters"), not the bare section word. */
	helpName?: string | undefined;
	docs?: ReactNode;
	/** The band's right-aligned action; outside the h4 so the heading's name stays the section word. */
	action?: ReactNode;
}) {
	return (
		<div className="inspector-section-head">
			<h4 className="inspector-section" id={id} tabIndex={-1}>
				{label}
				{help !== undefined && helpName !== undefined ? <Help text={help} name={helpName} /> : null}
				{docs}
			</h4>
			{action}
		</div>
	);
}

/**
 * A section's record-path figures behind one collapsed disclosure: they
 * explain WHY a value won (the machinery), so they close the section instead
 * of preceding its answers. No chain with a story, no disclosure - an empty
 * details would promise detail it cannot show. Controlled open state: every
 * state push orphans the answers and unmounts this element until the fresh
 * ones land, and an uncontrolled details would remount collapsed under a
 * reader mid-chain.
 */
function RecordPathsDetails({
	chains,
	open,
	onToggle,
	onEditRecord,
	onEditEntry,
}: {
	chains: readonly RecordChainView[] | undefined;
	open: boolean;
	onToggle: (open: boolean) => void;
	onEditRecord?: ((key: string) => void) | undefined;
	onEditEntry?: ((label: string) => void) | undefined;
}) {
	if (chainsWithStory(chains).length === 0) {
		return null;
	}
	return (
		<details className="record-paths" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
			<summary>{l10n.t("Record paths")}</summary>
			<RecordChainFigure chains={chains} onEditRecord={onEditRecord} onEditEntry={onEditEntry} />
		</details>
	);
}

export function ModelInspector({
	model,
	stateSeq,
	anchor,
	fallbackFocusId = "models-section",
	onClose,
	onEditRecord,
	onEditEntry,
}: {
	model: DashboardModel;
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
	// The disclosures' controlled open state (see RecordPathsDetails), one per section.
	const [paramsPathsOpen, setParamsPathsOpen] = useState(false);
	const [capsPathsOpen, setCapsPathsOpen] = useState(false);

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

	// The Diagnostics jump's landing: move focus AND the reading position to
	// the named section heading (focus once - the slide-over's own first-field
	// focus must not win over the requested section, but later re-runs must
	// not yank focus back either), then re-scroll as each answer lands -
	// content filling in above the target moves it. The re-scrolls stop FOR
	// GOOD once both feeds have answered once: readiness flips false again on
	// every state push (fresh requestIds orphan the old answers), and a reader
	// who scrolled away must not be yanked back to the anchor by a
	// configuration change landing minutes later.
	const paramsReady = answeredParams !== undefined;
	const capsReady = answeredCaps !== undefined;
	const anchorFocused = useRef(false);
	const anchorSettled = useRef(false);
	useEffect(() => {
		if (anchor === undefined || anchorSettled.current) {
			return;
		}
		const target = document.getElementById(anchor === "caps" ? "inspector-section-caps" : "inspector-section-params");
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

	// The capability section partition over the resolved bag: the capabilities
	// (core order plus the consumed booleans, then the open extras sorted by
	// wire key - code-unit order, these are wire identifiers), the pricing
	// fields (base tier then long-context) in their own section, and the
	// params list up in the Parameters section. Object.keys reads own
	// properties only, and the per-name reads go through capabilityField: a
	// field named "toString" must read from the bag, never Object.prototype.
	const present = new Set(caps === undefined ? [] : Object.keys(caps.fields));
	const capabilityNames = [...FIELD_ORDER, ...CONSUMED_BOOLEAN_ORDER].filter((name) => present.has(name));
	const pricingNames = COST_CAPABILITY_FIELDS.filter((name) => present.has(name));
	const sectioned = new Set([...capabilityNames, ...pricingNames, "supported_openai_params"]);
	const extraNames = [...present].filter((name) => !sectioned.has(name)).sort();
	const advisories = caps === undefined ? [] : caps.diagnostics.filter((d) => d.kind === "unrecognized-key");
	const problems = caps === undefined ? [] : caps.diagnostics.filter((d) => d.kind !== "unrecognized-key");
	const capabilityChips = capabilityList(model);

	return (
		<SlideOver
			labelledBy="model-inspector-title"
			fallbackFocusId={fallbackFocusId}
			confirming={false}
			onRequestClose={onClose}
			onKeepEditing={onClose}
			onDiscard={onClose}
		>
			<div className="params-inspector model-inspector">
				<h3 id="model-inspector-title">{model.name}</h3>
				<p className="hint params-identity">
					{l10n.t({
						message: "{0} on {1}",
						args: [model.rawId, model.serverLabel],
						comment: ["{0} is a model ID, {1} is the server it is served from"],
					})}
				</p>
				{/* The token limits deliberately do NOT repeat here - the
				    capabilities table below carries them with provenance. */}
				<dl className="model-orientation">
					<dt className="params-caveat-label">{l10n.t("Family")}</dt>
					<dd>{model.family}</dd>
					<dt className="params-caveat-label">{l10n.t("Capabilities")}</dt>
					<dd>
						{capabilityChips.length > 0 ? (
							capabilityChips.map((cap) => (
								<span className="cap-chip" key={cap}>
									{cap}
								</span>
							))
						) : (
							<span className="hint">{l10n.t("none declared")}</span>
						)}
					</dd>
				</dl>
				<section aria-labelledby="inspector-section-params">
					<SectionTitle
						id="inspector-section-params"
						label={l10n.t("Parameters")}
						help={helpParamsInspector()}
						helpName={l10n.t("About effective parameters")}
						docs={<DocsLink href={DOCS_LINK_PARAMS_INSPECTOR} label={l10n.t("Open the effective-parameters guide")} />}
						action={
							onEditRecord !== undefined ? (
								<Button
									variant="quiet"
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
					/>
					{answeredParams === undefined ? (
						<p className="hint" role="status">
							{l10n.t("Resolving parameters...")}
						</p>
					) : projection === undefined ? (
						<p className="hint" role="status">
							{l10n.t("The model list changed; close and reopen the inspector.")}
						</p>
					) : projection.rows.length > 0 ? (
						<table className="params">
							<CapsColumns />
							<thead>
								<tr>
									<th>{l10n.t("Parameter")}</th>
									<th>{l10n.t("Value")}</th>
									<th>{l10n.t("Source")}</th>
								</tr>
							</thead>
							<tbody>
								{projection.rows.map((row) => (
									<ParameterRow key={row.name} row={row} onEditSource={editParamSource} />
								))}
							</tbody>
						</table>
					) : paramsEmpty ? (
						<p className="hint params-empty">{l10n.t("No configured parameters match this model.")}</p>
					) : null}
					{projection !== undefined && projection.diagnostics.length > 0 ? (
						<div className="params-replaced">
							<p className="hint">{l10n.t("Configuration problems in the matched records:")}</p>
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
					{caps !== undefined ? <SupportedParamsBlock fields={caps.fields} onEditField={editCapField} /> : null}
					{projection !== undefined ? (
						<p className="params-max-tokens">
							<code>max_tokens {maxTokensParts(projection.maxTokens).value}</code>
							<span className="hint"> {maxTokensParts(projection.maxTokens).reason}</span>
						</p>
					) : null}
					<div className="params-fixed">
						<span className="params-caveat-label">{l10n.t("Always sent")}</span>
						{ALWAYS_SENT_FIELDS.map((field) => (
							<code key={field}>{field}</code>
						))}
						<span className="hint">{l10n.t("+ tools, tool_choice with tools; not overridable")}</span>
					</div>
					{projection !== undefined ? (
						<dl className="params-caveats">
							<div>
								<dt className="params-caveat-label">{l10n.t("Runtime options")}</dt>
								<dd className="hint">
									{projection.rows.some((row) => row.forced === true)
										? l10n.t("Set per request by the chat client; they override every row above except forced rows.")
										: l10n.t("Set per request by the chat client; they override every row above.")}
								</dd>
							</div>
							{model.reasoning ? (
								<div>
									<dt className="params-caveat-label">{l10n.t("Picker: reasoning effort")}</dt>
									<dd className="hint">
										{l10n.t("Chosen in Configure Model and stored by VS Code; overrides reasoning_effort here.")}
									</dd>
								</div>
							) : null}
						</dl>
					) : null}
					<RecordPathsDetails
						chains={answeredParams?.chains}
						open={paramsPathsOpen}
						onToggle={setParamsPathsOpen}
						onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("parameters", key, false)}
						onEditEntry={onEditEntry}
					/>
				</section>
				<section aria-labelledby="inspector-section-caps">
					<SectionTitle
						id="inspector-section-caps"
						label={l10n.t("Capabilities")}
						help={helpCapsInspector()}
						helpName={l10n.t("About effective capabilities")}
						docs={<DocsLink href={DOCS_LINK_CAPS_INSPECTOR} label={l10n.t("Open the effective-capabilities guide")} />}
						action={
							onEditRecord !== undefined ? (
								<Button
									variant="quiet"
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
					/>
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
								<div className="caps-inspector">
									<table className="params">
										<CapsColumns />
										<thead>
											<tr>
												<th>{l10n.t("Capability")}</th>
												<th>{l10n.t("Value")}</th>
												<th>{l10n.t("Source")}</th>
											</tr>
										</thead>
										{/* Unlabeled: the section's own header already names these
										    rows; only the open extras get an inner band. */}
										<CapsSection names={capabilityNames} fields={caps.fields} onEditField={editCapField} />
										<CapsSection
											label={l10n.t("Other fields")}
											names={extraNames}
											fields={caps.fields}
											onEditField={editCapField}
										/>
									</table>
								</div>
							) : null}
							<p className="params-max-tokens">
								<span className="hint">{outputLimitNote(caps)}</span>
							</p>
							{problems.length > 0 ? (
								<div className="params-replaced">
									<p className="hint">{l10n.t("Configuration problems in the matched records:")}</p>
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
								<div className="params-replaced params-advisories">
									<p className="hint">{l10n.t("Notes on the matched records:")}</p>
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
					<RecordPathsDetails
						chains={answeredCaps?.chains}
						open={capsPathsOpen}
						onToggle={setCapsPathsOpen}
						onEditRecord={onEditRecord === undefined ? undefined : (key) => onEditRecord("capabilities", key, false)}
						onEditEntry={onEditEntry}
					/>
				</section>
				{caps !== undefined && pricingNames.length > 0 ? (
					<section aria-labelledby="inspector-section-pricing">
						<SectionTitle
							id="inspector-section-pricing"
							label={l10n.t({
								message: "Pricing ($/M tokens)",
								comment: ["Section header; $/M is US dollars per million tokens"],
							})}
						/>
						<div className="caps-inspector">
							<table className="params">
								<CapsColumns />
								<HiddenColumnHeads />
								<CapsSection names={pricingNames} fields={caps.fields} onEditField={editCapField} />
							</table>
						</div>
					</section>
				) : null}
			</div>
		</SlideOver>
	);
}
