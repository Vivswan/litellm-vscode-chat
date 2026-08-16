import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";

/**
 * One spoken announcement per standing failure, however many surfaces render it and
 * however often they remount: a bare role="alert" re-announces on every mount, so an
 * unchanged failure was re-spoken on every tab change; keying to the failure's seq turns
 * "this line is on screen" back into "this just happened". The VISIBLE line always
 * renders - only the announcement dedupes. A Set of seqs (App mints them from one
 * counter) in App-scoped context, so a remounted App starts with nothing announced.
 */
const AnnouncedSeqs = createContext<Set<number> | undefined>(undefined);

/** The dashboard-wide announcement memory; App wraps its shell in exactly one. */
export function AnnounceOnceScope({ children }: { children: ReactNode }) {
	const announced = useRef<Set<number> | undefined>(undefined);
	announced.current ??= new Set();
	return <AnnouncedSeqs.Provider value={announced.current}>{children}</AnnouncedSeqs.Provider>;
}

/**
 * The role for a standing failure's notice: "alert" until its seq has been spoken,
 * absent after. The seq is recorded in an effect, not during render, so the announcing
 * render commits with the role in place; a twin mounting hidden in the same commit
 * counts as spoken. Outside a scope every mount announces (what a lone surface wants).
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
