/**
 * The server edit surface: the add/edit form, the adopt form, and the field
 * machinery they are built from.
 *
 * It lives apart from servers.tsx because the two are different jobs that only
 * shared a file: the overview answers "what is the state of my fleet", the
 * editor answers "change this one entry". Together they were 2577 lines, and
 * the seam between them was invisible.
 *
 * The boundary is deliberately narrow. This module renders fields and reports
 * two things outward - the draft is dirty, and the user asked to leave - and
 * knows nothing about where it is mounted: whether a panel, a scrim, a close
 * affordance or a discard bar exists around it is the caller's business.
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
import { SectionHeader } from "./ui/section";
import { Select } from "./ui/select";
import { sendRequest } from "./vscodeApi";

/**
 * Where a saved entry lands. A setting ID is a protocol term, so it stays
 * English and can be a module constant; the save bar shows it because a page
 * that writes a user's settings file should say so before it does.
 */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/**
 * What the open form is for, decided once where it opens (a row's Edit or the
 * Add button) so no component re-derives it from optional fields: adding a
 * new entry, editing a declared one, or adopting an external group.
 */
export type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: DeclaredDashboardServer }
	| { readonly kind: "adopt"; readonly server: ExternalDashboardServer };

/** The targets ServerForm handles; adoption renders AdoptForm instead. */
type ServerFormTarget = Extract<FormTarget, { kind: "add" | "edit" }>;

/**
 * The edit form's live hint evidence: the CURRENT server row's observed
 * /model/info key set, looked up by the edited entry's label on every render
 * rather than read from the form's frozen open-time snapshot - a discovery
 * pass finishing while the form is open must update the capability rows'
 * unknown-key hints the same way it updates the host-side filter. An add
 * target has no server and so no evidence.
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
 * What the shell asked this page to be, by IDENTITY rather than by object: a
 * label for a declared entry, an opaque handle for an external group. The page
 * resolves it against the live state on every render, so an entry that changes
 * under an open page is followed rather than frozen, and one that disappears
 * says so instead of editing a ghost.
 */
export type ServerEditRequest =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly label: string }
	| { readonly kind: "adopt"; readonly handle: string };

/**
 * Where the form is in its life. The prefill and save round trips each run
 * their own correlation (the prefill through its useRpc hook, the save
 * through the saved requestId below), but the form is only ever in one of
 * them: fields stay editable throughout, and only Save gates on the phase
 * being "editing".
 */
type FormPhase =
	| { readonly phase: "prefill" }
	| { readonly phase: "editing" }
	| { readonly phase: "saving"; readonly requestId: string };

/**
 * The draft-connection test's own little lifecycle, independent of FormPhase:
 * a test in flight must not gate editing, saving, or cancelling. Leaving
 * "testing" for any other state abandons the in-flight requestId, so a late
 * outcome for it is ignored - which is exactly what clearing on an edit needs.
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
 * The troubleshooting-guide section behind a setup-hint id (the transport
 * assigns one only where the advice is known right; see
 * shared/errorClassification.ts), with the fuller accessible label naming the
 * destination. Labels resolve per call so the l10n bundle is honored. Shared
 * by the draft-test footer and the servers error banner, so a classified
 * failure links the same section wherever it surfaces.
 */
