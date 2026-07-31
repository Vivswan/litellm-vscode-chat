import { useEffect, useState } from "preact/hooks";
import type {
	DashboardIntentType,
	DashboardServer,
	SecretFieldId,
	SecretLocation,
} from "../../extension/dashboard/protocol";
import { SECRET_FIELD_IDS } from "../../extension/dashboard/protocol";
import type { GroupProblems } from "../../extension/dashboard/recordDraft";
import { toGroups } from "../../extension/dashboard/recordDraft";
import type {
	SecretFieldDraft,
	ServerFormDraft,
	ServerFormField,
	ServerFormProblems,
} from "../../extension/dashboard/serverForm";
import {
	applyInlinePrefill,
	EMPTY_SERVER_FORM,
	OAUTH_SECTION_FIELDS,
	parseServerForm,
	SERVER_FORM_FIELD_LABELS,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	validateAdoptLabel,
} from "../../extension/dashboard/serverForm";
import type { FailuresByIntent, InlineSecretsResponse, IntentAck } from "./app";
import { Help, HoverTip } from "./help";
import {
	HELP_ENTRY_MODEL_PARAMETER_PREFIX,
	HELP_SECRET_STORAGE,
	HELP_SERVERS_SECTION,
	SERVER_FIELD_HELP,
} from "./helpText";
import { ParamGroupsFields } from "./recordEditors";
import { SlideOver } from "./slideOver";
import { relativeTime, useNow } from "./time";
import { postMessage } from "./vscodeApi";

/** A correlation ID for one posted intent; matched against intentSucceeded/intentFailed notices. */
function newRequestId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The row's status pill: tone dot, plain-language verdict, and how long ago
 * discovery last looked. An "ok" row that still carries an error (a live
 * group kept serving while its sync failed) shows the warn tone; the error
 * text itself renders in the section's banner, where it is selectable.
 */
function StatusPill({ server, now }: { server: DashboardServer; now: number }) {
	const checked = server.lastChecked === undefined ? undefined : relativeTime(server.lastChecked, now);
	const time = checked === undefined ? null : <span class="pill-time">{checked}</span>;
	if (server.state === "ok") {
		if (server.error !== undefined) {
			return (
				<HoverTip tip="The server answered, but its last settings sync reported a problem; details below.">
					<span class="pill tone-warn">
						<span class="dot" />
						Sync issue
						{time}
					</span>
				</HoverTip>
			);
		}
		return (
			<span class="pill tone-ok">
				<span class="dot" />
				Connected
				{time}
			</span>
		);
	}
	if (server.state === "error") {
		return (
			<span class="pill tone-error">
				<span class="dot" />
				Error
				{time}
			</span>
		);
	}
	return (
		<HoverTip tip="Declared in settings; no discovery pass has seen it yet. Run Sync models to check it now.">
			<span class="pill tone-muted">
				<span class="dot" />
				Not checked
			</span>
		</HoverTip>
	);
}

/** The two DashboardServer origins as their own types; Extract keeps them in step with the protocol union. */
type DeclaredDashboardServer = Extract<DashboardServer, { origin: "declared" }>;
type ExternalDashboardServer = Extract<DashboardServer, { origin: "external" }>;

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

function secretDraft(existing: SecretLocation): SecretFieldDraft {
	return { value: "", location: existing === "settings" ? "settings" : "secure", clear: false, existing };
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
	};
}

