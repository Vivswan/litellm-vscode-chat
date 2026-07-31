/**
 * The dev-seed handshake between `bun run dev` and a development-mode
 * activation: the launcher (scripts/dev/dev.ts) writes this file into the
 * extension development folder, and src/extension/devSeed.ts consumes it
 * exactly once. Both sides import the filename and shape from here so the
 * contract cannot drift. Pure declarations: no vscode, no Node (the launcher
 * runs outside the extension host).
 */

/** The seed file's name, resolved against the extension development folder. */
export const DEV_SEED_FILENAME = ".dev-seed.json";

/**
 * The seed file's shape. The launcher writes exactly this; the extension side
 * reads it through parseDevSeed, which tolerates missing optionals (an empty
 * label falls back, apiKey defaults to "", openDashboard to false).
 */
export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
}
