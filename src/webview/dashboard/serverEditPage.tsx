/**
 * The server edit surface, the add/edit form and its field machinery. The boundary outward is four callbacks
 * (onDirtyChange, onRequestClose, onTargetGone, onSaved), and the module knows nothing about what is mounted around it.
 */
import * as l10n from "@vscode/l10n";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IntentAckTone, ReplacedEntryIdentity } from "../../dashboard/endpoints";
import type { PrefixGroup } from "../../dashboard/recordDraft";
import { toCapabilityGroups, toGroups, toggleCanonical, toHeaderRows } from "../../dashboard/recordDraft";
import type {
	ApiVersionDraft,
	AuthFormId,
	ServerFormContext,
	ServerFormDraft,
	ServerFormField,
	ServerFormIntent,
	ServerFormParse,
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
	mcpDraftOf,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	staleKeyFieldsOnSave,
	storedInactiveSecrets,
} from "../../dashboard/serverForm";
import type {
	DashboardServer,
	DeclaredDashboardServer,
	EditableDashboardServer,
	ExternalDashboardServer,
} from "../../dashboard/viewModels";
import { isEditableServer } from "../../dashboard/viewModels";
import { CONFIG_SECTION, SERVERS_SETTING_KEY } from "../../shared/config/settingSpec";
import type { SetupHintKind, TransportErrorClassification } from "../../shared/errorClassification";
import type { ExpectedFailureCategory, NonChatMode, SecretFieldId, SkippedModeCounts } from "../../shared/serverEntry";
import {
	EXPECTED_FAILURE_CATEGORIES,
	NON_CHAT_MODES,
	pickNonSecretOptionalFields,
	SECRET_FIELD_IDS,
	secretDestination,
} from "../../shared/serverEntry";
import { canonicalBaseUrl, DEFAULT_API_VERSION, mcpEndpointOf } from "../../shared/util/baseUrl";
import { trimHttpWhitespace } from "../../shared/util/headers";
import { SETUP_HINT_DOCS_URLS } from "../../shared/util/links";
import { AdoptForm } from "./adoptForm";
import { BackToServers } from "./backToServers";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_AUTHENTICATION,
	DOCS_LINK_DECLARED_MODELS,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_MODEL_PARAMETERS,
	DOCS_LINK_SERVER_FORM,
} from "./docsLinks";
import { FailureText } from "./failureText";
import { DocsLink, Help } from "./help";
import {
	helpConnectionSection,
	helpDiscoverySection,
	helpEntryModelParameterPrefix,
	helpMcpEndpoint,
	helpMcpSection,
	helpOauthCompanionApiKey,
	serverFieldHelp,
} from "./helpText";
import type { IntentOutcome, IntentOutcomeState } from "./hooks";
import { useIntentOutcome, useRpc } from "./hooks";
import { IconAdd, IconPlug } from "./icons";
import { capabilityKeySuggestions } from "./recordGroupFields";
import type { GroupIssueView, RecordEditorKind } from "./recordIssues";
import { capabilityIssueViews, paramIssueViews } from "./recordIssues";
import { RecordMatcherEditorOverlay, RecordMatcherTable } from "./recordMatcherTable";
import type { FieldRenderProps } from "./serverFormFields";
import {
	COMMIT_BAR_CLASS,
	CompanionNote,
	FieldSpan,
	FieldUnderRow,
	FormFieldRow,
	FormSection,
	fieldHasContent,
	HeaderRowsEditor,
	matcherCountAside,
	SecretField,
	StoredSecretRow,
	secretDraft,
	TextField,
	unsavedText,
} from "./serverFormFields";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "./ui/cn";
import { ConfirmDialog } from "./ui/dialog";
import { Input } from "./ui/input";
import { Radio } from "./ui/radio";
import { SectionHeader } from "./ui/section";
import { Select } from "./ui/select";
import { Textarea } from "./ui/textarea";

/** Where a saved entry lands, shown in the save bar because a page that writes a settings file should say so. */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/**
 * What the open form is for, decided once where it opens so no component re-derives it.
 *
 *   An edit target                      -> is an EditableDashboardServer BY TYPE
 *   secret locations are still unproven -> cannot construct one
 *   cannot construct one                -> no form can freeze a wrong identity from it
 */
type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: EditableDashboardServer }
	| { readonly kind: "adopt"; readonly server: ExternalDashboardServer };

/** The targets ServerForm handles; adoption renders AdoptForm instead. */
type ServerFormTarget = Extract<FormTarget, { kind: "add" | "edit" }>;

/**
 * The edit form's live evidence row: the CURRENT declared row, looked up per render rather than from the form's frozen
 * open-time snapshot - a discovery pass finishing under an open form must update the unknown-key hints and the
 * skipped-mode checkboxes.
 */
function liveRowForForm(servers: readonly DashboardServer[], target: ServerFormTarget): DashboardServer | undefined {
	if (target.kind !== "edit") {
		return undefined;
	}
	return servers.find((server) => server.origin === "declared" && server.label === target.original.label);
}

/**
 *   What the shell asked this page to be -> by IDENTITY rather than by object
 *   by IDENTITY rather than by object    -> resolved against the live state on every render
 */
export type ServerEditRequest =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly label: string }
	| { readonly kind: "adopt"; readonly handle: string };

/**
 * Where the form is in its life.
 *
 *   Prefill and save -> each run their own correlation
 *   the form         -> is only ever in one
 */
type FormPhase =
	| { readonly phase: "prefill" }
	| { readonly phase: "editing" }
	| { readonly phase: "saving"; readonly requestId: string };

/**
 * The draft test's own lifecycle, independent of FormPhase: a test in flight must not gate editing, saving, or
 * cancelling. Leaving "testing" abandons the in-flight requestId, so a late outcome is ignored - exactly what clearing
 * on an edit needs.
 */
type TestState =
	| { readonly kind: "idle" }
	| { readonly kind: "testing"; readonly requestId: string }
	| { readonly kind: "pass"; readonly text: string; readonly tone?: IntentAckTone | undefined }
	| {
			readonly kind: "fail";
			readonly text: string;
			readonly classification?: TransportErrorClassification | undefined;
	  };

/**
 * The troubleshooting-guide section behind a setup-hint id, read from the host's own hint-to-heading record so
 * the dashboard and the host's toasts land on one heading. Labels resolve per call so the l10n bundle is
 * honored; shared by the draft-test footer and the servers error banner, so a classified failure links the
 * same section everywhere.
 */
