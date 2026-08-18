/**
 * The server edit surface: the add/edit form, the adopt form, and the field machinery.
 * The boundary outward is deliberately narrow - the draft is dirty, the user asked to
 * leave - and the module knows nothing about what is mounted around it.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GroupProblems, HeaderRow } from "../../dashboard/recordDraft";
import { toCapabilityGroups, toGroups, toggleExpectedFailure, toHeaderRows } from "../../dashboard/recordDraft";
import type {
	ApiVersionDraft,
	AuthFormId,
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormProblems,
} from "../../dashboard/serverForm";
import {
	apiVersionDraftOf,
	applyInlinePrefill,
	CONNECTION_FIELDS,
	changedServerFormFields,
	deriveAuthForm,
	EMPTY_SERVER_FORM,
	isUsableHttpUrl,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	storedInactiveSecrets,
	validateAdoptLabel,
} from "../../dashboard/serverForm";
import type { DashboardServer, DeclaredDashboardServer, ExternalDashboardServer } from "../../dashboard/viewModels";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { SetupHintKind, TransportErrorClassification } from "../../shared/errorClassification";
import type { ExpectedFailureCategory, SecretFieldId, SecretLocation } from "../../shared/serverEntry";
import { EXPECTED_FAILURE_CATEGORIES, SECRET_FIELD_IDS } from "../../shared/serverEntry";
import { DEFAULT_API_VERSION } from "../../shared/util/baseUrl";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_CHECK_BASE_URL,
	DOCS_LINK_CONFIGURE_API_KEY,
	DOCS_LINK_DECLARED_MODELS,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_MODEL_PARAMETERS,
	DOCS_LINK_PROXY_NOT_RUNNING,
	DOCS_LINK_SERVER_FORM,
} from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink, Help } from "./help";
import {
	helpAdoptionSection,
	helpConnectionSection,
	helpDiscoverySection,
	helpEntryModelParameterPrefix,
	helpOauthCompanionApiKey,
	helpSecretStorage,
	serverFieldHelp,
} from "./helpText";
import { useIntentOutcome, useRpc } from "./hooks";
import { IconAdd, IconArrowLeft, IconPlug, IconTrash } from "./icons";
import type { RecordEditorKind } from "./recordEditors";
import {
	capabilityIssueViews,
	capabilityKeySuggestions,
	paramIssueViews,
	RecordMatcherEditorOverlay,
	RecordMatcherTable,
} from "./recordEditors";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { SecretInput } from "./ui/secretInput";
import { SectionHeader } from "./ui/section";
import { Select } from "./ui/select";
import { sendRequest } from "./vscodeApi";

/**
 * Where a saved entry lands. A setting ID is a protocol term (English, module constant);
 * the save bar shows it because a page that writes a settings file should say so.
 */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/** What the open form is for, decided once where it opens so no component re-derives it. */
export type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: DeclaredDashboardServer }
	| { readonly kind: "adopt"; readonly server: ExternalDashboardServer };

/** The targets ServerForm handles; adoption renders AdoptForm instead. */
type ServerFormTarget = Extract<FormTarget, { kind: "add" | "edit" }>;

/**
 * The edit form's live hint evidence: the CURRENT row's observed /model/info key set,
 * looked up per render rather than from the form's frozen open-time snapshot - a
 * discovery pass finishing under an open form must update the unknown-key hints.
 */
function observedKeysForForm(
	servers: readonly DashboardServer[],
	target: ServerFormTarget
): readonly string[] | undefined {
	if (target.kind !== "edit") {
		return undefined;
	}
	const row = servers.find((server) => server.origin === "declared" && server.label === target.original.label);
	return row?.observedModelInfoKeys;
}

/**
 * What the shell asked this page to be, by IDENTITY rather than by object: resolved against
 * the live state on every render, so a changed entry is followed and a vanished one says so.
 */
export type ServerEditRequest =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly label: string }
	| { readonly kind: "adopt"; readonly handle: string };

/**
 * Where the form is in its life. Prefill and save each run their own correlation, but the
 * form is only ever in one; fields stay editable throughout, only Save gates on "editing".
 */
type FormPhase =
	| { readonly phase: "prefill" }
	| { readonly phase: "editing" }
	| { readonly phase: "saving"; readonly requestId: string };

/**
 * The draft test's own lifecycle, independent of FormPhase: a test in flight must not gate
 * editing, saving, or cancelling. Leaving "testing" abandons the in-flight requestId, so a
 * late outcome is ignored - exactly what clearing on an edit needs.
 */
type TestState =
	| { readonly kind: "idle" }
	| { readonly kind: "testing"; readonly requestId: string }
	| { readonly kind: "pass"; readonly text: string }
	| {
			readonly kind: "fail";
			readonly text: string;
			readonly classification?: TransportErrorClassification | undefined;
	  };

/**
 * The troubleshooting-guide section behind a setup-hint id (see shared/errorClassification.ts).
 * Labels resolve per call so the l10n bundle is honored; shared by the draft-test footer and
 * the servers error banner, so a classified failure links the same section everywhere.
 */
export function troubleshootingLink(hint: SetupHintKind): { href: DocsUrl; label: string; topic: string } {
	switch (hint) {
		case "proxy-not-running":
			return {
				href: DOCS_LINK_PROXY_NOT_RUNNING,
				label: l10n.t("Open the troubleshooting guide: unable to connect"),
				topic: l10n.t("unable to connect"),
			};
		case "configure-api-key":
			return {
				href: DOCS_LINK_CONFIGURE_API_KEY,
				label: l10n.t("Open the troubleshooting guide: authentication failed"),
				topic: l10n.t("authentication failed"),
			};
		case "check-base-url":
			return {
				href: DOCS_LINK_CHECK_BASE_URL,
				label: l10n.t("Open the troubleshooting guide: the server answered 404"),
				topic: l10n.t("the server answered 404"),
			};
	}
}

function secretDraft(existing: SecretLocation): SecretFieldDraft {
	return { value: "", location: existing === "settings" ? "settings" : "secure", clear: false, existing };
}

/** One expected-failure category's checkbox label; endpoint paths stay English (protocol terms). */
function expectedFailureLabel(category: ExpectedFailureCategory): string {
	switch (category) {
		case "modelListing":
			return l10n.t({
				message: "Model listing (/models)",
				comment: ["Do not translate /models; it is an HTTP endpoint path."],
			});
		case "modelInfo":
			return l10n.t({
				message: "Model info (/model/info)",
				comment: ["Do not translate /model/info; it is an HTTP endpoint path."],
			});
	}
}

