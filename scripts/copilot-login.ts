#!/usr/bin/env bun
// scripts/copilot-login.ts
//
// One-time GitHub device-flow login for the stack's github_copilot routes.
// Writes the OAuth access token into docker/.copilot-token/, which
// docker-compose mounts into the litellm container (the proxy's own
// github_copilot authenticator reads it there) and which the config
// generator reads to fetch the live Copilot model catalog at generation
// time. Re-run whenever GitHub revokes the token; delete the access-token
// file inside the directory to sign out (the directory itself is a tracked
// compose mountpoint - keep it). A GitHub account with a Copilot seat is
// required - a plain PAT cannot reach the Copilot token exchange.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { COPILOT_CLIENT_ID, COPILOT_TOKEN_DIR } from "./litellmConfig";

const FETCH_TIMEOUT_MS = 10_000;

interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_uri: string;
	expires_in: number;
	interval: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const startResponse = await fetch("https://github.com/login/device/code", {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const device = (await startResponse.json()) as Partial<DeviceCode> & { error?: string; error_description?: string };
	if (device.device_code === undefined || device.user_code === undefined) {
		// Allow-listed fields only: a raw response dump could leak a credential.
		const detail = device.error ?? "unexpected response shape";
		console.error(
			`[copilot-login] device flow did not start: ${detail}${device.error_description ? ` (${device.error_description})` : ""}`
		);
		process.exit(1);
	}

	console.log(`[copilot-login] visit ${device.verification_uri} and enter: ${device.user_code}`);
	console.log(`[copilot-login] waiting for authorization (expires in ${device.expires_in}s)...`);

	const deadline = Date.now() + (device.expires_in ?? 900) * 1000;
	// The device-flow spec: poll no faster than `interval`, and add five
	// seconds whenever GitHub answers slow_down.
	let intervalMs = ((device.interval ?? 5) + 1) * 1000;
	let accessToken: string | undefined;
	while (Date.now() < deadline) {
		await sleep(intervalMs);
		const pollResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				client_id: COPILOT_CLIENT_ID,
				device_code: device.device_code,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		const poll = (await pollResponse.json()) as { access_token?: string; error?: string };
		if (poll.access_token !== undefined) {
			accessToken = poll.access_token;
			break;
		}
		if (poll.error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		if (poll.error !== undefined && poll.error !== "authorization_pending") {
			console.error(`[copilot-login] device flow failed: ${poll.error}`);
			process.exit(1);
		}
	}
	if (accessToken === undefined) {
		console.error("[copilot-login] timed out waiting for authorization; run it again");
		process.exit(1);
	}

	// Owner-only on both the directory and the file, chmod'd even when they
	// already exist: the token is a long-lived credential.
	const tokenDir = path.join(process.cwd(), COPILOT_TOKEN_DIR);
	mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
	chmodSync(tokenDir, 0o700);
	const tokenPath = path.join(tokenDir, "access-token");
	writeFileSync(tokenPath, accessToken, { mode: 0o600 });
	chmodSync(tokenPath, 0o600);
	console.log(`[copilot-login] token saved to ${COPILOT_TOKEN_DIR}; the next stack start emits github_copilot routes`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