export function troubleshootingLink(hint: SetupHintKind): { href: DocsUrl; label: string } {
	switch (hint) {
		case "proxy-not-running":
			return { href: DOCS_LINK_PROXY_NOT_RUNNING, label: l10n.t("Open the troubleshooting guide: unable to connect") };
		case "configure-api-key":
			return {
				href: DOCS_LINK_CONFIGURE_API_KEY,
				label: l10n.t("Open the troubleshooting guide: authentication failed"),
			};
		case "check-base-url":
			return {
				href: DOCS_LINK_CHECK_BASE_URL,
				label: l10n.t("Open the troubleshooting guide: the server answered 404"),
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
 * The Authentication selector's option labels; OAuth stays English (protocol
 * term). Deliberately distinct from the field labels ("API key", "Virtual key
 * header"): two identical label texts would leave label-based lookup - screen
 * readers' and the test harness's alike - ambiguous.
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
	 * The problems the form shows right now, computed once per render in
	 * ServerForm (a problem is visible once its field was touched or holds
	 * content). Fields render these directly, so the field decorations and the
	 * save summary cannot disagree.
	 */
	readonly visibleProblems: ServerFormProblems;
	readonly disabled: boolean;
	readonly patch: (patch: Partial<ServerFormDraft>) => void;
	readonly touch: (field: ServerFormField) => void;
}

/**
 * One section of the flat page. The entry is ONE scroll: every section is a
 * heading in the flow with its fields under it, and there is no collapsed
 * state to open - so a section either belongs to the required path or reads
 * as an aside, which is the whole of what `quiet` says. Quiet dims the
 * heading and the label column together; the fields themselves stay at full
 * strength, because a value the user typed is never the quiet part.
 *
 * A heading and nothing else: the paragraph that used to sit under each one
 * said what the "?" beside it already says, six times down a page whose whole
 * job is to be scannable. Detail is on demand here, not on arrival.
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
	 * The section's detail, behind its "?". Required, because the paragraphs
	 * that used to carry it are gone: a section with neither is a heading that
	 * explains nothing, and "remember to add one" is not a rule a type can
	 * keep. The glyph is named for its section - a page with a dozen of them
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
			{/* The shared header primitive, so this heading is drawn the one way
			    every section header is: title, help, docs, meta, actions as
			    SIBLINGS on the .section-head line. The form's own scale (13px
			    titles, 11px meta) rides the .form-section-head rules in
			    dashboard.css. Quiet dims the whole line through inheritance; the
			    fields below stay at full strength, because a value the user
			    typed is never the quiet part. */}
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
			{/* The section owns the tracks and every row adopts them through
			    subgrid, so one gutter and one set of control edges run down the
			    whole scroll. Rows cannot each own a grid instead: the last track
			    is content-sized, and a row carrying a docs link beside its "?"
			    then sizes it wider than its neighbours and drags the fr tracks
			    with it - the Declared models row ran its textarea 250px past
			    every other control that way. Nor can the cells be direct children
			    of one grid: the glyph has to change track per breakpoint, that
			    needs a pinned row, and a pinned row number stacks every row's
			    glyph into the section's first row. Subgrid is what gives shared
			    sizing AND per-row placement.

			    The breakpoint measures the PANE, not the viewport: this form
			    narrows when the rail is there, when the panel is docked, and when
			    the window is split, none of which the viewport width describes.
			    Below it the rows stack, because the gutter stops being worth what
			    it costs the fields - at 500px of pane the 150px gutter left a
			    Base URL input too narrow to show its own value. */}
			<div
				className={cn(
					"grid grid-cols-[150px_minmax(0,1.35fr)_minmax(0,1fr)_auto] gap-x-4 gap-y-2.5",
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
 * One row of the section grid: the label in the gutter, the control, and the
 * hint beside it - or, when the field has a problem, the error in the hint's
 * place. A `wide` control (record tables, header rows, a textarea) takes the
 * hint column too and carries its own hint underneath.
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
	// One row of the section's tracks, adopted through subgrid. Wide: gutter,
	// control, hint, glyph. Stacked: label and glyph on line one, control and
	// then hint at full width below. 700px of PANE is the threshold
	// dashboard.css already stacks key/value rows at, and the matcher editor
	// inside this very page turns at it, so the page changes idiom once.
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
					wide === true && "col-span-2 flex-col items-stretch gap-1"
				)}
			>
				{children}
			</div>
			{wide === true ? null : (
				// The hint carries the field's id whether it reads as a hint or as
				// the error covering it: a description that only exists while
				// something is wrong leaves the storage advice - the most
				// consequential line on the page - unannounced.
				// The id sits on the CELL, and the two voices are its children: the
				// hint stays in flow (invisible while a problem stands, so the cell
				// keeps the height it reserved) and the problem is an absolute
				// overlay in the same box - the settings rows' covered-description
				// mechanism, so a field going invalid never moves the input or the
				// rows below (the charter's transients-never-move-anything clause).
				// min-height reserves one line where the field has no hint to hold
				// the box open; a longer message overflows the reserved box into the
				// row gap instead of re-flowing the form. Only visible text reaches
				// the field's announcement: a hidden child is excluded from the
				// description the id carries.
				<span
					id={errorId}
					className={cn(
						"relative col-start-3 row-start-1 flex min-h-[1lh] items-baseline gap-1.5 text-[11.5px]",
						"@max-[700px]/pane:col-start-1 @max-[700px]/pane:col-span-2 @max-[700px]/pane:row-start-3"
					)}
				>
					<span
						className={cn(
							// One register at a time: stacking text-muted-foreground under
							// state-warn shipped muted for as long as the tone rules could
							// lose to a utility, and still reads as muted in the source now
							// that they cannot. The covering error hides this span whole,
							// so the two registers never paint together.
							hintTone === "warn" ? "state-warn" : "text-muted-foreground",
							showProblem && "invisible"
						)}
					>
						{hint}
					</span>
					{showProblem ? (
						// pointer-events-none like the settings overlay: what it covers
						// is visibility-hidden and untouchable anyway, and the overlay
						// must never eat clicks aimed at the row.
						<span className="error pointer-events-none absolute inset-0">{problem}</span>
					) : null}
				</span>
			)}
			{/* Last in the DOM, so Tab reaches a field's control before its help
			    rather than stopping at the "?" on the way in. Which track it
			    lands in is the container query's business: the end of a wide row,
			    and up beside the label once stacked, where "after the hint" would
			    be a mark alone on a line under an input for the five rows that
			    have no hint. The glyph is the ONLY thing this track carries: a
			    row-level extra (a docs link once rode here) widens the section's
			    own auto track and jogs its help column off every other
			    section's - anything beyond the "?" belongs to the section
			    header's docs slot. */}
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
		</div>
	);
}

