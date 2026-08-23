/**
 * The consent surface for a settings-file URL change over a stored secret: a
 * hand edit that re-points an entry's base URL (or OAuth token URL) leaves the
 * label's SecretStorage value stamped for the old destination, the sync engine
 * skips the entry ("secretsMismatched"), and nothing asks the user what the
 * stored credential should do now. This watcher turns that skip into the ONE
 * question the dashboard's edit form asks at save time: keep using the stored
 * value with the new destination (re-stamp it), or clear it.
 *
 * State-detecting and re-arming, the migrations' idiom: the mismatch is
 * re-derived from the setting and the blob on every sync pass, and each
 * distinct mismatch state (label + per-field stamp -> destination) is asked
 * about once per session. A dismissed notice therefore does not re-raise on
 * every settings keystroke while the same mismatch persists; it re-arms on the
 * next activation (fresh session memory) or when the mismatch itself changes
 * (the URL moved again). Two guards keep the question honest across its open
 * window: the mismatch must survive a short recheck delay before it is asked
 * about at all - a dashboard save's staged-write window (secrets re-stamped
 * for the new URL before the settings write lands) classifies a pass as
 * mismatched for well under that, so transient states neither raise the
 * question nor burn its arming key - and an answer applies only while a fresh
 * detection still keys identically to the state the question named, so an
 * entry or blob that moved under an open notification is left alone (the new
 * state re-arms and asks again).
 *
 * Deliberate residual, unchanged here: request paths keep their send-anyway
 * behavior while the question stands - the one-shot features knowingly send
 * the stored value to the new host and let the server's 401 tell the story
 * (entryConnectionFor's refusedSecrets contract), and the already-created
 * provider group keeps serving the OLD pairing the host froze at creation.
 * Only MCP refuses at resolve time. This notice is the consent surface, not a
 * request gate.
 */

import type { SecretFieldId } from "../../../shared/serverEntry";
import { errorLabel } from "../../../shared/util/errorLabel";
import type { DeclaredServerView } from "./engine";
import type { SecretStore, StoredSecretsRecord } from "./secrets";
import { readServerSecretsRecord, resolveOwnedSecrets, secretDestination, updateServerSecret } from "./secrets";
import type { DeclaredServer } from "./setting";
import { acceptedEntry } from "./setting";

/** The two answers the notice offers; dismissal is the absent third. */
export type StaleStampAnswer = "use-same" | "clear";

/** How long a mismatch must persist before the question is raised; see the module note. */
const RECHECK_DELAY_MS = 2000;

/** The slice of the sync engine the watcher reads; injectable for tests. */
export interface StaleStampNoticeEngine {
	onDidSync(listener: () => void): { dispose(): void };
	getDeclared(): readonly DeclaredServerView[];
}

/** The watcher's whole world; createServerSyncEnv's sibling wiring supplies the real one. */
export interface StaleStampNoticeEnv {
	/** The effective litellm-vscode-chat.servers value, read fresh per detection. */
	readServersSetting(): unknown;
	readonly secrets: SecretStore;
	/** Raise the one question for `label`; resolves the picked action, or undefined when dismissed. */
	ask(label: string): Promise<StaleStampAnswer | undefined>;
	requestSync(): void;
	/** English classifications only; labels and field ids at most, never values or stamps. */
	log(message: string, data?: unknown): void;
	/** The recheck wait; injectable so tests can mutate the world mid-wait instead of sleeping. */
	delay?(ms: number): Promise<void>;
}

/** One detected mismatch: the entry, its blob, and the refused fields, all from one read pair. */
interface DetectedMismatch {
	readonly entry: DeclaredServer;
	readonly record: StoredSecretsRecord;
	readonly refused: readonly SecretFieldId[];
}

export class StaleStampNotice {
	/** Mismatch states already asked about this session; see the module note for the re-arm rule. */
	private readonly asked = new Set<string>();
	/** Labels with an evaluation in flight (recheck wait or open notification): one question per label at a time. */
	private readonly pending = new Set<string>();
	/** Labels whose sync passes landed while pending; each gets one follow-up evaluation when its question settles. */
	private readonly rescan = new Set<string>();
	private readonly subscription: { dispose(): void };

	constructor(
		private readonly engine: StaleStampNoticeEngine,
		private readonly env: StaleStampNoticeEnv,
		private readonly recheckDelayMs = RECHECK_DELAY_MS
	) {
		this.subscription = engine.onDidSync(() => void this.scan());
	}

	dispose(): void {
		this.subscription.dispose();
	}

	/** One sweep over the last pass's views; exposed so tests can await what the listener fires. */
	async scan(): Promise<void> {
		for (const view of this.engine.getDeclared()) {
			if (view.syncFailure?.class !== "secretsMismatched") {
				continue;
			}
			try {
				await this.evaluate(view.label);
			} catch (error) {
				// A notification surface must never take the sync listener down; the
				// mismatch persists and the next pass re-evaluates.
				this.env.log("Raising the stale-stamped secret notice failed", {
					label: view.label,
					error: errorLabel(error),
				});
			}
		}
	}

