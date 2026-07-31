import { useEffect, useState } from "preact/hooks";
import type { HeaderScalar, ScopedRecordSetting } from "../../extension/dashboard/protocol";
import { formatHeaderValue, formatJsonValue, SETTING_SCOPE_LABELS } from "../../extension/dashboard/protocol";
import type { GroupProblems, PrefixGroup } from "../../extension/dashboard/recordDraft";
import { parseGroups, parseHeaderRows, toGroups, toHeaderRows } from "../../extension/dashboard/recordDraft";
import { DOCS_LINK_MODEL_PARAMETERS } from "./docsLinks";
import { DocsLink, Help } from "./help";
import {
	HELP_CUSTOM_HEADERS_SECTION,
	HELP_MODEL_PARAMETER_NAME,
	HELP_MODEL_PARAMETER_PREFIX,
	HELP_MODEL_PARAMETER_VALUE,
	HELP_MODEL_PARAMETERS_SECTION,
} from "./helpText";
import { IconAdd, IconTrash } from "./icons";
import { postMessage } from "./vscodeApi";

/**
 * Both editors here follow one draft-and-apply model: rows are edited
 * locally, validated on every keystroke, and written back to configuration
 * only through Apply, so the object settings never pass through an invalid
 * intermediate shape. With no draft the store value renders directly; a
 * dirty draft wins until Apply or Reset. An applied draft keeps rendering
 * (no flicker back to the pre-apply value) until either the store push that
 * reflects the write arrives (which drops it) or the extension reports the
 * write failed (which returns it to a dirty, retryable state).
 */
function useDraftRows<T>(
	external: T,
	failure: IntentFailure | undefined
): {
	rows: T;
	dirty: boolean;
	update: (next: T) => void;
	apply: () => void;
	reset: () => void;
} {
	const externalKey = JSON.stringify(external);
	const [draft, setDraft] = useState<{ rows: T; applied: boolean; baseKey: string } | undefined>(undefined);
	const failureSeq = failure?.seq;

	useEffect(() => {
		if (draft?.applied === true && externalKey !== draft.baseKey) {
			setDraft(undefined);
		}
	}, [draft, externalKey]);

	// A reported write failure re-opens the applied draft for editing.
	useEffect(() => {
		if (failureSeq !== undefined) {
			setDraft((current) => (current?.applied === true ? { ...current, applied: false } : current));
		}
	}, [failureSeq]);

	return {
		rows: draft?.rows ?? external,
		dirty: draft !== undefined && !draft.applied,
		update: (next) => setDraft({ rows: next, applied: false, baseKey: externalKey }),
		apply: () => setDraft((current) => (current === undefined ? undefined : { ...current, applied: true })),
		reset: () => setDraft(undefined),
	};
}

/** One reported intent failure; `seq` distinguishes repeated failures with the same text. */
export interface IntentFailure {
	readonly seq: number;
	readonly message: string;
	/** Whether the intent's durable write committed before the failure; see the protocol's intentFailed notice. */
	readonly kind: "validation" | "operation";
	/** The failed intent's correlation ID, when the intent carried one. */
	readonly requestId?: string | undefined;
}

function ScopeNote({ scoped }: { scoped: ScopedRecordSetting<unknown> }) {
	return <p class="hint">Editing {SETTING_SCOPE_LABELS[scoped.editScope]} settings.</p>;
}

function FailureNote({ failure, dirty }: { failure: IntentFailure | undefined; dirty: boolean }) {
	if (failure === undefined || !dirty) {
		return null;
	}
	return <p class="error">Saving failed: {failure.message} Your edits are kept; fix them and Apply again.</p>;
}

/**
 * The model-parameter group rows themselves: one group per model prefix, one
 * row per request parameter, values entered as JSON, problems row-aligned
 * from parseGroups. Purely presentational (edits go through onChange), so the
 * global settings editor below and the server form's per-entry section render
 * the identical rows over their own drafts. The prefix placeholder and help
 * are required props because the two surfaces genuinely differ: global keys
 * may lead with a base URL to scope to one server, entry keys are already
 * scoped and match model IDs only, so a URL prefix there would never match.
 * The parameter-name and value help stay shared; they are scope-agnostic.
 */
