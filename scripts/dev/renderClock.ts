/**
 * The instant every rendered page believes it is: the harness freezes the
 * page's Date to this epoch and the fixtures derive their timestamps from it,
 * so relative labels ("2 minutes ago") and absolute labels (locale date
 * strings) come out identical on every render - two screenshots of the same
 * surface should differ only where the UI did. Both sides import this one
 * constant; a fixture timestamp computed from anything else would drift
 * against the page clock.
 */
export const RENDER_EPOCH_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