const LOCATION_NAMES: Record<Exclude<SecretLocation, "none">, string> = {
	secure: "secret storage",
	settings: "settings",
};

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
	field: Exclude<ServerFormField, SecretFieldId | "modelParameters">;
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
				<label for={id}>{SERVER_FORM_FIELD_LABELS[field]}</label>
				<Help text={SERVER_FIELD_HELP[field]} />
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
				<label for={id}>{SERVER_FORM_FIELD_LABELS[field]}</label>
				<Help text={SERVER_FIELD_HELP[field]} />
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
					aria-label={`${revealed ? "Hide" : "Show"} the ${SERVER_FORM_FIELD_LABELS[field]}`}
					disabled={props.disabled || value.clear || empty}
					onClick={() => setRevealed((current) => !current)}
				>
					{revealed ? "Hide" : "Show"}
				</button>
			</span>
			<span class="secret-where" role="radiogroup" aria-label={`Where to store the ${SERVER_FORM_FIELD_LABELS[field]}`}>
				<span class="where-label">Store in:</span>
				<Help text={HELP_SECRET_STORAGE} />
				<label>
					<input
						type="radio"
						name={`${id}-where`}
						checked={value.location === "secure"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "secure" })}
					/>
					secret storage
				</label>
				<label>
					<input
						type="radio"
						name={`${id}-where`}
						checked={value.location === "settings"}
						disabled={props.disabled || value.clear}
						onChange={() => patchSecret({ location: "settings" })}
					/>
					settings (visible)
				</label>
				{value.existing !== "none" ? (
					<label>
						<input
							type="checkbox"
							checked={value.clear}
							disabled={props.disabled}
							onChange={(event) => patchSecret({ clear: event.currentTarget.checked })}
						/>
						remove
					</label>
				) : null}
			</span>
			{value.prefill !== undefined && !value.clear ? (
				value.value.trim().length === 0 ? (
					<span class="hint">Emptied, but the stored value is kept; use remove to delete it.</span>
				) : (
					<span class="hint">
						Inline in the servers setting, so settings.json already shows it; saving it unedited keeps it.
					</span>
				)
			) : value.existing !== "none" && !value.clear ? (
				<span class="hint">Currently in {LOCATION_NAMES[value.existing]}; leave the field empty to keep it.</span>
			) : null}
			{value.clear ? <span class="hint">The stored value will be removed on save.</span> : null}
			{showProblem ? (
				<span id={errorId} class="error">
					{problem}
				</span>
			) : null}
		</div>
	);
}

/**
 * Whether a field "holds content" for problem visibility. Model-parameter
 * problems only exist on rows the user (or the prefill) put there, so any
 * rows count as content; text and secret fields count their text.
 */
function fieldHasContent(draft: ServerFormDraft, field: ServerFormField): boolean {
	if (field === "modelParameters") {
		return draft.modelParameters.length > 0;
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
	declaredLabels,
	onUserEdit,
	onClose,
	onCancel,
}: {
	target: ServerFormTarget;
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	inlineSecrets: InlineSecretsResponse | undefined;
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
	const [oauthOpen, setOauthOpen] = useState(false);
	// The per-entry parameters disclosure opens by itself only for an entry
	// that already carries some; adding rows to a bare entry is opt-in.
	const [paramsOpen, setParamsOpen] = useState(
		() => target.kind === "edit" && Object.keys(target.original.config.modelParameters ?? {}).length > 0
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
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find((field) => visibleProblems[field] !== undefined);
	const oauthProblemVisible = OAUTH_SECTION_FIELDS.some((field) => visibleProblems[field] !== undefined);
	const paramsProblemVisible = visibleProblems.modelParameters !== undefined;
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
			return;
		}
		const requestId = newRequestId();
		postMessage({ type: "saveServerSetting", ...parse.intent, requestId });
		setPhase({ phase: "saving", requestId });
	};

	const props: FieldRenderProps = {
		draft,
		visibleProblems,
		disabled: saving,
		patch: (patch) => {
			onUserEdit();
			setDraft((current) => ({ ...current, ...patch }));
		},
		touch: (field) => setTouched((current) => new Set(current).add(field)),
	};

	return (
		<div class="form-card">
			<h3 id="server-form-title">{target.kind === "add" ? "Add server" : `Edit ${target.original.label}`}</h3>
			<TextField field="label" placeholder="e.g. Production" props={props} />
			{renaming && (parse.ok || parse.problems.label === undefined) ? (
				<p class="hint">
					The label is this server's identity: saving under a new one creates a new provider group, and the old group
					stays until removed in the native editor.
				</p>
			) : null}
			{target.kind === "edit" && !renaming ? (
				<p class="hint">
					Connection changes (URL, credentials) cannot reach the existing VS Code group: VS Code has no group-update
					API. After saving, remove the old group in the native editor and run Sync Models Now.
				</p>
			) : null}
			{collides ? <p class="hint">An entry with this label already exists; saving replaces it.</p> : null}
			<TextField field="baseUrl" placeholder="e.g. http://localhost:4000" props={props} />
			<SecretField field="apiKey" props={props} />
			<details open={oauthOpen} onToggle={(event) => setOauthOpen(event.currentTarget.open)}>
				<summary>OAuth and virtual key (optional)</summary>
				<TextField field="oauthTokenUrl" placeholder="e.g. https://idp.example.com/oauth2/token" props={props} />
				<TextField field="oauthClientId" placeholder="e.g. litellm-vscode" props={props} />
				<SecretField field="oauthClientSecret" props={props} />
				<TextField field="oauthScopes" placeholder="e.g. litellm.read litellm.write" props={props} />
				<TextField field="virtualKeyHeader" placeholder="e.g. x-litellm-api-key" props={props} />
				<SecretField field="virtualKeyValue" props={props} />
			</details>
			<details open={paramsOpen} onToggle={(event) => setParamsOpen(event.currentTarget.open)}>
				<summary>
					Model parameters for this server (optional) <Help text={SERVER_FIELD_HELP.modelParameters} />
				</summary>
				<p class="hint">
					Sent only with requests routed through this entry; overrides the global Model parameters setting for the same
					keys. Matching is by model ID prefix, longest prefix wins.
				</p>
				<ParamGroupsFields
					groups={draft.modelParameters}
					problems={modelParameterProblems}
					disabled={saving}
					prefixPlaceholder="Model prefix, e.g. gpt-4"
					prefixHelp={HELP_ENTRY_MODEL_PARAMETER_PREFIX}
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
					Add model prefix
				</button>
			</details>
			<p class="hint">
				Saved to the litellm-vscode-chat.servers user setting and synced to VS Code automatically. Secrets left empty or
				unedited keep their current value.
			</p>
			<div class="toolbar">
				<button type="button" disabled={phase.phase !== "editing"} onClick={save}>
					{saving ? "Saving..." : "Save"}
				</button>
				<button type="button" class="secondary" onClick={onCancel}>
					Cancel
				</button>
				{phase.phase === "prefill" ? <span class="hint">Loading stored values...</span> : null}
				{firstBlocking !== undefined ? (
					<span class="error" role="alert">
						Cannot save: fix {SERVER_FORM_FIELD_LABELS[firstBlocking]}
					</span>
				) : null}
			</div>
		</div>
	);
}