/** A note or control that belongs to the section but not to one field; spans the whole grid. */
function FieldSpan({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn("col-span-4 min-w-0 @max-[700px]/pane:col-span-2", className)}>{children}</div>;
}

/**
 * The line marking off an auth form's companions - second credentials sent
 * beside the chosen form's own. A label, not a fold: there is nothing to open,
 * and the Authentication "?" says what a companion is.
 */
function CompanionNote() {
	return (
		<FieldSpan className="mt-2">
			<p className="m-0 text-[11.5px] font-semibold text-muted-foreground">{l10n.t("Companions (optional)")}</p>
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

/**
 * The commit bar the edit and adopt forms share: it sticks to the bottom of
 * the viewport while the page scrolls. Its rule meets the page's own 860px
 * measure when the pane caps the column, and bleeds into `.pane`'s 24px gutter
 * when the pane is what limits it - a symmetric bleed at every width overshot
 * the capped column by 24px each side. The bleed is a CLAMP rather than a pane
 * query on purpose: 860 sits inside the band the rail's collapse makes
 * ambiguous (the same pane width occurs on both sides of the collapse, so a
 * threshold there flips back and forth while the window narrows once -
 * narrowThresholds.test.ts refuses it), and a continuous ramp cannot flip.
 * 884px is the cap plus the full bleed, so the ramp starts exactly where the
 * gutter stops being the limit; the padding mirrors the margin so the buttons
 * hold the column's edge. The z-index is the house footer level; the discard
 * question outranks it from the shell's own modal layer, not from here.
 */
const COMMIT_BAR_CLASS =
	"toolbar sticky bottom-0 z-[2] mt-6 mb-[-48px] flex flex-wrap items-center gap-4 border-t border-border bg-background py-3 [--bleed:clamp(0px,884px_-_100cqw,24px)] mx-[calc(0px_-_var(--bleed))] px-[var(--bleed)]";

/** A control that belongs under the row above it: it clears the label gutter, and takes the full width once the rows stack. */
function FieldUnderRow({ children, className }: { children: ReactNode; className?: string }) {
	return (
		// Placed in the grid rather than padded past the gutter by hand: a
		// literal offset is the track width plus the gap restated, and the two
		// drift the moment either changes.
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
 * React mirrors a controlled input's value into the value ATTRIBUTE (via the
 * defaultValue property, for form-reset semantics), which would put a
 * secret's plaintext into every DOM serialization - and the mirror is written
 * again after each input event by React's controlled-state restoration, so a
 * one-time scrub cannot hold. This mount ref instead makes the mirror inert
 * for the node's lifetime: it re-writes the value property first (a dirty
 * input no longer reflects the attribute, so the removal cannot blank a
 * not-yet-touched field), removes the mounted attribute, and shadows
 * defaultValue with a no-op instance property so every later mirror write
 * vanishes. The secret still lives only in the value property, exactly the
 * one residence the sweep in the tests permits.
 */
function disarmValueAttributeMirror(node: HTMLInputElement | null): void {
	if (node === null) {
		return;
	}
	const current = node.value;
	node.value = current;
	node.removeAttribute("value");
	Object.defineProperty(node, "defaultValue", {
		configurable: true,
		get: () => "",
		set: () => undefined,
	});
}

/**
 * One secret field: a password input plus the user's per-field storage
 * choice. Values in secure storage are never shown (they never reach this
 * page); an inline value prefills the input, masked behind a Show toggle,
 * because settings.json already displays it in plain text. Leaving the input
 * empty - or leaving a prefill unedited - keeps the stored value where it is.
 * Invariant: this is the page's ONLY secret-bearing input. A new secret field
 * must render through it, because the disarm above is what keeps the value
 * out of the serialized DOM.
 */
function SecretField({ field, help, props }: { field: SecretFieldId; help?: string; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const [revealed, setRevealed] = useState(false);
	// Nothing to reveal in an empty or removal-marked field, so the toggle
	// disables and any lingering revealed state resets: the next value typed
	// (or a re-ticked remove undone) starts masked again.
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
	// One short line, and only where it says something the reader cannot see:
	// where the value is now, or what the save is about to do with the one they
	// typed. A problem takes its place, so the row is one line tall in every
	// state, and a field with nothing stored and nothing typed says nothing.
	// The prefilled value is already in settings.json; a typed one is about to
	// be. One sentence for both was wrong for whichever state it did not mean,
	// and its translations picked the future tense for a value saved long ago.
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
	// Two states earn a tone of their own: a value on its way into plain text,
	// and a stored value on its way out. Both are consequences the reader is
	// one Save away from, stated where the choice is made. An unchanged prefill
	// is a fact about the past, so it states itself plainly.
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
					<Input
						id={id}
						ref={disarmValueAttributeMirror}
						// The reveal button is absolutely positioned over the field's
						// right edge; the padding keeps the value clear of it.
						className="min-w-0 flex-1 pr-13"
						type={revealed ? "text" : "password"}
						value={value.value}
						disabled={props.disabled || value.clear}
						aria-invalid={showProblem}
						aria-describedby={errorId}
						onChange={(event) => patchSecret({ value: event.currentTarget.value })}
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
					{/* Stacked, the two options wrapped apart - one beside this label,
					    one under it - so the pair a reader is choosing between lost its
					    shared left edge. The label and its glyph take the line
					    together and the options share the next one. */}
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
 * Whether a field "holds content" for problem visibility. Record-row and
 * list-valued fields only carry problems on entries the user (or the
 * prefill) put there, so any entries count as content; text and secret
 * fields count their text.
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
		// Only a custom mode with text counts: an empty custom surfaces on Save
		// (which marks every field touched), like the other required-but-empty
		// inputs.
		return draft.apiVersion.mode === "custom" && draft.apiVersion.custom.length > 0;
	}
	const value = draft[field];
	return typeof value === "string" ? value.length > 0 : value.value.length > 0;
}

/**
 * An inactive form's stored secret, rendered so its Remove checkbox stays
 * reachable without offering an input (the parse would drop anything typed
 * into a field whose form is not selected): where the value lives, the remove
 * gesture, and any problem the parse pinned on the field.
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
			// The same id the field's input-bearing row uses. The two never
			// render together - this row exists only while that form is
			// unselected - so the id stays unique.
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

/**
 * The custom-header rows: name and value inputs per row, the parse's
 * row-aligned problems under the offending row, remove and add actions - the
 * record editors' row idiom over the entry's headers record.
 */
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
						// 204 = the 190px measure this input always showed plus its own
						// padding and border, which border-box now counts inside the
						// width; at 190 the placeholder lost its last three characters.
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
					{/* The row's one status line, reserved whether or not it speaks
					    (the record rows' .record-status idiom; min-height 1lh from the
					    shared .row .row-status rule): the parse verdict lands per
					    keystroke, and a line mounted only alongside a problem pushed
					    the row below down on the first bad character. */}
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
 * The inline Add/Edit form. Saving posts one saveServerSetting intent through
 * the form's own useIntentOutcome hook and waits for its correlated outcome:
 * an ok closes the form (discarding the draft, typed secrets included); a
 * validation-kind fail returns it to a retryable editing state, while an
 * operation-kind one closes it too - the save committed, so the draft is
 * stale and the section-level notice carries the recovery path. Unrelated
 * state pushes leave it alone.
 */

/**
 * The edit destination: one entry's whole configuration, mounted in the
 * shell's pane rather than floating over the page it came from. The rail
 * stays on screen beside it, which is the point - the user's rule about doors
 * opening onto doors applies to a form as much as to a menu.
 *
 * The boundary outward is two facts and two events: the draft is dirty, the
 * reader asked to leave, the save committed. Everything else - which pane is
 * showing, what a rail click means while a draft is dirty, where focus lands
 * on the way out - belongs to the shell, and this page knows none of it.
 *
 * The target resolves from the live state on every render rather than from an
 * object captured at open time: a discovery pass landing under an open page
 * refreshes its evidence, and an entry deleted from another window leaves a
 * page that says so instead of one editing something that is gone.
 */
export function ServerEditPage({
	request,
	servers,
	onDirtyChange,
	onRequestClose,
	onSaved,
}: {
	request: ServerEditRequest;
	servers: readonly DashboardServer[];
	onDirtyChange: (dirty: boolean) => void;
	onRequestClose: () => void;
	onSaved: () => void;
}) {
	// The page's own adopt round trip. It lives here rather than in the servers
	// list because the page is what the outcome decides the fate of: an ok
	// leaves, a validation failure stays and re-enables the form. The list
	// keeps its own hook for the notice and the banner - both see the same
	// envelope, which is the documented shape of these outcomes.
	const adoptIntent = useIntentOutcome("adoptServer");
	const saveIntent = useIntentOutcome("saveServerSetting");
	const [adopting, setAdopting] = useState<string | undefined>(undefined);
	const [savingId, setSavingId] = useState<string | undefined>(undefined);
	const adoptOutcome = adoptIntent.outcome;
	const saveOutcome = saveIntent.outcome;
	// A validation failure keeps the reader here to fix it, so the message has
	// to be here too: the servers list carries its own banner, and the list is
	// behind this page. An operation failure committed its write, so it leaves
	// with the same disposition a success does and the list's banner takes it.
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

	// Arriving here is a navigation, so focus travels with it: to the first
	// field, or to the page itself when there is nothing to type into. A panel
	// used to do this by being a focus-trapped dialog; a destination has to do
	// it deliberately, or Tab would carry on from the row the reader left
	// behind on a pane that is no longer showing - and a nested overlay
	// closing would have nowhere inside the page to put focus back.

	// Misconfigured entries count as taken: they occupy their label in the
	// setting, so a rename onto one must be refused like any sibling.
	const declaredLabels = servers
		.filter((server) => server.origin === "declared" || server.origin === "misconfigured")
		.map((server) => server.label);

	// Memoized so the resolved target is one object for as long as the rows it
	// came from are: a fresh object per render turns any effect that depends on
	// it into a render loop, which is exactly what the prefill did.
	const resolved = useMemo(() => resolveEditTarget(request, servers), [request, servers]);
	const lastResolved = useRef(resolved);
	// A commit in flight freezes the target - the whole target, not just the
	// case where it stops resolving. The save's own write comes back as a
	// state push: a rename makes the old label resolve to nothing (the form
	// would unmount and the ack would land on nothing, so a save that worked
	// reads as a deleted entry), and a secret moving from secure to inline
	// resolves to a DIFFERENT object that restarts the prefill, drops the form
	// out of saving, and re-enables Save before the first ack lands. Both are
	// the same mistake: reading the result of a commit while the commit is
	// still in flight.
	const committing = savingId !== undefined || adopting !== undefined;
	if (resolved !== undefined && !committing) {
		lastResolved.current = resolved;
	}
	const target = committing ? lastResolved.current : resolved;
	// The entry went away under the page, taking the draft with it: there is
	// nothing left to save and so nothing to ask about. Without this the
	// shell's guard keeps answering "this is dirty" to a form that no longer
	// exists, and every way out raises a question nothing renders.
	const targetGone = target === undefined;
	useEffect(() => {
		if (targetGone) {
			onDirtyChange(false);
		}
	}, [targetGone, onDirtyChange]);
	const pageRef = useRef<HTMLElement>(null);
	// Also keyed on the form going away: an entry deleted under an open page
	// unmounts the field that had focus, and focus would land on the body -
	// outside the shell that hears Esc, so the reader's keyboard would stop
	// working on a page that is still on screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: targetGone is the trigger, not a value the body reads - the form going away is what leaves focus homeless
	useEffect(() => {
		const page = pageRef.current;
		if (page?.contains(document.activeElement) === true) {
			return;
		}
		const field = page?.querySelector<HTMLElement>("input, select, textarea");
		(field ?? page)?.focus();
	}, [targetGone]);
	// tabIndex -1 so the page can take focus itself when it holds no field;
	// never in the tab order, like every other programmatic focus target here.
	// The id is the surface the shell's discard-confirm modal returns focus
	// into on "keep editing".
	const page = (children: ReactNode) => (
		// A section rather than a dialog: it is where the reader IS, not
		// something over where they were - and a name needs an element that
		// takes one, so the heading only labels this because it is a section.
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
 * The request read against the live rows: absent when the row it names is
 * gone, or when it names a row whose shape the form cannot round-trip (a
 * misconfigured entry, which the list offers no edit for in the first place).
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
 * The way back, at the top where a reader looks for it. A panel had an X in
 * its corner; a destination has the trail it came down, and it routes through
 * the same request the rail and Esc do - so a dirty draft gets the same
 * question from all three (the shell's discard-confirm modal).
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
	// What the form opened with, for the save bar's unsaved count. Re-based
	// when the inline prefill lands (the same transform runs over both), so a
	// value the form filled in for the user never reads as an edit the user
	// made.
	const [baseline, setBaseline] = useState<ServerFormDraft>(() => draftFor(target));
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [testState, setTestState] = useState<TestState>({ kind: "idle" });
	// The form's own round trips. The inline-secret values live only in this
	// hook's state and the draft, both of which die with the form instance, so
	// a closed form leaves no secret value behind in webview memory.
	const saveIntent = useIntentOutcome("saveServerSetting");
	const testIntent = useIntentOutcome("testServerDraft");
	const inlineSecrets = useRpc("readInlineSecrets");
	// The full matcher editor overlay over this form, by record kind and DRAFT
	// index (the tables' sorted order is a view; the draft array is the
	// identity space). Index identity is safe HERE, unlike the settings
	// editors: the form's draft is local state no store push ever rewrites,
	// so the arrays only change through the form's own actions. It still
	// closes itself when its group leaves the draft.
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
	// Save holds until the prefill response lands (phase "prefill"): saving
	// before it arrives would assemble the still-empty fields as "keep",
	// silently dropping a relocation the user just picked (flip the radio to
	// secure, hit Save). Fields stay editable meanwhile; the response never
	// clobbers what was typed. The response is one round trip behind the form
	// opening, so the gate is imperceptible in practice.
	const saveOutcome = saveIntent.outcome;

	// Editing a declared entry with inline-stored secrets: ask for their values
	// once per form instance (the key remounts a fresh form). Secure-side and
	// absent fields are never requested-for or returned; they keep the empty
	// placeholder input.
	//
	// Keyed on WHICH entry rather than on the target object: the page resolves
	// that object from the live rows on every render, so an object dependency
	// re-asks on every render - and asking sets the phase, which renders, which
	// asks. The label is the identity that decides whether a second request
	// would even be a different question.
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

	// This form's own test outcome. Success renders the extension-composed
	// message verbatim ("Connected - N models"); an outcome for an abandoned
	// requestId (the state left "testing" on an edit or a retest) is ignored.
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
	// One parse per keystroke: it either carries the intent Save posts or the
	// problems the form renders, so what the fields show and what would be
	// saved can never diverge. The observed-keys evidence is the live prop, so
	// a discovery pass finishing under the open form refreshes the hints.
	const parse = parseServerForm(draft, {
		takenLabels: declaredLabels,
		...(originalLabel !== undefined ? { originalLabel } : {}),
		...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
	});
	const label = draft.label.trim();
	const renaming = target.kind === "edit" && label !== target.original.label;
	const collides = target.kind === "add" && declaredLabels.includes(label);

	// A problem is visible once its field was touched or holds content
	// (fieldHasContent); computed once here and passed through the render
	// props, so the fields and the save summary always show the same problems.
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
	// The capability-key autocomplete over THIS entry's own observed
	// /model/info vocabulary (live, like the hint evidence above): an
	// entry-scoped record applies to this server only, so other servers'
	// vocabularies never leak in - an add target (no server yet) and a server
	// without evidence get just the static list.
	const entryCapabilityKeySuggestions = capabilityKeySuggestions(observedModelInfoKeys);
	const headerRowProblems: readonly (string | undefined)[] = parse.ok ? [] : parse.headerProblems;
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find((field) => visibleProblems[field] !== undefined);
	// Every field of the entry is in the same scroll, so a problem is always
	// reachable: nothing has to be opened before Save can point at it.
	const changedFields = changedServerFormFields(draft, baseline);
	const unsavedCount = changedFields.length;
	// The models-file caveat is about a connection the host already resolved,
	// so it belongs to an edit that actually moves one - not to every open.
	const connectionEdited = changedFields.some((field) => (CONNECTION_FIELDS as readonly string[]).includes(field));

	const save = () => {
		if (phase.phase !== "editing") {
			// Belt and braces behind the disabled button: never post while the
			// prefill is still on its way or a save is already in flight.
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

	// The draft as typed goes out for one extension-side discovery probe; the
	// label and the model-parameter rows never gate it (parseServerFormForTest),
	// but a connection-relevant problem surfaces the way Save surfaces its
	// problems instead of probing a configuration a save would refuse.
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
			// Any field a probe's outcome depends on makes a standing (or
			// in-flight) result describe a configuration that no longer exists;
			// a stale PASS is worse than no result, so it clears. The label
			// counts: it selects which stored or orphan secret a "keep" directive
			// resolves extension-side, so a rename can silently change the
			// effective credentials the probe would use.
			// modelCapabilities and expectedFailures stay out of CONNECTION_FIELDS
			// (they never gate a probe) but still clear a standing result: they
			// shape its OUTCOME - the declared count and the expected downgrade.
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
			// An empty field stays quiet on blur: brushing focus past it toward
			// Cancel must not repaint the form mid-click (the inserted error line
			// moves the buttons under the pointer). A required-but-empty field
			// surfaces on Save, which marks every field touched.
			if (!fieldHasContent(draft, field)) {
				return;
			}
			setTouched((current) => new Set(current).add(field));
		},
	};

	// Kept stored secrets whose form is not selected: the shape-and-storage
	// rule (docs/servers.md#secrets-and-secret-storage) means a stored API key
	// still activates the bearer on the none and virtualKey shapes, and kept
	// stored values of the other two fields would make the save OAuth- or
	// virtual-key-shaped, so each renders a visible hint plus its Remove
	// checkbox instead of silently riding along.
	const storedApiKeyOrphan =
		(draft.authForm === "none" || draft.authForm === "virtualKey") && draft.apiKey.existing !== "none";
	const storedVkOrphan = draft.authForm === "none" && draft.virtualKeyValue.existing !== "none";
	const storedOauthSecretOrphan = draft.authForm !== "oauth" && draft.oauthClientSecret.existing !== "none";

	const virtualKeyPair = (
		<>
			<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
			<SecretField field="virtualKeyValue" props={props} />
		</>
	);

	// Closing the overlay sweeps up a still-pristine new matcher (no key, no
	// fields): keeping it would strand an invalid empty row in the table.
	// Both the sweep and the add that minted the group write through setDraft
	// directly, NOT props.patch: a structural add-then-cancel is a no-op and
	// must not arm the shell's discard confirm (the dirty report is one-way).
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
			{/* The shared header primitive puts the docs anchor beside the heading
			    as its sibling, so neither the page's accessible name nor the
			    heading's own carries the anchor's label. The 24px above is the h3
			    rule's, written here because this row opens no <section> for it to
			    come from, and a heading zeroed inside an unspaced row would slide
			    up into the breadcrumb. */}
			<SectionHeader
				titleId="server-form-title"
				level={3}
				title={target.kind === "add" ? l10n.t("Add server") : l10n.t("Edit {0}", target.original.label)}
				docs={{ href: DOCS_LINK_SERVER_FORM, label: l10n.t("Open the server fields guide") }}
				className="mt-6"
			/>
			<FormSection title={l10n.t("Connection")} help={helpConnectionSection()}>
				<TextField field="label" placeholder={l10n.t("e.g. Production")} props={props} />
				{renaming && (parse.ok || parse.problems.label === undefined) ? (
					<FieldUnderRow>
						<p className="hint m-0 text-[11.5px]">
							{l10n.t("Renaming creates a new server; the old name serves until you delete it from the models file.")}
						</p>
					</FieldUnderRow>
				) : null}
				{collides ? (
					<FieldUnderRow>
						<p className="hint m-0 text-[11.5px]">
							{l10n.t("An entry with this label already exists; saving replaces it.")}
						</p>
					</FieldUnderRow>
				) : null}
				<TextField field="baseUrl" mono={true} placeholder={l10n.t("e.g. http://localhost:4000")} props={props} />
				{/* The probe belongs to the URL it probes, not to the save bar:
				    testing is not committing, and the two were read as one action
				    for as long as they shared a footer. It keeps the quiet rank
				    for the same reason - Save is the page's one accent, and a
				    second one would make the reader choose between them - and
				    earns its shape from the icon instead: a glyph is what tells a
				    control apart from the hint beside it without borrowing rank
				    from the commit. */}
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
								// A classified setup problem: the link to its matching
								// troubleshooting-guide section rides inside the alert so one
								// announcement carries the failure and the way out. The leading
								// space keeps copied text from gluing the link label onto the
								// error message.
								<>
									{" "}
									<span className="test-hint">
										<DocsLink {...troubleshootingLink(testState.classification.setupHint)}>
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
						{/* A rename gets the full three-step remediation from the toast
						    the sync engine raises on save; a connection edit raises no
						    toast, so this line is the only place the reader is told,
						    and it has to name every step or it strands them.
						    The row is mounted on every edit form and the sentence holds
						    its own box invisibly until it speaks (the spacing-twin
						    idiom; visibility keeps the box and removes the words from
						    the accessibility tree): the note lands on the first
						    connection keystroke, and inserting it then pushed every row
						    below down 36px mid-edit. While a rename stands, the rename
						    note carries the remediation and this line stays silent. */}
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
					{/* One per line rather than an inline flow. The four labels are
					    very unequal - "None" against "Virtual key in a custom
					    header" - so a wrapping row lands differently at every pane
					    width: an orphaned "OAuth" on its own second line here, a
					    ragged 2x2 with three different left edges there. Mutually
					    exclusive options are read by scanning down the choices, and
					    a column is the only layout that lets that happen at every
					    width. The cost is one row's height, paid once. */}
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
							{/* The tone-text register (state-warn), not utility spellings of
							    the same color and weight: one register keeps the heading and
							    its lines in one voice, and carries the forced-colors squiggle
							    the utilities lack. */}
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
						className="w-full rounded-sm border border-input bg-input-background px-1.5 py-[3px] font-mono text-[12px] text-input-foreground placeholder:text-input-placeholder focus:outline-1 focus:-outline-offset-1 focus:outline-ring focus:outline-solid"
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
					{/* One row while the pair fits it with room, a column below the
					    560px tier: between those, the two labels either sat squeezed
					    into one exactly-full line or wrapped at whatever width the
					    translation happened to hit. The threshold is the stylesheet's
					    own 560 with the same exclusive `width < 560px` semantics. */}
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
				{/* Named apart from the confirm dialog's own Discard: this one
				    REQUESTS a close (a dirty form still gets asked), and two
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
				<span className="ml-auto text-right text-[11.5px] text-muted-foreground">
					<span className="save-target">{l10n.t("Saved to {0}", SERVERS_SETTING_ID)}</span>
					{unsavedCount > 0 ? (
						<span className="unsaved-count block tabular-nums">
							{unsavedCount === 1 ? l10n.t("1 unsaved change") : l10n.t("{0} unsaved changes", unsavedCount)}
						</span>
					) : null}
				</span>
			</div>
			{matcherEditorView}
		</div>
	);
}

/**
 * The adopt form: turns an external provider group into a declared servers
 * entry. Credentials exist extension-side only, so instead of secret inputs
 * the form offers one storage choice per secret field; the posted intent
 * carries the label, the source row's identity, and those choices - never a
 * credential value. The round trip lives in ServerEditPage, which leaves on
 * its own ack; the servers list watches the same envelope for its
 * post-adoption notice, so leaving mid-flight loses nothing.
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

	// Which secret rows to offer: hasApiKey is coarse (the provider reports it
	// for OAuth-only groups too, as "authentication configured"), so the key
	// row drops out only when the group demonstrably holds no credentials at
	// all, and every row states its own condition instead of promising a copy
	// that may not exist.
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
			{/* The same header primitive as the edit form's title row, without a
			    docs slot; the 24px above is the h3 rule's, restated here for the
			    reason the edit form restates it. */}
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
