import type { ServerWithKey } from "../shared/servers";

/**
 * Injected by the extension layer so the provider layer never touches
 * vscode.window. Resolves true when the user completed a configuration flow,
 * signalling the caller to re-check the server list.
 */
export interface ConfigurationPrompt {
	promptToConfigure(): Promise<boolean>;
}

export async function resolveServer(
	serverId: string,
	getServers: () => Promise<ServerWithKey[]>
): Promise<ServerWithKey | undefined> {
	const servers = await getServers();
	return servers.find((s) => s.id === serverId);
}

export async function ensureServers(
	silent: boolean,
	getServers: () => Promise<ServerWithKey[]>,
	prompt?: ConfigurationPrompt
): Promise<ServerWithKey[] | undefined> {
	const servers = await getServers();
	if (servers.length > 0) {
		return servers;
	}

	if (silent || !prompt) {
		return undefined;
	}

	if (await prompt.promptToConfigure()) {
		const refreshed = await getServers();
		if (refreshed.length > 0) {
			return refreshed;
		}
	}

	return undefined;
}
