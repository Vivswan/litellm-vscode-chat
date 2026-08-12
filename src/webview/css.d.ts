// Stylesheet imports are side-effect-only: esbuild bundles them into the
// sibling css output and bun's test runtime resolves them as no-ops.
declare module "*.css";