const ADOPT_SECRET_LABELS: Record<SecretFieldId, string> = {
	apiKey: SERVER_FORM_FIELD_LABELS.apiKey,
	oauthClientSecret: SERVER_FORM_FIELD_LABELS.oauthClientSecret,
	virtualKeyValue: SERVER_FORM_FIELD_LABELS.virtualKeyValue,
};

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
		...(server.hasApiKey ? [{ field: "apiKey" as const, hint: "Copied only if the group has an API key." }] : []),
		{ field: "oauthClientSecret" as const, hint: "Copied only if the group is configured for OAuth." },
		{ field: "virtualKeyValue" as const, hint: "Copied only if the group sends a virtual key header." },
	];

	return (
		<div class="form-card">
			<h3 id="server-form-title">Adopt {server.label}</h3>
			<p class="hint">
				Adopting writes this VS Code-managed group into the litellm-vscode-chat.servers setting, so it becomes editable
				here. Its credentials are copied inside the extension and never pass through this page.
			</p>
			<div class="field">
				<label for="adopt-label">Label</label>
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
					Names the new entry and its provider group; usually worth renaming, since a name an existing VS Code group
					already uses cannot be synced.
				</span>
				{showProblem ? (
					<span id="adopt-label-error" class="error">
						{problem}
					</span>
				) : null}
			</div>
			<div class="field">
				<span class="field-label">Base URL</span>
				<span class="readonly-value">{server.baseUrl}</span>
				<span class="hint">Fixed to the group being adopted; edit the server afterwards to change it.</span>
			</div>
			{secretRows.map(({ field, hint }) => (
				<div class="field" key={field}>
					<span>{ADOPT_SECRET_LABELS[field]}</span>
					<span class="hint">{hint}</span>
					<span class="secret-where" role="radiogroup" aria-label={`Where to store the ${ADOPT_SECRET_LABELS[field]}`}>
						<span class="where-label">Store in:</span>
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
							secret storage
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
							settings (visible)
						</label>
					</span>
				</div>
			))}
			<p class="hint">
				The original group is not removed (VS Code offers no way to); its models appear twice until you delete it in the
				native editor.
			</p>
			<div class="toolbar">
				<button type="button" disabled={saving} onClick={adopt}>
					{saving ? "Adopting..." : "Adopt"}
				</button>
				{/* Disabled while the intent is in flight: cancelling would unmount
				    this form before the ack and lose the post-adoption notice (the
				    duplicate-group reminder and any missing-credentials caveat). */}
				<button type="button" class="secondary" disabled={saving} onClick={onCancel}>
					Cancel
				</button>
				{showProblem ? (
					<span class="error" role="alert">
						Cannot adopt: fix Label
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
}: {
	server: DashboardServer;
	now: number;
	armed: boolean;
	onEdit: () => void;
	onArmRemove: (armed: boolean) => void;
}) {
	const confirmRemove = () => {
		postMessage({ type: "removeServerSetting", label: server.label, requestId: newRequestId() });
		onArmRemove(false);
	};
	return (
		<tr>
			<td>{server.label}</td>
			<td class="url">{server.baseUrl}</td>
			<td data-label="Status">
				<StatusPill server={server} now={now} />
			</td>
			<td class="num" data-label="Models">
				{server.modelCount}
			</td>
			<td>
				{server.hasApiKey || server.hasOAuth ? (
					<HoverTip tip={server.hasOAuth ? "OAuth configured" : "API key configured"}>
						<span class="badge">auth</span>
					</HoverTip>
				) : null}
				{server.origin === "external" ? (
					<HoverTip tip="No entry in the servers setting; managed in the native editor">
						<span class="badge">external</span>
					</HoverTip>
				) : null}
				{server.notice === "entry-params-inactive" ? (
					<HoverTip tip="This entry's per-server model parameters are not applied: the provider group serving it does not carry this entry's labeled identity (it predates entry labels or a rename). Remove the group in the native Manage Language Models editor and run Sync Models Now, or save the entry under a new label, to activate them.">
						<span class="badge state-warn">params inactive</span>
					</HoverTip>
				) : null}
			</td>
			<td class={armed ? "actions armed" : "actions"}>
				{server.origin === "declared" ? (
					armed ? (
						<>
							<button type="button" class="quiet state-error" onClick={confirmRemove}>
								Confirm remove?
							</button>
							<button type="button" class="quiet" onClick={() => onArmRemove(false)}>
								Cancel
							</button>
						</>
					) : (
						<>
							<button type="button" class="quiet" onClick={onEdit}>
								Edit
							</button>
							<button type="button" class="quiet" onClick={() => onArmRemove(true)}>
								Remove
							</button>
						</>
					)
				) : (
					<button type="button" class="quiet" onClick={onEdit}>
						Edit
					</button>
				)}
			</td>
		</tr>
	);
}

export function ServersSection({
	servers,
	ack,
	failures,
	inlineSecrets,
	onDismissFailure,
	onClearInlineSecrets,
}: {
	servers: readonly DashboardServer[];
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	inlineSecrets: InlineSecretsResponse | undefined;
	/** Drop the latest failure notice for one intent type (Cancel dismisses a stale save failure). */
	onDismissFailure: (intentType: DashboardIntentType) => void;
	/** Drop the held inlineSecrets response; called when the edit form closes so the value leaves webview memory. */
	onClearInlineSecrets: () => void;
}) {
	// The form target survives state pushes (editing continues across a
	// background refresh); a fresh key forces a clean draft per open.
	const [form, setForm] = useState<{ target: FormTarget; key: number } | undefined>(undefined);
	// The slide-over's close policy: a dirty form asks before discarding, a
	// busy one (adopt in flight) ignores close requests until its ack lands.
	const [formDirty, setFormDirty] = useState(false);
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const [formBusy, setFormBusy] = useState(false);
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	// The one-time post-adoption notice: the old host-owned group survives (no
	// removal API), so the user is told plainly why models now appear twice.
	const [adoptNotice, setAdoptNotice] = useState<string | undefined>(undefined);
	const saveFailure = failures.saveServerSetting;
	const removeFailure = failures.removeServerSetting;
	const adoptFailure = failures.adoptServer;
	const noServers = servers.length === 0;

	const openForm = (target: FormTarget) => {
		// A fresh form must never see the previous entry's response (switching
		// straight from one Edit to another), and the old value should not
		// outlive its form in webview memory.
		onClearInlineSecrets();
		setFormDirty(false);
		setConfirmingDiscard(false);
		setFormBusy(false);
		setForm((current) => ({ target, key: (current?.key ?? 0) + 1 }));
	};

	const closeForm = () => {
		setForm(undefined);
		setFormDirty(false);
		setConfirmingDiscard(false);
		setFormBusy(false);
		onClearInlineSecrets();
	};

	// Every way out of an open form funnels through here: the form's Cancel,
	// the slide-over's X, the scrim, and Esc. One policy: ignore while an
	// intent is in flight, confirm before discarding edits, otherwise close
	// (dismissing the form's stale failure notice with it).
	const cancelIntent: DashboardIntentType = form?.target.kind === "adopt" ? "adoptServer" : "saveServerSetting";
	const discardForm = () => {
		onDismissFailure(cancelIntent);
		closeForm();
	};
	const requestCloseForm = () => {
		if (formBusy) {
			return;
		}
		if (formDirty && !confirmingDiscard) {
			setConfirmingDiscard(true);
			return;
		}
		discardForm();
	};

	const declaredLabels = servers.filter((server) => server.origin === "declared").map((server) => server.label);
	const now = useNow();

	return (
		<section>
			<h2>
				Servers <span class="count">{servers.length}</span> <Help text={HELP_SERVERS_SECTION} below />
			</h2>
			<div class="toolbar">
				<button type="button" onClick={() => openForm({ kind: "add" })}>
					Add server
				</button>
				<button
					type="button"
					class="secondary"
					disabled={noServers}
					onClick={() => postMessage({ type: "executeCommand", command: "testConnection" })}
				>
					Test connection
				</button>
				<button
					type="button"
					class="secondary"
					disabled={noServers}
					onClick={() => postMessage({ type: "executeCommand", command: "showDiagnostics" })}
				>
					Show diagnostics
				</button>
				<button
					type="button"
					class="quiet"
					title="VS Code's Manage Language Models editor; group removal lives there"
					onClick={() => postMessage({ type: "executeCommand", command: "manageServers" })}
				>
					Open native editor
				</button>
			</div>
			{form !== undefined ? (
				<SlideOver
					labelledBy="server-form-title"
					confirming={confirmingDiscard}
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
							onBusyChange={setFormBusy}
							onAdopted={(message) => {
								setAdoptNotice(
									`Adopted into the servers setting. The original VS Code-managed group still exists, so its models appear twice until you remove that group in the native editor.${message !== undefined ? ` ${message}` : ""}`
								);
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
							declaredLabels={declaredLabels}
							onUserEdit={() => setFormDirty(true)}
							onClose={closeForm}
							onCancel={requestCloseForm}
						/>
					)}
				</SlideOver>
			) : null}
			{adoptNotice !== undefined ? (
				<div class="notice" role="status">
					<p>{adoptNotice}</p>
					<div class="toolbar">
						<button
							type="button"
							class="secondary"
							onClick={() => postMessage({ type: "executeCommand", command: "manageServers" })}
						>
							Open native editor
						</button>
						<button type="button" class="quiet" onClick={() => setAdoptNotice(undefined)}>
							Dismiss
						</button>
					</div>
				</div>
			) : null}
			{adoptFailure !== undefined ? (
				<p class="error">
					{adoptFailure.kind === "operation"
						? adoptFailure.message
						: sectionFailureText("Adopting the server failed:", adoptFailure.message)}{" "}
					<button type="button" class="quiet" onClick={() => onDismissFailure("adoptServer")}>
						Dismiss
					</button>
				</p>
			) : null}
			{saveFailure !== undefined ? (
				<p class="error">
					{saveFailure.kind === "operation"
						? saveFailure.message
						: sectionFailureText("Saving the server failed:", saveFailure.message)}{" "}
					<button type="button" class="quiet" onClick={() => onDismissFailure("saveServerSetting")}>
						Dismiss
					</button>
				</p>
			) : null}
			{removeFailure !== undefined ? (
				<p class="error">
					{sectionFailureText("Removing failed:", removeFailure.message)}{" "}
					<button type="button" class="quiet" onClick={() => onDismissFailure("removeServerSetting")}>
						Dismiss
					</button>
				</p>
			) : null}
			{noServers ? (
				<div class="empty-block">
					<p>No servers yet.</p>
					<p class="hint">
						Add server opens an inline form; the entry lands in the litellm-vscode-chat.servers user setting and syncs
						to VS Code automatically. API keys can stay in VS Code secret storage instead of the settings file. Models
						appear below after the first sync.
					</p>
				</div>
			) : (
				<div class="table-scroll">
					{/* class="servers": the narrow-viewport stylesheet stacks these rows
					    into cards so the row actions stay reachable. */}
					<table class="servers">
						<thead>
							<tr>
								<th>Server</th>
								<th>Base URL</th>
								<th>Status</th>
								<th class="num">Models</th>
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
								/>
							))}
						</tbody>
					</table>
				</div>
			)}
			{servers.some((server) => server.error !== undefined) ? (
				<p class="error">
					{servers
						.filter((server) => server.error !== undefined)
						.map((server) => `${server.label}: ${server.error}`)
						.join("; ")}
				</p>
			) : null}
			{servers.some((server) => server.notice === "entry-params-inactive") ? (
				<p class="state-warn">
					{servers
						.filter((server) => server.notice === "entry-params-inactive")
						.map((server) => server.label)
						.join(", ")}
					: per-server model parameters are not applied because the provider group does not carry the entry's labeled
					identity (it predates entry labels or a rename). Remove the group in the native Manage Language Models editor
					and run Sync Models Now, or save the entry under a new label, to activate them.
				</p>
			) : null}
		</section>
	);
}
