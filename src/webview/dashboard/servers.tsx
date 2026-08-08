import * as l10n from "@vscode/l10n";
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	DashboardIntentType,
	DashboardServer,
	ExpectedFailureCategory,
	HiddenGroup,
	SecretFieldId,
	SecretLocation,
	SetupHintKind,
	TransportErrorClassification,
} from "../../extension/dashboard/protocol";
import { EXPECTED_FAILURE_CATEGORIES, SECRET_FIELD_IDS } from "../../extension/dashboard/protocol";
import type { GroupProblems } from "../../extension/dashboard/recordDraft";
import { toCapabilityGroups, toGroups, toggleExpectedFailure } from "../../extension/dashboard/recordDraft";
import type {
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormProblems,
} from "../../extension/dashboard/serverForm";
import {
	applyInlinePrefill,
	CONNECTION_FIELDS,
	EMPTY_SERVER_FORM,
	isUsableHttpUrl,
	OAUTH_SECTION_FIELDS,
	parseServerForm,
	parseServerFormForTest,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	serverFormFieldLabel,
	validateAdoptLabel,
} from "../../extension/dashboard/serverForm";
import type { FailuresByIntent, InlineSecretsResponse, IntentAck } from "./app";
import type { DocsUrl } from "./docsLinks";
import {
	DOCS_LINK_CHECK_BASE_URL,
	DOCS_LINK_CONFIGURE_API_KEY,
	DOCS_LINK_MODEL_CAPABILITIES,
	DOCS_LINK_PARAMS_INACTIVE,
	DOCS_LINK_PROXY_NOT_RUNNING,
	DOCS_LINK_SERVER_FORM,
	DOCS_LINK_SERVERS,
} from "./docsLinks";
import { DocsLink, Help, HoverTip } from "./help";
import { helpEntryModelParameterPrefix, helpSecretStorage, helpServersSection, serverFieldHelp } from "./helpText";
import { IconAdd } from "./icons";
import type { CatalogSearchResponse } from "./recordEditors";
import { CapabilityGroupsFields, ParamGroupsFields } from "./recordEditors";
import { SlideOver } from "./slideOver";
import { relativeTime } from "./time";
import { newRequestId, postMessage } from "./vscodeApi";

/**
 * How long a pending adopt may hold the modal before the notice bar arms its
 * "Close anyway" escape: long enough for a normal ack, short enough that a
 * hung one cannot trap the user until a reload.
 */
const ADOPT_ESCAPE_AFTER_MS = 10000;

/**
 * The row's status pill: tone dot, plain-language verdict, and how long ago
 * discovery last looked. An "ok" row that still carries an error (a live
 * group kept serving while its sync failed) shows the warn tone, as does an
 * expected discovery failure (the entry declared it, so red would be a lie);
 * the error text itself renders in the section's banner, where it is
 * selectable.
 */
