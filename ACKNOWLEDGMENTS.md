# Acknowledgments

Every name here made the extension concretely better. Code contributions are credited here and as
commit co-authors. Bug reports and feature requests are credited here when
the fix landed in a traceable commit; from the adoption of the convention
below they are also credited in commit subjects, which release-please
carries into the changelog (commit history cannot be rewritten to backfill
the older ones).

Reports that were resolved without a code change (configuration issues,
stale reports, or fixes that predate traceable history) are not listed - a
row here means the report changed the code.

## Code contributions

Pull requests that were merged, or whose implementations and ideas were
folded into later rewrites of the same feature. The historical landing
commits predate the co-author convention below; as a one-time backfill,
everyone in this table is credited with a `Co-authored-by:` trailer on the
commit that introduced this file.

| Author | Contribution |
|---|---|
| [@albertlast](https://github.com/albertlast) | OAuth2 client-credentials authentication ([#165](https://github.com/Vivswan/litellm-vscode-chat/pull/165), via [#161](https://github.com/Vivswan/litellm-vscode-chat/issues/161)) |
| [@ali-corpo](https://github.com/ali-corpo) | Pricing metadata and live pricing ([#124](https://github.com/Vivswan/litellm-vscode-chat/pull/124), precursor to the picker pricing feature) |
| [@amwdrizz](https://github.com/amwdrizz) | Token constraints from model info ([#7](https://github.com/Vivswan/litellm-vscode-chat/pull/7), [#8](https://github.com/Vivswan/litellm-vscode-chat/pull/8), closed unmerged; reimplemented on main shortly after) |
| [@drajnic](https://github.com/drajnic) | Model info support and prompt caching groundwork ([#32](https://github.com/Vivswan/litellm-vscode-chat/pull/32), merged) |
| [@manitra](https://github.com/manitra) | Model discovery caching (proposed in [#195](https://github.com/Vivswan/litellm-vscode-chat/pull/195) for [#190](https://github.com/Vivswan/litellm-vscode-chat/issues/190); closed unmerged, reimplemented on main) |
| [@martinschmatz](https://github.com/martinschmatz) | Multi-anchor prompt caching for agent sessions ([#125](https://github.com/Vivswan/litellm-vscode-chat/issues/125); [#142](https://github.com/Vivswan/litellm-vscode-chat/pull/142) explored a mode/TTL design, closed unmerged); also suggested the README cache TTL note |
| [@uiop860](https://github.com/uiop860) | Centralized model defaults (proposed in [#83](https://github.com/Vivswan/litellm-vscode-chat/pull/83) for [#82](https://github.com/Vivswan/litellm-vscode-chat/issues/82); closed unmerged, superseded by the maintainer's [#84](https://github.com/Vivswan/litellm-vscode-chat/pull/84)) |
| [@Unlifate](https://github.com/Unlifate) | Base URL trailing-slash handling ([#55](https://github.com/Vivswan/litellm-vscode-chat/pull/55), merged) |

## Bug reports and feature requests

| Author | Helped with |
|---|---|
| [@adrenalinedj](https://github.com/adrenalinedj) | Configurable request timeout ([#104](https://github.com/Vivswan/litellm-vscode-chat/issues/104)) |
| [@carvajalluis](https://github.com/carvajalluis) | Filtering blocked models out of discovery ([#182](https://github.com/Vivswan/litellm-vscode-chat/issues/182)) |
| [@cihatsarsilmaz](https://github.com/cihatsarsilmaz) | Diagnostics reports that surfaced the issue-reporter double-encoding bug ([#192](https://github.com/Vivswan/litellm-vscode-chat/issues/192), [#193](https://github.com/Vivswan/litellm-vscode-chat/issues/193)) |
| [@doggy8088](https://github.com/doggy8088) | Models missing from the model picker, which drove the discovery diagnostics ([#19](https://github.com/Vivswan/litellm-vscode-chat/issues/19)) |
| [@emelylongpre1414](https://github.com/emelylongpre1414) | Diagnostics report that surfaced the issue-reporter double-encoding bug ([#189](https://github.com/Vivswan/litellm-vscode-chat/issues/189)) |
| [@gavinvw](https://github.com/gavinvw) | Models not shown in the Language Models window ([#188](https://github.com/Vivswan/litellm-vscode-chat/issues/188)) |
| [@i20dv](https://github.com/i20dv) | Diagnostics report that surfaced the issue-reporter double-encoding bug ([#191](https://github.com/Vivswan/litellm-vscode-chat/issues/191)) |
| [@K0IN](https://github.com/K0IN) | Reasoning effort selection request ([#177](https://github.com/Vivswan/litellm-vscode-chat/issues/177)) |
| [@kfkawalec](https://github.com/kfkawalec) | Pasted/attached images never reaching LiteLLM ([#73](https://github.com/Vivswan/litellm-vscode-chat/issues/73)) |
| [@kushagra-patel-nykaa](https://github.com/kushagra-patel-nykaa) | Models missing on VS Code 1.120+, `isUserSelectable` placement ([#119](https://github.com/Vivswan/litellm-vscode-chat/issues/119)) |
| [@Lw-CodeStorage](https://github.com/Lw-CodeStorage) | Sticker images not recognized in chat ([#141](https://github.com/Vivswan/litellm-vscode-chat/issues/141)) |
| [@o-l-a-v](https://github.com/o-l-a-v) | Confirming and narrowing the missing-models report ([#188](https://github.com/Vivswan/litellm-vscode-chat/issues/188)) |
| [@Pandaplanes](https://github.com/Pandaplanes) | Base URL trailing-slash normalization ([#53](https://github.com/Vivswan/litellm-vscode-chat/issues/53)) |
| [@proxium](https://github.com/proxium) | Custom HTTP headers for virtual keys ([#157](https://github.com/Vivswan/litellm-vscode-chat/issues/157)) |
| [@qisthidev](https://github.com/qisthidev) | Provider missing on newest VS Code ([#105](https://github.com/Vivswan/litellm-vscode-chat/issues/105)) |
| [@s0301132](https://github.com/s0301132) | Server profiles request ([#94](https://github.com/Vivswan/litellm-vscode-chat/issues/94)) |
| [@TheLastNever](https://github.com/TheLastNever) | max_tokens from model_info request ([#174](https://github.com/Vivswan/litellm-vscode-chat/issues/174)) |
| [@uiop860](https://github.com/uiop860) | Wrong gpt-5.5 default parameters ([#82](https://github.com/Vivswan/litellm-vscode-chat/issues/82)) |
| [@Unlifate](https://github.com/Unlifate) | Base URL trailing-slash normalization ([#54](https://github.com/Vivswan/litellm-vscode-chat/issues/54)) |
| [@wartzar-bee](https://github.com/wartzar-bee) | Prompt-caching discussion ([#125](https://github.com/Vivswan/litellm-vscode-chat/issues/125)) |
| [@webysther](https://github.com/webysther) | Provider name in the model list ([#48](https://github.com/Vivswan/litellm-vscode-chat/issues/48)) |
| [@wgenchi-mwb](https://github.com/wgenchi-mwb) | Prompt-caching discussion ([#125](https://github.com/Vivswan/litellm-vscode-chat/issues/125)) |
| [@yongzhang](https://github.com/yongzhang) | Load-balanced model group display ([#183](https://github.com/Vivswan/litellm-vscode-chat/issues/183)) |
| [@yongzhang](https://github.com/yongzhang) | Silent empty response from reasoning models, with the missing end-of-stream guard pinpointed ([#215](https://github.com/Vivswan/litellm-vscode-chat/issues/215)) |

If you reported something and are missing here, open an issue or PR and say
so - the list is maintained by hand.

## Ongoing credit

- A commit that resolves a community-reported issue or feature request
  credits the reporter in its subject, for example
  `fix: normalize base URL slashes (#53, thanks @Pandaplanes)`.
  release-please copies the subject into [CHANGELOG.md](CHANGELOG.md), so the
  acknowledgment ships with the release.
- A commit that lands community code, or supersedes a community PR while
  keeping its ideas, carries a `Co-authored-by:` trailer for the human
  author, and this file gains a row.
