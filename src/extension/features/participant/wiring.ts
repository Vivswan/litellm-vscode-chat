import * as vscode from "vscode";
import { PARTICIPANT_ID } from "../../../shared/config/commandIds";
import { CONFIG_SECTION } from "../../../shared/config/settingSpec";
import { isFeatureEnabled } from "../../../shared/config/settings";
import type { Logger } from "../../../shared/logger";
import { errorLabel } from "../errorLabel";
import { participantFollowups } from "./followups";
import { handleParticipantTurn, type ParticipantRequest } from "./handler";
import type { ChatMessage, HistoryTurn } from "./historyConversion";
import type { ResolvedReference } from "./references";
import type { SlashCommandRegistry } from "./slashCommands";
import { createSlashCommandRegistry } from "./slashCommands";
import type { SnapshotSource } from "./snapshots";
import { participantSnapshots } from "./snapshots";

/**
 * The @litellm participant's wiring: it adapts the host's ChatRequestHandler
 * signature onto the pure turn handler, owns the ONE logging boundary for the
 * feature, and creates or disposes the participant as chatParticipant.enabled
 * changes. Unlike the other features this one is ON by default and costs
 * nothing until a user types @litellm - it answers with the chat request's own
 * model, so it has no model setting and never picks a model itself.
 *
 * The slash-command registry outlives every participant instance on purpose:
 * a feature that extends the table (quick fixes add /fix and /explain)
 * registers once at activation, and a disable/enable cycle must not drop what
 * it registered.
 */

export interface ChatParticipantWiring {
	/**
	 * The slash-command table other features extend the participant through,
	 * and the one place the live command set can be read.
	 *
	 * The contract, in full:
	 * - Register during activation wiring, before any turn can arrive. It is
	 *   not a runtime toggle - registering has no effect on turns in flight.
	 * - `command.name` must be a name package.json contributes under this
	 *   participant's `commands`. The HOST decides what `/name` routes to us,
	 *   so a registration the manifest does not declare is never invoked. The
	 *   contribution test pins the live table and the manifest equal in both
	 *   directions, which is why the whole registry is exposed rather than a
	 *   bare register function: a set nothing can read is a set nothing can
	 *   pin.
	 * - A duplicate name throws, because a silently shadowed command is a
	 *   routing bug rather than a last-writer-wins preference.
	 * - Registration survives the enablement toggle; disabling the feature
	 *   disposes the participant, not the table.
	 */
	readonly slashCommands: SlashCommandRegistry;
	/**
	 * Whether a live participant exists RIGHT NOW - the enable setting said yes
	 * AND the host accepted the registration. Read per use, never cached: both
	 * halves change at runtime.
	 *
	 * It exists because the setting alone is not the same fact. Registration can
	 * refuse (an id conflict, a host that says no), and that failure is
	 * classified and left unregistered here rather than thrown, so a caller that
	 * needs @litellm to actually answer - the quick fixes, whose lightbulb
	 * submits a turn addressed to it - would otherwise send into a name with
	 * nothing behind it.
	 */
	readonly isRegistered: () => boolean;
}

/** The participant's avatar in the chat view: the extension's own logo. */
function participantIcon(context: vscode.ExtensionContext): vscode.Uri {
	return vscode.Uri.joinPath(context.extensionUri, "assets", "logo.png");
}

/** One converted history message as the host's message object; the two roles are all the conversion emits. */
function toChatMessage(message: ChatMessage): vscode.LanguageModelChatMessage {
	return message.role === "user"
		? vscode.LanguageModelChatMessage.User(message.content)
		: vscode.LanguageModelChatMessage.Assistant(message.content);
}

/** One attachment's display name: workspace-relative where possible, with the line range when it has one. */
function referenceName(uri: vscode.Uri, range?: vscode.Range): string {
	const base = vscode.workspace.asRelativePath(uri);
	// Ranges are zero-based; users count lines from one.
	return range === undefined ? base : `${base}:${String(range.start.line + 1)}-${String(range.end.line + 1)}`;
}

/**
 * Read one reference's text. Uris and Locations are opened through the
 * workspace (which serves dirty editor buffers, so the model sees what the
 * user is looking at rather than what is on disk); a plain string value is
 * already text. Anything else in the host's open value vocabulary contributes
 * nothing rather than guessing at it.
 */
async function readReference(reference: vscode.ChatPromptReference): Promise<ResolvedReference | undefined> {
	const value: unknown = reference.value;
	if (typeof value === "string") {
		return value.trim() === "" ? undefined : { name: reference.id, content: value };
	}
	if (value instanceof vscode.Uri) {
		const document = await vscode.workspace.openTextDocument(value);
		return { name: referenceName(value), content: document.getText() };
	}
	if (value instanceof vscode.Location) {
		const document = await vscode.workspace.openTextDocument(value.uri);
		return { name: referenceName(value.uri, value.range), content: document.getText(value.range) };
	}
	return undefined;
}

/** The name to show for an attachment that could not be read; the value may be anything. */
function unreadableName(reference: vscode.ChatPromptReference): string {
	const value: unknown = reference.value;
	if (value instanceof vscode.Uri) {
		return vscode.workspace.asRelativePath(value);
	}
	return value instanceof vscode.Location ? vscode.workspace.asRelativePath(value.uri) : reference.id;
}

