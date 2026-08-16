/**
 * The instant every rendered page believes it is: the harness freezes the page's
 * Date to this epoch and the fixtures derive their timestamps from it, so
 * relative and absolute labels come out identical on every render. Both sides
 * import this one constant; a timestamp computed from anything else would drift
 * against the page clock.
 */
export const RENDER_EPOCH_MS = Date.UTC(2026, 5, 15, 12, 0, 0);
