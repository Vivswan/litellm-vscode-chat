/**
 * The server form's field primitives: sections, rows and spans, the text and
 * secret fields with their stored-secret row, and the header rows editor.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { HeaderRow } from "../../dashboard/recordDraft";
import type {
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormProblems,
} from "../../dashboard/serverForm";
import { serverFormFieldLabel } from "../../dashboard/serverForm";
import type { SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import type { DocsUrl } from "./docsLinks";
import { Help } from "./help";
import { helpSecretStorage, serverFieldHelp } from "./helpText";
import { IconAdd, IconTrash } from "./icons";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { SecretInput } from "./ui/secretInput";
import { SectionHeader } from "./ui/section";

export function secretDraft(existing: SecretLocation): SecretFieldDraft {
	return { value: "", location: existing === "settings" ? "settings" : "secure", clear: false, existing };
}

/** One expected-failure category's checkbox label; endpoint paths stay English (protocol terms). */

function locationName(location: Exclude<SecretLocation, "none">): string {
	return location === "secure" ? l10n.t("secret storage") : l10n.t("settings");
}

export interface FieldRenderProps {
	readonly draft: ServerFormDraft;
	/**
	 * The problems the form shows right now, computed once per render in ServerForm; fields
	 * render these directly, so field decorations and the save summary cannot disagree.
	 */
	readonly visibleProblems: ServerFormProblems;
	readonly disabled: boolean;
	readonly patch: (patch: Partial<ServerFormDraft>) => void;
	readonly touch: (field: ServerFormField) => void;
}

/**
 * One section of the flat page - one scroll, no folds - so a section either belongs to the
 * required path or reads as an aside, which is the whole of what `quiet` says: it dims the
 * heading and label column; fields stay at full strength (a typed value is never quiet).
 */
export function FormSection({
	title,
	aside,
	help,
	docs,
	quiet,
	children,
}: {
	title: string;
	/** The heading's quiet trailing fact: "optional", plus a count where the section holds rows. */
	aside?: string;
	/**
	 * The section's detail, behind its "?". Required: a section with neither is a heading that
	 * explains nothing. The glyph is named for its section - a page with a dozen of them
	 * announces a dozen identical "Help" buttons otherwise.
	 */
	help: string;
	/** The section's docs anchor, on the header line in the primitive's docs slot. */
	docs?: { readonly href: DocsUrl; readonly label: string };
	quiet?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="form-section mt-6">
			{/* The shared header primitive: title, help, docs, meta, actions as SIBLINGS on the
			    .section-head line; the form's own scale rides the .form-section-head rules. Quiet
			    dims the whole line through inheritance; the fields below stay at full strength. */}
			<SectionHeader
				level={4}
				title={title}
				help={help}
				{...(docs !== undefined ? { docs } : {})}
				{...(aside !== undefined ? { meta: aside } : {})}
				className={cn("form-section-head mb-0.5", quiet === true && "text-muted-foreground")}
			/>
			{/* The rule's only paint is a fill, which forced colours repaint to
			    Canvas - the section seam vanished; restated in ink there. */}
			<div className="mt-2 mb-3 h-px bg-border forced-colors:bg-[CanvasText]" />
			{/* The section owns the tracks; every row adopts them through subgrid, which is what
			    gives shared sizing AND per-row placement (per-row grids let a docs link drag the
			    fr tracks; one flat grid cannot move the glyph track per breakpoint). The
			    breakpoint measures the PANE, not the viewport - the form narrows with rail, dock,
			    and split. The gutter is the settings rows' 10rem floor as a FLAT track: fixed,
			    the edge is uniform by construction in every locale; the form-records fixture
			    guard pins the label edge. */}
			<div
				className={cn(
					"grid grid-cols-[10rem_minmax(0,1.35fr)_minmax(0,1fr)_auto] gap-x-4 gap-y-2.5",
					"@max-[700px]/pane:grid-cols-[auto_minmax(0,1fr)] @max-[700px]/pane:gap-x-1.5 @max-[700px]/pane:gap-y-1",
					quiet === true && "[&_.label-row]:text-muted-foreground"
				)}
			>
				{children}
			</div>
		</div>
	);
}

