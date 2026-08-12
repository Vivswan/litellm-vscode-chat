// Stylesheet imports are side-effect-only: the bundle script emits them as the
// sibling css output and bun's test runtime resolves them as no-ops.
declare module "*.css";