function StatusPill({ server, now }: { server: DashboardServer; now: number }) {
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	const time = checked === undefined ? null : <span class="pill-time">{checked}</span>;
	if (server.state === "ok") {
		if (server.error !== undefined) {
			return (
				<HoverTip
					focusable
					tip={l10n.t("The server answered, but its last settings sync reported a problem; details below.")}
				>
					<span class="pill tone-warn">
						<span class="dot" />
						{l10n.t("Sync issue")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span class="pill tone-ok">
				<span class="dot" />
				{l10n.t("Connected")}
				{time}
			</span>
		);
	}
	if (server.state === "error") {
		if (server.expected === true) {
			const declared = server.declaredModelCount ?? 0;
			// One state, one name across tabs: a row still serving declared
			// models reads Connected here exactly as the Diagnostics grid reads
			// it OK, with the warn tone and tip carrying the expected failure.
			return (
				<HoverTip
					focusable
					tip={
						declared > 0
							? l10n.t(
									"Discovery failed in a category this entry expects; its declared models keep serving. The banner below has the details."
								)
							: l10n.t(
									"Discovery failed in a category this entry expects. Nothing is declared, so no models are served; add IDs to the entry's discovery.declared."
								)
					}
				>
					<span class="pill tone-warn">
						<span class="dot" />
						{declared > 0 ? l10n.t("Connected") : l10n.t("Expected failure")}
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span class="pill tone-error">
				<span class="dot" />
				{l10n.t("Error")}
				{time}
			</span>
		);
	}
	return (
		<HoverTip
			focusable
			tip={l10n.t("Declared in settings; no discovery pass has seen it yet. Run Sync models to check it now.")}
		>
			<span class="pill tone-muted">
				<span class="dot" />
				{l10n.t("Not checked")}
			</span>
		</HoverTip>
	);
}

/** The two DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */
type DeclaredDashboardServer = Extract<DashboardServer, { origin: "declared" }>;
type ExternalDashboardServer = Extract<DashboardServer, { origin: "external" }>;

/**
 * The external badge's hover tip, from the row's provenance classification.
 * The copy lives here (classifications cross the boundary, words do not):
 * a removed entry's leftover names the removed label, a rename leftover names
 * both labels, and a row without provenance gets the honest default - added
 * outside this extension, or predating the tracking. Deletion instructions
 * name the models file: VS Code offers extensions no group removal, so the
 * file (or VS Code's own UI) is where deleting actually lives.
 */
function externalTip(server: ExternalDashboardServer): string {
	const provenance = server.provenance;
	if (provenance?.kind === "removed-entry-leftover") {
		return l10n.t(
			'Leftover of the removed entry "{0}". Remove hides its models; deleting its object from the models file erases it.',
			provenance.removedLabel
		);
	}
	if (provenance?.kind === "rename-leftover") {
		return l10n.t(
			'Leftover of renaming "{0}" to "{1}". Its models show under both names until its object is deleted from the models file.',
			provenance.oldLabel,
			provenance.newLabel
		);
	}
	return l10n.t(
		"No entry in the servers setting: added outside this extension, or predates its tracking. Edit adopts it."
	);
}

/**
 * What the open form is for, decided once where it opens (a row's Edit or the
 * Add button) so no component re-derives it from optional fields: adding a
 * new entry, editing a declared one, or adopting an external group.
 */
type FormTarget =
	| { readonly kind: "add" }
	| { readonly kind: "edit"; readonly original: DeclaredDashboardServer }
	| { readonly kind: "adopt"; readonly server: ExternalDashboardServer };

/** The targets ServerForm handles; adoption renders AdoptForm instead. */
type ServerFormTarget = Extract<FormTarget, { kind: "add" | "edit" }>;

/**
 * Where the form is in its life. The prefill and save round trips each carry
 * their own correlation ID, but the form is only ever in one of them: fields
 * stay editable throughout, and only Save gates on the phase being "editing".
 */
type FormPhase =
	| { readonly phase: "prefill"; readonly requestId: string }
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
function troubleshootingLink(hint: SetupHintKind): { href: DocsUrl; label: string } {
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
		oauthTokenUrl: original.config.oauthTokenUrl ?? "",
		oauthClientId: original.config.oauthClientId ?? "",
		oauthScopes: original.config.oauthScopes ?? "",
		virtualKeyHeader: original.config.virtualKeyHeader ?? "",
		apiKey: secretDraft(original.config.secrets.apiKey),
		oauthClientSecret: secretDraft(original.config.secrets.oauthClientSecret),
		virtualKeyValue: secretDraft(original.config.secrets.virtualKeyValue),
		modelParameters: toGroups(original.config.modelParameters ?? {}),
		modelCapabilities: toCapabilityGroups(original.config.modelCapabilities ?? {}),
		expectedFailures: original.config.expectedFailures ?? [],
	};
}

/** The storage locations' display names, resolved at call time (no module-level localized constants). */
function locationName(location: Exclude<SecretLocation, "none">): string {
	return location === "secure" ? l10n.t("secret storage") : l10n.t("settings");
}

interface FieldRenderProps {
	readonly draft: ServerFormDraft;
	/**
	 * The problems the form shows right now, computed once per render in
	 * ServerForm (a problem is visible once its field was touched or holds
	 * content). Fields render these directly, so the field decorations, the
	 * OAuth disclosure, and the save summary cannot disagree.
	 */
	readonly visibleProblems: ServerFormProblems;
	readonly disabled: boolean;
	readonly patch: (patch: Partial<ServerFormDraft>) => void;
	readonly touch: (field: ServerFormField) => void;
}

function TextField({
	field,
	placeholder,
	props,
}: {
	field: Exclude<ServerFormField, SecretFieldId | "modelParameters" | "modelCapabilities" | "expectedFailures">;
	placeholder?: string;
	props: FieldRenderProps;
}) {
	const problem = props.visibleProblems[field];
	const showProblem = problem !== undefined;
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	return (
		<div class="field">
			<span class="label-row">
				<label for={id}>{serverFormFieldLabel(field)}</label>
				<Help text={serverFieldHelp(field)} />
			</span>
			<input
				id={id}
				type="text"
				class={showProblem ? "invalid" : ""}
				placeholder={placeholder ?? ""}
				value={props.draft[field]}
				disabled={props.disabled}
				aria-invalid={showProblem}
				aria-describedby={showProblem ? errorId : undefined}
				onInput={(event) => props.patch({ [field]: event.currentTarget.value } as Partial<ServerFormDraft>)}
				onBlur={() => props.touch(field)}
			/>
			{showProblem ? (
				<span id={errorId} class="error">
					{problem}
				</span>
			) : null}
		</div>
	);
}

/**
 * One secret field: a password input plus the user's per-field storage
 * choice. Values in secure storage are never shown (they never reach this
 * page); an inline value prefills the input, masked behind a Show toggle,
 * because settings.json already displays it in plain text. Leaving the input
 * empty - or leaving a prefill unedited - keeps the stored value where it is.
 */
function SecretField({ field, props }: { field: SecretFieldId; props: FieldRenderProps }) {
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
	return (
		<div class="field">
			<span class="label-row">
				<label for={id}>{serverFormFieldLabel(field)}</label>
				<Help text={serverFieldHelp(field)} />
			</span>
			<span class="secret-input">
				<input
					id={id}
					type={revealed ? "text" : "password"}
					class={showProblem ? "invalid" : ""}
					value={value.value}
					disabled={props.disabled || value.clear}
					aria-invalid={showProblem}
					aria-describedby={showProblem ? errorId : undefined}
					onInput={(event) => patchSecret({ value: event.currentTarget.value })}
					onBlur={() => props.touch(field)}
				/>
				<button
					type="button"
					class="quiet"
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
				</button>
			</span>
			<span
				class="secret-where"
				role="radiogroup"
				aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
			>
				<span class="where-label">{l10n.t("Store in:")}</span>
				<Help text={helpSecretStorage()} />
				<label>
					<input
						type="radio"
						name={`${id}-where`}
						checked={value.location === "secure"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "secure" })}
					/>
					{l10n.t("secret storage")}
				</label>
				<label>
					<input
						type="radio"
						name={`${id}-where`}
						checked={value.location === "settings"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "settings" })}
					/>
					{l10n.t("settings (visible)")}
				</label>
			</span>
			{/* Removal is destructive, so it lives on its own line in its own
			    tone, never as a third option inside the storage choice. */}
			{value.existing !== "none" ? (
				<label class={value.clear ? "secret-remove armed" : "secret-remove"}>
					<input
						type="checkbox"
						checked={value.clear}
						disabled={props.disabled}
						onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
					/>
					{l10n.t("Remove the stored {0} on save", serverFormFieldLabel(field))}
				</label>
			) : null}
			{value.prefill !== undefined && !value.clear ? (
				value.value.trim().length === 0 ? (
					<span class="hint">{l10n.t("Emptied, but the stored value is kept; use remove to delete it.")}</span>
				) : (
					<span class="hint">
						{l10n.t("Inline in the servers setting, so settings.json already shows it; saving it unedited keeps it.")}
					</span>
				)
			) : value.existing !== "none" && !value.clear ? (
				<span class="hint">
					{l10n.t("Currently in {0}; leave the field empty to keep it.", locationName(value.existing))}
				</span>
			) : null}
			{value.clear ? <span class="hint">{l10n.t("The stored value will be removed on save.")}</span> : null}
			{showProblem ? (
				<span id={errorId} class="error">
					{problem}
				</span>
			) : null}
		</div>
	);
}

/**
 * Whether a field "holds content" for problem visibility. Record-row and
 * list-valued fields only carry problems on entries the user (or the
 * prefill) put there, so any entries count as content; text and secret
 * fields count their text.
 */
function fieldHasContent(draft: ServerFormDraft, field: ServerFormField): boolean {
	if (field === "modelParameters" || field === "modelCapabilities" || field === "expectedFailures") {
		return draft[field].length > 0;
	}
	const value = draft[field];
	return typeof value === "string" ? value.length > 0 : value.value.length > 0;
}

/**
 * The inline Add/Edit form. Saving posts one saveServerSetting intent tagged
 * with a requestId and waits for its own ack: intentSucceeded closes the form
 * (discarding the draft, typed secrets included); a validation-kind
 * intentFailed returns it to a retryable editing state, while an
 * operation-kind one closes it too - the save committed, so the draft is
 * stale and the section-level notice carries the recovery path. Unrelated
 * state pushes leave it alone.
 */
