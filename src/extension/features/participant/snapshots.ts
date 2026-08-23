/**
 * The provider's last-known models, shaped for the /models answer. The input
 * is a structural mirror of what LiteLLMChatModelProvider.getServerSnapshots()
 * hands back, so the wiring passes that array straight in and this module
 * needs no vscode import and stays pure for the bun tree.
 *
 * Zero network by construction: a snapshot is what the last serve already
 * produced. A group that has never been served has no snapshot, so /models
 * reports what the picker would show right now, not what a fresh discovery
 * might find.
 */

import * as l10n from "@vscode/l10n";
import { isHiddenGroupServerStatus } from "../../../shared/servers";
import { compactTokenCount } from "../../../shared/util/tokenCount";
import type { ProviderSnapshot, SnapshotModel } from "./modelsMarkdown";

/**
 * One model as the status window holds it: the exposed id, the mint-stamped
 * raw-ID metadata, and the registration-time capability values. Everything
 * past the id is optional here even where the host's own type requires it,
 * because a snapshot round-trips through the host and a missing field must
 * render as "not reported" rather than throw.
 */
interface SnapshotSourceModel {
	readonly id: string;
	/** The mint-stamped raw model ID; a copy that lost it falls back to the exposed id, which group mints keep raw. */
	readonly litellm?: { readonly rawModelId?: string | undefined } | undefined;
	readonly maxInputTokens?: number | undefined;
	readonly capabilities?:
		| {
				/** The host's own union: `true`, or the maximum tool count a request may carry. */
				readonly toolCalling?: boolean | number | undefined;
				readonly imageInput?: boolean | undefined;
		  }
		| undefined;
}

/**
 * One provider group's snapshot. The status carries the label, the group's
 * server id, and the two fields that decide whether the group belongs in the
 * answer at all - see isHiddenGroupServerStatus.
 */
export interface SnapshotSource {
	readonly status: {
		readonly label: string;
		readonly serverId: string;
		readonly state: "ok" | "error";
		readonly hiddenByRemoval?: boolean | undefined;
	};
	readonly models: readonly SnapshotSourceModel[];
}

/**
 * One model's capability summary: the context window it accepts plus the two
 * capabilities that change what a user can send it. Each fragment is a
 * complete phrase, joined by a comma, and a model reporting none of the three
 * says so rather than rendering an empty cell.
 */
function capabilitySummary(model: SnapshotSourceModel): string {
	const parts: string[] = [];
	const maxInput = model.maxInputTokens;
	if (typeof maxInput === "number" && Number.isFinite(maxInput) && maxInput > 0) {
		parts.push(
			l10n.t({
				message: "{0} context",
				args: [compactTokenCount(Math.floor(maxInput))],
				comment: ["/models table cell; {0} is a compact token count such as 128k"],
			})
		);
	}
	// toolCalling is `true` or a maximum tool count, so a reported 0 means the
	// model takes no tools and must not advertise them.
	const toolCalling = model.capabilities?.toolCalling;
	if (toolCalling === true || (typeof toolCalling === "number" && toolCalling > 0)) {
		parts.push(l10n.t({ message: "tools", comment: ["/models table cell: the model supports tool calling"] }));
	}
	if (model.capabilities?.imageInput === true) {
		parts.push(l10n.t({ message: "images", comment: ["/models table cell: the model accepts image input"] }));
	}
	return parts.length === 0 ? l10n.t("no capabilities reported") : parts.join(", ");
}

/**
 * Convert the provider's snapshots to the /models input: the group's label,
 * each model's RAW id (the id the user writes in a `servers` entry or a
 * feature model setting, not the host-namespaced one), and its summary.
 * Ordering is not this module's business - modelsMarkdown sorts what it
 * renders, so the snapshot arrival order cannot reach the document.
 */
export function participantSnapshots(sources: readonly SnapshotSource[]): ProviderSnapshot[] {
	// Groups the user explicitly removed are still in the status window, healthy
	// and serving nothing, so an unfiltered /models would head a section with a
	// server the user deleted and report "no models discovered" under it. The
	// shared predicate is the same one every other surface hides them by.
	return sources
		.filter((source) => !isHiddenGroupServerStatus(source.status))
		.map((source) => {
			const models: SnapshotModel[] = source.models.map((model) => ({
				id: model.litellm?.rawModelId ?? model.id,
				capabilities: capabilitySummary(model),
			}));
			return { label: source.status.label, models };
		});
}
