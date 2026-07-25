import * as vscode from "vscode";
import type { ServerWithKey } from "../extension/serverRegistry";

export async function resolveServer(
	serverId: string,
	getServers: (() => Promise<ServerWithKey[]>) | undefined
): Promise<ServerWithKey | undefined> {
	if (!getServers) {
		return undefined;
	}
	const servers = await getServers();
	return servers.find((s) => s.id === serverId);
}

export async function ensureServers(
	silent: boolean,
	getServers: (() => Promise<ServerWithKey[]>) | undefined
): Promise<ServerWithKey[] | undefined> {
	if (getServers) {
		const servers = await getServers();
		if (servers.length > 0) {
			return servers;
		}
	}

	if (silent) {
		return undefined;
	}

	const result = await vscode.window.showErrorMessage(
		"LiteLLM is not configured. Set up your connection to use this provider.",
		"Configure Now",
		"Learn More"
	);

	if (result === "Configure Now") {
		await vscode.commands.executeCommand("litellm.manage");
		if (getServers) {
			const servers = await getServers();
			if (servers.length > 0) {
				return servers;
			}
		}
	} else if (result === "Learn More") {
		vscode.env.openExternal(vscode.Uri.parse("https://github.com/Vivswan/litellm-vscode-chat#quick-start"));
	}

	return undefined;
}
