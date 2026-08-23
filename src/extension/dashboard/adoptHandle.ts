import { randomBytes } from "node:crypto";
import type { PreAttachModelInfo } from "../../provider/catalog/groupModels";
import type { ServerModelsSnapshot } from "../../provider/catalog/statusWindow";
import { fingerprint } from "../../shared/util/fingerprint";
import type { LabeledSnapshot } from "./declaredJoin";
import { labeledSnapshots } from "./declaredJoin";

/**
 * The opaque token an external row carries so the adopt intent can name its
 * source group (DashboardServer.adoptHandle): a one-way hash of the server ID
 * under a per-session salt, so nothing able to read webview state learns
 * anything correlatable from it (the ID embeds a credential fingerprint).
 * Stable within one session, which is all adoption needs; nothing depends on
 * it across sessions.
 */
const ADOPT_HANDLE_SALT = randomBytes(16).toString("hex");

export function adoptSourceHandle(serverId: string): string {
	return fingerprint(`adopt-source:${ADOPT_HANDLE_SALT}:${serverId}`);
}

/**
 * The key a model row's request scope rides under (DashboardModel.scopeKey):
 * the same salted one-way construction under its own domain prefix. Hashing
 * the server ID instead of numbering the sorted snapshots keeps the key
 * non-positional: a stale key de-resolves to nothing, never to whichever
 * server now sits at that index.
 */
export function modelScopeKey(serverId: string): string {
	return fingerprint(`model-scope:${ADOPT_HANDLE_SALT}:${serverId}`);
}

/** What locateModel resolved: the snapshot the scope key named and the model the raw ID named inside it. */
export interface LocatedModel {
	readonly labeled: LabeledSnapshot;
	readonly info: PreAttachModelInfo;
}

/**
 * De-resolve a (scopeKey, rawId) pair from a state push back to the live
 * model, beside the key minter so the two directions cannot drift: the scope
 * key finds its snapshot by the same modelScopeKey hash the push minted, and
 * the raw ID matches the mint-stamped litellm.rawModelId the push's rawId came
 * from. Undefined when either half no longer resolves - a store change between
 * the push and the request means the state moved on, and the responders answer
 * that instead of inventing values.
 */
export function locateModel(
	snapshots: readonly ServerModelsSnapshot[],
	scopeKey: string,
	rawId: string
): LocatedModel | undefined {
	const labeled = labeledSnapshots(snapshots).find(
		(entry) => modelScopeKey(entry.snapshot.status.serverId) === scopeKey
	);
	if (labeled === undefined) {
		return undefined;
	}
	const info = labeled.snapshot.models.find((model) => model.litellm.rawModelId === rawId);
	return info === undefined ? undefined : { labeled, info };
}
