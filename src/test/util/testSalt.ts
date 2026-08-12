/**
 * The fixed, public fingerprint salt every test bootstrap pins before any
 * suite computes a fingerprint: the Mocha unit label via util/fingerprintSalt
 * and the bun tree via bun/preload. Deliberately vscode-free so both runners
 * can load it.
 */
export const FIXED_TEST_SALT = "litellm-vscode-chat unit-test fingerprint salt (fixed, not a secret)";