	/**
	 * The engine's view classified the label; the mismatch itself is re-derived
	 * here through the same resolveOwnedSecrets check the engine ran, because
	 * the arming and application keys need the per-field stamps and
	 * destinations the view deliberately does not carry.
	 */
	private async detect(label: string): Promise<DetectedMismatch | undefined> {
		const found = acceptedEntry(this.env.readServersSetting(), label);
		if (found === undefined) {
			return undefined;
		}
		let record: StoredSecretsRecord;
		try {
			record = await readServerSecretsRecord(this.env.secrets, label);
		} catch {
			// An unreadable blob is the engine's "secretsUnreadable" story, not a
			// stamp mismatch; the read failure is already logged there.
			return undefined;
		}
		const refused = resolveOwnedSecrets(found.entry, record).refused;
		return refused.length > 0 ? { entry: found.entry, record, refused } : undefined;
	}

	/**
	 * The mismatch's identity: which fields, stamped for what, refused by which
	 * destination, structurally encoded (JSON over tuples - URLs are
	 * user-controlled text, so a character-delimited join could collide). The
	 * same persisting mismatch keys identically pass after pass, so a dismissed
	 * question stays dismissed for the session; any change to either side
	 * re-arms it, and an answer applies only against it.
	 */
	private keyOf(label: string, detected: DetectedMismatch): string {
		return JSON.stringify([
			label,
			detected.refused.map((field) => [
				field,
				detected.record.owners[field] ?? null,
				secretDestination(detected.entry, field),
			]),
		]);
	}

	private async evaluate(label: string): Promise<void> {
		if (this.pending.has(label)) {
			// A pass landing while this label's question is open (or mid-recheck)
			// may be the CHANGED state's only event; remember it, and the finally
			// below re-evaluates once the open question settles.
			this.rescan.add(label);
			return;
		}
		this.pending.add(label);
		try {
			await this.evaluateOnce(label);
		} finally {
			this.pending.delete(label);
			if (this.rescan.delete(label)) {
				await this.evaluate(label);
			}
		}
	}

	private async evaluateOnce(label: string): Promise<void> {
		const first = await this.detect(label);
		if (first === undefined) {
			return;
		}
		const key = this.keyOf(label, first);
		if (this.asked.has(key)) {
			return;
		}
		// The persistence gate: only a mismatch that keys identically on both
		// sides of the wait is a standing state worth a question (and worth
		// burning its once-per-session key on). A transient one - a save's
		// staged-write window, a keystroke mid-edit - simply evaporates, and
		// the next pass evaluates whatever stands then.
		await (this.env.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
			this.recheckDelayMs
		);
		const confirmed = await this.detect(label);
		if (confirmed === undefined || this.keyOf(label, confirmed) !== key) {
			return;
		}
		this.asked.add(key);
		let answer: StaleStampAnswer | undefined;
		try {
			answer = await this.env.ask(label);
		} catch {
			answer = undefined;
		}
		if (answer === undefined) {
			// Dismissal is a non-answer, not consent either way: the entry keeps
			// skipping and the question re-arms per the module note.
			this.env.log("Stale-stamped secret notice dismissed; the entry stays unsynced", { label });
			return;
		}
		try {
			await this.apply(label, key, answer);
		} catch (error) {
			// The blob write failed, so the mismatch still stands; forgetting the
			// key lets the next pass raise the question again instead of wedging.
			this.asked.delete(key);
			this.env.log("Applying the stale-stamped secret answer failed", {
				label,
				error: errorLabel(error),
			});
		}
	}

	/**
	 * Act on the answer only while a fresh detection still keys identically to
	 * the state the question named: the notification sat open, so the entry or
	 * the blob may have moved, and the answer must not mutate a state the user
	 * never saw - the changed state's own key is unasked, so the next pass
	 * raises its own question instead.
	 */
	private async apply(label: string, key: string, answer: StaleStampAnswer): Promise<void> {
		const fresh = await this.detect(label);
		if (fresh === undefined || this.keyOf(label, fresh) !== key) {
			this.env.log("Stale-stamped secret answer arrived after the mismatch changed; nothing applied", { label });
			return;
		}
		for (const field of fresh.refused) {
			if (answer === "use-same") {
				// The answer IS the deliberate pairing a stamp records: same value,
				// re-stamped for the destination the entry names now - the same
				// re-stamp the dashboard's edit save applies.
				await updateServerSecret(
					this.env.secrets,
					label,
					field,
					fresh.record.values[field],
					secretDestination(fresh.entry, field)
				);
			} else {
				await updateServerSecret(this.env.secrets, label, field, undefined, undefined);
			}
		}
		this.env.log(
			answer === "use-same"
				? "Stale-stamped secret re-stamped for the entry's current destination"
				: "Stale-stamped secret cleared",
			{ label, fields: fresh.refused }
		);
		this.env.requestSync();
	}
}
