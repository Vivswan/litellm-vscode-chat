/**
 * The server edit surface: the add/edit form, the adopt form, and the field machinery.
 * The boundary outward is deliberately narrow - the draft is dirty, the user asked to
 * leave - and the module knows nothing about what is mounted around it.
 */
import * as l10n from "@vscode/l10n";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IntentAckTone, ReplacedEntryIdentity } from "../../dashboard/endpoints";
import type { GroupProblems } from "../../dashboard/recordDraft";
import { toCapabilityGroups, toGroups, toggleExpectedFailure, toHeaderRows } from "../../dashboard/recordDraft";
import type {
	ApiVersionDraft,
	AuthFormId,
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
	mcpDraftOf,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	staleKeyFieldsOnSave,
	storedInactiveSecrets,
	validateAdoptLabel,
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
import type { ExpectedFailureCategory, SecretFieldId } from "../../shared/serverEntry";
import {
	EXPECTED_FAILURE_CATEGORIES,
	pickNonSecretOptionalFields,
	SECRET_FIELD_IDS,
	secretDestination,
} from "../../shared/serverEntry";
import { DEFAULT_API_VERSION, mcpEndpointOf } from "../../shared/util/baseUrl";
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
	helpMcpEndpoint,
	helpMcpSection,
	helpOauthCompanionApiKey,
	serverFieldHelp,
} from "./helpText";
import { useIntentOutcome, useRpc } from "./hooks";
import { IconAdd, IconArrowLeft, IconPlug } from "./icons";
import { capabilityKeySuggestions } from "./recordGroupFields";
import type { RecordEditorKind } from "./recordIssues";
import { capabilityIssueViews, paramIssueViews } from "./recordIssues";
import { RecordMatcherEditorOverlay, RecordMatcherTable } from "./recordMatcherTable";
import type { FieldRenderProps } from "./serverFormFields";
import {
	COMMIT_BAR_CLASS,
	CompanionNote,
	FieldRow,
	FieldSpan,
	FieldUnderRow,
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
import { sendRequest } from "./vscodeApi";

/**
 * Where a saved entry lands. A setting ID is a protocol term (English, module constant);
 * the save bar shows it because a page that writes a settings file should say so.
 */
const SERVERS_SETTING_ID = `${CONFIG_SECTION}.${SERVERS_SETTING_KEY}`;

/**
 * What the open form is for, decided once where it opens so no component re-derives it.
 * An edit target is an EditableDashboardServer BY TYPE: a row whose secret locations are
 * still unproven (the pre-first-pass fallback) cannot construct one, so no form can
 * freeze a wrong identity from it.
 */
export type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: EditableDashboardServer }
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
	| { readonly kind: "pass"; readonly text: string; readonly tone?: IntentAckTone | undefined }
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
		case "use-bare-localhost":
			// The bare-localhost advice is a bullet of the same connection-error
			// section, so both hints link one heading.
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
 * What an empty MCP endpoint publishes, said concretely. The entry's own base
 * URL is right there in the draft, so the hint names the exact address rather
 * than describing the rule and leaving the reader to apply it. A base URL that
 * is empty or not yet a usable URL has no derivable answer, so that case falls
 * back to naming the shape instead of interpolating half a URL.
 */
