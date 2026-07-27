import { useEffect, useState } from "preact/hooks";
import type { DashboardServer, SecretFieldId, SecretLocation } from "../../extension/dashboard/protocol";
import type { SecretFieldDraft, ServerFormDraft, ServerFormField } from "../../extension/dashboard/serverForm";
import {
	assembleServerForm,
	EMPTY_SERVER_FORM,
	hasServerFormProblems,
	OAUTH_SECTION_FIELDS,
	SERVER_FORM_FIELD_LABELS,
	SERVER_FORM_FIELD_ORDER,
	saveFailureDisposition,
	sectionFailureText,
	validateServerForm,
} from "../../extension/dashboard/serverForm";
import type { FailuresByIntent, IntentAck } from "./app";
import { postMessage } from "./vscodeApi";

function formatTimestamp(iso: string | undefined): string {
	if (iso === undefined) {
		return "-";
	}
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** A correlation ID for one posted intent; matched against intentSucceeded/intentFailed notices. */
function newRequestId(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === "function") {
		return cryptoApi.randomUUID();
	}
	return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function StateCell({ server }: { server: DashboardServer }) {
	if (server.state === "ok") {
		return <span class="state-ok">reachable</span>;
	}
	if (server.state === "error") {
		return (
			<span class="state-error" title={server.error ?? ""}>
				error
			</span>
		);
	}
	return (
		<span class="state-muted" title="Declared in settings; no discovery pass has seen it yet">
			not checked
		</span>
	);
}

interface FormTarget {
	/** Editing an existing declared entry; undefined means adding a new one. */
	readonly original?: DashboardServer | undefined;
}

function secretDraft(existing: SecretLocation): SecretFieldDraft {
	return { value: "", location: existing === "settings" ? "settings" : "secure", clear: false, existing };
}

function draftFor(target: FormTarget): ServerFormDraft {
	const original = target.original;
	if (original?.config === undefined) {
		return EMPTY_SERVER_FORM;
	}
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
	};
}

const LOCATION_NAMES: Record<Exclude<SecretLocation, "none">, string> = {
	secure: "secret storage",
	settings: "settings",
};

interface FieldRenderProps {
	readonly draft: ServerFormDraft;
	readonly problems: Partial<Record<ServerFormField, string>>;
	readonly touched: ReadonlySet<ServerFormField>;
	readonly disabled: boolean;
	readonly patch: (patch: Partial<ServerFormDraft>) => void;
	readonly touch: (field: ServerFormField) => void;
}

