import { randomBytes } from "node:crypto";
import { fingerprint } from "../../shared/fingerprint";

/**
 * The opaque token an external row carries so the adopt intent can name its
 * source group (DashboardServer.adoptHandle): a one-way hash of the server
 * ID, salted with a per-session random value. The salt is load-bearing: the
 * server ID embeds the group's unsalted credential fingerprint and the base
 * URL already sits in the state, so an unsalted hash would let anything able
 * to read webview state confirm guessed low-entropy keys offline by
 * reproducing the handle. Salted, the handle is stable across state pushes
 * within one session (an open adopt form survives background refreshes),
 * which is all adoption needs; nothing depends on it across sessions.
 */
const ADOPT_HANDLE_SALT = randomBytes(16).toString("hex");

export function adoptSourceHandle(serverId: string): string {
	return fingerprint(`adopt-source:${ADOPT_HANDLE_SALT}:${serverId}`);
}
