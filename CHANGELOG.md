# Changelog

## [0.3.0](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.2.7...v0.3.0) (2026-06-07)


### Features

* add auto-assign workflow for PRs and issues ([276f2e9](https://github.com/Vivswan/litellm-vscode-chat/commit/276f2e974b325e780e1b32e2200a6dae1f1f356b))
* add comprehensive diagnostics for model discovery ([3bbc625](https://github.com/Vivswan/litellm-vscode-chat/commit/3bbc6251eadcfca74888f312f751ca7ec5f0aa9c))
* add Help & Feedback command and integrate into diagnostics ([0bf1dc2](https://github.com/Vivswan/litellm-vscode-chat/commit/0bf1dc2d4829e65bca33909451211b6fadcb7ee9))
* add manual trigger for bump-version workflow ([8ea8a19](https://github.com/Vivswan/litellm-vscode-chat/commit/8ea8a19c3bfbb1e3d4c93f1b756bb5462712bd52))
* add model-specific parameter customization ([823cf8b](https://github.com/Vivswan/litellm-vscode-chat/commit/823cf8b377ffb28a45f45998af84adf0a7263d90))
* add multi-server LiteLLM support ([145d1af](https://github.com/Vivswan/litellm-vscode-chat/commit/145d1af9a3e74cb01837e47bde3b51095fc8ff48))
* add prefilled GitHub issue reporting with sanitized diagnostics ([2df4bcb](https://github.com/Vivswan/litellm-vscode-chat/commit/2df4bcb9a16dcc7b1082d867594cefc942683d53))
* add token constraints from LiteLLM model info ([fa2f8b3](https://github.com/Vivswan/litellm-vscode-chat/commit/fa2f8b3c16844b8d06f759260036ca89ac88ff8e))
* centralized model defaults with per-model _replaceDefaults opt-in ([d918261](https://github.com/Vivswan/litellm-vscode-chat/commit/d9182611fee3df4cd849d0c6dfa591c5c6ae4bbf)), closes [#82](https://github.com/Vivswan/litellm-vscode-chat/issues/82)
* full LiteLLM multimodal compatibility for VS Code chat ([a25f8c3](https://github.com/Vivswan/litellm-vscode-chat/commit/a25f8c36d2aebfe8d7b8af8ae54abd113ff512eb)), closes [#73](https://github.com/Vivswan/litellm-vscode-chat/issues/73)
* Trim trailing slashes from baseUrl in config ([46292ad](https://github.com/Vivswan/litellm-vscode-chat/commit/46292adb1adc9815b6c0187874abe304c98fa781))


### Bug Fixes

* add explicit permissions to GitHub Actions workflows ([9535a3e](https://github.com/Vivswan/litellm-vscode-chat/commit/9535a3ec0dc6bf1af796daaa0c58b573dd547791))
* add HUSKY=0 to create-pull-request action ([16a6e4b](https://github.com/Vivswan/litellm-vscode-chat/commit/16a6e4bfb306c230b1b813849367905ac04c8ba0))
* add slash validation to edit flow, fix log message, remove dupe JSDoc ([2bcad06](https://github.com/Vivswan/litellm-vscode-chat/commit/2bcad06f7c7fed7bd4600176ad8bc858988212c7))
* address PR [#95](https://github.com/Vivswan/litellm-vscode-chat/issues/95) review feedback ([05ee36f](https://github.com/Vivswan/litellm-vscode-chat/commit/05ee36f75cd0116b366a082c1bd30c6448717dbf))
* address PR review feedback for multi-server support ([f379116](https://github.com/Vivswan/litellm-vscode-chat/commit/f3791164cac77f31ec3b84aa441a8134b3ba25d8))
* address remaining PR [#95](https://github.com/Vivswan/litellm-vscode-chat/issues/95) review feedback ([62172a1](https://github.com/Vivswan/litellm-vscode-chat/commit/62172a11f6a922c23fd2852b26a05f82d3c38a1a))
* bump-version workflow was pushing directly to main ([dd536e1](https://github.com/Vivswan/litellm-vscode-chat/commit/dd536e1565b856e6533f58574ee5bf5790025173))
* correct invalid .gitignore Icon pattern ([f60d041](https://github.com/Vivswan/litellm-vscode-chat/commit/f60d04136d84a45d803039edd0d782d1c36501ea))
* delete stale version-bump branch before pushing ([45a14cc](https://github.com/Vivswan/litellm-vscode-chat/commit/45a14ccd8a73745777237681bc63f391b328b09c))
* filter VS Code internal keys from modelOptions pass-through ([e30a61a](https://github.com/Vivswan/litellm-vscode-chat/commit/e30a61aac76b3bfa0d309223dac04d52e449e115))
* handle null token limits and add mock server script ([f7805d0](https://github.com/Vivswan/litellm-vscode-chat/commit/f7805d0ffdf890f7f761e0a6cff4d70b9568623b))
* improve error handling for 'Add models' button ([628b5d0](https://github.com/Vivswan/litellm-vscode-chat/commit/628b5d0f0edff0f5d9dfed97b1761e18e0ed3c7c))
* reduce issue URL size and copy full diagnostics to clipboard ([105f7a1](https://github.com/Vivswan/litellm-vscode-chat/commit/105f7a13700121da9db839e0cc64ec2fdeaf51cd))
* resolve ESLint errors and configure pre-commit hooks ([de3b3a6](https://github.com/Vivswan/litellm-vscode-chat/commit/de3b3a602f8c2e419337eb38ca4aa3e3cec9998c))
* skip auto-assign for fork PRs to prevent permission errors ([c28a8ba](https://github.com/Vivswan/litellm-vscode-chat/commit/c28a8ba39d5ea642d70175cef6f5c674290ebd9b))
* use force-with-lease for version bump branch push ([e6a2969](https://github.com/Vivswan/litellm-vscode-chat/commit/e6a2969d5b99cd590066a3396d6f3107c703714c))
