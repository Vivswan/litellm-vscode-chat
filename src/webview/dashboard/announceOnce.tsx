import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";

/**
 * One spoken announcement per standing failure, however many surfaces can
 * render it and however often they remount.
 *
 * A standing failure outlives navigation, and more than one surface renders
 * it - the settings page places a refused write under its owning row, while
 * the pane top carries the same failure whenever that page is hidden. A bare
 * role="alert" re-announces on every mount, so an unchanged failure was
 * re-spoken on every tab change; keying the announcement to the failure's
 * seq is what turns "this line is on screen" back into "this just happened".
 * The VISIBLE line always renders - only the announcement dedupes.
 *
 * The registry is a Set of announced seqs rather than a last-seq-per-channel
 * map because App mints seqs from one counter, so a seq alone names a
 * failure; it lives in App-scoped context rather than module state so a
 * remounted App (each test, a reopened panel) starts with nothing announced.
 * Growth is bounded by the counter: a session accumulates one entry per
 * failure envelope, and failures are rare.
 */
const AnnouncedSeqs = createContext<Set<number> | undefined>(undefined);

/** The dashboard-wide announcement memory; App wraps its shell in exactly one. */
export function AnnounceOnceScope({ children }: { children: ReactNode }) {
	const announced = useRef<Set<number> | undefined>(undefined);
	announced.current ??= new Set();
	return <AnnouncedSeqs.Provider value={announced.current}>{children}</AnnouncedSeqs.Provider>;
}

/**
 * The role attribute for a standing failure's notice: "alert" until the
 * failure's seq has been spoken once, absent after. The seq is recorded in
 * an effect, not during render, so the announcing render commits with the
 * role in place and only the NEXT render stands it down - an element that
 * mounts hidden in the same commit still counts as spoken, because the
 * visible twin announcing it is what the reader heard. Outside a scope
 * (a component test rendering one surface alone) every mount announces,
 * which is the pre-dedupe behavior a lone surface wants.
 */
export function useAlertOnce(seq: number | undefined): "alert" | undefined {
	const announced = useContext(AnnouncedSeqs);
	useEffect(() => {
		if (seq !== undefined) {
			announced?.add(seq);
		}
	}, [announced, seq]);
	if (seq === undefined) {
		return undefined;
	}
	return announced === undefined || !announced.has(seq) ? "alert" : undefined;
}