export function troubleshootingLink(hint: SetupHintKind): { href: DocsUrl; label: string; topic: string } {
	const href = SETUP_HINT_DOCS_URLS[hint];
	switch (hint) {
		case "proxy-not-running":
		case "use-bare-localhost":
			// The bare-localhost advice is a bullet of the connection-error section, so both hints share one label.
			return {
				href,
				label: l10n.t("Open the troubleshooting guide: unable to connect"),
				topic: l10n.t("unable to connect"),
			};
		case "configure-api-key":
			return {
				href,
				label: l10n.t("Open the troubleshooting guide: authentication failed"),
				topic: l10n.t("authentication failed"),
			};
		case "check-base-url":
			return {
				href,
				label: l10n.t("Open the troubleshooting guide: the server answered 404"),
				topic: l10n.t("the server answered 404"),
			};
	}
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

/**
 * One included-mode checkbox label: the mode token (a protocol term, untranslated) plus what the last listing dropped.
 */
function includeModeLabel(mode: NonChatMode, skipped: number | undefined): string {
	return skipped !== undefined && skipped > 0 ? l10n.t("{0} ({1} skipped)", mode, skipped) : mode;
}

/**
 * The entry's own base URL is right there in the draft, so the hint names the exact address rather than describing the
 * rule and leaving the reader to apply it. A base URL that is empty or not yet a usable URL has no derivable answer, so
 * that case falls back to naming the shape instead of interpolating half a URL.
 */
function derivedMcpHint(baseUrl: string): string {
	const trimmed = trimHttpWhitespace(baseUrl);
	// mcpEndpointOf over the spelling Save stores is the publisher's own derivation, so the address named here is the
	// address that gets published - not a second rendering of the rule.
	const canonical = canonicalBaseUrl(trimmed);
	return isUsableHttpUrl(trimmed) && canonical !== undefined
		? l10n.t("Leave empty to use {0}", mcpEndpointOf(canonical))
		: l10n.t("Leave empty to use this server's own /mcp.");
}

function draftFor(target: ServerFormTarget): ServerFormDraft {
	if (target.kind === "add") {
		return EMPTY_SERVER_FORM;
	}
	const original = target.original;
	const locations = original.config.secrets.locations;
	return {
		label: original.label,
		baseUrl: original.baseUrl,
		apiVersion: apiVersionDraftOf(original.config.apiVersion),
		authForm: deriveAuthForm({ ...original.config, secrets: locations }),
		oauthTokenUrl: original.config.oauthTokenUrl ?? "",
		oauthClientId: original.config.oauthClientId ?? "",
		oauthScopes: original.config.oauthScopes ?? "",
		virtualKeyHeader: original.config.virtualKeyHeader ?? "",
		apiKey: secretDraft(locations.apiKey),
		oauthClientSecret: secretDraft(locations.oauthClientSecret),
		virtualKeyValue: secretDraft(locations.virtualKeyValue),
		headers: toHeaderRows(original.config.headers ?? {}),
		declaredModels: (original.config.declaredModels ?? []).join("\n"),
		budget: original.config.budget === undefined ? "" : String(original.config.budget),
		mcp: mcpDraftOf(original.config.mcp),
		modelParameters: toGroups(original.config.modelParameters ?? {}),
		modelCapabilities: toCapabilityGroups(original.config.modelCapabilities ?? {}),
		expectedFailures: original.config.expectedFailures ?? [],
		includeModes: original.config.includeModes ?? [],
	};
}

/**
 * The Authentication selector's option labels; OAuth stays English (protocol term). Deliberately distinct from the
 * field labels: two identical label texts would leave label-based lookup - screen readers' and the test harness's -
 * ambiguous.
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

/**
 * The request read against the live rows: absent when the row is gone or cannot round-trip the form (a misconfigured
 * entry, which the list offers no edit for).
 *
 *   "locations-unproven"                    -> it is not an edit target - the page waits
 *   its secret locations are not proven yet -> it is not an edit target
 */
function resolveEditTarget(
	request: ServerEditRequest,
	servers: readonly DashboardServer[]
): FormTarget | "locations-unproven" | undefined {
	if (request.kind === "add") {
		return { kind: "add" };
	}
	if (request.kind === "edit") {
		const original = servers.find(
			(server): server is DeclaredDashboardServer => server.origin === "declared" && server.label === request.label
		);
		if (original === undefined) {
			return undefined;
		}
		return isEditableServer(original) ? { kind: "edit", original } : "locations-unproven";
	}
	const server = servers.find(
		(candidate): candidate is ExternalDashboardServer =>
			candidate.origin === "external" && candidate.adoptHandle === request.handle
	);
	return server === undefined ? undefined : { kind: "adopt", server };
}

/**
 * What the form's sections share.
 *
 *   parse          -> one per keystroke: either the intent Save posts or the problems the sections render, so shown
 *                     and saved can never diverge
 *   keySuggestions -> the capability-key autocomplete over THIS entry's own observed vocabulary (live, like the hint
 *                     evidence): entry-scoped records apply to this server only, so other servers' never leak in
 *   setDraft       -> structural writes that must not dirty the form; edits go through props.patch
 */
interface FormModel {
	readonly target: ServerFormTarget;
	readonly draft: ServerFormDraft;
	readonly parse: ServerFormParse;
	readonly props: FieldRenderProps;
	readonly saving: boolean;
	readonly keySuggestions: readonly string[];
	readonly setDraft: Dispatch<SetStateAction<ServerFormDraft>>;
}

interface ServerFormProps {
	/** Add or edit; the draft and the frozen identity derive from it once, when the form opens (draftFor). */
	readonly target: ServerFormTarget;

	/** Labels the setting already holds (declared and misconfigured entries); a collision refuses the add or rename. */
	readonly declaredLabels: readonly string[];

	/** The external groups' sync stamps: a label among them is likely held by the host, so the form advises, not refuses. */
	readonly liveGroupLabels: readonly string[];

	/** The edited entry's LIVE observed /model/info key set (liveRowForForm); the capability hints' evidence. */
	readonly observedModelInfoKeys?: readonly string[] | undefined;

	/** The edited entry's LIVE per-mode skip counts (liveRowForForm); the include-modes checkboxes' evidence. */
	readonly skippedModeCounts?: SkippedModeCounts | undefined;

	/** Reports that the draft has edits worth asking about; the shell's navigation guard reads it. */
	readonly onDirtyChange: (dirty: boolean) => void;

	/** Hands the posted intent's requestId to the page, which owns the round trip. */
	readonly onSavePosted: (requestId: string) => void;

	/** The reader asked to leave; the shell owns what that means. */
	readonly onRequestClose: () => void;
}

/**
 * The draft, its baseline, and the frozen identity, all derived from the target once when the form opens.
 *
 *   baseline     -> what the form opened with, for the save bar's unsaved count; re-based when the prefill lands, so a
 *                   value the form filled in never reads as a user edit
 *   original     -> the identity of the entry this form DISPLAYS, frozen like the draft while the target prop follows
 *                   live state; it rides the save, test, and prefill intents as `replace`. Locations only, never values
 *   applyPrefill -> the inline-stored values landing in the untouched fields of draft and baseline alike
 */
interface OpeningState {
	readonly draft: ServerFormDraft;
	readonly setDraft: Dispatch<SetStateAction<ServerFormDraft>>;
	readonly baseline: ServerFormDraft;
	readonly original: ReplacedEntryIdentity | undefined;
	readonly applyPrefill: (values: Parameters<typeof applyInlinePrefill>[1]) => void;
}

/** The draft test's lifecycle and the moves on it. */
interface DraftTest {
	readonly state: TestState;
	readonly start: (requestId: string) => void;
	readonly clear: () => void;
}

/** What one draft test reads and marks. */
interface DraftTestInput {
	readonly draft: ServerFormDraft;
	readonly original: ReplacedEntryIdentity | undefined;
	readonly test: DraftTest;
	readonly send: IntentOutcomeState<"testServerDraft">["send"];
	readonly setTouched: Dispatch<SetStateAction<ReadonlySet<ServerFormField>>>;
}

/**
 * The full matcher editor overlay's target, by record kind and DRAFT index (the tables' sorted order is a view; the
 * draft array is the identity space). Index identity is safe HERE: the draft is local state no store push rewrites.
 */
interface MatcherEditorTarget {
	readonly kind: RecordEditorKind;
	readonly index: number;
}

/**
 * The stale-key question a Save raised (staleKeyFieldsOnSave): the save re-points the base URL while keeping a
 * secure-stored secret stamped for the old one, so nothing posts until the reader answers. Locations decided it.
 */
interface StaleKeyQuestion {
	readonly fields: readonly SecretFieldId[] | undefined;
	readonly ask: (fields: readonly SecretFieldId[]) => void;
	readonly dismiss: () => void;
}

/** Save and the two answers to the stale-key question. */
interface CommitActions {
	readonly save: () => void;
	readonly answerStaleKeyKeep: () => void;
	readonly answerStaleKeyClear: () => void;
}

interface CommitInput {
	readonly draft: ServerFormDraft;
	readonly parse: ServerFormParse;
	readonly phase: FormPhase;
	readonly options: ServerFormContext;
	readonly staleKey: StaleKeyQuestion;
	readonly setDraft: Dispatch<SetStateAction<ServerFormDraft>>;
	readonly setTouched: Dispatch<SetStateAction<ReadonlySet<ServerFormField>>>;
	readonly postSave: (intent: ServerFormIntent) => void;
}

interface FieldRenderInput {
	readonly draft: ServerFormDraft;
	readonly visibleProblems: ServerFormProblems;
	readonly saving: boolean;
	readonly test: DraftTest;
	readonly setDraft: Dispatch<SetStateAction<ServerFormDraft>>;
	readonly setTouched: Dispatch<SetStateAction<ReadonlySet<ServerFormField>>>;
	readonly onDirtyChange: (dirty: boolean) => void;
}

/** Everything the form renders from: the shared model, the probe, the commit moves, and the two overlays' state. */
interface ServerFormModel {
	readonly form: FormModel;
	readonly phase: FormPhase;
	readonly original: ReplacedEntryIdentity | undefined;
	readonly changedFields: readonly ServerFormField[];
	readonly test: DraftTest;
	readonly testConnection: () => void;
	readonly commit: CommitActions;
	readonly staleKey: StaleKeyQuestion;
	readonly matcherEditor: MatcherEditorTarget | undefined;
	readonly setMatcherEditor: (next: MatcherEditorTarget | undefined) => void;
}

/** Which of the label's notes speaks: a live group holds the label, an edit renames, or an add collides. */
interface LabelNotesProps {
	readonly target: ServerFormTarget;
	readonly parse: ServerFormParse;
	readonly renaming: boolean;
	readonly collides: boolean;
	readonly heldByGroup: boolean;
}

interface ConnectionSectionProps {
	readonly form: FormModel;
	readonly labels: LabelNotesProps;
	readonly testState: TestState;
	readonly onTest: () => void;
	readonly connectionEdited: boolean;
}

interface MatcherSectionProps {
	readonly form: FormModel;
	readonly kind: RecordEditorKind;
	readonly onOpenEditor: (index: number) => void;
}

/** The matcher section's words and ids, by record kind. */
interface MatcherSectionWords {
	readonly docs: { readonly href: DocsUrl; readonly label: string };
	readonly empty: string;
	readonly addId: string;
	readonly addLabel: string;
}

interface DiscoverySectionProps {
	readonly form: FormModel;
	readonly offeredModes: readonly NonChatMode[];
	readonly skippedModeCounts: SkippedModeCounts | undefined;
}

interface CommitBarProps {
	readonly phase: FormPhase;
	readonly firstBlocking: ServerFormField | undefined;
	readonly unsavedCount: number;
	readonly onSave: () => void;
	readonly onRequestClose: () => void;
}

interface MatcherOverlayProps {
	readonly form: FormModel;
	readonly editor: MatcherEditorTarget;
	readonly onClose: () => void;
	readonly onRemoved: () => void;
}

/** The record options every parse of this form reads: the taken labels, the frozen identity, the live evidence. */
function parseOptions(
	declaredLabels: readonly string[],
	original: ReplacedEntryIdentity | undefined,
	observedModelInfoKeys: readonly string[] | undefined
): ServerFormContext {
	return {
		takenLabels: declaredLabels,
		...(original === undefined ? {} : { original }),
		...(observedModelInfoKeys === undefined ? {} : { observedModelInfoKeys }),
	};
}

/** The edited entry's identity as the form opened on it (OpeningState.original); an add has none. */
function frozenIdentity(target: ServerFormTarget): ReplacedEntryIdentity | undefined {
	if (target.kind !== "edit") {
		return undefined;
	}
	return {
		label: target.original.label,
		baseUrl: target.original.baseUrl,
		...(target.original.config.apiVersion === undefined ? {} : { apiVersion: target.original.config.apiVersion }),
		...pickNonSecretOptionalFields(target.original.config),
		secrets: target.original.config.secrets.locations,
	};
}

/**
 * A problem is visible once its field was touched or holds content; computed once so the fields and the save summary
 * always show the same problems.
 */
function visibleProblemsOf(
	parse: ServerFormParse,
	draft: ServerFormDraft,
	touched: ReadonlySet<ServerFormField>
): ServerFormProblems {
	const visible: ServerFormProblems = {};
	if (parse.ok) {
		return visible;
	}
	for (const field of SERVER_FORM_FIELD_ORDER) {
		const problem = parse.problems[field];
		if (problem === undefined) {
			continue;
		}
		if (touched.has(field) || fieldHasContent(draft, field)) {
			visible[field] = problem;
		}
	}
	return visible;
}

/**
 * Whether a patch touches a field a probe's outcome depends on, so a standing result would describe a config that no
 * longer exists; a stale PASS is worse than none. modelCapabilities and expectedFailures stay out of CONNECTION_FIELDS
 * but still clear a result, since they shape its OUTCOME.
 */
function patchInvalidatesTest(patch: Partial<ServerFormDraft>): boolean {
	return Object.keys(patch).some(
		(field) =>
			field === "label" ||
			field === "modelCapabilities" ||
			field === "expectedFailures" ||
			field === "includeModes" ||
			field === "declaredModels" ||
			(CONNECTION_FIELDS as readonly string[]).includes(field)
	);
}

/** The connection fields a refused test parse flagged, added to the touched set so their problems show like Save's. */
function touchConnectionProblems(
	touched: ReadonlySet<ServerFormField>,
	problems: ServerFormProblems
): ReadonlySet<ServerFormField> {
	const next = new Set(touched);
	for (const field of CONNECTION_FIELDS) {
		if (problems[field] !== undefined) {
			next.add(field);
		}
	}
	return next;
}

/**
 * The stale-key dialog's detail line.
 *
 *   the keys share the base URL -> destinations deduplicated
 *   no token URL                -> nothing to name; the sentence without a destination
 *   resolved per render         -> l10n stays call-time
 */
function staleKeyDetail(fields: readonly SecretFieldId[], original: ReplacedEntryIdentity | undefined): string {
	const describe = (field: SecretFieldId): string => {
		if (original === undefined) {
			return "";
		}
		const destination = secretDestination(original, field);
		if (typeof destination === "string") {
			return destination;
		}
		if (destination.tokenUrl === undefined) {
			return "";
		}
		return destination.clientId === undefined
			? destination.tokenUrl
			: l10n.t("{0} (client {1})", destination.tokenUrl, destination.clientId);
	};
	const destinations = [...new Set(fields.map(describe).filter((d) => d !== ""))];
	return destinations.length > 0
		? l10n.t(
				"The stored key was saved for {0}. Clearing the key removes it from secret storage.",
				destinations.join(", ")
			)
		: l10n.t("The stored key was saved for a different destination. Clearing the key removes it from secret storage.");
}

/**
 * The SAVED entry's modes stay offered while the form is open, not the draft's: gating on the draft made unchecking a
 * retained mode with no current skips remove its checkbox, so the edit could not be reversed without discarding the
 * form.
 */
function offeredModesFor(
	target: ServerFormTarget,
	skippedModeCounts: SkippedModeCounts | undefined
): readonly NonChatMode[] {
	const savedModes = target.kind === "edit" ? (target.original.config.includeModes ?? []) : [];
	return NON_CHAT_MODES.filter((mode) => (skippedModeCounts?.[mode] ?? 0) > 0 || savedModes.includes(mode));
}

/** The draft's matcher groups of one record kind. */
function groupsOf(draft: ServerFormDraft, kind: RecordEditorKind): readonly PrefixGroup[] {
	return kind === "params" ? draft.modelParameters : draft.modelCapabilities;
}

/** The draft patch that replaces one record kind's matcher groups. */
function groupsPatch(kind: RecordEditorKind, groups: readonly PrefixGroup[]): Partial<ServerFormDraft> {
	return kind === "params" ? { modelParameters: groups } : { modelCapabilities: groups };
}

/**
 * Closing the overlay removes a still-pristine new matcher (no prefix, no rows): the patch that drops it, or nothing.
 * The caller writes it through setDraft, NOT props.patch - a structural add-then-cancel is a no-op and must not arm
 * the shell's discard confirm.
 */
function pristineMatcherRemoval(
	draft: ServerFormDraft,
	editor: MatcherEditorTarget
): Partial<ServerFormDraft> | undefined {
	const list = groupsOf(draft, editor.kind);
	const group = list[editor.index];
	if (group === undefined || trimHttpWhitespace(group.prefix).length > 0 || group.params.length > 0) {
		return undefined;
	}
	return groupsPatch(
		editor.kind,
		list.filter((_, index) => index !== editor.index)
	);
}

/** The matcher table's per-row issue views of one record kind, from the current parse. */
function matcherIssueViews(form: FormModel, kind: RecordEditorKind): readonly GroupIssueView[] {
	const { draft, parse } = form;
	if (kind === "params") {
		return paramIssueViews(
			draft.modelParameters,
			parse.ok ? [] : parse.modelParameterProblems,
			parse.modelParameterHints
		);
	}
	return capabilityIssueViews(draft.modelCapabilities, parse.modelCapabilityIssues);
}

function labelNotes(
	form: FormModel,
	declaredLabels: readonly string[],
	liveGroupLabels: readonly string[]
): LabelNotesProps {
	const { target, parse } = form;
	const label = trimHttpWhitespace(form.draft.label);
	const renaming = target.kind === "edit" && label !== target.original.label;
	return {
		target,
		parse,
		renaming,
		collides: target.kind === "add" && declaredLabels.includes(label),
		heldByGroup: (target.kind === "add" || renaming) && liveGroupLabels.includes(label),
	};
}

function matcherSectionWords(kind: RecordEditorKind): MatcherSectionWords {
	if (kind === "params") {
		return {
			docs: { href: DOCS_LINK_MODEL_PARAMETERS, label: l10n.t("Open the model parameters guide") },
			empty: l10n.t("No per-server parameters."),
			addId: "server-params-add",
			addLabel: l10n.t("Add model matcher"),
		};
	}
	return {
		docs: { href: DOCS_LINK_MODEL_CAPABILITIES, label: l10n.t("Open the model capabilities guide") },
		empty: l10n.t("No corrections."),
		addId: "server-caps-add",
		addLabel: l10n.t("Add capability matcher"),
	};
}

/**
 * The fields' render contract. patch dirties the form and clears a standing probe result it invalidates. touch leaves
 * an empty field quiet on blur: brushing focus toward Cancel must not repaint the form mid-click; required-but-empty
 * surfaces on Save, which marks every field touched.
 */
function fieldRenderProps({
	draft,
	visibleProblems,
	saving,
	test,
	setDraft,
	setTouched,
	onDirtyChange,
}: FieldRenderInput): FieldRenderProps {
	return {
		draft,
		visibleProblems,
		disabled: saving,
		patch: (patch) => {
			onDirtyChange(true);
			if (test.state.kind !== "idle" && patchInvalidatesTest(patch)) {
				test.clear();
			}
			setDraft((current) => ({ ...current, ...patch }));
		},
		touch: (field) => {
			if (!fieldHasContent(draft, field)) {
				return;
			}
			setTouched((current) => new Set(current).add(field));
		},
	};
}

/**
 * Save posts the parse as it stands, or surfaces every problem instead of refusing silently; a stored value saved for
 * the old destination asks first, since posting "keep" would re-pair it with the new one host-side.
 *
 * "Use same key" posts the parse as it stands (the host re-stamps the kept value for the new URL). "Clear key" marks
 * the stale fields' Remove checkboxes and posts the re-parse when it is clean; a clear that breaks a pairing rule (a
 * virtual key's header left naming a removed value) returns to editing with the problem visible instead.
 */
function commitActions({
	draft,
	parse,
	phase,
	options,
	staleKey,
	setDraft,
	setTouched,
	postSave,
}: CommitInput): CommitActions {
	const save = () => {
		if (phase.phase !== "editing") {
			// Belt and braces behind the disabled button: never post during prefill or save.
			return;
		}
		if (!parse.ok) {
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
			return;
		}
		const stale = staleKeyFieldsOnSave(parse.intent);
		if (stale.length > 0) {
			staleKey.ask(stale);
			return;
		}
		postSave(parse.intent);
	};
	const answerStaleKeyKeep = () => {
		staleKey.dismiss();
		if (parse.ok) {
			postSave(parse.intent);
		}
	};
	const answerStaleKeyClear = () => {
		if (staleKey.fields === undefined) {
			return;
		}
		let next = draft;
		for (const field of staleKey.fields) {
			next = { ...next, [field]: { ...next[field], clear: true } };
		}
		staleKey.dismiss();
		setDraft(next);
		const cleared = parseServerForm(next, options);
		if (cleared.ok) {
			postSave(cleared.intent);
		} else {
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
		}
	};
	return { save, answerStaleKeyKeep, answerStaleKeyClear };
}

/**
 * The draft as typed goes out for one extension-side probe; label and model-parameter rows never gate it, but a
 * connection-relevant problem surfaces like Save's.
 */
function startDraftTest({ draft, original, test, send, setTouched }: DraftTestInput): void {
	const testParse = parseServerFormForTest(draft, original === undefined ? {} : { original });
	if (!testParse.ok) {
		setTouched((current) => touchConnectionProblems(current, testParse.problems));
		return;
	}
	test.start(send(testParse.intent));
}

function useOpeningState(target: ServerFormTarget): OpeningState {
	const [draft, setDraft] = useState<ServerFormDraft>(() => draftFor(target));
	const [baseline, setBaseline] = useState<ServerFormDraft>(() => draftFor(target));
	const [original] = useState<ReplacedEntryIdentity | undefined>(() => frozenIdentity(target));
	const applyPrefill = useCallback((values: Parameters<typeof applyInlinePrefill>[1]) => {
		setDraft((current) => applyInlinePrefill(current, values));
		setBaseline((current) => applyInlinePrefill(current, values));
	}, []);
	return { draft, setDraft, baseline, original, applyPrefill };
}

/**
 * The inline-stored values, asked for once per form instance (the key remounts a fresh form); secure-side and absent
 * fields are never requested, and the request carries the FROZEN identity. This form's own response prefills the
 * untouched inline fields; the hook answers only the request this form instance posted.
 *
 * Save holds until the prefill lands: saving before would assemble empty fields as "keep", silently dropping a
 * just-picked relocation; fields stay editable meanwhile.
 */
function useInlinePrefill(
	original: ReplacedEntryIdentity | undefined,
	phase: FormPhase,
	setPhase: (next: FormPhase) => void,
	applyPrefill: OpeningState["applyPrefill"]
): void {
	const inlineSecrets = useRpc("readInlineSecrets");
	const requestInlineSecrets = inlineSecrets.send;
	const hasInlineSecret =
		original !== undefined && SECRET_FIELD_IDS.some((field) => original.secrets[field] === "settings");
	useEffect(() => {
		if (original === undefined || !hasInlineSecret) {
			return;
		}
		requestInlineSecrets({ replace: original });
		setPhase({ phase: "prefill" });
	}, [original, hasInlineSecret, requestInlineSecrets, setPhase]);
	const inlineValues = inlineSecrets.data?.values;
	useEffect(() => {
		if (phase.phase !== "prefill" || inlineValues === undefined) {
			return;
		}
		setPhase({ phase: "editing" });
		applyPrefill(inlineValues);
	}, [inlineValues, phase, setPhase, applyPrefill]);
}

/** The page owns what a save's outcome means for the destination; the form only needs to stop calling itself busy. */
function useSaveSettles(
	saveOutcome: IntentOutcome | undefined,
	phase: FormPhase,
	setPhase: (next: FormPhase) => void
): void {
	useEffect(() => {
		if (phase.phase === "saving" && saveOutcome?.id === phase.requestId) {
			setPhase({ phase: "editing" });
		}
	}, [saveOutcome, phase, setPhase]);
}

/**
 * This form's own test outcome; an outcome for an abandoned requestId is ignored. The zero-model probe passes with a
 * warning tone (the shared zero-model vocabulary); a quiet success carries none.
 */
function useDraftTest(testOutcome: IntentOutcome | undefined): DraftTest {
	const [state, setState] = useState<TestState>({ kind: "idle" });
	useEffect(() => {
		if (state.kind !== "testing" || testOutcome === undefined || testOutcome.id !== state.requestId) {
			return;
		}
		if (testOutcome.result === "ok") {
			setState({
				kind: "pass",
				text: testOutcome.message ?? l10n.t("Connected"),
				...(testOutcome.tone === undefined ? {} : { tone: testOutcome.tone }),
			});
		} else {
			setState({ kind: "fail", text: testOutcome.message, classification: testOutcome.classification });
		}
	}, [testOutcome, state]);
	return {
		state,
		start: (requestId) => setState({ kind: "testing", requestId }),
		clear: () => setState({ kind: "idle" }),
	};
}

/** The open matcher editor's target; a target whose group left the draft closes. */
function useMatcherEditorTarget(
	draft: ServerFormDraft
): [MatcherEditorTarget | undefined, (next: MatcherEditorTarget | undefined) => void] {
	const [editor, setEditor] = useState<MatcherEditorTarget | undefined>(undefined);
	const { modelParameters, modelCapabilities } = draft;
	useEffect(() => {
		setEditor((current) => {
			if (current === undefined) {
				return current;
			}
			const list = current.kind === "params" ? modelParameters : modelCapabilities;
			return list[current.index] === undefined ? undefined : current;
		});
	}, [modelParameters, modelCapabilities]);
	return [editor, setEditor];
}

function useServerFormModel({
	target,
	declaredLabels,
	observedModelInfoKeys,
	onDirtyChange,
	onSavePosted,
}: ServerFormProps): ServerFormModel {
	const { draft, setDraft, baseline, original, applyPrefill } = useOpeningState(target);
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [staleKeyFields, setStaleKeyFields] = useState<readonly SecretFieldId[] | undefined>(undefined);
	const saveIntent = useIntentOutcome("saveServerSetting");
	const testIntent = useIntentOutcome("testServerDraft");
	const test = useDraftTest(testIntent.outcome);
	const [matcherEditor, setMatcherEditor] = useMatcherEditorTarget(draft);
	useInlinePrefill(original, phase, setPhase, applyPrefill);
	useSaveSettles(saveIntent.outcome, phase, setPhase);
	const saving = phase.phase === "saving";
	const options = parseOptions(declaredLabels, original, observedModelInfoKeys);
	const parse = parseServerForm(draft, options);
	const visibleProblems = visibleProblemsOf(parse, draft, touched);
	const props = fieldRenderProps({ draft, visibleProblems, saving, test, setDraft, setTouched, onDirtyChange });
	const form: FormModel = {
		target,
		draft,
		parse,
		props,
		saving,
		keySuggestions: capabilityKeySuggestions(observedModelInfoKeys),
		setDraft,
	};
	const postSave = (intent: ServerFormIntent) => {
		const requestId = saveIntent.send(intent);
		onSavePosted(requestId);
		setPhase({ phase: "saving", requestId });
	};
	const staleKey: StaleKeyQuestion = {
		fields: staleKeyFields,
		ask: setStaleKeyFields,
		dismiss: () => setStaleKeyFields(undefined),
	};
	const testConnection = () => {
		if (test.state.kind === "testing" || saving) {
			return;
		}
		startDraftTest({ draft, original, test, send: testIntent.send, setTouched });
	};
	return {
		form,
		phase,
		original,
		changedFields: changedServerFormFields(draft, baseline),
		test,
		testConnection,
		commit: commitActions({ draft, parse, phase, options, staleKey, setDraft, setTouched, postSave }),
		staleKey,
		matcherEditor,
		setMatcherEditor,
	};
}

/**
 * The label's consequence line, mounted always and holding its box invisibly until it speaks (visibility keeps the
 * box, removes the words from the accessibility tree): inserting it on the first renaming keystroke pushed every row
 * below down mid-typing.
 */
function LabelNotes({ target, parse, renaming, collides, heldByGroup }: LabelNotesProps) {
	if (heldByGroup) {
		return (
			<p className="held-note hint m-0 text-[11.5px]">
				{l10n.t(
					"A provider group already appears under this label; if it is this server, adopt it from its row instead - VS Code refuses a second group with one name."
				)}
			</p>
		);
	}
	if (target.kind === "edit") {
		return (
			<p
				className={cn(
					"rename-note hint m-0 text-[11.5px]",
					!(renaming && (parse.ok || parse.problems.label === undefined)) && "invisible"
				)}
			>
				{l10n.t(
					"Renaming creates a new server; the old name's group serves until you delete it in Manage Language Models or the models file."
				)}
			</p>
		);
	}
	return (
		<p className={cn("collides-note hint m-0 text-[11.5px]", !collides && "invisible")}>
			{l10n.t("An entry with this label already exists; saving replaces it and its stored credentials.")}
		</p>
	);
}

/**
 * The draft test's result beside the probe button. The troubleshooting link rides inside the alert so one announcement
 * carries failure and way out; the leading space keeps copied text from gluing label onto message. The accessible name
 * leads with the visible verb (Label in Name); the helper's sentence label buries "Troubleshoot" where speech input
 * cannot match it.
 */
function TestResult({ testState }: { testState: TestState }) {
	if (testState.kind === "pass") {
		return (
			<span
				className={cn("test-result text-[11.5px]", testState.tone === "warning" ? "state-warn" : "state-ok")}
				role="status"
			>
				{testState.text}
			</span>
		);
	}
	if (testState.kind !== "fail") {
		return null;
	}
	const hint = testState.classification?.setupHint;
	return (
		<span className="test-result error text-[11.5px]" role="alert">
			{testState.text}
			{hint === undefined ? null : (
				<>
					{" "}
					<span className="test-hint">
						<DocsLink
							href={troubleshootingLink(hint).href}
							label={l10n.t("Troubleshoot: {0}", troubleshootingLink(hint).topic)}
						>
							{l10n.t("Troubleshoot")}
						</DocsLink>
					</span>
				</>
			)}
		</span>
	);
}

/**
 * The probe belongs to the URL it probes, not the save bar: testing is not committing. Quiet rank on purpose - Save is
 * the page's one accent - shaped by its icon instead.
 */
function TestConnectionRow({ form, testState, onTest }: { form: FormModel; testState: TestState; onTest: () => void }) {
	return (
		<FieldUnderRow>
			<Button
				variant="secondary"
				disabled={
					!isUsableHttpUrl(trimHttpWhitespace(form.draft.baseUrl)) || testState.kind === "testing" || form.saving
				}
				onClick={onTest}
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
			<TestResult testState={testState} />
		</FieldUnderRow>
	);
}

/** The API version's mode select, and the custom segment's input while that mode is live. */
function ApiVersionRows({ form }: { form: FormModel }) {
	const { draft, props, saving } = form;
	return (
		<>
			<FormFieldRow
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
			</FormFieldRow>
			{draft.apiVersion.mode === "custom" ? (
				<FormFieldRow
					htmlFor="server-apiVersion"
					label={l10n.t("Version segment")}
					problem={props.visibleProblems.apiVersion}
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
						aria-invalid={props.visibleProblems.apiVersion !== undefined}
						aria-describedby="server-apiVersion-error"
						onChange={(event) =>
							props.patch({ apiVersion: { ...draft.apiVersion, custom: event.currentTarget.value } })
						}
						onBlur={() => props.touch("apiVersion")}
					/>
				</FormFieldRow>
			) : null}
		</>
	);
}

/**
 * The Connection section. A connection edit raises no toast (a rename does), so the models-file line must name every
 * step; mounted on every edit form, holding its box invisibly until it speaks (the spacing-twin idiom): inserting it on
 * the first keystroke pushed rows down 36px mid-edit. While a rename stands, the rename note carries the remediation
 * instead.
 */
function ConnectionSection({ form, labels, testState, onTest, connectionEdited }: ConnectionSectionProps) {
	const { target, props } = form;
	return (
		<FormSection title={l10n.t("Connection")} help={helpConnectionSection()}>
			<TextField field="label" placeholder={l10n.t("e.g. Production")} props={props} />
			<FieldUnderRow>
				<LabelNotes {...labels} />
			</FieldUnderRow>
			<TextField field="baseUrl" mono={true} placeholder={l10n.t("e.g. http://localhost:4000")} props={props} />
			<TestConnectionRow form={form} testState={testState} onTest={onTest} />
			{target.kind === "edit" ? (
				<FieldUnderRow>
					<p className={cn("hint state-warn m-0 text-[11.5px]", (labels.renaming || !connectionEdited) && "invisible")}>
						{l10n.t(
							"VS Code keeps the old connection until you remove this server from the models file, reload, and run Sync Models Now."
						)}
					</p>
				</FieldUnderRow>
			) : null}
			<ApiVersionRows form={form} />
		</FormSection>
	);
}

/**
 * The Authentication selector, one option per line: the four labels are very unequal, so a wrapping row lands
 * differently at every pane width, and mutually exclusive options are read by scanning down. The cost is one row's
 * height, paid once.
 */
function AuthMethodRow({ form }: { form: FormModel }) {
	const { draft, props, saving } = form;
	return (
		<FormFieldRow label={l10n.t("Method")} wide={true}>
			<span
				className="auth-selector flex flex-col items-start gap-y-1 text-[12.5px]"
				role="radiogroup"
				aria-label={serverFormFieldLabel("authForm")}
			>
				{AUTH_FORM_IDS.map((auth) => (
					<label key={auth} className="flex items-center gap-1.5">
						<Radio
							name="server-auth-form"
							checked={draft.authForm === auth}
							disabled={saving}
							onChange={() => props.patch({ authForm: auth })}
						/>
						{authFormName(auth)}
					</label>
				))}
			</span>
		</FormFieldRow>
	);
}

/** The fields of the selected authentication method; the virtual-key pair rides along with every keyed method. */
function AuthFields({ form }: { form: FormModel }) {
	const { draft, props } = form;
	const virtualKeyPair = (
		<>
			<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
			<SecretField field="virtualKeyValue" props={props} />
		</>
	);
	return (
		<>
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
		</>
	);
}

/**
 * Kept stored secrets whose form is not selected still change the save's shape (the shape-and-storage rule,
 * docs/servers.md#secrets-and-secret-storage), so each renders a visible hint plus its Remove checkbox instead of
 * silently riding along. The parse's blocking rules read the same derivation, so the way out of a block always
 * renders.
 *
 * The tone-text register (state-warn), not utility spellings: one register keeps heading and lines in one voice and
 * carries the forced-colors squiggle the utilities lack.
 */
function StoredOrphans({ form }: { form: FormModel }) {
	const orphans = storedInactiveSecrets(form.draft);
	if (!(orphans.apiKey || orphans.virtualKeyValue || orphans.oauthClientSecret)) {
		return null;
	}
	return (
		<>
			<FieldSpan className="mt-2">
				<p className="state-warn m-0 text-[11.5px]">{l10n.t("Stored credentials")}</p>
				{orphans.apiKey ? (
					<p className="hint state-warn m-0 text-[11.5px]">
						{l10n.t("A stored API key is still attached and still sent as a bearer token.")}
					</p>
				) : null}
				{orphans.virtualKeyValue ? (
					<p className="hint state-warn m-0 text-[11.5px]">{l10n.t("A stored virtual key value is still attached.")}</p>
				) : null}
				{orphans.oauthClientSecret ? (
					<p className="hint state-warn m-0 text-[11.5px]">
						{l10n.t("A stored OAuth client secret is still attached.")}
					</p>
				) : null}
			</FieldSpan>
			{orphans.apiKey ? <StoredSecretRow field="apiKey" props={form.props} /> : null}
			{orphans.virtualKeyValue ? <StoredSecretRow field="virtualKeyValue" props={form.props} /> : null}
			{orphans.oauthClientSecret ? <StoredSecretRow field="oauthClientSecret" props={form.props} /> : null}
		</>
	);
}

function AuthenticationSection({ form }: { form: FormModel }) {
	return (
		<FormSection
			title={serverFormFieldLabel("authForm")}
			help={serverFieldHelp("authForm")}
			docs={{ href: DOCS_LINK_AUTHENTICATION, label: l10n.t("Open the authentication guide") }}
		>
			<AuthMethodRow form={form} />
			<AuthFields form={form} />
			<StoredOrphans form={form} />
		</FormSection>
	);
}

/** One record kind's matcher table; the key suggestions are the capabilities table's alone. */
function MatcherTable({ form, kind, onOpenEditor }: MatcherSectionProps) {
	const { draft, props, saving } = form;
	const issues = matcherIssueViews(form, kind);
	if (kind === "params") {
		return (
			<RecordMatcherTable
				kind="params"
				groups={draft.modelParameters}
				issues={issues}
				disabled={saving}
				onChange={(next) => props.patch({ modelParameters: next })}
				onOpenEditor={onOpenEditor}
			/>
		);
	}
	return (
		<RecordMatcherTable
			kind="caps"
			groups={draft.modelCapabilities}
			issues={issues}
			disabled={saving}
			keySuggestions={form.keySuggestions}
			onChange={(next) => props.patch({ modelCapabilities: next })}
			onOpenEditor={onOpenEditor}
		/>
	);
}

/**
 * One matcher-record section (parameters or capabilities) with its table and the add action. The add writes through
 * setDraft, not patch: appending the empty group is structural, and the removal on close undoes it without arming the
 * confirm.
 */
function MatcherSection({ form, kind, onOpenEditor }: MatcherSectionProps) {
	const { draft, saving, setDraft } = form;
	const field = kind === "params" ? "modelParameters" : "modelCapabilities";
	const words = matcherSectionWords(kind);
	const groups = draft[field];
	const add = () => {
		setDraft((current) => ({
			...current,
			...groupsPatch(kind, [...groupsOf(current, kind), { prefix: "", params: [] }]),
		}));
		onOpenEditor(groups.length);
	};
	return (
		<FormSection
			quiet={true}
			title={serverFormFieldLabel(field)}
			aside={matcherCountAside(groups.length)}
			help={serverFieldHelp(field)}
			docs={words.docs}
		>
			<FormFieldRow label={l10n.t("Matchers")} wide={true}>
				{groups.length > 0 ? (
					<MatcherTable form={form} kind={kind} onOpenEditor={onOpenEditor} />
				) : (
					<p className="m-0 text-[12px] text-muted-foreground">{words.empty}</p>
				)}
				<div>
					<Button variant="secondary" id={words.addId} disabled={saving} onClick={add}>
						<IconAdd /> {words.addLabel}
					</Button>
				</div>
			</FormFieldRow>
		</FormSection>
	);
}

/**
 * A checkbox set as a real fieldset, not a role: the set is a group with a name, and the flat page has no box chrome
 * for it to inherit. One row while the pair fits, a column below the stylesheet's own 560px tier (same exclusive
 * `width < 560px` semantics); between, wrap depended on the translation's width.
 */
function CheckboxSet({ ariaLabel, children }: { ariaLabel: string; children: ReactNode }) {
	return (
		<fieldset
			className="expected-failures m-0 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0 text-[12.5px] @max-[560px]/pane:flex-col @max-[560px]/pane:items-start"
			aria-label={ariaLabel}
		>
			{children}
		</fieldset>
	);
}

/** The Discovery section: the declared models, the expected failures, and the modes to include where any is offered. */
function DiscoverySection({ form, offeredModes, skippedModeCounts }: DiscoverySectionProps) {
	const { draft, props, saving } = form;
	return (
		<FormSection
			quiet={true}
			title={l10n.t("Discovery")}
			aside={l10n.t("optional")}
			help={helpDiscoverySection()}
			docs={{ href: DOCS_LINK_DECLARED_MODELS, label: l10n.t("Open the declared models guide") }}
		>
			<FormFieldRow
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
				<Textarea
					id="server-declaredModels"
					className="w-full font-mono text-[12px]"
					rows={3}
					placeholder={l10n.t("One model ID per line, e.g. deepseek-r1")}
					value={draft.declaredModels}
					disabled={saving}
					onChange={(event) => props.patch({ declaredModels: event.currentTarget.value })}
				/>
			</FormFieldRow>
			<FormFieldRow
				label={serverFormFieldLabel("expectedFailures")}
				help={
					<Help
						text={serverFieldHelp("expectedFailures")}
						name={l10n.t("Help: {0}", serverFormFieldLabel("expectedFailures"))}
					/>
				}
				wide={true}
			>
				<CheckboxSet ariaLabel={serverFormFieldLabel("expectedFailures")}>
					{EXPECTED_FAILURE_CATEGORIES.map((category) => (
						<label key={category} className="setting-check flex items-center gap-1.5">
							<Checkbox
								checked={draft.expectedFailures.includes(category)}
								disabled={saving}
								onChange={(event) =>
									props.patch({
										expectedFailures: toggleCanonical(
											EXPECTED_FAILURE_CATEGORIES,
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
				</CheckboxSet>
			</FormFieldRow>
			{offeredModes.length > 0 && (
				<FormFieldRow
					label={serverFormFieldLabel("includeModes")}
					help={
						<Help
							text={serverFieldHelp("includeModes")}
							name={l10n.t("Help: {0}", serverFormFieldLabel("includeModes"))}
						/>
					}
					wide={true}
				>
					<CheckboxSet ariaLabel={serverFormFieldLabel("includeModes")}>
						{offeredModes.map((mode) => (
							<label key={mode} className="setting-check flex items-center gap-1.5">
								<Checkbox
									checked={draft.includeModes.includes(mode)}
									disabled={saving}
									onChange={(event) =>
										props.patch({
											includeModes: toggleCanonical(
												NON_CHAT_MODES,
												draft.includeModes,
												mode,
												event.currentTarget.checked
											),
										})
									}
								/>
								{includeModeLabel(mode, skippedModeCounts?.[mode])}
							</label>
						))}
					</CheckboxSet>
				</FormFieldRow>
			)}
		</FormSection>
	);
}

function HeadersSection({
	form,
	headerProblems,
}: {
	form: FormModel;
	headerProblems: readonly (string | undefined)[];
}) {
	const { draft, props, saving } = form;
	return (
		<FormSection
			quiet={true}
			title={l10n.t("Headers and budget")}
			aside={l10n.t("optional")}
			help={serverFieldHelp("headers")}
		>
			<FormFieldRow label={serverFormFieldLabel("headers")} wide={true}>
				<HeaderRowsEditor
					rows={draft.headers}
					problems={headerProblems}
					disabled={saving}
					onChange={(next) => props.patch({ headers: next })}
				/>
			</FormFieldRow>
			<TextField field="budget" narrow={true} placeholder={l10n.t("e.g. 50")} props={props} />
		</FormSection>
	);
}

/**
 * The MCP section. The endpoint row follows the API version's idiom: it exists only while the choice it belongs to is
 * live, so an opted-out entry shows no dead input. Its hint is the DERIVED default, not an abstract restatement: the
 * form knows the base URL, so it can show the exact address an empty field publishes.
 */
function McpSection({ form }: { form: FormModel }) {
	const { draft, props, saving } = form;
	return (
		<FormSection quiet={true} title={l10n.t("MCP")} aside={l10n.t("optional")} help={helpMcpSection()}>
			<FormFieldRow
				label={serverFormFieldLabel("mcp")}
				help={<Help text={serverFieldHelp("mcp")} name={l10n.t("Help: {0}", serverFormFieldLabel("mcp"))} />}
			>
				<label className="setting-check flex items-center gap-1.5">
					<Checkbox
						checked={draft.mcp.enabled}
						disabled={saving}
						onChange={(event) => props.patch({ mcp: { ...draft.mcp, enabled: event.currentTarget.checked } })}
					/>
					{l10n.t("Make this server's MCP tools available in chat")}
				</label>
			</FormFieldRow>
			{draft.mcp.enabled ? (
				<FormFieldRow
					htmlFor="server-mcp-url"
					label={l10n.t("MCP endpoint")}
					help={<Help text={helpMcpEndpoint()} name={l10n.t("Help: {0}", l10n.t("MCP endpoint"))} />}
					problem={props.visibleProblems.mcp}
					errorId="server-mcp-url-error"
					hint={derivedMcpHint(draft.baseUrl)}
				>
					<Input
						id="server-mcp-url"
						type="text"
						className="min-w-0 flex-1 font-mono text-[12px]"
						placeholder={l10n.t("e.g. https://gateway.internal/mcp")}
						value={draft.mcp.url}
						disabled={saving}
						aria-invalid={props.visibleProblems.mcp !== undefined}
						aria-describedby="server-mcp-url-error"
						onChange={(event) => props.patch({ mcp: { ...draft.mcp, url: event.currentTarget.value } })}
						onBlur={() => props.touch("mcp")}
					/>
				</FormFieldRow>
			) : null}
		</FormSection>
	);
}

/**
 * The save bar. "Discard changes" is named apart from the confirm dialog's own Discard: this one REQUESTS a close, and
 * two controls one answer apart must not answer to the same word.
 *
 * The bar's trailing facts sit on ONE wrap-proof line (dashboard.css .commit-status, the record footer's
 * .editor-status discipline): zero flex basis, so the count speaking never changes the bar's wrap points or its
 * height; the DOM keeps the whole text, so screen readers read it unclipped.
 *
 * NBSP glue around the dash: the two facts are flex items, so a collapsible space at the target's start sits at its
 * own line box's start and is trimmed.
 */
function CommitBar({ phase, firstBlocking, unsavedCount, onSave, onRequestClose }: CommitBarProps) {
	const savedTo = l10n.t("Saved to {0}", SERVERS_SETTING_ID);
	return (
		<div className={COMMIT_BAR_CLASS}>
			<Button disabled={phase.phase !== "editing"} onClick={onSave}>
				{phase.phase === "saving" ? (
					<>
						<span className="spinner" aria-hidden="true" /> {l10n.t("Saving...")}
					</>
				) : (
					l10n.t("Save")
				)}
			</Button>
			<Button variant="secondary" onClick={onRequestClose}>
				{l10n.t("Discard changes")}
			</Button>
			{firstBlocking === undefined ? null : (
				<span className="error text-[11.5px]" role="alert">
					{l10n.t("Cannot save: fix {0}", serverFormFieldLabel(firstBlocking))}
				</span>
			)}
			{phase.phase === "prefill" ? (
				<span className="hint m-0 text-[11.5px]">{l10n.t("Loading stored values...")}</span>
			) : null}
			<span
				className="commit-status text-right text-[11.5px] text-muted-foreground"
				title={unsavedCount > 0 ? `${unsavedText(unsavedCount)} - ${savedTo}` : savedTo}
			>
				{unsavedCount > 0 ? <span className="unsaved-count tabular-nums">{unsavedText(unsavedCount)}</span> : null}
				<span className="save-target">{unsavedCount > 0 ? `\u00a0-\u00a0${savedTo}` : savedTo}</span>
			</span>
		</div>
	);
}

/** The full matcher editor over one draft group; its edits write through props.patch, so they dirty the form. */
function MatcherOverlay({ form, editor, onClose, onRemoved }: MatcherOverlayProps) {
	const { draft, parse, props, saving } = form;
	const note = l10n.t("Changes here edit the form; Save stores them on the entry.");
	const list = groupsOf(draft, editor.kind);
	const group = list[editor.index];
	if (group === undefined) {
		return null;
	}
	const onChange = (next: PrefixGroup) =>
		props.patch(
			groupsPatch(
				editor.kind,
				list.map((g, index) => (index === editor.index ? next : g))
			)
		);
	const onRemove = () => {
		props.patch(
			groupsPatch(
				editor.kind,
				list.filter((_, index) => index !== editor.index)
			)
		);
		onRemoved();
	};
	if (editor.kind === "params") {
		return (
			<RecordMatcherEditorOverlay
				kind="params"
				group={group}
				groupProblems={parse.ok ? undefined : parse.modelParameterProblems[editor.index]}
				groupHints={parse.modelParameterHints[editor.index]}
				prefixHelp={helpEntryModelParameterPrefix()}
				disabled={saving}
				fallbackFocusId="server-params-add"
				note={note}
				onChange={onChange}
				onRemove={onRemove}
				onClose={onClose}
			/>
		);
	}
	return (
		<RecordMatcherEditorOverlay
			kind="caps"
			group={group}
			groupIssues={parse.modelCapabilityIssues[editor.index]}
			keySuggestions={form.keySuggestions}
			disabled={saving}
			fallbackFocusId="server-caps-add"
			note={note}
			onChange={onChange}
			onRemove={onRemove}
			onClose={onClose}
		/>
	);
}

/**
 * The surfaces over the form: the full matcher editor, and the stale-key question a Save raised - modal like the
 * discard confirm, since a credential decision interrupts the save and has no in-place anywhere. Esc/"Keep editing"
 * posts nothing; the two verbs answer the ONE question.
 */
function FormOverlays({ model }: { model: ServerFormModel }) {
	const { form, matcherEditor, setMatcherEditor, staleKey, commit, original } = model;
	const closeMatcherEditor = (editor: MatcherEditorTarget) => {
		const removal = pristineMatcherRemoval(form.draft, editor);
		if (removal !== undefined) {
			form.setDraft((current) => ({ ...current, ...removal }));
		}
		setMatcherEditor(undefined);
	};
	return (
		<>
			{matcherEditor === undefined ? null : (
				<MatcherOverlay
					form={form}
					editor={matcherEditor}
					onClose={() => closeMatcherEditor(matcherEditor)}
					onRemoved={() => setMatcherEditor(undefined)}
				/>
			)}
			{staleKey.fields === undefined ? null : (
				<ConfirmDialog
					question={l10n.t("Keep using the stored key for the new destination?")}
					detail={staleKeyDetail(staleKey.fields, original)}
					confirmLabel={l10n.t("Clear key")}
					alternateLabel={l10n.t("Use same key")}
					cancelLabel={l10n.t("Keep editing")}
					surfaceId="server-edit-page"
					onConfirm={commit.answerStaleKeyClear}
					onAlternate={commit.answerStaleKeyKeep}
					onCancel={staleKey.dismiss}
				/>
			)}
		</>
	);
}

/**
 * The add/edit form. Every field is in the same scroll, so a problem is always reachable before Save. The models-file
 * caveat is about a connection the host already resolved, so it belongs to an edit that actually moves one - not to
 * every open.
 */
function ServerForm(props: ServerFormProps) {
	const { target, declaredLabels, liveGroupLabels, skippedModeCounts, onRequestClose } = props;
	const model = useServerFormModel(props);
	const { form, test, commit, phase, changedFields } = model;
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
			<ConnectionSection
				form={form}
				labels={labelNotes(form, declaredLabels, liveGroupLabels)}
				testState={test.state}
				onTest={model.testConnection}
				connectionEdited={changedFields.some((field) => (CONNECTION_FIELDS as readonly string[]).includes(field))}
			/>
			<AuthenticationSection form={form} />
			<MatcherSection
				form={form}
				kind="params"
				onOpenEditor={(index) => model.setMatcherEditor({ kind: "params", index })}
			/>
			<MatcherSection
				form={form}
				kind="caps"
				onOpenEditor={(index) => model.setMatcherEditor({ kind: "caps", index })}
			/>
			<DiscoverySection
				form={form}
				offeredModes={offeredModesFor(target, skippedModeCounts)}
				skippedModeCounts={skippedModeCounts}
			/>
			<HeadersSection form={form} headerProblems={form.parse.ok ? [] : form.parse.headerProblems} />
			<McpSection form={form} />
			<CommitBar
				phase={phase}
				firstBlocking={SERVER_FORM_FIELD_ORDER.find((field) => form.props.visibleProblems[field] !== undefined)}
				unsavedCount={changedFields.length}
				onSave={commit.save}
				onRequestClose={onRequestClose}
			/>
			<FormOverlays model={model} />
		</div>
	);
}

interface ServerEditPageProps {
	request: ServerEditRequest;
	servers: readonly DashboardServer[];
	onDirtyChange: (dirty: boolean) => void;
	onTargetGone: () => void;
	onRequestClose: () => void;
	onSaved: () => void;
}

/** A validation failure the page keeps beside the draft it refused, with which round trip raised it. */
interface PageFailure {
	readonly message: string;
	readonly frame: "save" | "adopt";
}

/** One posted write's round trip, as the page follows it. */
interface CommitRoundTrip {
	readonly outcome: IntentOutcome | undefined;
	readonly requestId: string | undefined;
	readonly clear: () => void;
	readonly frame: PageFailure["frame"];
	readonly onSaved: () => void;
	readonly onFailure: (failure: PageFailure) => void;
}

/** The page's two writes, adopt and save, as the form and the adopt card see them. */
interface PageCommits {
	readonly adopting: string | undefined;
	readonly committing: boolean;
	readonly failure: PageFailure | undefined;
	readonly dismissFailure: () => void;
	readonly postAdopt: (requestId: string) => void;
	readonly postSave: (requestId: string) => void;
}

/** The request resolved against the live rows, with the two states that are not edit targets. */
interface ResolvedTarget {
	readonly target: FormTarget | "locations-unproven" | undefined;
	readonly waitingForProof: boolean;
	readonly targetGone: boolean;
}

/** The labels the form judges a new or renamed label against. */
interface TakenLabels {
	readonly declaredLabels: readonly string[];
	readonly liveGroupLabels: readonly string[];
}

/**
 * The outcome decides the page's fate: ok leaves, a validation failure stays with its message here (an operation
 * failure leaves like a success and the list's banner takes it). The list keeps its own hook for notice and banner -
 * both see the same envelope, the documented shape of these outcomes.
 */
function useCommitRoundTrip({ outcome, requestId, clear, frame, onSaved, onFailure }: CommitRoundTrip): void {
	useEffect(() => {
		if (requestId === undefined || outcome?.id !== requestId) {
			return;
		}
		clear();
		if (outcome.result === "ok" || saveFailureDisposition(outcome.failureKind) === "close") {
			onSaved();
			return;
		}
		onFailure({ message: outcome.message, frame });
	}, [outcome, requestId, clear, frame, onSaved, onFailure]);
}

/**
 * The page's adopt and save round trips, each followed to its own outcome. A retry starts clean: the banner belongs to
 * the round trip that produced it, not to the form.
 */
function usePageCommits(onSaved: () => void): PageCommits {
	const adoptIntent = useIntentOutcome("adoptServer");
	const saveIntent = useIntentOutcome("saveServerSetting");
	const [adopting, setAdopting] = useState<string | undefined>(undefined);
	const [savingId, setSavingId] = useState<string | undefined>(undefined);
	const [failure, setFailure] = useState<PageFailure | undefined>(undefined);
	const clearAdopting = useCallback(() => setAdopting(undefined), []);
	const clearSaving = useCallback(() => setSavingId(undefined), []);
	useCommitRoundTrip({
		outcome: adoptIntent.outcome,
		requestId: adopting,
		clear: clearAdopting,
		frame: "adopt",
		onSaved,
		onFailure: setFailure,
	});
	useCommitRoundTrip({
		outcome: saveIntent.outcome,
		requestId: savingId,
		clear: clearSaving,
		frame: "save",
		onSaved,
		onFailure: setFailure,
	});
	return {
		adopting,
		committing: savingId !== undefined || adopting !== undefined,
		failure,
		dismissFailure: () => setFailure(undefined),
		postAdopt: (requestId) => {
			setFailure(undefined);
			setAdopting(requestId);
		},
		postSave: (requestId) => {
			setFailure(undefined);
			setSavingId(requestId);
		},
	};
}

/**
 * The request resolved per render. A commit in flight freezes the WHOLE target: the save's write comes back as a state
 * push, so a rename resolves the old label to nothing and a save that worked would read as a deleted entry.
 *
 * A row turning unproven UNDER an open form must not tear the form down (the draft dies with it): the form keeps its
 * last proven target - the frozen identity still guards the save extension-side. Only a page that never had a proven
 * target waits.
 */
function useResolvedTarget(
	request: ServerEditRequest,
	servers: readonly DashboardServer[],
	committing: boolean
): ResolvedTarget {
	// Memoized so the resolved target is one object for as long as its rows are: a fresh object per render turned the
	// prefill effect into a render loop.
	const resolved = useMemo(() => resolveEditTarget(request, servers), [request, servers]);
	const lastResolved = useRef<FormTarget | undefined>(undefined);
	if (resolved !== undefined && resolved !== "locations-unproven" && !committing) {
		lastResolved.current = resolved;
	}
	const settled =
		resolved === "locations-unproven" && lastResolved.current !== undefined ? lastResolved.current : resolved;
	const target = committing ? lastResolved.current : settled;
	return { target, waitingForProof: target === "locations-unproven", targetGone: target === undefined };
}

/**
 * Arriving here is a navigation, so focus travels with it: to the first field, or the page itself. A destination must
 * do this deliberately, or Tab carries on from a pane that is no longer showing.
 *
 * Also keyed on the form arriving or going away (the waiting card resolving into it counts), because the unmounting
 * field or button drops focus on the body, outside the shell that hears Esc, so the keyboard would stop working.
 * targetGone and waitingForProof are triggers, not values the body reads.
 */
function useArrivalFocus(pageRef: RefObject<HTMLElement | null>, targetGone: boolean, waitingForProof: boolean): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: the deps are triggers, not read values
	useEffect(() => {
		const page = pageRef.current;
		if (page?.contains(document.activeElement) === true) {
			return;
		}
		const field = page?.querySelector<HTMLElement>("input, select, textarea");
		(field ?? page)?.focus();
	}, [targetGone, waitingForProof]);
}

/**
 * Misconfigured entries count as taken: they occupy their label in the setting, so a rename onto one must be refused
 * like any sibling.
 *
 * The live group labels are the stamps of the external groups: the names the sync engine gave the groups it created,
 * so a label among them is likely held by the host already (which refuses the add); a group the host named itself can
 * carry any stamp, so this advises instead of refusing.
 */
function takenLabels(servers: readonly DashboardServer[]): TakenLabels {
	return {
		declaredLabels: servers
			.filter((server) => server.origin === "declared" || server.origin === "misconfigured")
			.map((server) => server.label),
		liveGroupLabels: servers.flatMap((server) =>
			server.origin === "external" && server.entryLabel !== undefined ? [server.entryLabel] : []
		),
	};
}

/**
 * The page's frame: a section, not a dialog - it is where the reader IS; the heading labels it because a section takes
 * a name. tabIndex -1: the page takes focus itself when it holds no field, never in the tab order. The id is where the
 * discard-confirm modal returns focus on "keep editing".
 */
function EditPageFrame({ pageRef, children }: { pageRef: RefObject<HTMLElement | null>; children: ReactNode }) {
	return (
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
}

/** A card standing in for the form, with the one way back. */
function StandInCard({ title, hint, onRequestClose }: { title: string; hint: string; onRequestClose: () => void }) {
	return (
		<div className="form-card server-form">
			<h3 id="server-form-title">{title}</h3>
			<p className="hint">{hint}</p>
			<div className="toolbar">
				<Button onClick={onRequestClose}>{l10n.t("Back to servers")}</Button>
			</div>
		</div>
	);
}

/** The validation failure a round trip left beside the draft, with the frame naming which write refused it. */
function PageFailureNotice({ failure, onDismiss }: { failure: PageFailure; onDismiss: () => void }) {
	return (
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
			<Button variant="secondary" size="compact" onClick={onDismiss}>
				{l10n.t("Dismiss")}
			</Button>
		</div>
	);
}

/**
 * The edit destination, mounted in the shell's pane. The boundary outward is two facts and two events: the draft is
 * dirty, the reader asked to leave, the save committed - pane choice, rail clicks, and focus on the way out belong to
 * the shell.
 *
 * The pre-first-pass fallback cannot prove where this entry's secrets live (an API key may sit in secret storage it
 * has not read), so no form opens on it: a form frozen over guessed locations would only earn a refusal on save. An
 * entry that went away took the draft: nothing left to save, nothing to ask about.
 *
 *   onTargetGone -> the draft ceased to exist (its entry left the setting): its own channel, so a dirty report can
 *                   never mean it
 */
export function ServerEditPage({
	request,
	servers,
	onDirtyChange,
	onTargetGone,
	onRequestClose,
	onSaved,
}: ServerEditPageProps) {
	const commits = usePageCommits(onSaved);
	const labels = takenLabels(servers);
	const { target, waitingForProof, targetGone } = useResolvedTarget(request, servers, commits.committing);
	useEffect(() => {
		if (targetGone) {
			onTargetGone();
		}
	}, [targetGone, onTargetGone]);
	const pageRef = useRef<HTMLElement>(null);
	useArrivalFocus(pageRef, targetGone, waitingForProof);
	if (target === undefined) {
		return (
			<EditPageFrame pageRef={pageRef}>
				<StandInCard
					title={l10n.t("This server is gone")}
					hint={l10n.t("It was removed while you were editing it - by another window or an edit to settings.json.")}
					onRequestClose={onRequestClose}
				/>
			</EditPageFrame>
		);
	}
	if (target === "locations-unproven") {
		return (
			<EditPageFrame pageRef={pageRef}>
				<StandInCard
					title={l10n.t("Checking where this server's secrets are stored")}
					hint={l10n.t(
						"The first sync is confirming this entry's secret locations, e.g. an API key in secret storage. Editing opens here as soon as it finishes."
					)}
					onRequestClose={onRequestClose}
				/>
			</EditPageFrame>
		);
	}
	const failureNotice =
		commits.failure === undefined ? null : (
			<PageFailureNotice failure={commits.failure} onDismiss={commits.dismissFailure} />
		);
	if (target.kind === "adopt") {
		return (
			<EditPageFrame pageRef={pageRef}>
				{failureNotice}
				<AdoptForm
					server={target.server}
					declaredLabels={labels.declaredLabels}
					saving={commits.adopting !== undefined}
					onDirtyChange={onDirtyChange}
					onAdoptPosted={commits.postAdopt}
					onRequestClose={onRequestClose}
				/>
			</EditPageFrame>
		);
	}
	const liveRow = liveRowForForm(servers, target);
	return (
		<EditPageFrame pageRef={pageRef}>
			{failureNotice}
			<ServerForm
				target={target}
				declaredLabels={labels.declaredLabels}
				liveGroupLabels={labels.liveGroupLabels}
				observedModelInfoKeys={liveRow?.observedModelInfoKeys}
				skippedModeCounts={liveRow?.skippedModeCounts}
				onDirtyChange={onDirtyChange}
				onSavePosted={commits.postSave}
				onRequestClose={onRequestClose}
			/>
		</EditPageFrame>
	);
}