export function ParamGroupsFields({
	groups,
	problems,
	disabled,
	prefixPlaceholder,
	prefixHelp,
	onChange,
}: {
	groups: readonly PrefixGroup[];
	problems: readonly GroupProblems[];
	disabled?: boolean;
	prefixPlaceholder: string;
	prefixHelp: string;
	onChange: (next: PrefixGroup[]) => void;
}) {
	const patchGroup = (index: number, patch: Partial<PrefixGroup>) => {
		onChange(groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
	};
	return (
		<>
			{groups.map((group, groupIndex) => (
				// Rows are positional while being edited; the index is the identity.
				<div class="group" key={groupIndex}>
					<div class="row">
						<span class="cell key">
							<input
								type="text"
								class={`key${problems[groupIndex]?.prefix === undefined ? "" : " invalid"}`}
								placeholder={prefixPlaceholder}
								value={group.prefix}
								disabled={disabled}
								onInput={(event) => patchGroup(groupIndex, { prefix: event.currentTarget.value })}
							/>
							<Help text={prefixHelp} />
						</span>
						<button
							type="button"
							class="quiet"
							disabled={disabled}
							onClick={() => onChange(groups.filter((_, i) => i !== groupIndex))}
						>
							<IconTrash /> Remove prefix
						</button>
						{problems[groupIndex]?.prefix !== undefined ? (
							<span class="error">{problems[groupIndex]?.prefix}</span>
						) : null}
					</div>
					<div class="rows">
						{group.params.map((param, paramIndex) => (
							<div class="row" key={paramIndex}>
								<span class="cell key">
									<input
										type="text"
										class="key"
										placeholder="Parameter, e.g. temperature"
										value={param.key}
										disabled={disabled}
										onInput={(event) =>
											patchGroup(groupIndex, {
												params: group.params.map((p, i) =>
													i === paramIndex ? { ...p, key: event.currentTarget.value } : p
												),
											})
										}
									/>
									<Help text={HELP_MODEL_PARAMETER_NAME} />
								</span>
								<span class="cell value">
									<input
										type="text"
										class={`value${problems[groupIndex]?.params[paramIndex] === undefined ? "" : " invalid"}`}
										placeholder="JSON value, e.g. 0.2"
										value={param.valueText}
										disabled={disabled}
										onInput={(event) =>
											patchGroup(groupIndex, {
												params: group.params.map((p, i) =>
													i === paramIndex ? { ...p, valueText: event.currentTarget.value } : p
												),
											})
										}
									/>
									<Help text={HELP_MODEL_PARAMETER_VALUE} />
								</span>
								<button
									type="button"
									class="quiet"
									disabled={disabled}
									onClick={() => patchGroup(groupIndex, { params: group.params.filter((_, i) => i !== paramIndex) })}
								>
									<IconTrash /> Remove
								</button>
								{problems[groupIndex]?.params[paramIndex] !== undefined ? (
									<span class="error">{problems[groupIndex]?.params[paramIndex]}</span>
								) : null}
							</div>
						))}
					</div>
					<button
						type="button"
						class="secondary"
						disabled={disabled}
						onClick={() => patchGroup(groupIndex, { params: [...group.params, { key: "", valueText: "" }] })}
					>
						<IconAdd /> Add parameter
					</button>
				</div>
			))}
		</>
	);
}

/**
 * Structured editor for litellm-vscode-chat.modelParameters, the
 * object-of-objects the native Settings GUI cannot edit: one group per model
 * prefix, one row per request parameter, values entered as JSON. Edits apply
 * to one configuration scope; other scopes render read-only below.
 */
export function ModelParametersEditor({
	scoped,
	failure,
}: {
	scoped: ScopedRecordSetting<Readonly<Record<string, unknown>>>;
	failure: IntentFailure | undefined;
}) {
	const draft = useDraftRows(toGroups(scoped.value), failure);
	const groups = draft.rows;
	// One parse per keystroke: the row problems, the Apply gate, and the
	// assembled record are the same verdict, so a draft that renders clean can
	// never assemble differently.
	const parse = parseGroups(groups);
	const problems = parse.ok ? [] : parse.problems;

	const apply = () => {
		if (!parse.ok) {
			return;
		}
		postMessage({ type: "setModelParameters", value: parse.value });
		draft.apply();
	};

	return (
		<section>
			<h3>
				Model parameters <Help text={HELP_MODEL_PARAMETERS_SECTION} />{" "}
				<DocsLink href={DOCS_LINK_MODEL_PARAMETERS} label="Open the model parameters guide" />
			</h3>
			<p class="hint">
				Request parameters sent per model prefix (longest prefix wins). Values are JSON: 0.2, true, "text", ["stop"].
			</p>
			<ScopeNote scoped={scoped} />
			{groups.length === 0 ? <p class="empty">No model parameters configured in this scope.</p> : null}
			<ParamGroupsFields
				groups={groups}
				problems={problems}
				prefixPlaceholder="Model prefix, e.g. gpt-4 or http://host:4000/gpt-4"
				prefixHelp={HELP_MODEL_PARAMETER_PREFIX}
				onChange={(next) => draft.update(next)}
			/>
			<FailureNote failure={failure} dirty={draft.dirty} />
			<div class="toolbar">
				<button
					type="button"
					class="secondary"
					onClick={() => draft.update([...groups, { prefix: "", params: [{ key: "", valueText: "" }] }])}
				>
					<IconAdd /> Add model prefix
				</button>
				<button type="button" disabled={!draft.dirty || !parse.ok} onClick={apply}>
					Apply
				</button>
				<button type="button" class="secondary" disabled={!draft.dirty} onClick={() => draft.reset()}>
					Reset
				</button>
			</div>
			{scoped.otherScopes.map((other) => (
				<div class="group" key={other.scope}>
					<p class="hint">Also set in {SETTING_SCOPE_LABELS[other.scope]} settings (read-only here):</p>
					{Object.entries(other.value).map(([prefix, params]) => (
						<p key={prefix}>
							{prefix}:{" "}
							{Object.entries(params)
								.map(([key, paramValue]) => `${key} = ${formatJsonValue(paramValue)}`)
								.join(", ")}
						</p>
					))}
				</div>
			))}
		</section>
	);
}

/**
 * Structured editor for litellm-vscode-chat.headers: one row per header,
 * values as scalars. Edits apply to one configuration scope; other scopes
 * render read-only below.
 */
export function HeadersEditor({
	scoped,
	failure,
}: {
	scoped: ScopedRecordSetting<HeaderScalar>;
	failure: IntentFailure | undefined;
}) {
	const draft = useDraftRows(toHeaderRows(scoped.value), failure);
	const rows = draft.rows;
	// One parse per keystroke, like the model-parameters editor above.
	const parse = parseHeaderRows(rows);
	const problems = parse.ok ? [] : parse.problems;

	const patchRow = (index: number, patch: Partial<(typeof rows)[number]>) => {
		draft.update(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
	};

	const apply = () => {
		if (!parse.ok) {
			return;
		}
		postMessage({ type: "setHeaders", value: parse.value });
		draft.apply();
	};

	return (
		<section>
			<h3>
				Custom headers <Help text={HELP_CUSTOM_HEADERS_SECTION} />
			</h3>
			<p class="hint">Sent with every LiteLLM request. Prefer User settings for values that are secrets.</p>
			<ScopeNote scoped={scoped} />
			{rows.length === 0 ? <p class="empty">No custom headers configured in this scope.</p> : null}
			<div class="rows">
				{rows.map((row, index) => (
					<div class="row" key={index}>
						<input
							type="text"
							class={`key${problems[index] === undefined ? "" : " invalid"}`}
							placeholder="Header, e.g. x-litellm-api-key"
							value={row.name}
							onInput={(event) => patchRow(index, { name: event.currentTarget.value })}
						/>
						<input
							type="text"
							class="value"
							placeholder="Value"
							value={row.valueText}
							onInput={(event) => patchRow(index, { valueText: event.currentTarget.value })}
						/>
						<button type="button" class="quiet" onClick={() => draft.update(rows.filter((_, i) => i !== index))}>
							<IconTrash /> Remove
						</button>
						{problems[index] !== undefined ? <span class="error">{problems[index]}</span> : null}
					</div>
				))}
			</div>
			<FailureNote failure={failure} dirty={draft.dirty} />
			<div class="toolbar">
				<button type="button" class="secondary" onClick={() => draft.update([...rows, { name: "", valueText: "" }])}>
					<IconAdd /> Add header
				</button>
				<button type="button" disabled={!draft.dirty || !parse.ok} onClick={apply}>
					Apply
				</button>
				<button type="button" class="secondary" disabled={!draft.dirty} onClick={() => draft.reset()}>
					Reset
				</button>
			</div>
			{scoped.otherScopes.map((other) => (
				<div class="group" key={other.scope}>
					<p class="hint">Also set in {SETTING_SCOPE_LABELS[other.scope]} settings (read-only here):</p>
					{Object.entries(other.value).map(([name, headerValue]) => (
						<p key={name}>
							{name} = {formatHeaderValue(headerValue)}
						</p>
					))}
				</div>
			))}
		</section>
	);
}