function ServerForm({
	target,
	ack,
	failures,
	inlineSecrets,
	catalogResults,
	declaredLabels,
	onUserEdit,
	onClose,
	onCancel,
}: {
	target: ServerFormTarget;
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	inlineSecrets: InlineSecretsResponse | undefined;
	/** The latest catalogSearchResults response, for the capability rows' `_openrouter_model` picker. */
	catalogResults: CatalogSearchResponse | undefined;
	declaredLabels: readonly string[];
	/** Reports the first user edit; the slide-over's close-with-confirm keys on it. */
	onUserEdit: () => void;
	onClose: () => void;
	/** The Cancel button's close request; routed through the slide-over's discard policy. */
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<ServerFormDraft>(() => draftFor(target));
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [phase, setPhase] = useState<FormPhase>({ phase: "editing" });
	const [testState, setTestState] = useState<TestState>({ kind: "idle" });
	const [oauthOpen, setOauthOpen] = useState(false);
	// The per-entry parameters and capabilities disclosures open by themselves
	// only for an entry that already carries some; adding rows to a bare entry
	// is opt-in.
	const [paramsOpen, setParamsOpen] = useState(
		() => target.kind === "edit" && Object.keys(target.original.config.modelParameters ?? {}).length > 0
	);
	const [capsOpen, setCapsOpen] = useState(
		() =>
			target.kind === "edit" &&
			(Object.keys(target.original.config.modelCapabilities ?? {}).length > 0 ||
				(target.original.config.expectedFailures ?? []).length > 0)
	);
	const saving = phase.phase === "saving";
	// Save holds until the prefill response lands (phase "prefill"): saving
	// before it arrives would assemble the still-empty fields as "keep",
	// silently dropping a relocation the user just picked (flip the radio to
	// secure, hit Save). Fields stay editable meanwhile; the response never
	// clobbers what was typed. The response is one round trip behind the form
	// opening, so the gate is imperceptible in practice.
	const failure = failures.saveServerSetting;
	const failureSeq = failure?.seq;
	const failureRequestId = failure?.requestId;
	const failureKind = failure?.kind;

	// Editing a declared entry with inline-stored secrets: ask for their values
	// once per form instance (the key remounts a fresh form). Secure-side and
	// absent fields are never requested-for or returned; they keep the empty
	// placeholder input.
	useEffect(() => {
		if (target.kind !== "edit") {
			return;
		}
		const config = target.original.config;
		if (!SECRET_FIELD_IDS.some((field) => config.secrets[field] === "settings")) {
			return;
		}
		const requestId = newRequestId();
		postMessage({ type: "readInlineSecrets", label: target.original.label, requestId });
		setPhase({ phase: "prefill", requestId });
	}, [target]);

	// This form's own response prefills the untouched inline fields; a response
	// for a previous form instance (a stale requestId) is ignored.
	useEffect(() => {
		if (phase.phase !== "prefill" || inlineSecrets === undefined || inlineSecrets.requestId !== phase.requestId) {
			return;
		}
		setPhase({ phase: "editing" });
		setDraft((current) => applyInlinePrefill(current, inlineSecrets.values));
	}, [inlineSecrets, phase]);

	useEffect(() => {
		if (phase.phase === "saving" && ack?.requestId === phase.requestId) {
			onClose();
		}
	}, [ack, phase, onClose]);

	// This form's own test outcome. Success renders the extension-composed
	// message verbatim ("Connected - N models"); an outcome for an abandoned
	// requestId (the state left "testing" on an edit or a retest) is ignored.
	useEffect(() => {
		if (testState.kind === "testing" && ack?.requestId === testState.requestId) {
			setTestState({ kind: "pass", text: ack.message ?? l10n.t("Connected") });
		}
	}, [ack, testState]);

	const testFailure = failures.testServerDraft;
	const testFailureSeq = testFailure?.seq;
	const testFailureRequestId = testFailure?.requestId;
	const testFailureMessage = testFailure?.message;
	const testFailureClassification = testFailure?.classification;
	useEffect(() => {
		if (testState.kind !== "testing" || testFailureSeq === undefined || testFailureRequestId !== testState.requestId) {
			return;
		}
		setTestState({
			kind: "fail",
			text: testFailureMessage ?? l10n.t("The connection test failed"),
			classification: testFailureClassification,
		});
	}, [testFailureSeq, testFailureRequestId, testFailureMessage, testFailureClassification, testState]);

	// This form's own failure: a validation-kind one re-opens it for editing
	// (the draft is still the truth); an operation-kind one means the save
	// committed and the draft is stale, so the form closes like a success. The
	// message renders at the section level either way, so it also survives the
	// closed form.
	useEffect(() => {
		if (phase.phase !== "saving" || failureSeq === undefined || failureRequestId !== phase.requestId) {
			return;
		}
		if (saveFailureDisposition(failureKind ?? "validation") === "close") {
			onClose();
			return;
		}
		setPhase({ phase: "editing" });
	}, [failureSeq, failureRequestId, failureKind, phase, onClose]);

	const originalLabel = target.kind === "edit" ? target.original.label : undefined;
	// One parse per keystroke: it either carries the intent Save posts or the
	// problems the form renders, so what the fields show and what would be
	// saved can never diverge.
	const parse = parseServerForm(draft, {
		takenLabels: declaredLabels,
		...(originalLabel !== undefined ? { originalLabel } : {}),
	});
	const label = draft.label.trim();
	const renaming = target.kind === "edit" && label !== target.original.label;
	const collides = target.kind === "add" && declaredLabels.includes(label);

	// A problem is visible once its field was touched or holds content
	// (fieldHasContent); computed once here and passed through the render
	// props, so the fields, the disclosures, and the save summary all show the
	// same problems.
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
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find((field) => visibleProblems[field] !== undefined);
	const oauthProblemVisible = OAUTH_SECTION_FIELDS.some((field) => visibleProblems[field] !== undefined);
	const paramsProblemVisible = visibleProblems.modelParameters !== undefined;
	const capsProblemVisible = visibleProblems.modelCapabilities !== undefined;
	// A problem surfacing inside a collapsed disclosure opens it once
	// (otherwise Save would refuse over an error the user cannot see); beyond
	// that the element is the user's: closing it again sticks, and it does not
	// snap shut when the problems clear.
	useEffect(() => {
		if (oauthProblemVisible) {
			setOauthOpen(true);
		}
	}, [oauthProblemVisible]);
	useEffect(() => {
		if (paramsProblemVisible) {
			setParamsOpen(true);
		}
	}, [paramsProblemVisible]);
	useEffect(() => {
		if (capsProblemVisible) {
			setCapsOpen(true);
		}
	}, [capsProblemVisible]);

	const save = () => {
		if (phase.phase !== "editing") {
			// Belt and braces behind the disabled button: never post while the
			// prefill is still on its way or a save is already in flight.
			return;
		}
		if (!parse.ok) {
			// Surface every problem instead of refusing silently, opening the
			// disclosure when one hides inside it.
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
			if (OAUTH_SECTION_FIELDS.some((field) => parse.problems[field] !== undefined)) {
				setOauthOpen(true);
			}
			if (parse.problems.modelParameters !== undefined) {
				setParamsOpen(true);
			}
			if (parse.problems.modelCapabilities !== undefined) {
				setCapsOpen(true);
			}
			return;
		}
		const requestId = newRequestId();
		postMessage({ type: "saveServerSetting", ...parse.intent, requestId });
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
			if (OAUTH_SECTION_FIELDS.some((field) => testParse.problems[field] !== undefined)) {
				setOauthOpen(true);
			}
			return;
		}
		const requestId = newRequestId();
		postMessage({ type: "testServerDraft", ...testParse.intent, requestId });
		setTestState({ kind: "testing", requestId });
	};

	const props: FieldRenderProps = {
		draft,
		visibleProblems,
		disabled: saving,
		patch: (patch) => {
			onUserEdit();
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

	return (
		<div class="form-card">
			{/* The dialog's accessible name is the title span alone, so the
			    docs anchor's own label never leaks into it. */}
			<h3 class="head-with-icons">
				<span id="server-form-title">
					{target.kind === "add" ? l10n.t("Add server") : l10n.t("Edit {0}", target.original.label)}
				</span>
				<DocsLink href={DOCS_LINK_SERVER_FORM} label={l10n.t("Open the server fields guide")} />
			</h3>
			<TextField field="label" placeholder={l10n.t("e.g. Production")} props={props} />
			{renaming && (parse.ok || parse.problems.label === undefined) ? (
				<p class="hint">
					{l10n.t(
						"Renaming makes VS Code treat this as a new server: the old name keeps serving its models until you delete its object from the models file (the rename notice opens it)."
					)}
				</p>
			) : null}
			{target.kind === "edit" && !renaming ? (
				<details class="fine-print">
					<summary>{l10n.t("Changing the URL or credentials?")}</summary>
					<p class="hint">
						{l10n.t("Saving stores the change, but VS Code keeps using the old connection details until:")}
					</p>
					<ol class="notice-steps hint">
						<li>{l10n.t("You remove this server's object from the models file (chatLanguageModels.json).")}</li>
						<li>{l10n.t("You reload the window, then run Sync Models Now.")}</li>
					</ol>
				</details>
			) : null}
			{collides ? <p class="hint">{l10n.t("An entry with this label already exists; saving replaces it.")}</p> : null}
			<TextField field="baseUrl" placeholder={l10n.t("e.g. http://localhost:4000")} props={props} />
			<SecretField field="apiKey" props={props} />
			<details open={oauthOpen} onToggle={(event) => setOauthOpen(event.currentTarget.open)}>
				<summary>{l10n.t("OAuth and virtual key (optional)")}</summary>
				<TextField
					field="oauthTokenUrl"
					placeholder={l10n.t("e.g. https://idp.example.com/oauth2/token")}
					props={props}
				/>
				<TextField field="oauthClientId" placeholder={l10n.t("e.g. litellm-vscode")} props={props} />
				<SecretField field="oauthClientSecret" props={props} />
				<TextField field="oauthScopes" placeholder={l10n.t("e.g. litellm.read litellm.write")} props={props} />
				<TextField field="virtualKeyHeader" placeholder={l10n.t("e.g. x-litellm-api-key")} props={props} />
				<SecretField field="virtualKeyValue" props={props} />
			</details>
			<details open={paramsOpen} onToggle={(event) => setParamsOpen(event.currentTarget.open)}>
				<summary>
					{l10n.t("Model parameters for this server (optional)")} <Help text={serverFieldHelp("modelParameters")} />
				</summary>
				<p class="hint">
					{l10n.t(
						"Sent only with requests routed through this entry; overrides the global Model parameters setting for the same keys. Matching is by model ID prefix, longest prefix wins."
					)}
				</p>
				<ParamGroupsFields
					groups={draft.modelParameters}
					problems={modelParameterProblems}
					hints={modelParameterHints}
					disabled={saving}
					prefixPlaceholder={l10n.t("Model prefix, e.g. gpt-4")}
					prefixHelp={helpEntryModelParameterPrefix()}
					onChange={(next) => props.patch({ modelParameters: next })}
				/>
				<button
					type="button"
					class="secondary"
					disabled={saving}
					onClick={() =>
						props.patch({
							modelParameters: [...draft.modelParameters, { prefix: "", params: [{ key: "", valueText: "" }] }],
						})
					}
				>
					<IconAdd /> {l10n.t("Add model prefix")}
				</button>
			</details>
			<details open={capsOpen} onToggle={(event) => setCapsOpen(event.currentTarget.open)}>
				<summary>
					{l10n.t("Model capabilities for this server (optional)")} <Help text={serverFieldHelp("modelCapabilities")} />{" "}
					<DocsLink href={DOCS_LINK_MODEL_CAPABILITIES} label={l10n.t("Open the model capabilities guide")} />
				</summary>
				<p class="hint">
					{l10n.t(
						"Corrects what discovery reports for matching models, e.g. context_length 128000. Your values beat server-reported ones unless marked fallback."
					)}
				</p>
				<CapabilityGroupsFields
					groups={draft.modelCapabilities}
					issues={modelCapabilityIssues}
					disabled={saving}
					catalogResults={catalogResults}
					onChange={(next) => props.patch({ modelCapabilities: next })}
				/>
				<button
					type="button"
					class="secondary"
					disabled={saving}
					onClick={() =>
						props.patch({
							modelCapabilities: [...draft.modelCapabilities, { prefix: "", params: [{ key: "", valueText: "" }] }],
						})
					}
				>
					<IconAdd /> {l10n.t("Add capability prefix")}
				</button>
				<fieldset class="expected-failures">
					<legend class="label-row">
						{serverFormFieldLabel("expectedFailures")} <Help text={serverFieldHelp("expectedFailures")} />
					</legend>
					<p class="hint">
						{l10n.t(
							"Discovery endpoints this server is known to lack: marked failures log quietly, skip retries, and never count as errors."
						)}
					</p>
					{EXPECTED_FAILURE_CATEGORIES.map((category) => (
						<label key={category} class="setting-check">
							<input
								type="checkbox"
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
			</details>
			<p class="hint">
				{l10n.t(
					"Saved to the litellm-vscode-chat.servers user setting and synced to VS Code automatically. Secrets left empty or unedited keep their current value."
				)}
			</p>
			<div class="toolbar">
				<button type="button" disabled={phase.phase !== "editing"} onClick={save}>
					{saving ? (
						<>
							<span class="spinner" aria-hidden="true" /> {l10n.t("Saving...")}
						</>
					) : (
						l10n.t("Save")
					)}
				</button>
				<button type="button" class="secondary" onClick={onCancel}>
					{l10n.t("Cancel")}
				</button>
				{/* Probes the draft as typed, saved or not. Disabled only while the
				    base URL is unusable or a probe/save is in flight; Cancel stays
				    live throughout - an abandoned probe's outcome is simply ignored. */}
				<button
					type="button"
					class="secondary"
					disabled={!isUsableHttpUrl(draft.baseUrl.trim()) || testState.kind === "testing" || saving}
					onClick={testConnection}
				>
					{testState.kind === "testing" ? (
						<>
							<span class="spinner" aria-hidden="true" /> {l10n.t("Testing...")}
						</>
					) : (
						l10n.t("Test connection")
					)}
				</button>
				{phase.phase === "prefill" ? <span class="hint">{l10n.t("Loading stored values...")}</span> : null}
				{firstBlocking !== undefined ? (
					<span class="error" role="alert">
						{l10n.t("Cannot save: fix {0}", serverFormFieldLabel(firstBlocking))}
					</span>
				) : null}
				{testState.kind === "pass" ? (
					<span class="test-result state-ok" role="status">
						{testState.text}
					</span>
				) : null}
				{testState.kind === "fail" ? (
					<span class="test-result error" role="alert">
						{testState.text}
						{testState.classification?.setupHint !== undefined ? (
							// A classified setup problem: the link to its matching
							// troubleshooting-guide section rides inside the alert so one
							// announcement carries the failure and the way out. The leading
							// space keeps copied text from gluing the link label onto the
							// error message.
							<>
								{" "}
								<span class="test-hint">
									<DocsLink {...troubleshootingLink(testState.classification.setupHint)}>
										{l10n.t("Troubleshoot")}
									</DocsLink>
								</span>
							</>
						) : null}
					</span>
				) : null}
			</div>
		</div>
	);
}

/**
 * The adopt form: turns an external provider group into a declared servers
 * entry. Credentials exist extension-side only, so instead of secret inputs
 * the form offers one storage choice per secret field; the posted intent
 * carries the label, the source row's identity, and those choices - never a
 * credential value. Ack and failure handling mirror ServerForm: the intent's
 * own requestId closes the form, a validation failure returns it to editing.
 */
function AdoptForm({
	server,
	ack,
	failures,
	declaredLabels,
	onUserEdit,
	onBusyChange,
	onAdopted,
	onClose,
	onCancel,
}: {
	server: ExternalDashboardServer;
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	declaredLabels: readonly string[];
	/** Reports the first user edit; the slide-over's close-with-confirm keys on it. */
	onUserEdit: () => void;
	/**
	 * Reports the in-flight adopt: closing then would unmount this form before
	 * the ack and lose the post-adoption notice (the duplicate-group reminder
	 * and any missing-credentials caveat), so the slide-over ignores close
	 * requests while busy.
	 */
	onBusyChange: (busy: boolean) => void;
	/** Called once with the extension's optional caveat when the adoption lands; the parent shows the follow-up notice. */
	onAdopted: (message: string | undefined) => void;
	onClose: () => void;
	onCancel: () => void;
}) {
	const [label, setLabel] = useState(server.label);
	const [touched, setTouched] = useState(false);
	const [locations, setLocations] = useState<Record<SecretFieldId, "settings" | "secure">>({
		apiKey: "secure",
		oauthClientSecret: "secure",
		virtualKeyValue: "secure",
	});
	const [pending, setPending] = useState<string | undefined>(undefined);
	const saving = pending !== undefined;
	useEffect(() => {
		onBusyChange(saving);
	}, [saving, onBusyChange]);
	const failure = failures.adoptServer;
	const failureSeq = failure?.seq;
	const failureRequestId = failure?.requestId;
	const failureKind = failure?.kind;

	useEffect(() => {
		if (pending !== undefined && ack?.requestId === pending) {
			onAdopted(ack.message);
			onClose();
		}
	}, [ack, pending, onAdopted, onClose]);

	useEffect(() => {
		if (pending === undefined || failureSeq === undefined || failureRequestId !== pending) {
			return;
		}
		if (saveFailureDisposition(failureKind ?? "validation") === "close") {
			onClose();
			return;
		}
		setPending(undefined);
	}, [failureSeq, failureRequestId, failureKind, pending, onClose]);

	const problem = validateAdoptLabel(label, declaredLabels);
	const showProblem = problem !== undefined && (touched || label.trim() !== server.label);

	const adopt = () => {
		if (problem !== undefined) {
			setTouched(true);
			return;
		}
		const requestId = newRequestId();
		postMessage({
			type: "adoptServer",
			label: label.trim(),
			baseUrl: server.baseUrl,
			// External rows always carry the handle; the FormTarget union
			// guarantees only external rows reach this form.
			sourceHandle: server.adoptHandle,
			secrets: locations,
			requestId,
		});
		setPending(requestId);
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
		<div class="form-card">
			<h3 id="server-form-title">{l10n.t("Adopt {0}", server.label)}</h3>
			<p class="hint">
				{l10n.t(
					"Adopting writes this VS Code-managed group into the litellm-vscode-chat.servers setting, so it becomes editable here. Its credentials are copied inside the extension and never pass through this page."
				)}
			</p>
			<div class="field">
				<label for="adopt-label">{l10n.t("Label")}</label>
				<input
					id="adopt-label"
					type="text"
					class={showProblem ? "invalid" : ""}
					value={label}
					disabled={saving}
					aria-invalid={showProblem}
					aria-describedby={showProblem ? "adopt-label-error" : undefined}
					onInput={(event) => {
						onUserEdit();
						setLabel(event.currentTarget.value);
					}}
					onBlur={() => setTouched(true)}
				/>
				<span class="hint">
					{l10n.t(
						"Names the new entry and its provider group; usually worth renaming, since a name an existing VS Code group already uses cannot be synced."
					)}
				</span>
				{showProblem ? (
					<span id="adopt-label-error" class="error">
						{problem}
					</span>
				) : null}
			</div>
			<div class="field">
				<span class="field-label">{l10n.t("Base URL")}</span>
				<span class="readonly-value">{server.baseUrl}</span>
				<span class="hint">{l10n.t("Fixed to the group being adopted; edit the server afterwards to change it.")}</span>
			</div>
			{secretRows.map(({ field, hint }) => (
				<div class="field" key={field}>
					<span>{serverFormFieldLabel(field)}</span>
					<span class="hint">{hint}</span>
					<span
						class="secret-where"
						role="radiogroup"
						aria-label={l10n.t("Where to store the {0}", serverFormFieldLabel(field))}
					>
						<span class="where-label">{l10n.t("Store in:")}</span>
						<label>
							<input
								type="radio"
								name={`adopt-${field}-where`}
								checked={locations[field] === "secure"}
								disabled={saving}
								onChange={() => {
									onUserEdit();
									setLocations((current) => ({ ...current, [field]: "secure" }));
								}}
							/>
							{l10n.t("secret storage")}
						</label>
						<label>
							<input
								type="radio"
								name={`adopt-${field}-where`}
								checked={locations[field] === "settings"}
								disabled={saving}
								onChange={() => {
									onUserEdit();
									setLocations((current) => ({ ...current, [field]: "settings" }));
								}}
							/>
							{l10n.t("settings (visible)")}
						</label>
					</span>
				</div>
			))}
			<p class="hint">
				{l10n.t(
					"VS Code cannot remove the original group: its models appear twice until its object is deleted from the models file."
				)}
			</p>
			<div class="toolbar">
				<button type="button" disabled={saving} onClick={adopt}>
					{saving ? (
						<>
							<span class="spinner" aria-hidden="true" /> {l10n.t("Adopting...")}
						</>
					) : (
						l10n.t("Adopt")
					)}
				</button>
				{/* Disabled while the intent is in flight: cancelling would unmount
				    this form before the ack and lose the post-adoption notice (the
				    duplicate-group reminder and any missing-credentials caveat). */}
				<button type="button" class="secondary" disabled={saving} onClick={onCancel}>
					{l10n.t("Cancel")}
				</button>
				{showProblem ? (
					<span class="error" role="alert">
						{l10n.t("Cannot adopt: fix Label")}
					</span>
				) : null}
			</div>
		</div>
	);
}

function ServerRow({
	server,
	now,
	armed,
	onEdit,
	onArmRemove,
	onHideExternal,
	onShowModels,
}: {
	server: DashboardServer;
	now: number;
	armed: boolean;
	onEdit: () => void;
	onArmRemove: (armed: boolean) => void;
	/** Posts the hideExternalServer intent for this row; the section owns the requestId and the follow-up notice. */
	onHideExternal: (server: ExternalDashboardServer) => void;
	onShowModels: ((label: string) => void) | undefined;
}) {
	const confirmRemove = () => {
		postMessage({ type: "removeServerSetting", label: server.label, requestId: newRequestId() });
		onArmRemove(false);
	};
	return (
		<tr>
			<td>{server.label}</td>
			<td class="url">{server.baseUrl}</td>
			<td data-label={l10n.t("Status")}>
				<StatusPill server={server} now={now} />
			</td>
			<td class="num" data-label={l10n.t("Models")}>
				{/* The count doubles as the bridge to the models section below:
				    clicking it scopes the list to this server. A zero stays plain
				    text, since an empty scoped list has nothing to show. */}
				{onShowModels !== undefined && server.modelCount > 0 ? (
					<button
						type="button"
						class="quiet count-link"
						aria-label={l10n.t("Show models from {0}", server.label)}
						onClick={() => onShowModels(server.label)}
					>
						{server.modelCount}
					</button>
				) : (
					server.modelCount
				)}
			</td>
			<td>
				{/* The credential kind is the information, so it is the visible
				    text; a generic "auth" badge would hide it in a hover tip. */}
				{server.hasApiKey || server.hasOAuth ? (
					<span class="badge">{server.hasOAuth ? "OAuth" : l10n.t("API key")}</span>
				) : null}
				{server.origin === "external" ? (
					<HoverTip focusable tip={externalTip(server)}>
						<span class="badge">{l10n.t("external")}</span>
					</HoverTip>
				) : null}
				{/* Gated on expected: only expected failures fold the declared count
				    into the row's served models; an unexpected failure's declarations
				    are extension bookkeeping, and a badge beside a zero count would
				    contradict the row. */}
				{server.state === "error" && server.expected === true && (server.declaredModelCount ?? 0) > 0 ? (
					<HoverTip
						focusable
						tip={l10n.t(
							"Models declared in the entry's discovery.declared list; they keep serving while discovery fails."
						)}
					>
						<span class="badge">
							{(server.declaredModelCount ?? 0) === 1
								? l10n.t("1 declared model")
								: l10n.t("{0} declared models", server.declaredModelCount ?? 0)}
						</span>
					</HoverTip>
				) : null}
				{server.notices?.includes("entry-params-inactive") === true ? (
					<HoverTip
						tip={l10n.t(
							"Per-server model parameters are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
						)}
					>
						<span class="badge state-warn">{l10n.t("params inactive")}</span>
					</HoverTip>
				) : null}
				{server.notices?.includes("entry-capabilities-inactive") === true ? (
					<HoverTip
						tip={l10n.t(
							"Per-server model capabilities and expected failures are not applied: the group serving this entry predates its label or a rename. The banner below has the fix."
						)}
					>
						<span class="badge state-warn">{l10n.t("capabilities inactive")}</span>
					</HoverTip>
				) : null}
			</td>
			<td class={armed ? "actions armed" : "actions"}>
				{armed ? (
					<>
						<button
							type="button"
							class="quiet state-error"
							onClick={() => {
								// The same two-step confirm for both origins; only the intent
								// differs (a declared entry is removed from the setting, an
								// external group is hidden by tombstone).
								if (server.origin === "declared") {
									confirmRemove();
								} else {
									onHideExternal(server);
									onArmRemove(false);
								}
							}}
						>
							{l10n.t("Confirm remove?")}
						</button>
						<button type="button" class="quiet" onClick={() => onArmRemove(false)}>
							{l10n.t("Cancel")}
						</button>
					</>
				) : (
					<>
						<button type="button" class="quiet" onClick={onEdit}>
							{l10n.t("Edit")}
						</button>
						{/* A legacy-registry external row is not hideable (the registry
						    path would keep serving its models), so it keeps Edit only. */}
						{server.origin === "declared" || server.hideable ? (
							<button type="button" class="quiet" onClick={() => onArmRemove(true)}>
								{l10n.t("Remove")}
							</button>
						) : null}
					</>
				)}
			</td>
		</tr>
	);
}

/**
 * The collapsed hidden-groups line: one muted sentence stating the count,
 * expandable to a row per hidden group with its Unhide. Unhide clears the
 * removal tombstone extension-side; the group's models return on the host's
 * next re-resolution, which the extension triggers itself.
 */
function HiddenGroupsLine({ hidden }: { hidden: readonly HiddenGroup[] }) {
	const [expanded, setExpanded] = useState(false);
	if (hidden.length === 0) {
		return null;
	}
	return (
		<div class="hidden-groups">
			<p class="hint">
				{hidden.length === 1 ? l10n.t("1 hidden group") : l10n.t("{0} hidden groups", hidden.length)} -{" "}
				<button type="button" class="quiet" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
					{expanded ? l10n.t("hide") : l10n.t("show")}
				</button>
			</p>
			{expanded ? (
				<ul>
					{hidden.map((group, index) => (
						// Positional identity like the server rows: the list rebuilds
						// wholesale on every state push.
						<li key={index}>
							<span class="hidden-label">{group.label}</span> <span class="url">{group.baseUrl}</span>{" "}
							<button
								type="button"
								class="quiet"
								onClick={() =>
									postMessage({
										type: "unhideServer",
										label: group.label,
										baseUrl: group.baseUrl,
										requestId: newRequestId(),
									})
								}
							>
								{l10n.t("Unhide")}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function ServersSection({
	servers,
	hidden = [],
	now,
	ack,
	failures,
	inlineSecrets,
	catalogResults,
	onDismissFailure,
	onClearInlineSecrets,
	onShowModels,
	adoptEscapeAfterMs = ADOPT_ESCAPE_AFTER_MS,
}: {
	servers: readonly DashboardServer[];
	/** Groups hidden by an explicit removal; rendered as the collapsed hidden-groups line. */
	hidden?: readonly HiddenGroup[];
	/** The shared clock tick (one useNow in App), so a hidden panel does not run its own interval. */
	now: number;
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	inlineSecrets: InlineSecretsResponse | undefined;
	/** The latest catalogSearchResults response, for the edit form's `_openrouter_model` picker. */
	catalogResults?: CatalogSearchResponse | undefined;
	/** Drop the latest failure notice for one intent type (Cancel dismisses a stale save failure). */
	onDismissFailure: (intentType: DashboardIntentType) => void;
	/** Drop the held inlineSecrets response; called when the edit form closes so the value leaves webview memory. */
	onClearInlineSecrets: () => void;
	/** Scope the models section below to one server; absent, the count cells stay plain text. */
	onShowModels?: ((label: string) => void) | undefined;
	/** The escape hatch's grace period; a prop only so tests need not wait out the real value. */
	adoptEscapeAfterMs?: number;
}) {
	// The form target survives state pushes (editing continues across a
	// background refresh); a fresh key forces a clean draft per open.
	const [form, setForm] = useState<{ target: FormTarget; key: number } | undefined>(undefined);
	// The slide-over's close policy: a dirty form asks before discarding, a
	// busy one (adopt in flight) ignores close requests until its ack lands.
	const [formDirty, setFormDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [formBusy, setFormBusy] = useState(false);
	// A close attempt while the adopt is in flight gets a visible answer (the
	// slide-over's notice bar), not silence.
	const [busyNote, setBusyNote] = useState(false);
	// A pending adopt whose ack never arrives must not trap the user until a
	// reload: after the grace period the notice bar surfaces on its own and
	// arms a "Close anyway" action. The intent keeps running extension-side,
	// so its outcome still lands as a toast.
	const [escapeArmed, setEscapeArmed] = useState(false);
	useEffect(() => {
		if (!formBusy) {
			setEscapeArmed(false);
			return;
		}
		const timer = setTimeout(() => setEscapeArmed(true), adoptEscapeAfterMs);
		return () => clearTimeout(timer);
	}, [formBusy, adoptEscapeAfterMs]);
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The one-time post-adoption notice: the old host-owned group survives (no
	// removal API), so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	// The hide round trip: the posted intent's requestId plus the row's label,
	// so the guidance notice below can name the exact group to delete once the
	// ack lands. Copy is composed here; only the ack crosses the boundary.
	const [pendingHide, setPendingHide] = useState<{ requestId: string; label: string } | undefined>(undefined);
	const [removedNotice, setRemovedNotice] = useState<string | undefined>(undefined);
	const pendingHideRequestId = pendingHide?.requestId;
	const pendingHideLabel = pendingHide?.label;
	useEffect(() => {
		if (pendingHideRequestId !== undefined && ack?.requestId === pendingHideRequestId) {
			setRemovedNotice(pendingHideLabel);
			setPendingHide(undefined);
		}
	}, [ack, pendingHideRequestId, pendingHideLabel]);
	const hideExternal = (server: ExternalDashboardServer) => {
		const requestId = newRequestId();
		postMessage({ type: "hideExternalServer", baseUrl: server.baseUrl, sourceHandle: server.adoptHandle, requestId });
		setPendingHide({ requestId, label: server.label });
	};
	const saveFailure = failures.saveServerSetting;
	const removeFailure = failures.removeServerSetting;
	const adoptFailure = failures.adoptServer;
	const hideFailure = failures.hideExternalServer;
	const unhideFailure = failures.unhideServer;
	const noServers = servers.length === 0;

	const openForm = (target: FormTarget) => {
		// A fresh form must never see the previous entry's response (switching
		// straight from one Edit to another), and the old value should not
		// outlive its form in webview memory.
		onClearInlineSecrets();
		setFormDirty(false);
		setConfirmingDiscard(false);
		setFormBusy(false);
		setBusyNote(false);
		setForm((current) => ({ target, key: (current?.key ?? 0) + 1 }));
	};

	const closeForm = () => {
		setForm(undefined);
		setFormDirty(false);
		setConfirmingDiscard(false);
		setFormBusy(false);
		setBusyNote(false);
		onClearInlineSecrets();
		// A test failure renders only inside the form it belongs to; the closed
		// form's notice would otherwise sit invisibly in the failures map.
		onDismissFailure("testServerDraft");
	};

	// Every way out of an open form funnels through here: the form's Cancel,
	// the slide-over's X, the scrim, and Esc. One policy: while an intent is
	// in flight, answer with the visible notice bar; on a dirty form, toggle
	// the discard confirm (so Esc while it shows means "keep editing" - only
	// the explicit Discard button destroys edits); otherwise close, dismissing
	// the form's stale failure notice with it.
	const cancelIntent: DashboardIntentType = form?.target.kind === "adopt" ? "adoptServer" : "saveServerSetting";
	const discardForm = () => {
		onDismissFailure(cancelIntent);
		closeForm();
	};
	const requestCloseForm = () => {
		if (formBusy) {
			setBusyNote(true);
			return;
		}
		if (formDirty) {
			setConfirmingDiscard((current) => !current);
			return;
		}
		discardForm();
	};

	const declaredLabels = servers.filter((server) => server.origin === "declared").map((server) => server.label);

	return (
		<section>
			<h2>
				{l10n.t("Servers")} <Help text={helpServersSection()} below />
				<DocsLink href={DOCS_LINK_SERVERS} label={l10n.t("Open the servers guide")} />
			</h2>
			{/* First run shows the guided card alone; a strip of mostly disabled
			    controls above it would put dead buttons before the guidance. */}
			{!noServers ? (
				<div class="toolbar">
					<button type="button" onClick={() => openForm({ kind: "add" })}>
						<IconAdd /> {l10n.t("Add server")}
					</button>
				</div>
			) : null}
			{form !== undefined ? (
				<SlideOver
					labelledBy="server-form-title"
					fallbackFocusId="tab-overview"
					confirming={confirmingDiscard}
					notice={
						busyNote || escapeArmed ? (
							<>
								{l10n.t("Still adopting; the form closes by itself when it finishes.")}
								{escapeArmed ? (
									<button type="button" class="secondary" onClick={closeForm}>
										{l10n.t("Close anyway - adoption continues in the background")}
									</button>
								) : null}
							</>
						) : undefined
					}
					onRequestClose={requestCloseForm}
					onKeepEditing={() => setConfirmingDiscard(false)}
					onDiscard={discardForm}
				>
					{form.target.kind === "adopt" ? (
						<AdoptForm
							key={form.key}
							server={form.target.server}
							ack={ack}
							failures={failures}
							declaredLabels={declaredLabels}
							onUserEdit={() => setFormDirty(true)}
							onBusyChange={(busy) => {
								setFormBusy(busy);
								if (!busy) {
									setBusyNote(false);
								}
							}}
							onAdopted={(message) => {
								const base = l10n.t(
									"Adopted into the servers setting. Models appear twice until the original group's object is deleted: open the models file, remove it, reload the window."
								);
								setAdoptNotice(message !== undefined ? `${base} ${message}` : base);
							}}
							onClose={closeForm}
							onCancel={requestCloseForm}
						/>
					) : (
						<ServerForm
							key={form.key}
							target={form.target}
							ack={ack}
							failures={failures}
							inlineSecrets={inlineSecrets}
							catalogResults={catalogResults}
							declaredLabels={declaredLabels}
							onUserEdit={() => setFormDirty(true)}
							onClose={closeForm}
							onCancel={requestCloseForm}
						/>
					)}
				</SlideOver>
			) : null}
			{removedNotice !== undefined ? (
				<div class="notice" role="status">
					<p>
						{l10n.t(
							'Hid "{0}" and its models. VS Code still keeps a provider group named "{0}". To delete it for good:',
							removedNotice
						)}
					</p>
					<ol class="notice-steps">
						<li>{l10n.t('Open the models file and remove the "{0}" object from the JSON array.', removedNotice)}</li>
						<li>{l10n.t('Reload the window (Ctrl+Shift+P, "Developer: Reload Window") or restart VS Code.')}</li>
						<li>{l10n.t("Run Sync models.")}</li>
					</ol>
					<div class="toolbar">
						<button
							type="button"
							class="secondary"
							onClick={() => postMessage({ type: "executeCommand", command: "openGroupsFile" })}
						>
							{l10n.t("Open models file")}
						</button>
						<button type="button" class="quiet" onClick={() => setRemovedNotice(undefined)}>
							{l10n.t("Dismiss")}
						</button>
					</div>
				</div>
			) : null}
			{adoptNotice !== undefined ? (
				<div class="notice" role="status">
					<p>{adoptNotice}</p>
					<div class="toolbar">
						<button
							type="button"
							class="secondary"
							onClick={() => postMessage({ type: "executeCommand", command: "openGroupsFile" })}
						>
							{l10n.t("Open models file")}
						</button>
						<button type="button" class="quiet" onClick={() => setAdoptNotice(undefined)}>
							{l10n.t("Dismiss")}
						</button>
					</div>
				</div>
			) : null}
			{adoptFailure !== undefined ? (
				<div class="banner banner-error" role="alert">
					<p>
						{adoptFailure.kind === "operation"
							? adoptFailure.message
							: sectionFailureText(l10n.t("Adopting the server failed:"), adoptFailure.message)}
					</p>
					<button type="button" class="quiet" onClick={() => onDismissFailure("adoptServer")}>
						{l10n.t("Dismiss")}
					</button>
				</div>
			) : null}
			{saveFailure !== undefined ? (
				<div class="banner banner-error" role="alert">
					<p>
						{saveFailure.kind === "operation"
							? saveFailure.message
							: sectionFailureText(l10n.t("Saving the server failed:"), saveFailure.message)}
					</p>
					<button type="button" class="quiet" onClick={() => onDismissFailure("saveServerSetting")}>
						{l10n.t("Dismiss")}
					</button>
				</div>
			) : null}
			{removeFailure !== undefined ? (
				<div class="banner banner-error" role="alert">
					<p>{sectionFailureText(l10n.t("Removing failed:"), removeFailure.message)}</p>
					<button type="button" class="quiet" onClick={() => onDismissFailure("removeServerSetting")}>
						{l10n.t("Dismiss")}
					</button>
				</div>
			) : null}
			{hideFailure !== undefined ? (
				<div class="banner banner-error" role="alert">
					<p>{sectionFailureText(l10n.t("Hiding the group failed:"), hideFailure.message)}</p>
					<button type="button" class="quiet" onClick={() => onDismissFailure("hideExternalServer")}>
						{l10n.t("Dismiss")}
					</button>
				</div>
			) : null}
			{unhideFailure !== undefined ? (
				<div class="banner banner-error" role="alert">
					<p>{sectionFailureText(l10n.t("Unhiding the group failed:"), unhideFailure.message)}</p>
					<button type="button" class="quiet" onClick={() => onDismissFailure("unhideServer")}>
						{l10n.t("Dismiss")}
					</button>
				</div>
			) : null}
			{noServers ? (
				<div class="empty-start">
					<h3>{l10n.t("Connect LiteLLM to Copilot Chat")}</h3>
					<p class="hint">
						{l10n.t("Point the extension at your LiteLLM server and its models appear in Copilot Chat's model picker.")}
					</p>
					<ol>
						<li>{l10n.t("Enter the server's URL - for a local proxy that is usually http://localhost:4000.")}</li>
						<li>{l10n.t("Paste its API key if it needs one; it can stay in VS Code's encrypted secret storage.")}</li>
						<li>{l10n.t("Save. Models sync automatically and show up on this page.")}</li>
					</ol>
					<button type="button" onClick={() => openForm({ kind: "add" })}>
						{l10n.t("Add your first server")}
					</button>
				</div>
			) : (
				<div class="table-scroll">
					{/* class="servers": the narrow-viewport stylesheet stacks these rows
					    into cards so the row actions stay reachable. */}
					<table class="servers">
						<thead>
							<tr>
								<th>{l10n.t("Server")}</th>
								<th>{l10n.t("Base URL")}</th>
								<th>{l10n.t("Status")}</th>
								<th class="num">{l10n.t("Models")}</th>
								<th>{/* badges */}</th>
								<th>{/* actions */}</th>
							</tr>
						</thead>
						<tbody>
							{servers.map((server, index) => (
								// Rows rebuild wholesale on every state push; the positional
								// index is the identity (server IDs stay extension-side, they
								// embed a credential fingerprint).
								<ServerRow
									key={index}
									server={server}
									now={now}
									armed={armedRemove === server.label}
									onEdit={() =>
										// The one place the form's purpose is decided: a declared
										// row edits, an external row adopts.
										openForm(
											server.origin === "declared" ? { kind: "edit", original: server } : { kind: "adopt", server }
										)
									}
									onArmRemove={(armed) => setArmedRemove(armed ? server.label : undefined)}
									onHideExternal={hideExternal}
									onShowModels={onShowModels}
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
			<HiddenGroupsLine hidden={hidden} />
			{servers.some((server) => server.error !== undefined && server.expected !== true) ? (
				<div class="banner banner-error">
					<p class="error">
						{servers
							.filter((server) => server.error !== undefined && server.expected !== true)
							.map((server, index) => (
								// Keyed identity (origin plus the external row's opaque handle
								// or the declared row's setting-unique label) so reconciliation
								// keeps focus on a Troubleshoot link when an earlier entry
								// recovers. A classified failure carries the same short
								// Troubleshoot link as the draft-test footer, inline after its
								// own entry; an unclassified entry renders exactly the text it
								// always did.
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 ? "; " : ""}
									{`${server.label}: ${server.error}`}
									{server.classification?.setupHint !== undefined ? (
										// The leading space keeps copied text (the banner is the
										// selectable error surface) from gluing the link label
										// onto the error message.
										<>
											{" "}
											<span class="banner-hint">
												<DocsLink {...troubleshootingLink(server.classification.setupHint)}>
													{l10n.t("Troubleshoot")}
												</DocsLink>
											</span>
										</>
									) : null}
								</Fragment>
							))}
					</p>
				</div>
			) : null}
			{servers.some((server) => server.error !== undefined && server.expected === true) ? (
				<div class="banner banner-warn">
					<p class="state-warn">
						{servers
							.filter((server) => server.error !== undefined && server.expected === true)
							.map((server, index) => (
								<Fragment key={`${server.origin}:${server.adoptHandle ?? server.label}`}>
									{index > 0 ? "; " : ""}
									{/* Warn tone, never the red banner: the entry declared this
									    category, so the failure is stated with its localized
									    annotation instead of raised as a problem. */}
									{l10n.t("{0}: {1} (expected)", server.label, server.error ?? "")}
								</Fragment>
							))}
					</p>
				</div>
			) : null}
			{servers.some((server) => server.notices?.includes("entry-params-inactive") === true) ? (
				<div class="banner banner-warn">
					<p class="state-warn">
						{l10n.t(
							"{0}: per-server model parameters are not applied (the group serving the entry predates its label or a rename). To activate them:",
							servers
								.filter((server) => server.notices?.includes("entry-params-inactive") === true)
								.map((server) => server.label)
								.join(", ")
						)}{" "}
						<DocsLink href={DOCS_LINK_PARAMS_INACTIVE} label={l10n.t("Learn more in the troubleshooting guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
					<ol class="notice-steps">
						<li>{l10n.t("Delete the group's object from the models file (chatLanguageModels.json).")}</li>
						<li>
							{l10n.t("Reload the window, then run Sync Models Now - or save the entry under a new label instead.")}
						</li>
					</ol>
				</div>
			) : null}
			{servers.some((server) => server.notices?.includes("entry-capabilities-inactive") === true) ? (
				<div class="banner banner-warn">
					<p class="state-warn">
						{l10n.t(
							"{0}: per-server model capabilities and expected failures are not applied (the group serving the entry predates its label or a rename). To activate them:",
							servers
								.filter((server) => server.notices?.includes("entry-capabilities-inactive") === true)
								.map((server) => server.label)
								.join(", ")
						)}{" "}
						<DocsLink href={DOCS_LINK_PARAMS_INACTIVE} label={l10n.t("Learn more in the troubleshooting guide")}>
							{l10n.t("Learn more")}
						</DocsLink>
					</p>
					<ol class="notice-steps">
						<li>{l10n.t("Delete the group's object from the models file (chatLanguageModels.json).")}</li>
						<li>
							{l10n.t("Reload the window, then run Sync Models Now - or save the entry under a new label instead.")}
						</li>
					</ol>
				</div>
			) : null}
			{servers.some((server) => server.notices?.includes("expected-failures-nothing-declared") === true) ? (
				<div class="banner banner-warn">
					<p class="state-warn">
						{l10n.t(
							"{0}: discovery fails in an expected category and nothing is declared, so no models are served. Add IDs to the entry's discovery.declared list to serve models without discovery.",
							servers
								.filter((server) => server.notices?.includes("expected-failures-nothing-declared") === true)
								.map((server) => server.label)
								.join(", ")
						)}
					</p>
				</div>
			) : null}
		</section>
	);
}
