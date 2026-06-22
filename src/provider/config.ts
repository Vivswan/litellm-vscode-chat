import * as vscode from "vscode";
import type { ServerWithKey } from "../extension/serverRegistry";

export type ResolvedServer = Pick<ServerWithKey, "id" | "baseUrl" | "apiKey" | "auth" | "oauth">;

export async function resolveServer(
	serverId: string,
	getServers: (() => Promise<ServerWithKey[]>) | undefined,
	secrets: vscode.SecretStorage
): Promise<ResolvedServer | undefined> {
	if (serverId === "_legacy") {
		const config = await ensureConfig(secrets);
		return config ? { id: "_legacy", baseUrl: config.baseUrl, apiKey: config.apiKey } : undefined;
	}
	if (!getServers) {
		return undefined;
	}
	const servers = await getServers();
	return servers.find((s) => s.id === serverId);
}

export async function ensureServers(
	silent: boolean,
	getServers: (() => Promise<ServerWithKey[]>) | undefined,
	secrets: vscode.SecretStorage
): Promise<ServerWithKey[] | undefined> {
	if (getServers) {
		const servers = await getServers();
		if (servers.length > 0) {
			return servers;
		}
	}

	const baseUrl = await secrets.get("litellm.baseUrl");
	if (baseUrl) {
		const apiKey = (await secrets.get("litellm.apiKey")) ?? "";
		return [
			{
				id: "_legacy",
				label: "Default",
				baseUrl: baseUrl.replace(/\/+$/, ""),
				apiKey,
			},
		];
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

export async function ensureConfig(
	secrets: vscode.SecretStorage
): Promise<{ baseUrl: string; apiKey: string } | undefined> {
	const baseUrl = await secrets.get("litellm.baseUrl");
	if (!baseUrl) {
		return undefined;
	}
	const apiKey = (await secrets.get("litellm.apiKey")) ?? "";
	return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}