function derivedMcpHint(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	// mcpEndpointOf is the publisher's own derivation, so the address named here
	// is the address that gets published - not a second rendering of the rule.
	return isUsableHttpUrl(trimmed)
		? l10n.t("Leave empty to use {0}", mcpEndpointOf(trimmed))
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
		budget: original.config.budget !== undefined ? String(original.config.budget) : "",
		mcp: mcpDraftOf(original.config.mcp),
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
	const lastResolved = useRef<FormTarget | undefined>(undefined);
	// A commit in flight freezes the WHOLE target: the save's write comes back as a state
	// push, so a rename resolves the old label to nothing (a save that worked reads as a
	// deleted entry) and a secret moving storage resolves a DIFFERENT object that restarts
	// the prefill - both read the result of a commit still in flight.
	const committing = savingId !== undefined || adopting !== undefined;
	if (resolved !== undefined && resolved !== "locations-unproven" && !committing) {
		lastResolved.current = resolved;
	}
	// A row turning unproven UNDER an open form must not tear the form down
	// (the draft dies with it): the form keeps its last proven target - the
	// frozen identity still guards the save extension-side. Only a page that
	// never had a proven target waits.
	const settled =
		resolved === "locations-unproven" && lastResolved.current !== undefined ? lastResolved.current : resolved;
	const target = committing ? lastResolved.current : settled;
	// The row exists but the fallback push could not prove its secret locations
	// yet: not an edit target, so the page waits for the first pass's push.
	const waitingForProof = target === "locations-unproven";
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
	// Also keyed on the form going away or arriving (the waiting card resolving into it):
	// the unmounting field or button drops focus on the body - outside the shell that
	// hears Esc - so the keyboard would stop working.
	// biome-ignore lint/correctness/useExhaustiveDependencies: targetGone and waitingForProof are the triggers, not values the body reads - a page swap is what leaves focus homeless
	useEffect(() => {
		const page = pageRef.current;
		if (page?.contains(document.activeElement) === true) {
			return;
		}
		const field = page?.querySelector<HTMLElement>("input, select, textarea");
		(field ?? page)?.focus();
	}, [targetGone, waitingForProof]);
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
	if (target === "locations-unproven") {
		// The pre-first-pass fallback cannot prove where this entry's secrets live
		// (an API key may sit in secret storage it has not read), so no form opens
		// on it: a form frozen over guessed locations would only earn a refusal on
		// save. The first pass's push resolves this card into the form by itself.
		return page(
			<div className="form-card server-form">
				<h3 id="server-form-title">{l10n.t("Checking where this server's secrets are stored")}</h3>
				<p className="hint">
					{l10n.t(
						"The first sync is confirming this entry's secret locations, e.g. an API key in secret storage. Editing opens here as soon as it finishes."
					)}
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
 * "locations-unproven" is a declared row the pre-first-pass fallback served: its
 * secret locations are not proven yet, so it is not an edit target - the page
 * waits, and the first pass's push resolves it into one.
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
	// The identity of the entry this form DISPLAYS, frozen when the form opened like the
	// draft itself - the target prop follows live state, and a frozen identity is the point:
	// it rides the save, test, and prefill intents as `replace`, so an entry swapped in
	// under the same label while the form is open makes the extension REFUSE instead of
	// resolving credentials this form never showed. Locations only, never values.
	const [original] = useState<ReplacedEntryIdentity | undefined>(() =>
		target.kind === "edit"
			? {
					label: target.original.label,
					baseUrl: target.original.baseUrl,
					...(target.original.config.apiVersion !== undefined ? { apiVersion: target.original.config.apiVersion } : {}),
					...pickNonSecretOptionalFields(target.original.config),
					secrets: target.original.config.secrets.locations,
				}
			: undefined
	);
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [testState, setTestState] = useState<TestState>({ kind: "idle" });
	// The stale-key question a Save raised (staleKeyFieldsOnSave): the save re-points
	// the base URL while keeping a secure-stored secret stamped for the old one, so
	// nothing posts until the reader answers. Locations decided it; no stamp or value
	// ever reaches this page.
	const [staleKeyFields, setStaleKeyFields] = useState<readonly SecretFieldId[] | undefined>(undefined);
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
	// secure-side and absent fields are never requested. The request carries the FROZEN
	// identity, so a same-label replacement racing the prefill gets an empty answer instead
	// of prefilling its values into a form showing another entry.
	const requestInlineSecrets = inlineSecrets.send;
	const hasInlineSecret =
		original !== undefined && SECRET_FIELD_IDS.some((field) => original.secrets[field] === "settings");
	useEffect(() => {
		if (original === undefined || !hasInlineSecret) {
			return;
		}
		requestInlineSecrets({ replace: original });
		setPhase({ phase: "prefill" });
	}, [original, hasInlineSecret, requestInlineSecrets]);

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
			setTestState({
				kind: "pass",
				text: testOutcome.message ?? l10n.t("Connected"),
				// The zero-model probe passes with a warning tone (the shared
				// zero-model vocabulary); a quiet success carries none.
				...(testOutcome.tone !== undefined ? { tone: testOutcome.tone } : {}),
			});
		} else {
			setTestState({
				kind: "fail",
				text: testOutcome.message,
				classification: testOutcome.classification,
			});
		}
	}, [testOutcome, testState]);

	// One parse per keystroke: it carries either the intent Save posts or the problems the
	// form renders, so shown and saved can never diverge. Observed keys are the live prop;
	// `original` is the frozen open-time identity above.
	const parse = parseServerForm(draft, {
		takenLabels: declaredLabels,
		...(original !== undefined ? { original } : {}),
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

	const postSave = (intent: Parameters<typeof saveIntent.send>[0]) => {
		const requestId = saveIntent.send(intent);
		onSavePosted(requestId);
		setPhase({ phase: "saving", requestId });
	};

	// The stale-key dialog's detail line: every stale field's OLD destination
	// (deduplicated - the keys share the base URL), from the same shared
	// secretDestination rule the stamps record, over the identity the webview
	// already holds; a destination-free fallback covers a client secret stored
	// before the entry had a token URL. Resolved per render, so l10n stays
	// call-time.
	const staleKeyDetail = (): string => {
		const destinations = [
			...new Set(
				(staleKeyFields ?? [])
					.map((field) => (original !== undefined ? secretDestination(original, field) : ""))
					.filter((destination) => destination !== "")
			),
		];
		return destinations.length > 0
			? l10n.t(
					"The stored key was saved for {0}. Clearing the key removes it from secret storage.",
					destinations.join(", ")
				)
			: l10n.t("The stored key was saved for a different address. Clearing the key removes it from secret storage.");
	};

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
		// A save that re-points the URL while keeping a stored key asks first:
		// the stored value was saved for the old URL, and posting "keep" would
		// re-pair it with the new one host-side. Both answers post the same
		// intent shape - keep as parsed, or with those fields cleared.
		const stale = staleKeyFieldsOnSave(parse.intent);
		if (stale.length > 0) {
			setStaleKeyFields(stale);
			return;
		}
		postSave(parse.intent);
	};

	// The question's three ways out. "Use same key" posts the parse as it stands
	// (the host re-stamps the kept value for the new URL). "Clear key" marks the
	// stale fields' Remove checkboxes and posts the re-parse when it is clean;
	// a clear that breaks a pairing rule (a virtual key's header left naming a
	// removed value) returns to editing with the problem visible instead.
	const answerStaleKeyKeep = () => {
		setStaleKeyFields(undefined);
		if (parse.ok) {
			postSave(parse.intent);
		}
	};
	const answerStaleKeyClear = () => {
		if (staleKeyFields === undefined) {
			return;
		}
		let next = draft;
		for (const field of staleKeyFields) {
			next = { ...next, [field]: { ...next[field], clear: true } };
		}
		setStaleKeyFields(undefined);
		setDraft(next);
		const cleared = parseServerForm(next, {
			takenLabels: declaredLabels,
			...(original !== undefined ? { original } : {}),
			...(observedModelInfoKeys !== undefined ? { observedModelInfoKeys } : {}),
		});
		if (cleared.ok) {
			postSave(cleared.intent);
		} else {
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
		}
	};

	// The draft as typed goes out for one extension-side probe; label and model-parameter
	// rows never gate it, but a connection-relevant problem surfaces like Save's.
	const testConnection = () => {
		if (testState.kind === "testing" || saving) {
			return;
		}
		const testParse = parseServerFormForTest(draft, original !== undefined ? { original } : {});
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
							{l10n.t("An entry with this label already exists; saving replaces it and its stored credentials.")}
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
						<span
							className={cn("test-result text-[11.5px]", testState.tone === "warning" ? "state-warn" : "state-ok")}
							role="status"
						>
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
					<Textarea
						id="server-declaredModels"
						className="w-full font-mono text-[12px]"
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
			<FormSection quiet={true} title={l10n.t("MCP")} aside={l10n.t("optional")} help={helpMcpSection()}>
				<FieldRow
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
				</FieldRow>
				{/* The endpoint row follows the API version's idiom: it exists only while the
				    choice it belongs to is live, so an opted-out entry shows no dead input. */}
				{draft.mcp.enabled ? (
					<FieldRow
						htmlFor="server-mcp-url"
						label={l10n.t("MCP endpoint")}
						help={<Help text={helpMcpEndpoint()} name={l10n.t("Help: {0}", l10n.t("MCP endpoint"))} />}
						problem={visibleProblems.mcp}
						errorId="server-mcp-url-error"
						// The DERIVED default, not an abstract restatement: the form knows the
						// base URL, so it can show the exact address an empty field publishes.
						hint={derivedMcpHint(draft.baseUrl)}
					>
						<Input
							id="server-mcp-url"
							type="text"
							className="min-w-0 flex-1 font-mono text-[12px]"
							placeholder={l10n.t("e.g. https://gateway.internal/mcp")}
							value={draft.mcp.url}
							disabled={saving}
							aria-invalid={visibleProblems.mcp !== undefined}
							aria-describedby="server-mcp-url-error"
							onChange={(event) => props.patch({ mcp: { ...draft.mcp, url: event.currentTarget.value } })}
							onBlur={() => props.touch("mcp")}
						/>
					</FieldRow>
				) : null}
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
			{/* The stale-key question a Save raised: modal like the discard confirm - a
			    credential decision interrupts the save, it has no in-place anywhere.
			    Esc/"Keep editing" posts nothing; the two verbs answer the ONE question. */}
			{staleKeyFields !== undefined ? (
				<ConfirmDialog
					question={l10n.t("Keep using the stored key with the new URL?")}
					detail={staleKeyDetail()}
					confirmLabel={l10n.t("Clear key")}
					alternateLabel={l10n.t("Use same key")}
					cancelLabel={l10n.t("Keep editing")}
					surfaceId="server-edit-page"
					onConfirm={answerStaleKeyClear}
					onAlternate={answerStaleKeyKeep}
					onCancel={() => setStaleKeyFields(undefined)}
				/>
			) : null}
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

	// The credential verdict is coarse (reported for OAuth-only groups too), so the key row drops
	// out only when the group demonstrably holds no credentials; every row states its own condition.
	const secretRows: readonly { field: SecretFieldId; hint: string }[] = [
		...(server.credentials === "present"
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