/**
 * Every attachment on the turn, in the order the user wrote them. The host
 * sorts `references` in REVERSE prompt order (last reference first, to make
 * string surgery on the prompt easy), so reading them back to front restores
 * reading order.
 *
 * An attachment that cannot be read - a deleted file, a binary, a scheme with
 * no provider - never fails the turn: the rest of the question is still
 * answerable, and a hard failure here would make one stale editor tab enough
 * to break chat. It is carried through as `unreadable` rather than dropped, so
 * the model is told the user pointed at something it did not receive instead
 * of answering as though it had everything.
 */
async function resolveReferences(
	references: readonly vscode.ChatPromptReference[],
	log: (message: string) => void
): Promise<ResolvedReference[]> {
	const resolved: ResolvedReference[] = [];
	for (const reference of [...references].reverse()) {
		try {
			const one = await readReference(reference);
			if (one !== undefined) {
				resolved.push(one);
			}
		} catch (error) {
			log(`chat participant could not read an attachment: ${errorLabel(error)}`);
			resolved.push({ name: unreadableName(reference), unreadable: true });
		}
	}
	return resolved;
}

/**
 * Wire the feature. Returns the registration seam; the participant itself is
 * owned here, created and disposed by the enablement watcher.
 */
export function wireChatParticipant(
	context: vscode.ExtensionContext,
	logger: Logger,
	deps: {
		/** The provider's last known models per group; read per turn, never cached, and never a network call. */
		readonly getSnapshots: () => readonly SnapshotSource[];
	}
): ChatParticipantWiring {
	const commands = createSlashCommandRegistry();

	const handler: vscode.ChatRequestHandler = async (request, chatContext, response, token) => {
		// The attachments the turn came with - the editor selection, the open
		// file, every explicit #file:. request.prompt carries references only AS
		// AUTHORED, so without this read the model sees "#file:foo.ts" and no
		// foo.ts, and every "write tests for the selected function" turn arrives
		// with nothing to write tests for. request.toolReferences is deliberately
		// NOT read: this participant invokes no tools, a #tool mention carries no
		// inlinable value, and the mention itself already survives in the prompt.
		//
		// Read on demand and at most once: /models and the empty-prompt command
		// listing answer without the user's code and must not pay to open it.
		let pending: Promise<readonly ResolvedReference[]> | undefined;
		const attachments = (): Promise<readonly ResolvedReference[]> => {
			pending ??= resolveReferences(request.references, (message) => {
				logger.log(message);
			});
			return pending;
		};
		const turn: ParticipantRequest = {
			prompt: request.prompt,
			...(request.command === undefined ? {} : { command: request.command }),
			// ChatContext.history is exactly the request/response turn union the
			// conversion mirrors structurally; no copy, no mapping.
			history: chatContext.history as readonly HistoryTurn[],
			attachments,
		};
		const outcome = await handleParticipantTurn(turn, {
			sendRequest: async (messages) => {
				// The request's OWN model, never a model this feature picked: the
				// user's picker choice is the whole model policy here. No options
				// ride along, so nothing this feature invents reaches the wire.
				const result = await request.model.sendRequest(messages.map(toChatMessage), {}, token);
				return result.text;
			},
			stream: { report: (markdown) => response.markdown(markdown) },
			// A thunk the whole way down, so only a command that answers FROM the
			// snapshots reads them, and a read that does throw fails that turn
			// like any other instead of half-answering.
			snapshots: () => participantSnapshots(deps.getSnapshots()),
			commands,
			// The real instanceof check, plus the structural test the core falls
			// back to: the host is not the only source of a canceled error on this
			// path, and a transport that threw its own must not be logged either.
			isCancellation: (error) =>
				error instanceof vscode.CancellationError || (error instanceof Error && error.name === "Canceled"),
		});
		if (outcome.kind === "failed") {
			// The feature's single logging boundary; the classification is
			// English by construction and carries no response-derived text.
			logger.log(outcome.log);
		}
		return {
			metadata: {
				command: request.command ?? "",
				failed: outcome.kind === "failed",
			},
		};
	};

	let participant: vscode.ChatParticipant | undefined;

	const applyEnablement = (): void => {
		const enabled = isFeatureEnabled("chatParticipant");
		if (enabled && participant === undefined) {
			// Registration is host-side and can refuse (a manifest/runtime id
			// mismatch, an id already taken). This runs on the activation path and
			// inside a configuration listener, so a throw would take down more than
			// this feature; it is classified and left unregistered instead, and the
			// next configuration change retries.
			try {
				const created = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
				created.iconPath = participantIcon(context);
				created.followupProvider = {
					provideFollowups: (result) => {
						const metadata = result.metadata as { command?: unknown; failed?: unknown } | undefined;
						return participantFollowups({
							command: typeof metadata?.command === "string" ? metadata.command : undefined,
							failed: metadata?.failed === true,
						});
					},
				};
				participant = created;
			} catch (error) {
				logger.log(`chat participant registration failed: ${errorLabel(error)}`);
			}
		} else if (!enabled && participant !== undefined) {
			participant.dispose();
			participant = undefined;
		}
	};
	applyEnablement();

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				applyEnablement();
			}
		}),
		new vscode.Disposable(() => {
			participant?.dispose();
			participant = undefined;
		})
	);

	return { slashCommands: commands, isRegistered: () => participant !== undefined };
}