function draftFor(target: ServerFormTarget): ServerFormDraft {
	if (target.kind === "add") {
		return EMPTY_SERVER_FORM;
	}
	const original = target.original;
	return {
		label: original.label,
		baseUrl: original.baseUrl,
		apiVersion: apiVersionDraftOf(original.config.apiVersion),
		authForm: deriveAuthForm(original.config),
		oauthTokenUrl: original.config.oauthTokenUrl ?? "",
		oauthClientId: original.config.oauthClientId ?? "",
		oauthScopes: original.config.oauthScopes ?? "",
		virtualKeyHeader: original.config.virtualKeyHeader ?? "",
		apiKey: secretDraft(original.config.secrets.apiKey),
		oauthClientSecret: secretDraft(original.config.secrets.oauthClientSecret),
		virtualKeyValue: secretDraft(original.config.secrets.virtualKeyValue),
		headers: toHeaderRows(original.config.headers ?? {}),
		declaredModels: (original.config.declaredModels ?? []).join("\n"),
		budget: original.config.budget !== undefined ? String(original.config.budget) : "",
		modelParameters: toGroups(original.config.modelParameters ?? {}),
		modelCapabilities: toCapabilityGroups(original.config.modelCapabilities ?? {}),
		expectedFailures: original.config.expectedFailures ?? [],
	};
}

/**
 * The Authentication selector's option labels; OAuth stays English (protocol term).
 * Deliberately distinct from the field labels: two identical label texts would leave
 * label-based lookup - screen readers' and the test harness's - ambiguous.
 */
function authFormName(form: AuthFormId): string {
	switch (form) {
		case "none":
			return l10n.t("None");
		case "apiKey":
			return l10n.t("API key (bearer)");
		case "virtualKey":
			return l10n.t("Virtual key in a custom header");
		case "oauth":
			return "OAuth";
	}
}

/** The selector's render order: rank order, none first. */
const AUTH_FORM_IDS: readonly AuthFormId[] = ["none", "apiKey", "virtualKey", "oauth"];

/** The storage locations' display names, resolved at call time (no module-level localized constants). */
function locationName(location: Exclude<SecretLocation, "none">): string {
	return location === "secure" ? l10n.t("secret storage") : l10n.t("settings");
}