/**
 * One row of the section grid: label in the gutter, control, hint (or the field's problem
 * in its place). A `wide` control takes the hint column and carries its own hint below;
 * a help-less wide one runs through the glyph track as well.
 */
export function FieldRow({
	htmlFor,
	label,
	help,
	hint,
	hintTone,
	problem,
	errorId,
	wide,
	children,
}: {
	/** The control's id; absent for rows whose control is a group rather than one input. */
	htmlFor?: string;
	label: string;
	help?: ReactNode;
	hint?: ReactNode;
	/** A hint that names a consequence rather than a fact (a secret about to land in plain text). */
	hintTone?: "warn";
	problem?: string | undefined;
	errorId?: string;
	wide?: boolean;
	children: ReactNode;
}) {
	const showProblem = problem !== undefined;
	// One row of the section's tracks via subgrid. Wide: gutter, control, hint, glyph.
	// Stacked below 700px of PANE - the threshold dashboard.css already stacks key/value
	// rows at, so the page changes idiom once.
	const GRID = cn(
		"col-span-4 grid grid-cols-subgrid items-center",
		// Only the column axis is subgridded, so the parent's row gap does not
		// reach between a stacked row's three lines: without this the hint sits
		// flush against the bottom of the input it explains.
		"@max-[700px]/pane:col-span-2 @max-[700px]/pane:items-start @max-[700px]/pane:gap-y-1"
	);
	return (
		<div className={GRID}>
			<span
				className={cn(
					"label-row col-start-1 flex items-baseline justify-end text-right text-[12.5px]",
					// Stacked, the label sits above its control, so right-aligning it
					// would push it away from the thing it names.
					"@max-[700px]/pane:justify-start @max-[700px]/pane:pt-1.5 @max-[700px]/pane:text-left",
					wide === true && "self-start pt-1"
				)}
			>
				{htmlFor !== undefined ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
			</span>
			<div
				className={cn(
					"col-start-2 row-start-1 flex min-w-0 items-center gap-2",
					// Stacked, the control takes both tracks on its own line: the
					// second track exists for the glyph beside the label.
					"@max-[700px]/pane:col-start-1 @max-[700px]/pane:col-span-2 @max-[700px]/pane:row-start-2",
					// A wide row spans the hint track; a help-less wide row runs through the glyph track
					// too, so the tables' trailing pencil column ends on the other rows' glyph edge.
					wide === true && "flex-col items-stretch gap-1",
					wide === true && (help === undefined ? "col-span-3" : "col-span-2")
				)}
			>
				{children}
			</div>
			{wide === true ? null : (
				// The hint cell carries the field's id in both voices: the hint stays in flow (invisible
				// while a problem stands, holding the reserved height) and the problem overlays the same
				// box, so a field going invalid never moves anything (the charter's transients clause).
				// min-height reserves one line for hint-less fields; only visible text is announced.
				// break-anywhere because a hint may now interpolate USER text - the MCP row names the
				// derived endpoint - and a long URL offers no break opportunity of its own.
				<span
					id={errorId}
					className={cn(
						"relative col-start-3 row-start-1 flex min-h-[1lh] items-baseline gap-1.5 text-[11.5px]",
						"[overflow-wrap:anywhere]",
						"@max-[700px]/pane:col-start-1 @max-[700px]/pane:col-span-2 @max-[700px]/pane:row-start-3"
					)}
				>
					<span
						className={cn(
							// One register at a time: the covering error hides this span whole, so the two
							// registers never paint together.
							hintTone === "warn" ? "state-warn" : "text-muted-foreground",
							showProblem && "invisible"
						)}
					>
						{hint}
					</span>
					{showProblem ? (
						// pointer-events-none like the settings overlay: it must never eat clicks aimed at the row.
						<span className="error pointer-events-none absolute inset-0">{problem}</span>
					) : null}
				</span>
			)}
			{/* Last in the DOM, so Tab reaches a field's control before its help. The glyph is the
			    ONLY thing this track carries - a row-level extra widens the auto track and jogs the
			    help column off the other sections'. A help-less row mounts no cell: an empty span
			    would block the wide control's span through the track. */}
			{help === undefined ? null : (
				<span
					className={cn(
						"col-start-4 flex items-baseline gap-1.5 self-center",
						"@max-[700px]/pane:col-start-2 @max-[700px]/pane:row-start-1 @max-[700px]/pane:justify-self-start @max-[700px]/pane:pt-1.5",
						// A wide row's control is tall (a textarea), and centring against
						// it drops the glyph a line below the label it belongs to.
						wide === true && "self-start pt-1"
					)}
				>
					{help}
				</span>
			)}
		</div>
	);
}

/** A note or control that belongs to the section but not to one field; spans the whole grid. */

export function FieldSpan({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("col-span-4 min-w-0 @max-[700px]/pane:col-span-2", className)}>{children}</div>;
}

/**
 * The line marking off an auth form's companions - second credentials sent beside the
 * chosen form's own. A real heading with "optional" in the meta slot; not a fold, since
 * there is nothing to open.
 */
export function CompanionNote() {
	return (
		<FieldSpan className="mt-2">
			<SectionHeader
				level={5}
				title={l10n.t("Companions")}
				meta={l10n.t("optional")}
				className="companions-head mb-0"
			/>
		</FieldSpan>
	);
}

/** A record section's heading note: optional always, plus how many matchers the entry carries. */

export function matcherCountAside(count: number): string {
	if (count === 0) {
		return l10n.t("optional");
	}
	return count === 1 ? l10n.t("optional - 1 matcher") : l10n.t("optional - {0} matchers", count);
}

/** The commit bar's unsaved-change count, resolved at call time (no module-level localized constants). */

export function unsavedText(count: number): string {
	return count === 1 ? l10n.t("1 unsaved change") : l10n.t("{0} unsaved changes", count);
}

/**
 * The shared commit bar: sticky, its rule meeting the page's 860px measure and bleeding
 * into .pane's 24px gutter when the pane is what limits it. The bleed is a CLAMP, not a
 * pane query: 860 sits inside the band the rail's collapse makes ambiguous (the same pane
 * width occurs on both sides, so a threshold flips - narrowThresholds.test.ts refuses it);
 * a continuous ramp cannot flip, and 884px = cap + full bleed starts it exactly where the
 * gutter stops being the limit. The z-index is the house footer level.
 */
export const COMMIT_BAR_CLASS =
	"toolbar sticky bottom-0 z-[2] mt-6 mb-[-48px] flex flex-wrap items-center gap-4 border-t border-border bg-background py-3 [--bleed:clamp(0px,884px_-_100cqw,24px)] mx-[calc(0px_-_var(--bleed))] px-[var(--bleed)]";

/** A control that belongs under the row above it: it clears the label gutter, and takes the full width once the rows stack. */

export function FieldUnderRow({ children, className }: { children: ReactNode; className?: string }) {
	return (
		// Placed in the grid rather than hand-padded past the gutter: a literal offset restates
		// the track width plus the gap, and the two drift the moment either changes.
		<div className="col-span-4 grid grid-cols-subgrid @max-[700px]/pane:col-span-2">
			<div
				className={cn(
					"col-start-2 col-span-3 flex min-w-0 flex-wrap items-center gap-3",
					"@max-[700px]/pane:col-start-1 @max-[700px]/pane:col-span-2",
					className
				)}
			>
				{children}
			</div>
		</div>
	);
}

export function TextField({
	field,
	placeholder,
	hint,
	mono,
	narrow,
	props,
}: {
	field: Exclude<
		ServerFormField,
		| SecretFieldId
		| "apiVersion"
		| "authForm"
		| "headers"
		| "declaredModels"
		| "mcp"
		| "modelParameters"
		| "modelCapabilities"
		| "expectedFailures"
	>;
	placeholder?: string;
	/** The line beside the field; the field's problem takes its place while one stands. */
	hint?: string;
	/** Machine text (URLs, header names, scopes) reads in the mono face. */
	mono?: boolean;
	/** A field whose values are short (a budget): the input stops at its own measure. */
	narrow?: boolean;
	props: FieldRenderProps;
}) {
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	return (
		<FieldRow
			htmlFor={id}
			label={serverFormFieldLabel(field)}
			help={<Help text={serverFieldHelp(field)} name={l10n.t("Help: {0}", serverFormFieldLabel(field))} />}
			{...(hint !== undefined ? { hint } : {})}
			problem={problem}
			errorId={errorId}
		>
			<Input
				id={id}
				type="text"
				className={cn(
					"min-w-0 flex-1",
					mono === true && "font-mono text-[12px]",
					narrow === true && "max-w-[9em] flex-none tabular-nums"
				)}
				placeholder={placeholder ?? ""}
				value={props.draft[field]}
				disabled={props.disabled}
				aria-invalid={showProblem}
				aria-describedby={errorId}
				onChange={(event) => props.patch({ [field]: event.currentTarget.value } as Partial<ServerFormDraft>)}
				onBlur={() => props.touch(field)}
			/>
		</FieldRow>
	);
}

/**
 * One secret field: a password input plus the per-field storage choice. Secure-side values
 * never reach this page; an inline value prefills masked (settings.json already shows it).
 * Empty input or unedited prefill keeps the stored value. Invariant: the page's ONLY
 * secret-bearing input - the uncontrolled SecretInput keeps the value out of the
 * serialized DOM (no controlled mirror, so no value attribute to leak).
 */
export function SecretField({ field, help, props }: { field: SecretFieldId; help?: string; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const [revealed, setRevealed] = useState(false);
	// Nothing to reveal in an empty or removal-marked field: the toggle disables and revealed
	// state resets, so the next value starts masked.
	const empty = value.value.trim().length === 0;
	useEffect(() => {
		if (empty || value.clear) {
			setRevealed(false);
		}
	}, [empty, value.clear]);
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	const patchSecret = (patch: Partial<SecretFieldDraft>) =>
		props.patch({ [field]: { ...value, ...patch } } as Partial<ServerFormDraft>);
	// One short line, only where it says what the reader cannot see: where the value is now,
	// or what Save will do with the typed one. A problem takes its place, so the row stays
	// one line tall; the two states need separate sentences (tense differs in translation).
	const unchangedPrefill =
		value.prefill !== undefined && value.value === value.prefill && value.location === "settings";
	const storageHint = value.clear
		? l10n.t("Removed on save.")
		: value.prefill !== undefined && empty
			? l10n.t("Emptied; the stored value is kept.")
			: unchangedPrefill
				? l10n.t("In settings.json, in plain text.")
				: !empty && value.location === "settings"
					? l10n.t("Saved as plain text in settings.json.")
					: value.existing !== "none" && empty
						? l10n.t("In {0}. Leave empty to keep it.", locationName(value.existing))
						: undefined;
	// Two states earn a tone: a value on its way into plain text, and a stored value on its
	// way out - consequences one Save away. An unchanged prefill states itself plainly.
	const hintTone =
		value.clear || (!empty && value.location === "settings" && !unchangedPrefill) ? ("warn" as const) : undefined;
	return (
		<>
			<FieldRow
				htmlFor={id}
				label={serverFormFieldLabel(field)}
				help={<Help text={help ?? serverFieldHelp(field)} name={l10n.t("Help: {0}", serverFormFieldLabel(field))} />}
				{...(storageHint !== undefined ? { hint: storageHint } : {})}
				{...(hintTone !== undefined ? { hintTone } : {})}
				problem={problem}
				errorId={errorId}
			>
				<span className="secret-input relative flex min-w-0 flex-1 items-center">
					<SecretInput
						id={id}
						// The reveal button is absolutely positioned over the field's
						// right edge; the padding keeps the value clear of it.
						className="min-w-0 flex-1 pr-13"
						type={revealed ? "text" : "password"}
						value={value.value}
						disabled={props.disabled || value.clear}
						aria-invalid={showProblem}
						aria-describedby={errorId}
						onValueChange={(next) => patchSecret({ value: next })}
						onBlur={() => props.touch(field)}
					/>
					<Button
						variant="secondary"
						size="compact"
						// mx-0: absolutely positioned against the input's edge, so the
						// primitive's layout hand-back would drag the box past `right-1`.
						className="absolute top-1/2 right-1 mx-0 -translate-y-1/2"
						aria-pressed={revealed}
						aria-label={
							revealed
								? l10n.t("Hide the {0}", serverFormFieldLabel(field))
								: l10n.t("Show the {0}", serverFormFieldLabel(field))
						}
						disabled={props.disabled || value.clear || empty}
						onClick={() => setRevealed((current) => !current)}
					>
						{revealed ? l10n.t("Hide") : l10n.t("Show")}
					</Button>
				</span>
			</FieldRow>
			<FieldUnderRow className="text-[11.5px] text-muted-foreground">
				<span
					className="secret-where flex flex-wrap items-center gap-x-3 gap-y-1"
					role="radiogroup"
					aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
				>
					{/* Stacked, the wrapped-apart options lost their shared left edge: the label and glyph
					    take the line together and the options share the next one. */}
					<span className="flex items-center gap-1.5 @max-[700px]/pane:basis-full">
						<span className="where-label">{l10n.t("Store in:")}</span>
						<Help
							text={helpSecretStorage()}
							name={l10n.t("Help: where to store the {0}", serverFormFieldLabel(field))}
						/>
					</span>
					<label className="flex items-center gap-1.5">
						<Radio
							name={`${id}-where`}
							checked={value.location === "secure"}
							disabled={props.disabled || value.clear}
							onChange={() => patchSecret({ location: "secure" })}
						/>
						{l10n.t("secret storage")}
					</label>
					<label className="flex items-center gap-1.5">
						<Radio
							name={`${id}-where`}
							checked={value.location === "settings"}
							disabled={props.disabled || value.clear}
							onChange={() => patchSecret({ location: "settings" })}
						/>
						{l10n.t("settings (visible)")}
					</label>
				</span>
			</FieldUnderRow>
			{/* Removal is destructive, so it takes a line of its own: beside the
			    storage radios it read as a third place to put the value. */}
			{value.existing !== "none" ? (
				<FieldUnderRow>
					<label className={cn("secret-remove flex items-center gap-1.5 text-[12px]", value.clear && "armed text-err")}>
						<Checkbox
							checked={value.clear}
							disabled={props.disabled}
							onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
						/>
						{l10n.t("Remove the stored {0} on save", serverFormFieldLabel(field))}
					</label>
				</FieldUnderRow>
			) : null}
		</>
	);
}

/**
 * Whether a field "holds content" for problem visibility: rows and lists count entries,
 * text and secret fields count their text.
 */
export function fieldHasContent(draft: ServerFormDraft, field: ServerFormField): boolean {
	if (
		field === "modelParameters" ||
		field === "modelCapabilities" ||
		field === "expectedFailures" ||
		field === "headers"
	) {
		return draft[field].length > 0;
	}
	if (field === "authForm") {
		// The selector always holds a pick and never carries a problem.
		return false;
	}
	if (field === "apiVersion") {
		// Only a custom mode with text counts: an empty custom surfaces on Save, which marks
		// every field touched.
		return draft.apiVersion.mode === "custom" && draft.apiVersion.custom.length > 0;
	}
	if (field === "mcp") {
		// The endpoint text is the only thing that can carry a problem; the
		// checkbox alone never does.
		return draft.mcp.enabled && draft.mcp.url.length > 0;
	}
	const value = draft[field];
	return typeof value === "string" ? value.length > 0 : value.value.length > 0;
}

/**
 * An inactive form's stored secret: keeps the Remove checkbox reachable without offering
 * an input (the parse would drop anything typed into an unselected form's field).
 */
export function StoredSecretRow({ field, props }: { field: SecretFieldId; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.visibleProblems[field];
	const patchSecret = (patch: Partial<SecretFieldDraft>) =>
		props.patch({ [field]: { ...value, ...patch } } as Partial<ServerFormDraft>);
	return (
		<FieldRow
			label={serverFormFieldLabel(field)}
			hint={
				value.clear
					? l10n.t("Removed on save.")
					: value.existing === "none"
						? undefined
						: l10n.t("In {0}.", locationName(value.existing))
			}
			problem={problem}
			// The same id the input-bearing row uses; the two never render together, so it stays unique.
			errorId={`server-${field}-error`}
		>
			<label className={cn("secret-remove flex items-center gap-1.5 text-[12px]", value.clear && "armed text-err")}>
				<Checkbox
					checked={value.clear}
					disabled={props.disabled}
					aria-invalid={problem !== undefined}
					aria-describedby={`server-${field}-error`}
					onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
				/>
				{l10n.t("Remove the stored {0} on save", serverFormFieldLabel(field))}
			</label>
		</FieldRow>
	);
}

/** The custom-header rows: the record editors' row idiom over the entry's headers record. */

export function HeaderRowsEditor({
	rows,
	problems,
	disabled,
	onChange,
}: {
	rows: readonly HeaderRow[];
	problems: readonly (string | undefined)[];
	disabled: boolean;
	onChange: (next: readonly HeaderRow[]) => void;
}) {
	return (
		<>
			{rows.map((row, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: header rows are positional while being edited; the index is the identity
				<div className="row flex flex-wrap items-center gap-2" key={index}>
					<Input
						type="text"
						// 204 = the 190px measure this input always showed plus padding and border, which
						// border-box counts inside the width; at 190 the placeholder lost three characters.
						className="key w-[204px] font-mono text-[12px]"
						aria-label={l10n.t("Header name")}
						aria-invalid={problems[index] !== undefined}
						placeholder={l10n.t("Header, e.g. x-routing-env")}
						value={row.name}
						disabled={disabled}
						onChange={(event) =>
							onChange(rows.map((r, i) => (i === index ? { ...r, name: event.currentTarget.value } : r)))
						}
					/>
					<Input
						type="text"
						className="value min-w-0 flex-1 font-mono text-[12px]"
						aria-invalid={problems[index] !== undefined}
						aria-label={l10n.t("Header value")}
						placeholder={l10n.t("Value, e.g. prod")}
						value={row.valueText}
						disabled={disabled}
						onChange={(event) =>
							onChange(rows.map((r, i) => (i === index ? { ...r, valueText: event.currentTarget.value } : r)))
						}
					/>
					<Button
						variant="danger"
						size="compact"
						disabled={disabled}
						onClick={() => onChange(rows.filter((_, i) => i !== index))}
					>
						<IconTrash /> {l10n.t("Remove")}
					</Button>
					{/* Reserved whether or not it speaks (min-height 1lh, the shared
					    .row .row-status rule): the verdict lands per keystroke, and a
					    line mounted only when it speaks moves the row below. */}
					<span className={cn("row-status basis-full text-[11.5px]", problems[index] !== undefined && "error")}>
						{problems[index]}
					</span>
				</div>
			))}
			<div>
				<Button
					variant="secondary"
					disabled={disabled}
					onClick={() => onChange([...rows, { name: "", valueText: "" }])}
				>
					<IconAdd /> {l10n.t("Add header")}
				</Button>
			</div>
		</>
	);
}

/**
 * The inline Add/Edit form. Save posts one saveServerSetting intent and waits for its
 * correlated outcome: ok closes; a validation fail returns to editing; an operation fail
 * closes too - the save committed, so the draft is stale and the section notice carries
 * the recovery. Unrelated state pushes leave it alone.
 */
