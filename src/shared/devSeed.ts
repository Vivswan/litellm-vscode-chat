/**
 * The dev-seed handshake between `bun run dev` and a development-mode
 * activation: the launcher writes this file into the extension development
 * folder and src/extension/devSeed.ts consumes it exactly once. Both sides
 * import the filename and shape from here so the contract cannot drift. Pure
 * declarations: no vscode, no Node (the launcher runs outside the host).
 */

/** The seed file's name, resolved against the extension development folder. */
export const DEV_SEED_FILENAME = ".dev-seed.json";

/** A matcher-keyed record set, the shape both models.* settings use. */
type DevSeedRecords = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** The two model-keyed record settings a seed can carry content for. */
export interface DevSeedModels {
	readonly parameters?: DevSeedRecords;
	readonly capabilities?: DevSeedRecords;
}

/**
 * One seeded server entry beyond the main one. Upserted by label like the main
 * entry: the seed's own labels re-pin wholesale every run, every other entry
 * survives verbatim.
 */
export interface DevSeedEntry {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	/** The entry-level manual budget in USD (demonstrates the entry-over-key budget override). */
	readonly budget?: number;
	/** Entry-level models.parameters / models.capabilities records. */
	readonly models?: DevSeedModels;
}

/**
 * The seed file's shape. The launcher writes exactly this; parseDevSeed on the
 * extension side tolerates missing optionals.
 */
export interface DevSeed {
	readonly label: string;
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly openDashboard: boolean;
	/** Entry-level records for the main entry (the entry-over-global demo). */
	readonly models?: DevSeedModels;
	/** Extra demo entries, upserted by label like the main one. */
	readonly entries?: readonly DevSeedEntry[];
	/**
	 * Global demo records for the models.parameters / models.capabilities
	 * settings. The seed owns exactly the matcher keys named here (re-pinned
	 * wholesale every run); keys it does not name are user records that survive
	 * verbatim.
	 */
	readonly records?: DevSeedModels;
}