interface FieldRenderProps {
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
function FormSection({
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
function FieldRow({
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
				<span
					id={errorId}
					className={cn(
						"relative col-start-3 row-start-1 flex min-h-[1lh] items-baseline gap-1.5 text-[11.5px]",
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
function FieldSpan({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("col-span-4 min-w-0 @max-[700px]/pane:col-span-2", className)}>{children}</div>;
}

/**
 * The line marking off an auth form's companions - second credentials sent beside the
 * chosen form's own. A real heading with "optional" in the meta slot; not a fold, since
 * there is nothing to open.
 */
function CompanionNote() {
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
function matcherCountAside(count: number): string {
	if (count === 0) {
		return l10n.t("optional");
	}
	return count === 1 ? l10n.t("optional - 1 matcher") : l10n.t("optional - {0} matchers", count);
}

/** The commit bar's unsaved-change count, resolved at call time (no module-level localized constants). */
function unsavedText(count: number): string {
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
const COMMIT_BAR_CLASS =
	"toolbar sticky bottom-0 z-[2] mt-6 mb-[-48px] flex flex-wrap items-center gap-4 border-t border-border bg-background py-3 [--bleed:clamp(0px,884px_-_100cqw,24px)] mx-[calc(0px_-_var(--bleed))] px-[var(--bleed)]";

/** A control that belongs under the row above it: it clears the label gutter, and takes the full width once the rows stack. */
function FieldUnderRow({ children, className }: { children: ReactNode; className?: string }) {
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

function TextField({
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
function SecretField({ field, help, props }: { field: SecretFieldId; help?: string; props: FieldRenderProps }) {
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
function fieldHasContent(draft: ServerFormDraft, field: ServerFormField): boolean {
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
	const value = draft[field];
	return typeof value === "string" ? value.length > 0 : value.value.length > 0;
}

/**
 * An inactive form's stored secret: keeps the Remove checkbox reachable without offering
 * an input (the parse would drop anything typed into an unselected form's field).
 */
function StoredSecretRow({ field, props }: { field: SecretFieldId; props: FieldRenderProps }) {
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
function HeaderRowsEditor({
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

/**
 * The edit destination, mounted in the shell's pane. The boundary outward is two facts and
 * two events: the draft is dirty, the reader asked to leave, the save committed - pane
 * choice, rail clicks, and focus on the way out belong to the shell. The target resolves
 * from live state every render: refreshed evidence, and a deleted entry says so.
 */
export function ServerEditPage({
	request,
	servers,
	onDirtyChange,
	onTargetGone,
	onRequestClose,
	onSaved,
}: {
	request: ServerEditRequest;
	servers: readonly DashboardServer[];
	onDirtyChange: (dirty: boolean) => void;
	/** The draft ceased to exist (its entry left the setting): its own channel, so a dirty report can never mean it. */
	onTargetGone: () => void;
	onRequestClose: () => void;
	onSaved: () => void;
}) {
	// The page's own adopt round trip: the outcome decides the page's fate (ok leaves, a
	// validation failure stays). The list keeps its own hook for notice and banner - both
	// see the same envelope, the documented shape of these outcomes.
	const adoptIntent = useIntentOutcome("adoptServer");
	const saveIntent = useIntentOutcome("saveServerSetting");
	const [adopting, setAdopting] = useState<string | undefined>(undefined);
	const [savingId, setSavingId] = useState<string | undefined>(undefined);
	const adoptOutcome = adoptIntent.outcome;
	const saveOutcome = saveIntent.outcome;
	// A validation failure keeps the reader here, so the message must be here too. An
	// operation failure committed its write; it leaves like a success and the list's
	// banner takes it.
	const [failure, setFailure] = useState<{ message: string; frame: "save" | "adopt" } | undefined>(undefined);
	useEffect(() => {
		if (adopting === undefined || adoptOutcome?.id !== adopting) {
			return;
		}
		setAdopting(undefined);
		if (adoptOutcome.result === "ok" || saveFailureDisposition(adoptOutcome.failureKind) === "close") {
			onSaved();
			return;
		}
		setFailure({ message: adoptOutcome.message, frame: "adopt" });
	}, [adoptOutcome, adopting, onSaved]);
	useEffect(() => {
		if (savingId === undefined || saveOutcome?.id !== savingId) {
			return;
		}
		setSavingId(undefined);
		if (saveOutcome.result === "ok" || saveFailureDisposition(saveOutcome.failureKind) === "close") {
			onSaved();
			return;
		}
		setFailure({ message: saveOutcome.message, frame: "save" });
	}, [saveOutcome, savingId, onSaved]);

	// Arriving here is a navigation, so focus travels with it: to the first field, or the
	// page itself. A destination must do this deliberately, or Tab carries on from a pane
	// that is no longer showing.

	// Misconfigured entries count as taken: they occupy their label in the
	// setting, so a rename onto one must be refused like any sibling.
	const declaredLabels = servers
		.filter((server) => server.origin === "declared" || server.origin === "misconfigured")
		.map((server) => server.label);

	// Memoized so the resolved target is one object for as long as its rows are: a fresh
	// object per render turned the prefill effect into a render loop.
	const resolved = useMemo(() => resolveEditTarget(request, servers), [request, servers]);
	const lastResolved = useRef(resolved);
	// A commit in flight freezes the WHOLE target: the save's write comes back as a state
	// push, so a rename resolves the old label to nothing (a save that worked reads as a
	// deleted entry) and a secret moving storage resolves a DIFFERENT object that restarts
	// the prefill - both read the result of a commit still in flight.
	const committing = savingId !== undefined || adopting !== undefined;
	if (resolved !== undefined && !committing) {
		lastResolved.current = resolved;
	}
	const target = committing ? lastResolved.current : resolved;
	// The entry went away, taking the draft: nothing left to save, nothing to ask about.
	// Reported on its own channel so the shell can dismiss a standing discard question -
	// a signal the dirty report must never carry.
	const targetGone = target === undefined;
	useEffect(() => {
		if (targetGone) {
			onTargetGone();
		}
	}, [targetGone, onTargetGone]);
	const pageRef = useRef<HTMLElement>(null);
	// Also keyed on the form going away: the unmounting field drops focus on the body -
	// outside the shell that hears Esc - so the keyboard would stop working.
	// biome-ignore lint/correctness/useExhaustiveDependencies: targetGone is the trigger, not a value the body reads - the form going away is what leaves focus homeless
	useEffect(() => {
		const page = pageRef.current;
		if (page?.contains(document.activeElement) === true) {
			return;
		}
		const field = page?.querySelector<HTMLElement>("input, select, textarea");
		(field ?? page)?.focus();
	}, [targetGone]);
	// tabIndex -1: the page takes focus itself when it holds no field, never in the tab order.
	// The id is where the discard-confirm modal returns focus on "keep editing".
	const page = (children: ReactNode) => (
		// A section, not a dialog: it is where the reader IS; the heading labels it because a
		// section takes a name.
		<section
			className="server-edit-page max-w-[860px]"
			id="server-edit-page"
			ref={pageRef}
			tabIndex={-1}
			aria-labelledby="server-form-title"
		>
			{children}
		</section>
	);
	if (target === undefined) {
		return page(
			<div className="form-card server-form">
				<h3 id="server-form-title">{l10n.t("This server is gone")}</h3>
				<p className="hint">
					{l10n.t("It was removed while you were editing it - by another window or an edit to settings.json.")}
				</p>
				<div className="toolbar">
					<Button onClick={onRequestClose}>{l10n.t("Back to servers")}</Button>
				</div>
			</div>
		);
	}

	const failureNotice =
		failure === undefined ? null : (
			<div className="banner banner-error" role="alert">
				<p>
					<FailureText
						message={failure.message}
						frame={(headline: string) =>
							sectionFailureText(
								failure.frame === "save" ? l10n.t("Saving the server failed:") : l10n.t("Adopting the server failed:"),
								headline
							)
						}
					/>
				</p>
				<Button variant="secondary" size="compact" onClick={() => setFailure(undefined)}>
					{l10n.t("Dismiss")}
				</Button>
			</div>
		);
	if (target.kind === "adopt") {
		return page(
			<>
				{failureNotice}
				<AdoptForm
					server={target.server}
					declaredLabels={declaredLabels}
					saving={adopting !== undefined}
					onDirtyChange={onDirtyChange}
					onAdoptPosted={(requestId) => {
						setFailure(undefined);
						setAdopting(requestId);
					}}
					onRequestClose={onRequestClose}
				/>
			</>
		);
	}
	return page(
		<>
			{failureNotice}
			<ServerForm
				target={target}
				declaredLabels={declaredLabels}
				observedModelInfoKeys={observedKeysForForm(servers, target)}
				onDirtyChange={onDirtyChange}
				onSavePosted={(requestId) => {
					// A retry starts clean: the banner belongs to the round trip
					// that produced it, not to the form.
					setFailure(undefined);
					setSavingId(requestId);
				}}
				onRequestClose={onRequestClose}
			/>
		</>
	);
}

/**
 * The request read against the live rows: absent when the row is gone or cannot
 * round-trip the form (a misconfigured entry, which the list offers no edit for).
 */
function resolveEditTarget(request: ServerEditRequest, servers: readonly DashboardServer[]): FormTarget | undefined {
	if (request.kind === "add") {
		return { kind: "add" };
	}
	if (request.kind === "edit") {
		const original = servers.find(
			(server): server is DeclaredDashboardServer => server.origin === "declared" && server.label === request.label
		);
		return original === undefined ? undefined : { kind: "edit", original };
	}
	const server = servers.find(
		(candidate): candidate is ExternalDashboardServer =>
			candidate.origin === "external" && candidate.adoptHandle === request.handle
	);
	return server === undefined ? undefined : { kind: "adopt", server };
}

/**
 * The way back, at the top: it routes through the same request the rail and Esc do, so a
 * dirty draft gets the same discard-confirm question from all three.
 */
function BackToServers({ onRequestClose }: { onRequestClose: () => void }) {
	return (
		<nav className="page-trail mb-1 text-[12px]" aria-label={l10n.t("Breadcrumb")}>
			<Button variant="secondary" size="compact" onClick={onRequestClose}>
				<IconArrowLeft /> {l10n.t("Servers")}
			</Button>
		</nav>
	);
}

function ServerForm({
	target,
	declaredLabels,
	observedModelInfoKeys,
	onDirtyChange,
	onSavePosted,
	onRequestClose,
}: {
	target: ServerFormTarget;
	declaredLabels: readonly string[];
	/** The edited entry's LIVE observed /model/info key set (observedKeysForForm); the capability hints' evidence. */
	observedModelInfoKeys?: readonly string[] | undefined;
	/** Reports that the draft has edits worth asking about; the shell's navigation guard reads it. */
	onDirtyChange: (dirty: boolean) => void;
	/** Hands the posted intent's requestId to the page, which owns the round trip. */
	onSavePosted: (requestId: string) => void;
	/** The reader asked to leave; the shell owns what that means. */
	onRequestClose: () => void;
}) {
	const [draft, setDraft] = useState<ServerFormDraft>(() => draftFor(target));
	// What the form opened with, for the save bar's unsaved count; re-based when the prefill
	// lands, so a value the form filled in never reads as a user edit.
	const [baseline, setBaseline] = useState<ServerFormDraft>(() => draftFor(target));
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [testState, setTestState] = useState<TestState>({ kind: "idle" });
	// The form's own round trips. Inline-secret values live only in this hook's state and the
	// draft, both dying with the form instance - a closed form leaves no secret in memory.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const testIntent = useIntentOutcome("testServerDraft");
	const inlineSecrets = useRpc("readInlineSecrets");
	// The full matcher editor overlay, by record kind and DRAFT index (the tables' sorted
	// order is a view; the draft array is the identity space). Index identity is safe HERE:
	// the draft is local state no store push rewrites. Closes itself when its group leaves.
	const [matcherEditor, setMatcherEditor] = useState<{ kind: RecordEditorKind; index: number } | undefined>(undefined);
	const draftModelParameters = draft.modelParameters;
	const draftModelCapabilities = draft.modelCapabilities;
	useEffect(() => {
		setMatcherEditor((current) => {
			if (current === undefined) {
				return current;
			}
			const list = current.kind === "params" ? draftModelParameters : draftModelCapabilities;
			return list[current.index] === undefined ? undefined : current;
		});
	}, [draftModelParameters, draftModelCapabilities]);
	const saving = phase.phase === "saving";
	// Save holds until the prefill lands: saving before would assemble empty fields as
	// "keep", silently dropping a just-picked relocation. Fields stay editable meanwhile;
	// the gate is one round trip and imperceptible.
	const saveOutcome = saveIntent.outcome;

	// Ask for inline-stored values once per form instance (the key remounts a fresh form);
	// secure-side and absent fields are never requested. Keyed on WHICH entry, not the
	// target object - the object is re-resolved per render, and an object dependency
	// re-asks, sets the phase, renders, asks again.
	const requestInlineSecrets = inlineSecrets.send;
	const prefillLabel = target.kind === "edit" ? target.original.label : undefined;
	const hasInlineSecret =
		target.kind === "edit" && SECRET_FIELD_IDS.some((field) => target.original.config.secrets[field] === "settings");
	useEffect(() => {
		if (prefillLabel === undefined || !hasInlineSecret) {
			return;
		}
		requestInlineSecrets({ label: prefillLabel });
		setPhase({ phase: "prefill" });
	}, [prefillLabel, hasInlineSecret, requestInlineSecrets]);

	// This form's own response prefills the untouched inline fields; the hook
	// answers only the request this form instance posted.
	const inlineValues = inlineSecrets.data?.values;
	useEffect(() => {
		if (phase.phase !== "prefill" || inlineValues === undefined) {
			return;
		}
		setPhase({ phase: "editing" });
		setDraft((current) => applyInlinePrefill(current, inlineValues));
		setBaseline((current) => applyInlinePrefill(current, inlineValues));
	}, [inlineValues, phase]);

	// The page owns what a save's outcome means for the destination; the form
	// only needs to stop calling itself busy.
	useEffect(() => {
		if (phase.phase === "saving" && saveOutcome?.id === phase.requestId) {
			setPhase({ phase: "editing" });
		}
	}, [saveOutcome, phase]);

	// This form's own test outcome; an outcome for an abandoned requestId is ignored.
	const testOutcome = testIntent.outcome;
	useEffect(() => {
		if (testState.kind !== "testing" || testOutcome === undefined || testOutcome.id !== testState.requestId) {
			return;
		}
		if (testOutcome.result === "ok") {
			setTestState({ kind: "pass", text: testOutcome.message ?? l10n.t("Connected") });
		} else {
			setTestState({
				kind: "fail",
				text: testOutcome.message,
				classification: testOutcome.classification,
			});
		}
	}, [testOutcome, testState]);

	const originalLabel = target.kind === "edit" ? target.original.label : undefined;
	// One parse per keystroke: it carries either the intent Save posts or the problems the
	// form renders, so shown and saved can never diverge. Observed keys are the live prop.
	const parse = parseServerForm(draft, {
		takenLabels: declaredLabels,
		...(originalLabel !== undefined ? { originalLabel } : {}),
		...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
	});
	const label = draft.label.trim();
	const renaming = target.kind === "edit" && label !== target.original.label;
	const collides = target.kind === "add" && declaredLabels.includes(label);

	// A problem is visible once its field was touched or holds content; computed once so the
	// fields and the save summary always show the same problems.
	const visibleProblems: ServerFormProblems = {};
	if (!parse.ok) {
		for (const field of SERVER_FORM_FIELD_ORDER) {
			const problem = parse.problems[field];
			if (problem === undefined) {
				continue;
			}
			if (touched.has(field) || fieldHasContent(draft, field)) {
				visibleProblems[field] = problem;
			}
		}
	}
	const modelParameterProblems: readonly GroupProblems[] = parse.ok ? [] : parse.modelParameterProblems;
	const modelParameterHints = parse.modelParameterHints;
	const modelCapabilityIssues = parse.modelCapabilityIssues;
	const entryParamIssueViews = paramIssueViews(draft.modelParameters, modelParameterProblems, modelParameterHints);
	const entryCapIssueViews = capabilityIssueViews(draft.modelCapabilities, modelCapabilityIssues);
	// The capability-key autocomplete over THIS entry's own observed vocabulary (live, like
	// the hint evidence): entry-scoped records apply to this server only, so other servers'
	// vocabularies never leak in.
	const entryCapabilityKeySuggestions = capabilityKeySuggestions(observedModelInfoKeys);
	const headerRowProblems: readonly (string | undefined)[] = parse.ok ? [] : parse.headerProblems;
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find((field) => visibleProblems[field] !== undefined);
	// Every field is in the same scroll, so a problem is always reachable before Save.
	const changedFields = changedServerFormFields(draft, baseline);
	const unsavedCount = changedFields.length;
	// The models-file caveat is about a connection the host already resolved,
	// so it belongs to an edit that actually moves one - not to every open.
	const connectionEdited = changedFields.some((field) => (CONNECTION_FIELDS as readonly string[]).includes(field));

	const save = () => {
		if (phase.phase !== "editing") {
			// Belt and braces behind the disabled button: never post during prefill or save.
			return;
		}
		if (!parse.ok) {
			// Surface every problem instead of refusing silently.
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
			return;
		}
		const requestId = saveIntent.send(parse.intent);
		onSavePosted(requestId);
		setPhase({ phase: "saving", requestId });
	};

	// The draft as typed goes out for one extension-side probe; label and model-parameter
	// rows never gate it, but a connection-relevant problem surfaces like Save's.
	const testConnection = () => {
		if (testState.kind === "testing" || saving) {
			return;
		}
		const testParse = parseServerFormForTest(draft, originalLabel !== undefined ? { originalLabel } : {});
		if (!testParse.ok) {
			setTouched((current) => {
				const next = new Set(current);
				for (const field of CONNECTION_FIELDS) {
					if (testParse.problems[field] !== undefined) {
						next.add(field);
					}
				}
				return next;
			});
			return;
		}
		const requestId = testIntent.send(testParse.intent);
		setTestState({ kind: "testing", requestId });
	};

	const props: FieldRenderProps = {
		draft,
		visibleProblems,
		disabled: saving,
		patch: (patch) => {
			onDirtyChange(true);
			// Any field a probe's outcome depends on makes a standing result describe a config that
			// no longer exists; a stale PASS is worse than none. The label counts (it selects which
			// stored secret "keep" resolves); modelCapabilities/expectedFailures stay out of
			// CONNECTION_FIELDS but still clear a result - they shape its OUTCOME.
			if (
				testState.kind !== "idle" &&
				Object.keys(patch).some(
					(field) =>
						field === "label" ||
						field === "modelCapabilities" ||
						field === "expectedFailures" ||
						field === "declaredModels" ||
						(CONNECTION_FIELDS as readonly string[]).includes(field)
				)
			) {
				setTestState({ kind: "idle" });
			}
			setDraft((current) => ({ ...current, ...patch }));
		},
		touch: (field) => {
			// An empty field stays quiet on blur: brushing focus toward Cancel must not repaint the
			// form mid-click. Required-but-empty surfaces on Save, which marks every field touched.
			if (!fieldHasContent(draft, field)) {
				return;
			}
			setTouched((current) => new Set(current).add(field));
		},
	};

	// Kept stored secrets whose form is not selected still change the save's shape (the
	// shape-and-storage rule, docs/servers.md#secrets-and-secret-storage), so each renders a
	// visible hint plus its Remove checkbox instead of silently riding along. The parse's
	// blocking rules read the same derivation, so the way out of a block always renders.
	const storedOrphans = storedInactiveSecrets(draft);
	const storedApiKeyOrphan = storedOrphans.apiKey;
	const storedVkOrphan = storedOrphans.virtualKeyValue;
	const storedOauthSecretOrphan = storedOrphans.oauthClientSecret;

	const virtualKeyPair = (
		<>
			<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
			<SecretField field="virtualKeyValue" props={props} />
		</>
	);

	// Closing the overlay sweeps up a still-pristine new matcher; both the sweep and the add
	// write through setDraft, NOT props.patch - a structural add-then-cancel is a no-op and
	// must not arm the shell's discard confirm.
	const closeMatcherEditor = () => {
		if (matcherEditor !== undefined) {
			const list = matcherEditor.kind === "params" ? draft.modelParameters : draft.modelCapabilities;
			const group = list[matcherEditor.index];
			if (group !== undefined && group.prefix.trim().length === 0 && group.params.length === 0) {
				const remaining = list.filter((_, index) => index !== matcherEditor.index);
				setDraft((current) =>
					matcherEditor.kind === "params"
						? { ...current, modelParameters: remaining }
						: { ...current, modelCapabilities: remaining }
				);
			}
		}
		setMatcherEditor(undefined);
	};
	const matcherEditorNote = l10n.t("Changes here edit the form; Save stores them on the entry.");
	const matcherEditorView = (() => {
		if (matcherEditor === undefined) {
			return null;
		}
		if (matcherEditor.kind === "params") {
			const group = draft.modelParameters[matcherEditor.index];
			if (group === undefined) {
				return null;
			}
			return (
				<RecordMatcherEditorOverlay
					kind="params"
					group={group}
					groupProblems={modelParameterProblems[matcherEditor.index]}
					groupHints={modelParameterHints[matcherEditor.index]}
					prefixHelp={helpEntryModelParameterPrefix()}
					disabled={saving}
					fallbackFocusId="server-params-add"
					note={matcherEditorNote}
					onChange={(next) =>
						props.patch({
							modelParameters: draft.modelParameters.map((g, index) => (index === matcherEditor.index ? next : g)),
						})
					}
					onRemove={() => {
						props.patch({
							modelParameters: draft.modelParameters.filter((_, index) => index !== matcherEditor.index),
						});
						setMatcherEditor(undefined);
					}}
					onClose={closeMatcherEditor}
				/>
			);
		}
		const group = draft.modelCapabilities[matcherEditor.index];
		if (group === undefined) {
			return null;
		}
		return (
			<RecordMatcherEditorOverlay
				kind="caps"
				group={group}
				groupIssues={modelCapabilityIssues[matcherEditor.index]}
				keySuggestions={entryCapabilityKeySuggestions}
				disabled={saving}
				fallbackFocusId="server-caps-add"
				note={matcherEditorNote}
				onChange={(next) =>
					props.patch({
						modelCapabilities: draft.modelCapabilities.map((g, index) => (index === matcherEditor.index ? next : g)),
					})
				}
				onRemove={() => {
					props.patch({
						modelCapabilities: draft.modelCapabilities.filter((_, index) => index !== matcherEditor.index),
					});
					setMatcherEditor(undefined);
				}}
				onClose={closeMatcherEditor}
			/>
		);
	})();

	return (
		<div className="form-card server-form">
			<BackToServers onRequestClose={onRequestClose} />
			{/* The docs anchor rides beside the heading as a sibling, out of the accessible names.
			    The 24px above is the h3 rule's, restated because this row opens no <section>. */}
			<SectionHeader
				titleId="server-form-title"
				level={3}
				title={target.kind === "add" ? l10n.t("Add server") : l10n.t("Edit {0}", target.original.label)}
				docs={{ href: DOCS_LINK_SERVER_FORM, label: l10n.t("Open the server fields guide") }}
				className="mt-6"
			/>
			<FormSection title={l10n.t("Connection")} help={helpConnectionSection()}>
				<TextField field="label" placeholder={l10n.t("e.g. Production")} props={props} />
				{/* The label's consequence line, mounted always and holding its box invisibly until it
				    speaks (visibility keeps the box, removes the words from the accessibility tree):
				    inserting it on the first renaming keystroke pushed every row below down mid-typing. */}
				<FieldUnderRow>
					{target.kind === "edit" ? (
						<p
							className={cn(
								"rename-note hint m-0 text-[11.5px]",
								!(renaming && (parse.ok || parse.problems.label === undefined)) && "invisible"
							)}
						>
							{l10n.t("Renaming creates a new server; the old name serves until you delete it from the models file.")}
						</p>
					) : (
						<p className={cn("collides-note hint m-0 text-[11.5px]", !collides && "invisible")}>
							{l10n.t("An entry with this label already exists; saving replaces it.")}
						</p>
					)}
				</FieldUnderRow>
				<TextField field="baseUrl" mono={true} placeholder={l10n.t("e.g. http://localhost:4000")} props={props} />
				{/* The probe belongs to the URL it probes, not the save bar: testing is not committing.
				    Quiet rank on purpose - Save is the page's one accent - shaped by its icon instead. */}
				<FieldUnderRow>
					<Button
						variant="secondary"
						disabled={!isUsableHttpUrl(draft.baseUrl.trim()) || testState.kind === "testing" || saving}
						onClick={testConnection}
					>
						{testState.kind === "testing" ? (
							<>
								<span className="spinner" aria-hidden="true" /> {l10n.t("Testing...")}
							</>
						) : (
							<>
								<IconPlug /> {l10n.t("Test connection")}
							</>
						)}
					</Button>
					{testState.kind === "pass" ? (
						<span className="test-result state-ok text-[11.5px]" role="status">
							{testState.text}
						</span>
					) : null}
					{testState.kind === "fail" ? (
						<span className="test-result error text-[11.5px]" role="alert">
							{testState.text}
							{testState.classification?.setupHint !== undefined ? (
								// The troubleshooting link rides inside the alert so one announcement carries failure
								// and way out; the leading space keeps copied text from gluing label onto message.
								<>
									{" "}
									<span className="test-hint">
										{/* The accessible name leads with the visible verb (Label in Name); the helper's sentence
										    label buries "Troubleshoot" where speech input cannot match it. */}
										<DocsLink
											href={troubleshootingLink(testState.classification.setupHint).href}
											label={l10n.t("Troubleshoot: {0}", troubleshootingLink(testState.classification.setupHint).topic)}
										>
											{l10n.t("Troubleshoot")}
										</DocsLink>
									</span>
								</>
							) : null}
						</span>
					) : null}
				</FieldUnderRow>
				{target.kind === "edit" ? (
					<FieldUnderRow>
						{/* A connection edit raises no toast (a rename does), so this line must name every step.
						    Mounted on every edit form, holding its box invisibly until it speaks (the
						    spacing-twin idiom): inserting it on the first keystroke pushed rows down 36px
						    mid-edit. While a rename stands, the rename note carries the remediation instead. */}
						<p className={cn("hint state-warn m-0 text-[11.5px]", (renaming || !connectionEdited) && "invisible")}>
							{l10n.t(
								"VS Code keeps the old connection until you remove this server from the models file, reload, and run Sync Models Now."
							)}
						</p>
					</FieldUnderRow>
				) : null}
				<FieldRow
					htmlFor="server-apiVersion-mode"
					label={serverFormFieldLabel("apiVersion")}
					help={
						<Help text={serverFieldHelp("apiVersion")} name={l10n.t("Help: {0}", serverFormFieldLabel("apiVersion"))} />
					}
				>
					<Select
						id="server-apiVersion-mode"
						className="min-w-0 flex-1"
						aria-label={serverFormFieldLabel("apiVersion")}
						value={draft.apiVersion.mode}
						disabled={saving}
						onChange={(event) =>
							props.patch({
								apiVersion: { ...draft.apiVersion, mode: event.currentTarget.value as ApiVersionDraft["mode"] },
							})
						}
					>
						<option value="auto">{l10n.t("Auto-detect, default /{0}", DEFAULT_API_VERSION)}</option>
						<option value="none">{l10n.t("No version - use the URL as-is")}</option>
						<option value="custom">{l10n.t("Custom segment - type it below")}</option>
					</Select>
				</FieldRow>
				{draft.apiVersion.mode === "custom" ? (
					<FieldRow
						htmlFor="server-apiVersion"
						label={l10n.t("Version segment")}
						problem={visibleProblems.apiVersion}
						errorId="server-apiVersion-error"
						hint={l10n.t("Just the segment, no slashes.")}
					>
						<Input
							id="server-apiVersion"
							type="text"
							className="min-w-0 flex-1 font-mono text-[12px]"
							placeholder={l10n.t("e.g. v2")}
							value={draft.apiVersion.custom}
							disabled={saving}
							aria-invalid={visibleProblems.apiVersion !== undefined}
							aria-describedby="server-apiVersion-error"
							onChange={(event) =>
								props.patch({ apiVersion: { ...draft.apiVersion, custom: event.currentTarget.value } })
							}
							onBlur={() => props.touch("apiVersion")}
						/>
					</FieldRow>
				) : null}
			</FormSection>
			<FormSection
				title={serverFormFieldLabel("authForm")}
				help={serverFieldHelp("authForm")}
				docs={{ href: DOCS_LINK_AUTHENTICATION, label: l10n.t("Open the authentication guide") }}
			>
				<FieldRow label={l10n.t("Method")} wide={true}>
					{/* One per line: the four labels are very unequal, so a wrapping row lands differently at
					    every pane width, and mutually exclusive options are read by scanning down. The cost
					    is one row's height, paid once. */}
					<span
						className="auth-selector flex flex-col items-start gap-y-1 text-[12.5px]"
						role="radiogroup"
						aria-label={serverFormFieldLabel("authForm")}
					>
						{AUTH_FORM_IDS.map((form) => (
							<label key={form} className="flex items-center gap-1.5">
								<Radio
									name="server-auth-form"
									checked={draft.authForm === form}
									disabled={saving}
									onChange={() => props.patch({ authForm: form })}
								/>
								{authFormName(form)}
							</label>
						))}
					</span>
				</FieldRow>
				{draft.authForm === "apiKey" ? (
					<>
						<SecretField field="apiKey" props={props} />
						<CompanionNote />
						{virtualKeyPair}
					</>
				) : null}
				{draft.authForm === "virtualKey" ? virtualKeyPair : null}
				{draft.authForm === "oauth" ? (
					<>
						<TextField
							field="oauthTokenUrl"
							mono={true}
							placeholder={l10n.t("e.g. https://idp.example.com/oauth2/token")}
							props={props}
						/>
						<TextField field="oauthClientId" mono={true} placeholder={l10n.t("e.g. litellm-vscode")} props={props} />
						<SecretField field="oauthClientSecret" props={props} />
						<TextField
							field="oauthScopes"
							mono={true}
							placeholder={l10n.t("e.g. litellm.read litellm.write")}
							props={props}
						/>
						<CompanionNote />
						<SecretField field="apiKey" help={helpOauthCompanionApiKey()} props={props} />
						{virtualKeyPair}
					</>
				) : null}
				{storedApiKeyOrphan || storedVkOrphan || storedOauthSecretOrphan ? (
					<>
						<FieldSpan className="mt-2">
							{/* The tone-text register (state-warn), not utility spellings: one register keeps heading
							    and lines in one voice and carries the forced-colors squiggle the utilities lack. */}
							<p className="state-warn m-0 text-[11.5px]">{l10n.t("Stored credentials")}</p>
							{storedApiKeyOrphan ? (
								<p className="hint state-warn m-0 text-[11.5px]">
									{l10n.t("A stored API key is still attached and still sent as a bearer token.")}
								</p>
							) : null}
							{storedVkOrphan ? (
								<p className="hint state-warn m-0 text-[11.5px]">
									{l10n.t("A stored virtual key value is still attached.")}
								</p>
							) : null}
							{storedOauthSecretOrphan ? (
								<p className="hint state-warn m-0 text-[11.5px]">
									{l10n.t("A stored OAuth client secret is still attached.")}
								</p>
							) : null}
						</FieldSpan>
						{storedApiKeyOrphan ? <StoredSecretRow field="apiKey" props={props} /> : null}
						{storedVkOrphan ? <StoredSecretRow field="virtualKeyValue" props={props} /> : null}
						{storedOauthSecretOrphan ? <StoredSecretRow field="oauthClientSecret" props={props} /> : null}
					</>
				) : null}
			</FormSection>
			<FormSection
				quiet={true}
				title={serverFormFieldLabel("modelParameters")}
				aside={matcherCountAside(draft.modelParameters.length)}
				help={serverFieldHelp("modelParameters")}
				docs={{ href: DOCS_LINK_MODEL_PARAMETERS, label: l10n.t("Open the model parameters guide") }}
			>
				<FieldRow label={l10n.t("Matchers")} wide={true}>
					{draft.modelParameters.length > 0 ? (
						<RecordMatcherTable
							kind="params"
							groups={draft.modelParameters}
							issues={entryParamIssueViews}
							disabled={saving}
							onChange={(next) => props.patch({ modelParameters: next })}
							onOpenEditor={(index) => setMatcherEditor({ kind: "params", index })}
						/>
					) : (
						<p className="m-0 text-[12px] text-muted-foreground">{l10n.t("No per-server parameters.")}</p>
					)}
					<div>
						<Button
							variant="secondary"
							id="server-params-add"
							disabled={saving}
							onClick={() => {
								// setDraft, not patch: appending the empty group is structural,
								// and the pristine sweep undoes it without arming the confirm.
								setDraft((current) => ({
									...current,
									modelParameters: [...current.modelParameters, { prefix: "", params: [] }],
								}));
								setMatcherEditor({ kind: "params", index: draft.modelParameters.length });
							}}
						>
							<IconAdd /> {l10n.t("Add model matcher")}
						</Button>
					</div>
				</FieldRow>
			</FormSection>
			<FormSection
				quiet={true}
				title={serverFormFieldLabel("modelCapabilities")}
				aside={matcherCountAside(draft.modelCapabilities.length)}
				help={serverFieldHelp("modelCapabilities")}
				docs={{ href: DOCS_LINK_MODEL_CAPABILITIES, label: l10n.t("Open the model capabilities guide") }}
			>
				<FieldRow label={l10n.t("Matchers")} wide={true}>
					{draft.modelCapabilities.length > 0 ? (
						<RecordMatcherTable
							kind="caps"
							groups={draft.modelCapabilities}
							issues={entryCapIssueViews}
							disabled={saving}
							keySuggestions={entryCapabilityKeySuggestions}
							onChange={(next) => props.patch({ modelCapabilities: next })}
							onOpenEditor={(index) => setMatcherEditor({ kind: "caps", index })}
						/>
					) : (
						<p className="m-0 text-[12px] text-muted-foreground">{l10n.t("No corrections.")}</p>
					)}
					<div>
						<Button
							variant="secondary"
							id="server-caps-add"
							disabled={saving}
							onClick={() => {
								// setDraft, not patch: see the parameters twin above.
								setDraft((current) => ({
									...current,
									modelCapabilities: [...current.modelCapabilities, { prefix: "", params: [] }],
								}));
								setMatcherEditor({ kind: "caps", index: draft.modelCapabilities.length });
							}}
						>
							<IconAdd /> {l10n.t("Add capability matcher")}
						</Button>
					</div>
				</FieldRow>
			</FormSection>
			<FormSection
				quiet={true}
				title={l10n.t("Discovery")}
				aside={l10n.t("optional")}
				help={helpDiscoverySection()}
				docs={{ href: DOCS_LINK_DECLARED_MODELS, label: l10n.t("Open the declared models guide") }}
			>
				<FieldRow
					htmlFor="server-declaredModels"
					label={serverFormFieldLabel("declaredModels")}
					help={
						<Help
							text={serverFieldHelp("declaredModels")}
							name={l10n.t("Help: {0}", serverFormFieldLabel("declaredModels"))}
						/>
					}
					wide={true}
				>
					<textarea
						id="server-declaredModels"
						className="w-full rounded-(--radius-field) border border-input bg-input-background px-1.5 py-[3px] font-mono text-[12px] text-input-foreground placeholder:text-input-placeholder focus:outline-(length:--ring-w) focus:outline-offset-(--ring-offset-inset) focus:outline-ring focus:outline-solid"
						rows={3}
						placeholder={l10n.t("One model ID per line, e.g. deepseek-r1")}
						value={draft.declaredModels}
						disabled={saving}
						onChange={(event) => props.patch({ declaredModels: event.currentTarget.value })}
					/>
				</FieldRow>
				<FieldRow
					label={serverFormFieldLabel("expectedFailures")}
					help={
						<Help
							text={serverFieldHelp("expectedFailures")}
							name={l10n.t("Help: {0}", serverFormFieldLabel("expectedFailures"))}
						/>
					}
					wide={true}
				>
					{/* A real fieldset, not a role: the checkbox set is a group with a
					    name, and the flat page has no box chrome for it to inherit. */}
					{/* One row while the pair fits, a column below the stylesheet's own 560px tier (same
					    exclusive `width < 560px` semantics); between, wrap depended on the translation's width. */}
					<fieldset
						className="expected-failures m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0 text-[12.5px] @max-[560px]/pane:flex-col @max-[560px]/pane:items-start"
						aria-label={serverFormFieldLabel("expectedFailures")}
					>
						{EXPECTED_FAILURE_CATEGORIES.map((category) => (
							<label key={category} className="setting-check flex items-center gap-1.5">
								<Checkbox
									checked={draft.expectedFailures.includes(category)}
									disabled={saving}
									onChange={(event) =>
										props.patch({
											expectedFailures: toggleExpectedFailure(
												draft.expectedFailures,
												category,
												event.currentTarget.checked
											),
										})
									}
								/>
								{expectedFailureLabel(category)}
							</label>
						))}
					</fieldset>
				</FieldRow>
			</FormSection>
			<FormSection
				quiet={true}
				title={l10n.t("Headers and budget")}
				aside={l10n.t("optional")}
				help={serverFieldHelp("headers")}
			>
				<FieldRow label={serverFormFieldLabel("headers")} wide={true}>
					<HeaderRowsEditor
						rows={draft.headers}
						problems={headerRowProblems}
						disabled={saving}
						onChange={(next) => props.patch({ headers: next })}
					/>
				</FieldRow>
				<TextField field="budget" narrow={true} placeholder={l10n.t("e.g. 50")} props={props} />
			</FormSection>
			<div className={COMMIT_BAR_CLASS}>
				<Button disabled={phase.phase !== "editing"} onClick={save}>
					{saving ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Saving...")}
						</>
					) : (
						l10n.t("Save")
					)}
				</Button>
				{/* Named apart from the confirm dialog's own Discard: this one REQUESTS a close, and two
				    controls one answer apart must not answer to the same word. */}
				<Button variant="secondary" onClick={onRequestClose}>
					{l10n.t("Discard changes")}
				</Button>
				{firstBlocking !== undefined ? (
					<span className="error text-[11.5px]" role="alert">
						{l10n.t("Cannot save: fix {0}", serverFormFieldLabel(firstBlocking))}
					</span>
				) : null}
				{phase.phase === "prefill" ? (
					<span className="hint m-0 text-[11.5px]">{l10n.t("Loading stored values...")}</span>
				) : null}
				{/* The bar's trailing facts on ONE wrap-proof line (dashboard.css .commit-status, the
				    record footer's .editor-status discipline): zero flex basis, so the count speaking
				    never changes the bar's wrap points or its height. The count is the line's
				    non-shrinking region - only the standing saved-to fact clips, with an ellipsis -
				    while the DOM keeps the whole text (screen readers read it unclipped) and the
				    title carries it for pointers. */}
				<span
					className="commit-status text-right text-[11.5px] text-muted-foreground"
					title={
						unsavedCount > 0
							? `${unsavedText(unsavedCount)} - ${l10n.t("Saved to {0}", SERVERS_SETTING_ID)}`
							: l10n.t("Saved to {0}", SERVERS_SETTING_ID)
					}
				>
					{unsavedCount > 0 ? <span className="unsaved-count tabular-nums">{unsavedText(unsavedCount)}</span> : null}
					{/* NBSP glue around the dash: the two facts are flex items, so a collapsible
					    space at the target's start sits at its own line box's start and is trimmed. */}
					<span className="save-target">
						{unsavedCount > 0
							? `\u00a0-\u00a0${l10n.t("Saved to {0}", SERVERS_SETTING_ID)}`
							: l10n.t("Saved to {0}", SERVERS_SETTING_ID)}
					</span>
				</span>
			</div>
			{matcherEditorView}
		</div>
	);
}

/**
 * The adopt form: turns an external group into a declared entry. Credentials exist
 * extension-side only, so the form offers one storage choice per secret field; the intent
 * carries label, source identity, and choices - never a credential value. The round trip
 * lives in ServerEditPage; the servers list watches the same envelope for its notice.
 */
function AdoptForm({
	server,
	declaredLabels,
	saving,
	onDirtyChange,
	onAdoptPosted,
	onRequestClose,
}: {
	server: ExternalDashboardServer;
	declaredLabels: readonly string[];
	/** Whether this form instance's adopt intent is in flight; disables the inputs against a double submit. */
	saving: boolean;
	onDirtyChange: (dirty: boolean) => void;
	/** Hands the posted intent's requestId to the page, which owns the round trip. */
	onAdoptPosted: (requestId: string) => void;
	onRequestClose: () => void;
}) {
	const [label, setLabel] = useState(server.label);
	const [touched, setTouched] = useState(false);
	const [locations, setLocations] = useState<Record<SecretFieldId, "settings" | "secure">>({
		apiKey: "secure",
		oauthClientSecret: "secure",
		virtualKeyValue: "secure",
	});

	const problem = validateAdoptLabel(label, declaredLabels);
	const showProblem = problem !== undefined && (touched || label.trim() !== server.label);

	const adopt = () => {
		if (saving) {
			return;
		}
		if (problem !== undefined) {
			setTouched(true);
			return;
		}
		const requestId = sendRequest("adoptServer", {
			label: label.trim(),
			baseUrl: server.baseUrl,
			// External rows always carry the handle; the FormTarget union
			// guarantees only external rows reach this form.
			sourceHandle: server.adoptHandle,
			secrets: locations,
		});
		onAdoptPosted(requestId);
	};

	// hasApiKey is coarse (reported for OAuth-only groups too), so the key row drops out only
	// when the group demonstrably holds no credentials; every row states its own condition.
	const secretRows: readonly { field: SecretFieldId; hint: string }[] = [
		...(server.hasApiKey
			? [{ field: "apiKey" as const, hint: l10n.t("Copied only if the group has an API key.") }]
			: []),
		{ field: "oauthClientSecret" as const, hint: l10n.t("Copied only if the group is configured for OAuth.") },
		{ field: "virtualKeyValue" as const, hint: l10n.t("Copied only if the group sends a virtual key header.") },
	];

	return (
		<div className="form-card server-form">
			<BackToServers onRequestClose={onRequestClose} />
			{/* The edit form's header primitive without a docs slot; the 24px above restated for the
			    same no-<section> reason. */}
			<SectionHeader titleId="server-form-title" level={3} title={l10n.t("Adopt {0}", server.label)} className="mt-6" />
			<FormSection title={l10n.t("Adoption")} help={helpAdoptionSection()}>
				<FieldRow
					htmlFor="adopt-label"
					label={l10n.t("Label")}
					hint={l10n.t(
						"Names the new entry and its provider group; rename it if a VS Code group already uses the name."
					)}
					problem={showProblem ? problem : undefined}
					errorId="adopt-label-error"
				>
					<Input
						id="adopt-label"
						type="text"
						className="min-w-0 flex-1"
						value={label}
						disabled={saving}
						aria-invalid={showProblem}
						aria-describedby="adopt-label-error"
						onChange={(event) => {
							onDirtyChange(true);
							setLabel(event.currentTarget.value);
						}}
						onBlur={() => setTouched(true)}
					/>
				</FieldRow>
				<FieldRow label={l10n.t("Base URL")} hint={l10n.t("Editable after adopting.")}>
					{/* Plain dimmed text, never a disabled input: a value that cannot
					    be edited here must not look like one that merely refused. */}
					<span className="readonly-value font-mono text-[12px] break-all text-muted-foreground">{server.baseUrl}</span>
				</FieldRow>
				{secretRows.map(({ field, hint }) => (
					<FieldRow label={serverFormFieldLabel(field)} hint={hint} key={field}>
						<span
							className="secret-where flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground"
							role="radiogroup"
							aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
						>
							<span className="where-label @max-[700px]/pane:basis-full">{l10n.t("Store in:")}</span>
							<label className="flex items-center gap-1.5">
								<Radio
									name={`adopt-${field}-where`}
									checked={locations[field] === "secure"}
									disabled={saving}
									onChange={() => {
										onDirtyChange(true);
										setLocations((current) => ({ ...current, [field]: "secure" }));
									}}
								/>
								{l10n.t("secret storage")}
							</label>
							<label className="flex items-center gap-1.5">
								<Radio
									name={`adopt-${field}-where`}
									checked={locations[field] === "settings"}
									disabled={saving}
									onChange={() => {
										onDirtyChange(true);
										setLocations((current) => ({ ...current, [field]: "settings" }));
									}}
								/>
								{l10n.t("settings (visible)")}
							</label>
						</span>
					</FieldRow>
				))}
				<FieldSpan>
					<p className="hint m-0 text-[11.5px]">
						{l10n.t("The original group survives: its models appear twice until you delete it from the models file.")}
					</p>
				</FieldSpan>
			</FormSection>
			{/* Same footer as the edit page's, for the same reasons. */}
			<div className={COMMIT_BAR_CLASS}>
				<Button disabled={saving} onClick={adopt}>
					{saving ? (
						<>
							<span className="spinner" aria-hidden="true" /> {l10n.t("Adopting...")}
						</>
					) : (
						l10n.t("Adopt")
					)}
				</Button>
				{/* Cancel routes through the shell's discard policy; a pending
				    adopt never blocks it - the page owns the round trip. */}
				<Button variant="secondary" onClick={onRequestClose}>
					{l10n.t("Cancel")}
				</Button>
				{showProblem ? (
					<span className="error text-[11.5px]" role="alert">
						{l10n.t("Cannot adopt: fix Label")}
					</span>
				) : null}
			</div>
		</div>
	);
}