function TextField({
	field,
	placeholder,
	props,
}: {
	field: Exclude<ServerFormField, SecretFieldId>;
	placeholder?: string;
	props: FieldRenderProps;
}) {
	const problem = props.problems[field];
	const showProblem = problem !== undefined && (props.touched.has(field) || props.draft[field].length > 0);
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	return (
		<div class="field">
			<label for={id}>{SERVER_FORM_FIELD_LABELS[field]}</label>
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
 * choice. Existing values are never shown (they never reach the webview);
 * leaving the input empty keeps the stored value where it is.
 */
function SecretField({ field, props }: { field: SecretFieldId; props: FieldRenderProps }) {
	const value = props.draft[field];
	const problem = props.problems[field];
	const showProblem = problem !== undefined && (props.touched.has(field) || value.value.length > 0);
	const id = `server-${field}`;
	const errorId = `${id}-error`;
	const patchSecret = (patch: Partial<SecretFieldDraft>) =>
		props.patch({ [field]: { ...value, ...patch } } as Partial<ServerFormDraft>);
	return (
		<div class="field">
			<label for={id}>{SERVER_FORM_FIELD_LABELS[field]}</label>
			<input
				id={id}
				type="password"
				class={showProblem ? "invalid" : ""}
				value={value.value}
				disabled={props.disabled || value.clear}
				aria-invalid={showProblem}
				aria-describedby={showProblem ? errorId : undefined}
				onInput={(event) => patchSecret({ value: event.currentTarget.value })}
				onBlur={() => props.touch(field)}
			/>
			<span class="secret-where" role="radiogroup" aria-label={`Where to store the ${SERVER_FORM_FIELD_LABELS[field]}`}>
				<span class="where-label">Store in:</span>
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
			{value.existing !== "none" && !value.clear ? (
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
	declaredLabels,
	onClose,
	onCancel,
}: {
	target: FormTarget;
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	declaredLabels: readonly string[];
	onClose: () => void;
	/** The Cancel button's close: also clears the section-level failure notice. */
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState<ServerFormDraft>(() => draftFor(target));
	const [touched, setTouched] = useState<ReadonlySet<ServerFormField>>(new Set());
	const [pending, setPending] = useState<string | undefined>(undefined);
	const [oauthOpen, setOauthOpen] = useState(false);
	const saving = pending !== undefined;
	const failure = failures.saveServerSetting;
	const failureSeq = failure?.seq;
	const failureRequestId = failure?.requestId;
	const failureKind = failure?.kind;

	useEffect(() => {
		if (pending !== undefined && ack?.requestId === pending) {
			onClose();
		}
	}, [ack, pending, onClose]);

	// This form's own failure: a validation-kind one re-opens it for editing
	// (the draft is still the truth); an operation-kind one means the save
	// committed and the draft is stale, so the form closes like a success. The
	// message renders at the section level either way, so it also survives the
	// closed form.
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

	const originalLabel = target.original?.label;
	const problems = validateServerForm(draft, {
		takenLabels: declaredLabels,
		...(originalLabel !== undefined ? { originalLabel } : {}),
	});
	const invalid = hasServerFormProblems(problems);
	const label = draft.label.trim();
	const renaming = target.original !== undefined && label !== target.original.label;
	const collides = target.original === undefined && declaredLabels.includes(label);

	// A problem is visible once its field was touched or holds content; the
	// same rule the field components render by, shared here so the OAuth
	// disclosure and the save summary agree with what the fields show.
	const problemVisible = (field: ServerFormField): boolean => {
		if (problems[field] === undefined) {
			return false;
		}
		const value = draft[field];
		const hasContent = typeof value === "string" ? value.length > 0 : value.value.length > 0;
		return touched.has(field) || hasContent;
	};
	const firstBlocking = SERVER_FORM_FIELD_ORDER.find(problemVisible);
	const oauthProblemVisible = OAUTH_SECTION_FIELDS.some(problemVisible);
	// A problem surfacing inside a collapsed disclosure opens it once
	// (otherwise Save would refuse over an error the user cannot see); beyond
	// that the element is the user's: closing it again sticks, and it does not
	// snap shut when the problems clear.
	useEffect(() => {
		if (oauthProblemVisible) {
			setOauthOpen(true);
		}
	}, [oauthProblemVisible]);

	const save = () => {
		if (invalid) {
			// Surface every problem instead of refusing silently, opening the
			// disclosure when one hides inside it.
			setTouched(new Set(SERVER_FORM_FIELD_ORDER));
			if (OAUTH_SECTION_FIELDS.some((field) => problems[field] !== undefined)) {
				setOauthOpen(true);
			}
			return;
		}
		const requestId = newRequestId();
		postMessage({
			type: "saveServerSetting",
			...assembleServerForm(draft, originalLabel),
			requestId,
		});
		setPending(requestId);
	};

	const props: FieldRenderProps = {
		draft,
		problems,
		touched,
		disabled: saving,
		patch: (patch) => setDraft((current) => ({ ...current, ...patch })),
		touch: (field) => setTouched((current) => new Set(current).add(field)),
	};

	return (
		<div class="form-card">
			<h3>{target.original === undefined ? "Add server" : `Edit ${target.original.label}`}</h3>
			<TextField field="label" placeholder="e.g. Production" props={props} />
			{renaming && problems.label === undefined ? (
				<p class="hint">
					The label is this server's identity: saving under a new one creates a new provider group, and the old group
					stays until removed in the native editor.
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
			<p class="hint">
				Saved to the litellm-vscode-chat.servers user setting and synced to VS Code automatically. Secrets left empty
				keep their current value.
			</p>
			<div class="toolbar">
				<button type="button" disabled={saving} onClick={save}>
					{saving ? "Saving..." : "Save"}
				</button>
				<button type="button" class="secondary" onClick={onCancel}>
					Cancel
				</button>
				{firstBlocking !== undefined ? (
					<span class="error" role="alert">
						Cannot save: fix {SERVER_FORM_FIELD_LABELS[firstBlocking]}
					</span>
				) : null}
			</div>
		</div>
	);
}

function ServerRow({
	server,
	armed,
	onEdit,
	onArmRemove,
}: {
	server: DashboardServer;
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
			<td>{server.baseUrl}</td>
			<td data-label="Status">
				<StateCell server={server} />
			</td>
			<td class="num" data-label="Models">
				{server.modelCount}
			</td>
			<td data-label="Last checked">{formatTimestamp(server.lastChecked)}</td>
			<td>
				{server.hasApiKey || server.hasOAuth ? (
					<span class="badge" title={server.hasOAuth ? "OAuth configured" : "API key configured"}>
						auth
					</span>
				) : null}
				{server.origin === "external" ? (
					<span class="badge" title="No entry in the servers setting; managed in the native editor">
						external
					</span>
				) : null}
			</td>
			<td class="actions">
				{server.origin === "declared" ? (
					armed ? (
						<>
							<button
								type="button"
								class="quiet state-error"
								title="Removes the settings entry; the VS Code group itself is removed in the native editor"
								onClick={confirmRemove}
							>
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
							<button
								type="button"
								class="quiet"
								title="Removes the settings entry; inline secrets in it are removed with it"
								onClick={() => onArmRemove(true)}
							>
								Remove
							</button>
						</>
					)
				) : (
					<button
						type="button"
						class="quiet"
						title="Managed outside settings; opens the native Manage Language Models editor"
						onClick={() => postMessage({ type: "executeCommand", command: "manageServers" })}
					>
						Manage
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
	onDismissFailure,
}: {
	servers: readonly DashboardServer[];
	ack: IntentAck | undefined;
	failures: FailuresByIntent;
	/** Drop the latest failure notice for one intent type (Cancel dismisses a stale save failure). */
	onDismissFailure: (intentType: string) => void;
}) {
	// The form target survives state pushes (editing continues across a
	// background refresh); a fresh key forces a clean draft per open.
	const [form, setForm] = useState<{ target: FormTarget; key: number } | undefined>(undefined);
	const [armedRemove, setArmedRemove] = useState<string | undefined>(undefined);
	const saveFailure = failures.saveServerSetting;
	const removeFailure = failures.removeServerSetting;
	const noServers = servers.length === 0;

	const openForm = (target: FormTarget) => {
		setForm((current) => ({ target, key: (current?.key ?? 0) + 1 }));
	};

	return (
		<section>
			<h2>
				Servers <span class="count">{servers.length}</span>
			</h2>
			<div class="toolbar">
				<button type="button" onClick={() => openForm({})}>
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
				<ServerForm
					key={form.key}
					target={form.target}
					ack={ack}
					failures={failures}
					declaredLabels={servers.filter((server) => server.origin === "declared").map((server) => server.label)}
					onClose={() => setForm(undefined)}
					onCancel={() => {
						onDismissFailure("saveServerSetting");
						setForm(undefined);
					}}
				/>
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
								<th>Last checked</th>
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
									armed={armedRemove === server.label}
									onEdit={() => openForm({ original: server })}
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
		</section>
	);
}
