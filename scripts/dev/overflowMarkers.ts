/**
 * The wire between render-dashboard.ts and check-overflow.ts: the harness
 * prints these words and the sweep classifies each fixture by grepping for
 * them, the same idiom as check-geometry's GEOMETRY-* markers. The prose
 * around them is for humans and free to reword; the markers are the contract.
 */

/** Carried by every horizontal-overflow failure the harness throws. */
export const OVERFLOW_SIDEWAYS_MARKER = "OVERFLOW-SIDEWAYS";

/** Printed when a measuredAtOwnWidth fixture skips the width sweep. */
export const OWN_WIDTH_ONLY_MARKER = "OVERFLOW-OWN-WIDTH";
