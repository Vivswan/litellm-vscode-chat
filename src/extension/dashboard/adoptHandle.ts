import { randomBytes } from "node:crypto";
import { fingerprint } from "../../shared/util/fingerprint";

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
