import { randomBytes } from "node:crypto";
import { fingerprint } from "../../shared/util/fingerprint";

/**
 * The opaque token an external row carries so the adopt intent can name its
 * source group (DashboardServer.adoptHandle): a one-way hash of the server
 * ID, salted with a per-session random value. The session salt keeps the
 * handle from doubling as the server ID's identity outside the extension:
 * the ID embeds the group's credential fingerprint (keyed these days by the
 * per-install salt, but still a stable identity), and anything able to read
 * webview state should learn nothing correlatable from it. Salted, the
 * handle is stable across state pushes within one session (an open adopt
 * form survives background refreshes), which is all adoption needs; nothing
 * depends on it across sessions.
 */
const ADOPT_HANDLE_SALT = randomBytes(16).toString("hex");

export function adoptSourceHandle(serverId: string): string {
	return fingerprint(`adopt-source:${ADOPT_HANDLE_SALT}:${serverId}`);
}
