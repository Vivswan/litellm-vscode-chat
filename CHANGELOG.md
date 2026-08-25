# Changelog

## [0.6.0](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.5.0...v0.6.0) (2026-08-25)


### ⚠ BREAKING CHANGES

* drop the parked global-headers record and its recovery flow
* drop the stale-stamp re-raise notice engine
* drop the v0.3.1 label-scoped parameter expansion
* always clear stored keys an import does not replace
* drop the legacy-registry migration; very old installs re-add servers
* retire the legacy registry and make parked migration state consumable
* drop pre-rename status readings and the pinned legacy group-identity format
* replace the two inline-completion language lists with one mode-based filter

### Features

* add a dashboard features page and a registry-driven feature architecture ([9c45ae0](https://github.com/Vivswan/litellm-vscode-chat/commit/9c45ae0ef8b69ec79c037cccce38b4b76027a57d))
* add AI review comments on your changes ([66a318e](https://github.com/Vivswan/litellm-vscode-chat/commit/66a318e422178d62043daa519a25d6c5b361e4aa))
* add commit message generation command ([82e5fbd](https://github.com/Vivswan/litellm-vscode-chat/commit/82e5fbddf734b4ab94513b04864785c07a230bd8))
* add fix and explain quick fixes on diagnostics ([c23058e](https://github.com/Vivswan/litellm-vscode-chat/commit/c23058ecb1e2e653c67072c6b54845fc5037700e))
* add inline completion and commit generation settings scaffolding ([e6ed047](https://github.com/Vivswan/litellm-vscode-chat/commit/e6ed047aad757d48e8a531b10d01a58943cfffe6))
* add inline completions from LiteLLM FIM models ([311e50c](https://github.com/Vivswan/litellm-vscode-chat/commit/311e50c952d896015426cf660319d965daf6689e))
* answer [@litellm](https://github.com/litellm) chat turns with slash commands ([cb536e2](https://github.com/Vivswan/litellm-vscode-chat/commit/cb536e21fe9f3bb5b1fe3f17cd40489108a66c5b))
* confirm the stored key when a server's URL changes ([7a47643](https://github.com/Vivswan/litellm-vscode-chat/commit/7a476432b43cba8b931da27085e0168adab44689))
* drop the legacy-registry migration; very old installs re-add servers ([90d4472](https://github.com/Vivswan/litellm-vscode-chat/commit/90d4472fc8dc6fd588f7ad52ccecfe2bddf0ea98))
* drop the parked global-headers record and its recovery flow ([64c5e01](https://github.com/Vivswan/litellm-vscode-chat/commit/64c5e01c9b5ef2c96705e62c9092cfb0194ccb03))
* drop the stale-stamp re-raise notice engine ([09e9778](https://github.com/Vivswan/litellm-vscode-chat/commit/09e97786e469849ec3fcde96662fba7eb3a8c0ae))
* drop the v0.3.1 label-scoped parameter expansion ([b763ee9](https://github.com/Vivswan/litellm-vscode-chat/commit/b763ee90e9f9ea2f272258681674d777b33d3a42))
* expose a LiteLLM consult tool for agent mode ([b83e2d6](https://github.com/Vivswan/litellm-vscode-chat/commit/b83e2d69f0f05fee97f7a1850eca6ebdeb15c2c3))
* generate PR titles and descriptions with a LiteLLM model ([6b49352](https://github.com/Vivswan/litellm-vscode-chat/commit/6b493524cefe440e64f510be11b03f781cbddc06))
* generate the settings reference from the settings spec ([0a8d8fd](https://github.com/Vivswan/litellm-vscode-chat/commit/0a8d8fd92b91a51fb138a4368912fd8b3911fbd6))
* publish MCP servers from declared LiteLLM entries ([47ae3f4](https://github.com/Vivswan/litellm-vscode-chat/commit/47ae3f498917eb5e66a454c21d7542de4b894a57))
* replace the two inline-completion language lists with one mode-based filter ([a95c573](https://github.com/Vivswan/litellm-vscode-chat/commit/a95c5734ccea02fa71fb68d574bf6a8b3a745ebc))
* retire the legacy registry and make parked migration state consumable ([29481f9](https://github.com/Vivswan/litellm-vscode-chat/commit/29481f967fe710dbf60e5feed8bc5f20e57bf7ab))


### Bug Fixes

* align commit generation errors, privacy claims, and naming across features ([9b4b6bc](https://github.com/Vivswan/litellm-vscode-chat/commit/9b4b6bc3ac8221d4cd93cb5309e9d0e179b9110b))
* align feature copy and retire the hand-counted recipe number ([343da5a](https://github.com/Vivswan/litellm-vscode-chat/commit/343da5ad10d13ee7c83aeac41e1a603bb8789387))
* bound each OAuth-exchange joiner by its own timeout and error surface ([0bf38e8](https://github.com/Vivswan/litellm-vscode-chat/commit/0bf38e8163960aaf3f3f201464b629ecbe4d6e87))
* edit the commit message prompt in a multiline editor ([856d146](https://github.com/Vivswan/litellm-vscode-chat/commit/856d14611f1d90b0036b9e793562a0b8888f4e12))
* escape backslashes in participant reference labels ([e6ef3cc](https://github.com/Vivswan/litellm-vscode-chat/commit/e6ef3cc8732e1721b98bdbefc7f323200d59cd1d))
* match OAuth exchange timeout advice and commit error format to their surfaces ([455f115](https://github.com/Vivswan/litellm-vscode-chat/commit/455f115afab63c997a63550039db4291753d31ef))
* pin vscode typings to the engines floor and refuse malformed language-filter requests ([4789170](https://github.com/Vivswan/litellm-vscode-chat/commit/4789170793bc1fa5da5d42d2fdaaf33289e43554))
* register entry fields once and make sync failures unrepresentable half-set ([2f82a43](https://github.com/Vivswan/litellm-vscode-chat/commit/2f82a435ec8072e0ddfc86b8a27651dbef57aa4a))
* restore the VSIX packaging and Marketplace publish in the release hook ([548003b](https://github.com/Vivswan/litellm-vscode-chat/commit/548003bbc002e6c94ff8f1d848ada334159304e5))
* route model-facing file labels and command failures through their owners ([7ea122d](https://github.com/Vivswan/litellm-vscode-chat/commit/7ea122d374e5c77a08395bbff2e04b83a53b0b08))
* scope egress-controlling feature settings to machine-overridable ([02527b8](https://github.com/Vivswan/litellm-vscode-chat/commit/02527b8e9c2beff902f948047eca203f32c6f3fd))


### Code Refactoring

* always clear stored keys an import does not replace ([fdef41b](https://github.com/Vivswan/litellm-vscode-chat/commit/fdef41b098b666cbb2e6ee623d1fc9abcee09cad))
* drop pre-rename status readings and the pinned legacy group-identity format ([f3559d3](https://github.com/Vivswan/litellm-vscode-chat/commit/f3559d3ad8f52ba544db036162a38f32f0fd2a7f))

## [0.5.0](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.7...v0.5.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* make the server editor a destination instead of a panel over the page
* port the dashboard webview from Preact to React 19
* redesign the dashboard message protocol around one endpoint table

### Features

* add a chat.tokenEstimation setting with lazy-loaded gpt-tokenizer encodings ([5337a5d](https://github.com/Vivswan/litellm-vscode-chat/commit/5337a5d625293d6d4b172cddb62be9affc78f8a8))
* add a currency symbol setting for spend displays ([d7c2c85](https://github.com/Vivswan/litellm-vscode-chat/commit/d7c2c8523b2741e1c8d7b2550debd1d12c86cac0))
* add discovery.staleServeWindow and derive the host-refresh deadline from discovery.timeout ([4e59b99](https://github.com/Vivswan/litellm-vscode-chat/commit/4e59b99494e1fea005420911fb230254b60513d8))
* add Tailwind with a VS Code theme-token design system ([cc55d4b](https://github.com/Vivswan/litellm-vscode-chat/commit/cc55d4b2d5a94cd79fce08e009f30fe2888364f2))
* add the Radio primitive and let a disabled quiet button stay quiet ([5e786d6](https://github.com/Vivswan/litellm-vscode-chat/commit/5e786d67728bf11ef5931cdd18e404ee4e8e18cb))
* adopt shadcn primitives on the token theme ([d87da60](https://github.com/Vivswan/litellm-vscode-chat/commit/d87da60c73d0deabc0ff278efc92a84eeb9f3120))
* copy the configuration problems, not just the connections ([6e34a27](https://github.com/Vivswan/litellm-vscode-chat/commit/6e34a27bca79d3815831cefdd2c4d5614ea79ab9))
* **dashboard:** badge wrong-record-type directive keys as ignored ([d93bd8b](https://github.com/Vivswan/litellm-vscode-chat/commit/d93bd8bda080b04c587b9d68f4b3de276fd054d1))
* **dashboard:** collapse the rail to icons when the window is narrow ([2f6af49](https://github.com/Vivswan/litellm-vscode-chat/commit/2f6af49040f386301008c9ab12f58d7dff58dba8))
* **dashboard:** color action buttons and links by scenario ([9195618](https://github.com/Vivswan/litellm-vscode-chat/commit/91956183ca30e1e945f7ba8a2be8b6df3f91c1b0))
* **dashboard:** filter the models list with structured pills ([0c6e1de](https://github.com/Vivswan/litellm-vscode-chat/commit/0c6e1de9f7a301beb7f1155a35b37ca527237df8))
* **dashboard:** fold the server row onto two lines in a narrow pane ([6277848](https://github.com/Vivswan/litellm-vscode-chat/commit/62778480bf93d1329468c5259ec95e88c7e02bf8))
* **dashboard:** let a wide pane read the models list as columns ([654806b](https://github.com/Vivswan/litellm-vscode-chat/commit/654806bbfec210c45264d8f902c0b5033f147cde))
* **dashboard:** list entry records in the server drawer and move warn-tier budget notices there ([1685e21](https://github.com/Vivswan/litellm-vscode-chat/commit/1685e21785fe386945dedf9b6597023470eac545))
* **dashboard:** one hoverable, dismissible tooltip for the whole page ([8491d3e](https://github.com/Vivswan/litellm-vscode-chat/commit/8491d3e9241f1a2c177b325252613a8c1d0077b3))
* **dashboard:** rebuild the settings page on one full-bleed row anatomy ([627ea6f](https://github.com/Vivswan/litellm-vscode-chat/commit/627ea6f78e29c4481241bd9ced6aeb4d9018938a))
* **dashboard:** replace the edit page's inline discard strip with a real modal ([4358697](https://github.com/Vivswan/litellm-vscode-chat/commit/4358697f70f06216ad1562b2b0903dea12454dcf))
* **dev:** assert the dashboard does not scroll sideways, at every declared width ([aa6b81c](https://github.com/Vivswan/litellm-vscode-chat/commit/aa6b81c05dc5c8053ef8d1c0e41673747307aa2c))
* **dev:** seed error-state demo servers so failures are visible in the dev host ([86ba177](https://github.com/Vivswan/litellm-vscode-chat/commit/86ba1774a9c47814955c00db679e9ea8834a8fca))
* give each model a readable row that opens in place ([4f3b9b7](https://github.com/Vivswan/litellm-vscode-chat/commit/4f3b9b77424b729a40005698fe448fa402fe1f1e))
* give the dashboard an appearance picker that applies as you click it ([6c0de87](https://github.com/Vivswan/litellm-vscode-chat/commit/6c0de87688e5a50557c088b3cfb904d6ddc441b6))
* give the dashboard its own theme and accent settings ([7618c23](https://github.com/Vivswan/litellm-vscode-chat/commit/7618c236c9febf74fed55c80c95b080d1fcbbbc2))
* lay the server edit page out as one flat scroll ([20d4207](https://github.com/Vivswan/litellm-vscode-chat/commit/20d4207b717b007639a1918703aabeb4b6f362fa))
* lead diagnostics with what you can act on and stop repeating the server rows ([700f4a3](https://github.com/Vivswan/litellm-vscode-chat/commit/700f4a30391d60d41528bff817af447a68f9d083))
* let the dashboard's sync answer for itself instead of being watched ([c39ab7c](https://github.com/Vivswan/litellm-vscode-chat/commit/c39ab7c1852b7a04f24666616dbb27a143fa2bc8))
* make the buttons typographic and give danger its own variant ([a445f78](https://github.com/Vivswan/litellm-vscode-chat/commit/a445f780e275797aacb80d7f39c6646abc8d2028))
* make the server editor a destination instead of a panel over the page ([98dc6b2](https://github.com/Vivswan/litellm-vscode-chat/commit/98dc6b2e88edf7eeeb51e37d049bbe3e02e17c3e))
* make the tool-schema and usage-window constants configurable ([99726be](https://github.com/Vivswan/litellm-vscode-chat/commit/99726be7783d02391dd8268cdd81ac3f0b4febb5))
* merge the Servers and Usage destinations into one ([ba911f5](https://github.com/Vivswan/litellm-vscode-chat/commit/ba911f5a704c41a59a03418ea07493d8f1c0daec))
* move the slide-over onto Radix Dialog ([9c1fc80](https://github.com/Vivswan/litellm-vscode-chat/commit/9c1fc803d9e09f7ea8a86cb3355f3f140bee59be))
* put each server's problems under the row that owns them ([188cdd4](https://github.com/Vivswan/litellm-vscode-chat/commit/188cdd413c78614c97dc141b9fe786e762874d2c))
* rebuild the model inspector around the provenance chain ([40d079b](https://github.com/Vivswan/litellm-vscode-chat/commit/40d079bd4a2a0d41692a6214340f29a1bca08906))
* rebuild usage and settings on the approved dashboard design ([f7e03ea](https://github.com/Vivswan/litellm-vscode-chat/commit/f7e03ea3842b098831381b70ae82d0248f5872ae))
* render the harness in light as well as dark ([2f442cd](https://github.com/Vivswan/litellm-vscode-chat/commit/2f442cdf88c4267fb02d1c74b5c04b4b90fb17a0))
* replace the tab strip with a rail that keeps the fleet's state on screen ([03cd53e](https://github.com/Vivswan/litellm-vscode-chat/commit/03cd53ee62d9b5d40a5f073348f315b204856378))
* resolve the reasoning-effort levels from capabilities and the server ([#265](https://github.com/Vivswan/litellm-vscode-chat/issues/265), [#266](https://github.com/Vivswan/litellm-vscode-chat/issues/266), thanks [@calexandre](https://github.com/calexandre)) ([ac58b1c](https://github.com/Vivswan/litellm-vscode-chat/commit/ac58b1ce7f4f36168c03d0ef1cef315bcf387bb1))
* split servers and models into separate rail destinations ([c221ec5](https://github.com/Vivswan/litellm-vscode-chat/commit/c221ec5b16b9d5d12cb24f2aa67c2d1e8ea25ce6))


### Bug Fixes

* announce a sync's outcome and say when a retry is running ([0895901](https://github.com/Vivswan/litellm-vscode-chat/commit/0895901971e18674d3a4fe17e4d71b15270c7e01))
* **catalog:** record declared models into the status window they are served from ([04fcc70](https://github.com/Vivswan/litellm-vscode-chat/commit/04fcc70e854b96c6448b2bff155b51cf0e839a04))
* **catalog:** record exactly the override-decorated set a group serves on every branch ([7780df7](https://github.com/Vivswan/litellm-vscode-chat/commit/7780df7e9901ca7b091a2f90d046522ab42879ed))
* **ci:** exempt the tokenizer suite's script test data from the typography check ([1cce70d](https://github.com/Vivswan/litellm-vscode-chat/commit/1cce70d1dcb6e197b8a77d4deb18219e4e9cff0d))
* clear a credential stranded under a mismatched entry before waking the failure-path sync ([89596de](https://github.com/Vivswan/litellm-vscode-chat/commit/89596dead0101ce299ae88bb47f4c8cc2fb91723))
* close out the review follow-ups from the redesign wave ([157d0a8](https://github.com/Vivswan/litellm-vscode-chat/commit/157d0a875a4fc907414ca71b58c7d168fbe8123c))
* close out the settings-landing review follow-ups ([d1eb345](https://github.com/Vivswan/litellm-vscode-chat/commit/d1eb34546ef93d206e7fa4a661ed22d69c9ee03e))
* close the remaining URL-credential echo paths ([cd8bd00](https://github.com/Vivswan/litellm-vscode-chat/commit/cd8bd0007e8563098a5db9d68757e8f3ea00054c))
* **config:** widen the directive sweep and route every consumer through the registry ([ebe1676](https://github.com/Vivswan/litellm-vscode-chat/commit/ebe16764495bfc781f656e00f0cc41055861a18e))
* **conversion:** keep every tool answer adjacent to its call on the wire ([169a1dc](https://github.com/Vivswan/litellm-vscode-chat/commit/169a1dca9c99f401a54c329861f022bfb58f46d4))
* **conversion:** pair tool calls by one normalized id from validation to the wire ([f643c4e](https://github.com/Vivswan/litellm-vscode-chat/commit/f643c4e2015e5bb6088b32fcca8bea2d324dfa63))
* **conversion:** price exactly what ships by converting once ([cf7d50e](https://github.com/Vivswan/litellm-vscode-chat/commit/cf7d50e36898c8d1c6c17d5ecb8cd237a14986a8))
* **conversion:** price the already-converted request instead of converting twice ([9b5e36f](https://github.com/Vivswan/litellm-vscode-chat/commit/9b5e36f8c451e144d3797da278f765299728584c))
* **conversion:** reject tool-call id reuse inside one emitted tool_calls array ([f5c4498](https://github.com/Vivswan/litellm-vscode-chat/commit/f5c4498ad7b9a0d481b7380db079b04017ee0510))
* correct six claims the closing review found, and pin what it found unpinned ([aa42c02](https://github.com/Vivswan/litellm-vscode-chat/commit/aa42c02bd72ea1ab924d4172c556d6f32178a189))
* cut the inspector's prose and right-align its numerics ([543ad03](https://github.com/Vivswan/litellm-vscode-chat/commit/543ad03cf4cb902f68664c44e6a5167c1b3e20ec))
* darken the status meter fills on light surfaces ([a844309](https://github.com/Vivswan/litellm-vscode-chat/commit/a84430989f973cd4c7811f98cd96f2c8102de2cb))
* **dashboard:** align glyph trails, compact rows, and stop burying page actions ([4391035](https://github.com/Vivswan/litellm-vscode-chat/commit/43910359fc6e64bd9b5dfbedfc2763ce409f4dee))
* **dashboard:** align the servers page's edges, disclosures, and in-flight status ([35a291c](https://github.com/Vivswan/litellm-vscode-chat/commit/35a291c70a98a92718c0fd1ace2338c4f9acc966))
* **dashboard:** an untouched threshold box never rewrites settings on blur ([a96bb01](https://github.com/Vivswan/litellm-vscode-chat/commit/a96bb0153cf3a1c96b873b677cfad9616bf165fb))
* **dashboard:** announce failures once per seq and rank problem rows for screen readers ([c0b97aa](https://github.com/Vivswan/litellm-vscode-chat/commit/c0b97aa7520b6fa0295fce64d330734f798b7ea4))
* **dashboard:** assemble server entries once for save, adopt, and test-connection ([148ac00](https://github.com/Vivswan/litellm-vscode-chat/commit/148ac002b2031cebf8b4f00088118b8f56c30361))
* **dashboard:** bind every chip and field radius to its shape token ([0a0bf66](https://github.com/Vivswan/litellm-vscode-chat/commit/0a0bf66274b07ef5fb16919d20d246a9dac8516f))
* **dashboard:** bind server saves and probes to the entry the form displayed ([dcb5d70](https://github.com/Vivswan/litellm-vscode-chat/commit/dcb5d7023b811db18e459ef87aec6e4c7ab5de16))
* **dashboard:** block saving an auth form that does not send the stored API key ([9a46b10](https://github.com/Vivswan/litellm-vscode-chat/commit/9a46b10c522997762735d4aa38c4f39ccf7ed21a))
* **dashboard:** clamp the record status slot so font metrics cannot grow it ([ddf43cd](https://github.com/Vivswan/litellm-vscode-chat/commit/ddf43cd5a372907b49f823c702acf59c36c6b1e1))
* **dashboard:** classify server health and usage prose through one pipeline each ([c8b378f](https://github.com/Vivswan/litellm-vscode-chat/commit/c8b378f978e28abe742d2f8be20f3384595682cb))
* **dashboard:** compose the bordered-mode hand-back reset with call-site margins ([c8b68df](https://github.com/Vivswan/litellm-vscode-chat/commit/c8b68df288ed9b291a0fb3191546110c0d1224ba))
* **dashboard:** correct the stale layout comments to what the code does now ([ee17042](https://github.com/Vivswan/litellm-vscode-chat/commit/ee17042bc8162baa290e4405d1cc294d70e6a234))
* **dashboard:** correct what a fill-less meter reads as, and pin the axis against an alpha ([e33547f](https://github.com/Vivswan/litellm-vscode-chat/commit/e33547fb6aa103085b11716386ced24cb2512aa7))
* **dashboard:** count raw labels when refusing a save onto a taken label ([d41511e](https://github.com/Vivswan/litellm-vscode-chat/commit/d41511e2a806888a7bc22685a485e6b896005abf))
* **dashboard:** cover the armed confirm, inline the stale mark, and shed the models floor line whole ([1e845c7](https://github.com/Vivswan/litellm-vscode-chat/commit/1e845c7296a8c2286ead2f59b71a1adf36b42c1e))
* **dashboard:** dedupe the retry advisory and name the drawer timestamps ([989b53d](https://github.com/Vivswan/litellm-vscode-chat/commit/989b53da4fa0d0e285c88d2715df447ca1188196))
* **dashboard:** delete the dead slide-over discard machinery and smaller verified leftovers ([0c9d5fe](https://github.com/Vivswan/litellm-vscode-chat/commit/0c9d5fed3d5763c85bdc6341ccac96e902a8ce3f))
* **dashboard:** derive the readable accent tier and the danger pair against their census ([cdecded](https://github.com/Vivswan/litellm-vscode-chat/commit/cdecded6638835289678215417e468754a194cdd))
* **dashboard:** drop the price-unknown placeholder from model rows ([3c9d0a0](https://github.com/Vivswan/litellm-vscode-chat/commit/3c9d0a08f1734bc6c0daa14e645bcc0e6439d5da))
* **dashboard:** fail the band-floor guard closed and stop a disposed poller's phantom follow-up ([e93cb24](https://github.com/Vivswan/litellm-vscode-chat/commit/e93cb24499963b51160d42cb78c23d69a6f771c6))
* **dashboard:** finish the narrow-tier checkbox, pill, and reveal idioms ([4da5eee](https://github.com/Vivswan/litellm-vscode-chat/commit/4da5eee4c87a69fa26e5ef19ef65639c0c355d84))
* **dashboard:** finish the reserved-slot sweep, unobscure the covered help glyph, and lead accessible names with their visible verbs ([6c8c74e](https://github.com/Vivswan/litellm-vscode-chat/commit/6c8c74e0edf12ea1d5d91b478ea06a028bdeced3))
* **dashboard:** fit the diagnostics table at every width and unify chip radius ([cf61a91](https://github.com/Vivswan/litellm-vscode-chat/commit/cf61a91ebf85a8eb5a0e7bab3a338f52d1231ba3))
* **dashboard:** flip the rail's paint and its hook at the same integer width ([c5d276f](https://github.com/Vivswan/litellm-vscode-chat/commit/c5d276fa5dbc236db36caf09fe72c1fbd3cb9ef6))
* **dashboard:** freeze the form's displayed identity and widen it to every secret destination ([b946c28](https://github.com/Vivswan/litellm-vscode-chat/commit/b946c282e4f273f35bb72e0ada071bdc4c03a563))
* **dashboard:** give both Button sizes one ink-gap semantics and centralize the bordered-mode margin repair ([d997934](https://github.com/Vivswan/litellm-vscode-chat/commit/d997934b81d278b37e01adb07ae47c58827b4408))
* **dashboard:** give error and warn text one presentation that survives every cascade and forced colors ([b712227](https://github.com/Vivswan/litellm-vscode-chat/commit/b71222750d0d7a8d76238b897c6ed12e6cd5cadc))
* **dashboard:** give every pane breakpoint one spelling, and a guard that keeps it ([674aeeb](https://github.com/Vivswan/litellm-vscode-chat/commit/674aeebea4cc40b930b3187acc4891b56b1b34ef))
* **dashboard:** give the inherited mark the key the badge lacks, from one derivation ([ff34f52](https://github.com/Vivswan/litellm-vscode-chat/commit/ff34f52503fe66b501225c22f28b6b05ff6c77fc))
* **dashboard:** give the settings page one right edge and one row grid ([4ec11ac](https://github.com/Vivswan/litellm-vscode-chat/commit/4ec11acafaf28e039d22967fc05afce6d1068935))
* **dashboard:** hidden groups reach the hero and counts derive from the served window ([1fe2fd0](https://github.com/Vivswan/litellm-vscode-chat/commit/1fe2fd0a82fecd2dd34945e78f09872dfd629d4e))
* **dashboard:** hint wrong-record-type keys before JSON parsing and pin directive message literals ([4777666](https://github.com/Vivswan/litellm-vscode-chat/commit/477766616035e820ec35475998804f52b007ff44))
* **dashboard:** hold the commit bar's count and pin the covered glyph's visibility ([4d1039e](https://github.com/Vivswan/litellm-vscode-chat/commit/4d1039e382bffe8e0fd3f6614fa6c021e45650bf))
* **dashboard:** home the models filter and count in the header line, and close four models/inspector seams ([68e0203](https://github.com/Vivswan/litellm-vscode-chat/commit/68e02037fa14ddf85cdd137b832bf7c331fa59f5))
* **dashboard:** keep one long server label from scrolling the models page sideways ([083c5da](https://github.com/Vivswan/litellm-vscode-chat/commit/083c5dab3422144110bc20f668bf37bc2d5b274e))
* **dashboard:** keep record-chip validation marks visible and stated once ([4311d57](https://github.com/Vivswan/litellm-vscode-chat/commit/4311d57afaab66995066f975c7d6db9a1124ed3f))
* **dashboard:** keep refused writes visible from any tab, key their rows by request id, and finish the tone-text class ([883d60c](https://github.com/Vivswan/litellm-vscode-chat/commit/883d60c78612e3b4fd280a69587b695f7f79f7a6))
* **dashboard:** keep server UI under a shared-label scope, and park a hidden Server sort ([542b76c](https://github.com/Vivswan/litellm-vscode-chat/commit/542b76cadd1b56f67d30ffd7c3b60b4916c0611e))
* **dashboard:** keep the bordered modes' box gaps and correct the review-found comments ([a69e1c2](https://github.com/Vivswan/litellm-vscode-chat/commit/a69e1c21251e3c000e8467a73bb1b691bd7ea765))
* **dashboard:** keep the narrow thresholds out of the rail's own blind spot ([faf920f](https://github.com/Vivswan/litellm-vscode-chat/commit/faf920f5b6cf3f3ebd34c52cd6e41ece0bf8ecba))
* **dashboard:** key declare-expected offers on the identity classification, not its evidence ([8e0fffa](https://github.com/Vivswan/litellm-vscode-chat/commit/8e0fffa42926016ad7bb8fa13c220a69d8f37f9a))
* **dashboard:** key row state by identity, share the served-count wording, pin the money locale ([ad938fa](https://github.com/Vivswan/litellm-vscode-chat/commit/ad938fa43ab254fd4fb73d4541ea932316e6f463))
* **dashboard:** let setting labels breathe and square the form's trailing edges ([d57ff1b](https://github.com/Vivswan/litellm-vscode-chat/commit/d57ff1bf34dd1492f024f49356889e599e441820))
* **dashboard:** let the auth display say it does not know yet instead of guessing ([b6e7775](https://github.com/Vivswan/litellm-vscode-chat/commit/b6e7775a249f4b3162df260b2d537130f5c9c90a))
* **dashboard:** let the matcher cell shrink in the narrow record rows ([026b236](https://github.com/Vivswan/litellm-vscode-chat/commit/026b2367bda364611d00854e447c5811e9781884))
* **dashboard:** let the server row's name spend free space before truncating ([3a4f62d](https://github.com/Vivswan/litellm-vscode-chat/commit/3a4f62da3efba3f63a2418d66a575ab3a42f20a7))
* **dashboard:** let the settings and usage rows answer to the pane ([70271f0](https://github.com/Vivswan/litellm-vscode-chat/commit/70271f0d8d49aed32e411281fb037ea525f3c103))
* **dashboard:** let the settings filter find rows by their help text ([6eb62a7](https://github.com/Vivswan/litellm-vscode-chat/commit/6eb62a7f7b7acb7bb22c6fcf70307dc084b71cb4))
* **dashboard:** make the open-refresh gate probe-aware and push pass starts; keep floor-width checkboxes on the title line ([b082116](https://github.com/Vivswan/litellm-vscode-chat/commit/b0821162f59608272ebde22a9daac9beb91d30b5))
* **dashboard:** make the save bar count exactly what Save writes for every field ([c7759ef](https://github.com/Vivswan/litellm-vscode-chat/commit/c7759ef3934a6c1a6198d6f1ba8cb6d9793939eb))
* **dashboard:** make the save bar count exactly what Save writes for secrets ([c6180c6](https://github.com/Vivswan/litellm-vscode-chat/commit/c6180c6d2fa9ebcfe190530e0cfe49703eae977e))
* **dashboard:** name the forced-colors state of every transparent border ([270c2c1](https://github.com/Vivswan/litellm-vscode-chat/commit/270c2c11b01b3408469339b8ffed16a27db49109))
* **dashboard:** name the server inside its expanded drawer ([09c1f65](https://github.com/Vivswan/litellm-vscode-chat/commit/09c1f65d666c0786b1f8f60faadb55651d0a43df))
* **dashboard:** never resurrect a removed label's credentials on create ([215e6bc](https://github.com/Vivswan/litellm-vscode-chat/commit/215e6bca134a98aac14da4525fa8eaa9f9288148))
* **dashboard:** one focus-ring geometry and one visually-hidden recipe ([c7e692e](https://github.com/Vivswan/litellm-vscode-chat/commit/c7e692e3d026292dcfb7ab4cd583eda6a2fa4ed0))
* **dashboard:** own the webview scrollbars so the sub-floor band reads as a scrollbar, not a rail gap ([cab6207](https://github.com/Vivswan/litellm-vscode-chat/commit/cab6207902444ca53813276dc9ab6ff69e8fd5b4))
* **dashboard:** paint reveals in bordered modes, restore the gutter accent, and pin the mark channels ([12d9d89](https://github.com/Vivswan/litellm-vscode-chat/commit/12d9d8966089008bf42713c6b9d1cedaf79bd487))
* **dashboard:** print and tone every budget number through one money pipeline ([19bd961](https://github.com/Vivswan/litellm-vscode-chat/commit/19bd9613bcedbd72d5cee2454e559ce02de18514))
* **dashboard:** push unproven secret locations instead of a fallback guess that freezes wrong edit identities ([6db8a1e](https://github.com/Vivswan/litellm-vscode-chat/commit/6db8a1ee82be6663b04abf27ec4e71c7e1e40e93))
* **dashboard:** put the usage pane's detail behind its disclosure ([edaa09b](https://github.com/Vivswan/litellm-vscode-chat/commit/edaa09b472b11a328dbcf7b05ed53022b0496224))
* **dashboard:** rank diagnostic severity by stroke geometry in every theme ([2466ddd](https://github.com/Vivswan/litellm-vscode-chat/commit/2466dddbde087d000ed5356b21c8353829d3999b))
* **dashboard:** rank same-row write failures by recency and route hidden rows' notices to the visible line ([2424a62](https://github.com/Vivswan/litellm-vscode-chat/commit/2424a626df83e0ce9e1800bed225a5257a1c62cb))
* **dashboard:** reorder the nav rail to servers, settings, models, diagnostics ([fa73f3f](https://github.com/Vivswan/litellm-vscode-chat/commit/fa73f3fe20d27087f53bfbec77a805a1bb680474))
* **dashboard:** reserve the server form's and record editors' transient slots so verdicts stop moving layout ([6c2ad2e](https://github.com/Vivswan/litellm-vscode-chat/commit/6c2ad2e23adfca5bdf853b386c72a4bc9fa65227))
* **dashboard:** reserve the stacked control track's minimum and floor the shared line at 560px ([61155a3](https://github.com/Vivswan/litellm-vscode-chat/commit/61155a3ba15a3c8c2299d55854e996f963e2c0cb))
* **dashboard:** reserve transient slots so errors, refusals, marks, and typing stop moving layout ([8efb33e](https://github.com/Vivswan/litellm-vscode-chat/commit/8efb33e41d15b222a52e7e72c179667d75601533))
* **dashboard:** rest the hidden spinner, pin Inspect in its scrollport, close the record cards flush, and top-load support ([70ae366](https://github.com/Vivswan/litellm-vscode-chat/commit/70ae366b27c1969508836399194243a3001dc097))
* **dashboard:** restate the toolbar and banner gaps in ink terms ([2a3ee91](https://github.com/Vivswan/litellm-vscode-chat/commit/2a3ee91dcf16ee95796b263da9ac7e480d94d9d6))
* **dashboard:** route every focus ring and chip radius through the theme tokens ([6df0e06](https://github.com/Vivswan/litellm-vscode-chat/commit/6df0e0649247ad84f4d169ac2c643d6310128e18))
* **dashboard:** run the diagnostics and servers surfaces full-bleed to the pane ([1068dff](https://github.com/Vivswan/litellm-vscode-chat/commit/1068dffcbbd827ad123adee23094e7628a56a9ea))
* **dashboard:** seat the record verdict beside its buttons and give read-only records back their words ([6e1fb14](https://github.com/Vivswan/litellm-vscode-chat/commit/6e1fb144f6b6d4f094e44897cdacfece643ff6c9))
* **dashboard:** settings failures land on their rows, and the page's copy, widths, and modified mark stop lying ([cfe791e](https://github.com/Vivswan/litellm-vscode-chat/commit/cfe791ed0143a61833c0cf61f27b0b3795c94f4b))
* **dashboard:** share the currency-symbol wire cap and refuse over-limit commits with a reason ([0d9a25a](https://github.com/Vivswan/litellm-vscode-chat/commit/0d9a25a056004bd867198fd5bf44cc8d3182b9a3))
* **dashboard:** shorten settings descriptions to one sentence, inline the catalog status, and retire the floating editors note ([d779d46](https://github.com/Vivswan/litellm-vscode-chat/commit/d779d462e1e0b5abc8757d6f94b1b22ac04b417f))
* **dashboard:** speak one provenance vocabulary across inspectors and diagnostics ([255b259](https://github.com/Vivswan/litellm-vscode-chat/commit/255b259b6d61c699e619837fbbad4f4ce68577d0))
* **dashboard:** stack the diagnostics actions vertically and speak absence in the resolved table ([b5d40c4](https://github.com/Vivswan/litellm-vscode-chat/commit/b5d40c4d8ce39b3c26864f1414ed078e86e1a400))
* **dashboard:** stop a rename from resurrecting the target label's credentials ([87ae7ce](https://github.com/Vivswan/litellm-vscode-chat/commit/87ae7ceeaf1cf4cbb087828f9312e35bf6bf4d52))
* **dashboard:** stop external OAuth groups wearing an API key badge ([bc7c175](https://github.com/Vivswan/litellm-vscode-chat/commit/bc7c1759247d87db9f4b3d416f87e27b761d564e))
* **dashboard:** the budget band names staleness through the row's one vocabulary ([6db2754](https://github.com/Vivswan/litellm-vscode-chat/commit/6db2754eff61c8600ca332949de5fac1fe839c54))
* **dashboard:** tokenize record-surface radii and restore the chip families' distinguishing channels ([ba3c586](https://github.com/Vivswan/litellm-vscode-chat/commit/ba3c586369673aebf3706d02e017b8eb404744e1))
* **dashboard:** true up the server form against the shared visual anatomy ([855aa26](https://github.com/Vivswan/litellm-vscode-chat/commit/855aa2638db89cf3d7a01a6f14da55e38005ca83))
* **dashboard:** trust the split sync-skip classes at the secret-proof boundary ([2531866](https://github.com/Vivswan/litellm-vscode-chat/commit/253186658f3b6d6c0af87d86fc76ef41b61c1185))
* **dashboard:** unbox the drawer budget notice into a leading fact row and paint error-tier budget lines red ([56a290b](https://github.com/Vivswan/litellm-vscode-chat/commit/56a290bbfc1e988feaa3fbbfb73a6cd9ab702634))
* **dashboard:** unify every problem band behind one tier pipeline ([d11a6fb](https://github.com/Vivswan/litellm-vscode-chat/commit/d11a6fb8221a017e96d9481198897c40f12ed916))
* **dashboard:** unify the inherited mark and the editors' raw-vs-trimmed key reading ([dd5fbab](https://github.com/Vivswan/litellm-vscode-chat/commit/dd5fbab5435bbe39afc972936992f7d6afd22786))
* **dashboard:** wrap-proof the server form commit bar's trailing facts ([69771ed](https://github.com/Vivswan/litellm-vscode-chat/commit/69771ed2e9e1fede88ea860d19826b672dd46dee))
* derive a server row's status dot from its worst problem ([54d3f38](https://github.com/Vivswan/litellm-vscode-chat/commit/54d3f387d555c53d570fb52466f4775859fdf57b))
* derive status bar, toasts, and dashboard verdicts from one classifier ([499a9fc](https://github.com/Vivswan/litellm-vscode-chat/commit/499a9fc0e5ddd4d39908b746cca91753ae0d8762))
* derive the wash scale where the theme kind actually lands ([bfbd57d](https://github.com/Vivswan/litellm-vscode-chat/commit/bfbd57de29dac9cbc251da4458d0dde4b245aad8))
* **dev:** deliver fixture messages a frame apart, not all in one tick ([95ffad6](https://github.com/Vivswan/litellm-vscode-chat/commit/95ffad6a91060f652b0fd04069eee2084b2400c6))
* **dev:** let a render fixture show a configured appearance row ([98b350b](https://github.com/Vivswan/litellm-vscode-chat/commit/98b350b649ed073bbbae9564d3776514d3f8f7d7))
* **dev:** pin the geometry harness fonts so every platform measures the same boxes ([43f93b1](https://github.com/Vivswan/litellm-vscode-chat/commit/43f93b155e03978d68454c8142b17b41476c5c5f))
* **dev:** resolve the installed Tailwind CLI by path instead of the registry ([bff03a1](https://github.com/Vivswan/litellm-vscode-chat/commit/bff03a1850325ef027405df3a1325f0e0da70b71))
* **dev:** retry a contended Chrome launch in the render harness ([ce4f5e9](https://github.com/Vivswan/litellm-vscode-chat/commit/ce4f5e9aff598043f9b126b0512f7296bc51f954))
* disambiguate four UI strings and hedge the inactive-entry diagnostic ([6811f54](https://github.com/Vivswan/litellm-vscode-chat/commit/6811f548f23f3e9849f40ef3a985afee3c123800))
* drop a non-array object content delta instead of coercing it ([13b795a](https://github.com/Vivswan/litellm-vscode-chat/commit/13b795a4fcfa627069a1d572afcfda3006671865))
* fail commits closed when the husky runtime was never installed ([7a757c0](https://github.com/Vivswan/litellm-vscode-chat/commit/7a757c065f3178a69d7f3d4b6ea0503e8476b72b))
* flip a chip popover above its anchor rather than off the screen ([f92c4b4](https://github.com/Vivswan/litellm-vscode-chat/commit/f92c4b4850079a325ed2796e4facf6bace8b2efa))
* give a forced light dashboard theme its own passing green ([11d49a5](https://github.com/Vivswan/litellm-vscode-chat/commit/11d49a5026f9a8f93e2dc2563a1cc9dfc36eaa52))
* give every diagnostic block a key and every reveal button a name of its own ([e431cd3](https://github.com/Vivswan/litellm-vscode-chat/commit/e431cd3718d56a81096dffebd6e8a69708c76ef2))
* give severity a readable text tier, and put Light Modern's green back ([d4b0412](https://github.com/Vivswan/litellm-vscode-chat/commit/d4b04123a5f015ce146d3d6a33d32ccb77452645))
* give the spend meter a baseline instead of an invisible track ([e41ca64](https://github.com/Vivswan/litellm-vscode-chat/commit/e41ca647531a0187c9d4473cfa184fabe5c758c7))
* judge the zero-model state once for toast and tooltip ([b98d7fa](https://github.com/Vivswan/litellm-vscode-chat/commit/b98d7fa3926885bd51b1eae581ae253d0737e8e6))
* keep a model row's price and capabilities on screen when the pane is narrow ([88834e0](https://github.com/Vivswan/litellm-vscode-chat/commit/88834e0a4e9119b7f9dc1fdd55632ac628c4b33b))
* keep restored verdicts and dashboard served counts honest about what renders ([7536c55](https://github.com/Vivswan/litellm-vscode-chat/commit/7536c55f0cfd00b2edae2a4c25009e4ba12e5698))
* keep the record editors' headings under the heading that holds them ([9aa6bac](https://github.com/Vivswan/litellm-vscode-chat/commit/9aa6bac6e3042df7bb643d7a6f0f4ea83a42c4f8))
* keep two leftovers of one key, and two entries of one label, apart ([260422d](https://github.com/Vivswan/litellm-vscode-chat/commit/260422d39b4d9e65f61ff3b2602b7591cb6a4de2))
* **l10n:** close the forwarding, namespace-member, and argument-reference holes in the census walks ([ea5ce14](https://github.com/Vivswan/litellm-vscode-chat/commit/ea5ce14c5ca465d10d5255eeb30eb2d872be6022))
* **l10n:** correct four Chinese translation slips ([5b299db](https://github.com/Vivswan/litellm-vscode-chat/commit/5b299db438bee95e2748a0acd27b494b77f256c5))
* **l10n:** register the full census of l10n.t-resolving helpers in the module-scope guard ([03a7fde](https://github.com/Vivswan/litellm-vscode-chat/commit/03a7fdeb84a5e2e80221f14fa4d5c3de4da65685))
* lead the connection-error headline with the bare-localhost correction ([96e024e](https://github.com/Vivswan/litellm-vscode-chat/commit/96e024e6a2eb2702f81fcef4c38ac24b2a0b43bc))
* let a destructive action be tellable apart before you aim at it ([387fa3b](https://github.com/Vivswan/litellm-vscode-chat/commit/387fa3b521df578ceb334f83b8ea1609c34a5d2a))
* let a record row wrap instead of painting its chips over its own cells ([7fe840e](https://github.com/Vivswan/litellm-vscode-chat/commit/7fe840eec93f7051d32c88cebad4dff309fce68c))
* let a secondary button look like a button before you point at it ([a9dade1](https://github.com/Vivswan/litellm-vscode-chat/commit/a9dade1714b73cbe7cd06a7569eee636bc63b498))
* let the edit page stop explaining itself, and stop dropping deep links ([2ac41ec](https://github.com/Vivswan/litellm-vscode-chat/commit/2ac41ecab396d479541e4ed1e6e496d07a3bc8cb))
* let the server form measure the pane it lives in, not the window ([f57cd00](https://github.com/Vivswan/litellm-vscode-chat/commit/f57cd009621d739b9649bc5085c21696e043a0bf))
* **logger:** sanitize stack traces through one leak-proof helper ([7dd5484](https://github.com/Vivswan/litellm-vscode-chat/commit/7dd54841649394cc7e68817ea518243c07f90b58))
* make a forced dashboard theme reach the whole page, and let high contrast win ([654e71f](https://github.com/Vivswan/litellm-vscode-chat/commit/654e71f40ffb6cb6f6f39f5558c3642564633f5e))
* make the form and the stylesheet agree on where 700px is ([a79f869](https://github.com/Vivswan/litellm-vscode-chat/commit/a79f86950bd7f0f24f52fe1ebfcba87141a7b275))
* make the hidden attribute beat a display utility ([fb6960a](https://github.com/Vivswan/litellm-vscode-chat/commit/fb6960a09125de675ae8a6cf6c0a95e2f8f7ab2d))
* measure the models scrollport's height budget instead of guessing it ([28c8232](https://github.com/Vivswan/litellm-vscode-chat/commit/28c8232dae1cefa3b7e711823d91c65491a5d320))
* **migrations:** clean up superseded legacy secrets so they cannot resurrect ([04c9af1](https://github.com/Vivswan/litellm-vscode-chat/commit/04c9af18a502e4fa227bc2cb29a5881b9f22be1d))
* one serving vocabulary for the status bar, toasts, dashboard, and rows ([f08e180](https://github.com/Vivswan/litellm-vscode-chat/commit/f08e180fa9b5eb3aac7b76bc38e7aaf55c54bd60))
* pin diagnostic severity and singleton creation points structurally ([f29c953](https://github.com/Vivswan/litellm-vscode-chat/commit/f29c953d4de85edb5197f96da5b100ad0dbafd98))
* pin the render harness's scroll offset before a full-page capture ([88c023a](https://github.com/Vivswan/litellm-vscode-chat/commit/88c023a52c1d5482868b07da28301cfa47135fd3))
* redact URL credentials in issue reports whatever their spelling ([8ceca06](https://github.com/Vivswan/litellm-vscode-chat/commit/8ceca06786e3536152ad9a6a6b5c829d8a88d04e))
* reopen the record-jump render fixture through the Inspect button ([27b4587](https://github.com/Vivswan/litellm-vscode-chat/commit/27b4587a2230f8e50f5053787fbf198e91e437ba))
* restore the slide-over's pointer and keyboard dismissal under Radix ([76b2479](https://github.com/Vivswan/litellm-vscode-chat/commit/76b2479f7b93f5026a898f53df15ada81cc2281e))
* **scripts:** give the overflow sweep a structured result channel ([3cf48fc](https://github.com/Vivswan/litellm-vscode-chat/commit/3cf48fc9129fe81dc1dd33a479ec9b1881b428b7))
* **scripts:** pin the Tailwind font tokens and close six fail-open guard gaps ([6b07ee9](https://github.com/Vivswan/litellm-vscode-chat/commit/6b07ee96105637e87cdeef72a562cbeb6d380f75))
* **scripts:** run compose through one executor and type the demo model keys ([05f92dc](https://github.com/Vivswan/litellm-vscode-chat/commit/05f92dceb89bb531b502cc2fd472e0acc25ff344))
* **servers:** close the review findings on the ownership pipeline's edges ([eda28f7](https://github.com/Vivswan/litellm-vscode-chat/commit/eda28f7fce7bc093de7ae12b7c77adc8c54bb7ea))
* **servers:** compare OAuth token-URL stamps verbatim and pin the new skip classes across surfaces ([1e2dd4b](https://github.com/Vivswan/litellm-vscode-chat/commit/1e2dd4be387b1edca69abcee78096ab63d4a110a))
* **servers:** give each sync skip its own error class instead of message forensics ([ebf4460](https://github.com/Vivswan/litellm-vscode-chat/commit/ebf446078e13910b2fe18359cab6602457c70145))
* **servers:** order and merge credential-bearing writes against concurrent state ([fc8741c](https://github.com/Vivswan/litellm-vscode-chat/commit/fc8741cd14ffac3f485c5b9b23b76c116d6e705d))
* **servers:** re-read the entry before the group add and the usage probe ([d8b63e9](https://github.com/Vivswan/litellm-vscode-chat/commit/d8b63e92f7efe41b03c55dab7d87ff550b2bcceb))
* **servers:** stamp stored secrets with their destination and refuse mismatched pairings ([a8b6a14](https://github.com/Vivswan/litellm-vscode-chat/commit/a8b6a142f9e871fc48c8cb45e5c57d8b7043edd4))
* **settingsTransfer:** count undo reconnects from owned secrets like the import side ([42ca04c](https://github.com/Vivswan/litellm-vscode-chat/commit/42ca04c2f967e0f4d91d060101265509fc643c50))
* **settingsTransfer:** normalize imports through the redesign restructure and settle one flat-vs-nested rule ([e4019d3](https://github.com/Vivswan/litellm-vscode-chat/commit/e4019d35f6f3024a7f8c4d6d16a44fa3539e9fd0))
* **status:** name the degraded cause honestly in the bar tooltip and toasts ([108da77](https://github.com/Vivswan/litellm-vscode-chat/commit/108da7782c4ed9c837a63b98e7fa4d3ec0e558df))
* **status:** sync failures reach the status bar and notifier ([2830c8f](https://github.com/Vivswan/litellm-vscode-chat/commit/2830c8f59239432d214902c120ab2b4b01a58aff))
* stop headings announcing their own toolbars ([36ca531](https://github.com/Vivswan/litellm-vscode-chat/commit/36ca531a78eec65f649f8181675029b6fc130682))
* stop the settings help glyph from wrapping away from its row ([2b84233](https://github.com/Vivswan/litellm-vscode-chat/commit/2b842332ff344d7455e29aa4ad5993794faea7a3))
* stop the unserved-endpoint error claiming nothing answered when both endpoints did ([47dcc7a](https://github.com/Vivswan/litellm-vscode-chat/commit/47dcc7abe8d9d561fe778aba08068d6fa55167d5))
* strip userinfo from URLs echoed in error messages ([7898a5b](https://github.com/Vivswan/litellm-vscode-chat/commit/7898a5b67b2301746b2f78d4c27fbc200ff280a7))
* suggest expectedFailures instead of a bigger timeout for non-LiteLLM servers ([#261](https://github.com/Vivswan/litellm-vscode-chat/issues/261), thanks [@leovela69](https://github.com/leovela69)) ([cb22cc2](https://github.com/Vivswan/litellm-vscode-chat/commit/cb22cc2c8fd61eea0163958caa1388399c87a727))
* **test:** derive setup-hint toast coverage from SETUP_HINT_KINDS ([19a7cee](https://github.com/Vivswan/litellm-vscode-chat/commit/19a7cee183f241ab276059382a465c0c8c9e6843))
* **test:** derive the %error help from ERROR_STATUSES ([5e12674](https://github.com/Vivswan/litellm-vscode-chat/commit/5e1267474abb63a0e6671d4f75d02ec209bcf042))
* **test:** derive the monkey redeclare oracle from the secret-ownership stamps ([f6b5c30](https://github.com/Vivswan/litellm-vscode-chat/commit/f6b5c304b89025045a7f21a1a7ba4fd0f0b9c075))
* **test:** escape every regex metacharacter when quoting selectors into rules ([b499260](https://github.com/Vivswan/litellm-vscode-chat/commit/b4992609e1d00d28be10dc867edf8d742195c497))
* **test:** make the transparent-border scan's keys platform-invariant ([8815515](https://github.com/Vivswan/litellm-vscode-chat/commit/8815515209f453f96c535e60ee965e8a42ded07b))
* **test:** state the settings filter's help boundary accurately in both filter tests ([6699c07](https://github.com/Vivswan/litellm-vscode-chat/commit/6699c07f6cbcb9bb7e449a1325f17c7c78ddd753))
* **test:** stop the fingerprint-salt suite leaking a tmpdir per test ([1d9afb0](https://github.com/Vivswan/litellm-vscode-chat/commit/1d9afb0824a8b135d72e609ff834a354302cdf83))
* **test:** stop the host suites leaking a user-data directory per label ([54fef27](https://github.com/Vivswan/litellm-vscode-chat/commit/54fef276052fc69f23b800813dd8ee251315d9f9))
* **test:** sweep the legacy flat tmp layout and close two purity-guard blind spots ([f149834](https://github.com/Vivswan/litellm-vscode-chat/commit/f149834fb87394d2b18270a7daf76c9027d2e840))
* **transfer:** re-clear restored secrets when an undo's settings write fails ([ac5d303](https://github.com/Vivswan/litellm-vscode-chat/commit/ac5d3032fb757fcc575ececb75b36f68c5395499))
* **transport:** classify error envelopes once for HTTP and stream paths ([d55a95a](https://github.com/Vivswan/litellm-vscode-chat/commit/d55a95a2d54ff2ea7e2bf36a264e45ecf4768e47))
* **transport:** classify socket failures once for chat, discovery, and OAuth ([415866f](https://github.com/Vivswan/litellm-vscode-chat/commit/415866fa99da76291c86fb07d5b127921daf196c))
* **transport:** require exceedance proof for statusless context-window frames ([a64283c](https://github.com/Vivswan/litellm-vscode-chat/commit/a64283c53ae30f16699dc7c5fec1ae39fcd70ac2))
* **transport:** suggest bare localhost when a *.localhost host cannot resolve ([#269](https://github.com/Vivswan/litellm-vscode-chat/issues/269), thanks @Tomoushie) ([af12a45](https://github.com/Vivswan/litellm-vscode-chat/commit/af12a45566026338d7376a83458648a739f42277))
* **transport:** validate before converting so rejected requests log nothing ([2023609](https://github.com/Vivswan/litellm-vscode-chat/commit/2023609c8e56d91e476eb85b6f0263cdcdd6db42))
* type the docs action's href as a DocsUrl ([3642211](https://github.com/Vivswan/litellm-vscode-chat/commit/3642211aa5de4dd1c9cb06c9505092bd9e5c0b70))
* **usage:** announce pass completion after the engine reads idle ([fedd87a](https://github.com/Vivswan/litellm-vscode-chat/commit/fedd87a3acfa7e4ea62ca33a2e585475909e13c3))
* **usage:** floor the displayed percent and gate the budget band on freshness ([f7ea46b](https://github.com/Vivswan/litellm-vscode-chat/commit/f7ea46b7d96301d3fa6994e79a319c8fe4155fc6))
* **usage:** one percent convention, one threshold rule, and over-budget always counts ([3dfbd58](https://github.com/Vivswan/litellm-vscode-chat/commit/3dfbd58ef01a78a248d2f6c198b5a082397377b4))
* **usage:** render configured thresholds exactly instead of flooring them ([a0778f6](https://github.com/Vivswan/litellm-vscode-chat/commit/a0778f6f9e14354aa88c277b60aff0b637949941))
* **usage:** stop the dashboard re-probing the fleet on every open and impersonating asked-for refreshes ([c4d52f9](https://github.com/Vivswan/litellm-vscode-chat/commit/c4d52f922d4c2938afe0b090640e55c7cd207b47))
* **usage:** survive mid-edit entries with one still-declared predicate and one path table ([2d4349e](https://github.com/Vivswan/litellm-vscode-chat/commit/2d4349ed438ba801764d2eefccdb26300c146a75))
* **usage:** the status bar names staleness through the one vocabulary ([bb94872](https://github.com/Vivswan/litellm-vscode-chat/commit/bb9487239af1187005edbc016961fbf127f81867))


### Code Refactoring

* port the dashboard webview from Preact to React 19 ([03c2dbf](https://github.com/Vivswan/litellm-vscode-chat/commit/03c2dbf41b99db1ba3193f887fa009b3040e8d18))
* redesign the dashboard message protocol around one endpoint table ([476cc46](https://github.com/Vivswan/litellm-vscode-chat/commit/476cc466692857d21f77756baf9d0a3474d4840b))

## [0.4.7](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.6...v0.4.7) (2026-08-12)


### Features

* attest the VSIX build provenance on release ([9831dbe](https://github.com/Vivswan/litellm-vscode-chat/commit/9831dbe9201ca10977a0f227150c210ed8731dee))
* honor cost, caching, and reasoning-parameter capability overrides at registration ([6989aca](https://github.com/Vivswan/litellm-vscode-chat/commit/6989aca6e8ced19957866e32e618c7b44340140b))
* honor every models.capabilities field as an override and price from LiteLLM only ([#248](https://github.com/Vivswan/litellm-vscode-chat/issues/248), thanks [@jiang-xiche](https://github.com/jiang-xiche)) ([4364d21](https://github.com/Vivswan/litellm-vscode-chat/commit/4364d214ab28774bbf4c4d16d510eff98e2cfbac))
* merge the parameters and capabilities inspectors into one model panel ([2309a49](https://github.com/Vivswan/litellm-vscode-chat/commit/2309a49269ae57c18d292c1387006324e1dfb4ec))
* render open capability fields with provenance in the inspector and editors ([bc30c58](https://github.com/Vivswan/litellm-vscode-chat/commit/bc30c58daaff37cf08a0b7b76285eaaf7009465f))
* stop sourcing model pricing from the OpenRouter catalog ([e3a64d4](https://github.com/Vivswan/litellm-vscode-chat/commit/e3a64d44b39da40eefffccdfa852b16a54d0a824))
* suggest the server's model-info fields in the capability key autocomplete ([9a77eb2](https://github.com/Vivswan/litellm-vscode-chat/commit/9a77eb2c06a4a52825ac50af2a24e235a0ba16ad))
* surface open capability overrides and advisory hints in the dashboard state ([647cafd](https://github.com/Vivswan/litellm-vscode-chat/commit/647cafd554596c2f637a3d9c13aae5aeb8cb9d7f))


### Bug Fixes

* drop the box around the server form auth section ([3c32e36](https://github.com/Vivswan/litellm-vscode-chat/commit/3c32e36263c308b9ca477df3f5279c97f8d45131))
* flag an inactive per-server apiVersion override on the dashboard ([8200add](https://github.com/Vivswan/litellm-vscode-chat/commit/8200addd6bc61d06585a51698e25c7454c72c42f))
* give every dashboard panel one width and render the full parameter list inline ([1be8fa7](https://github.com/Vivswan/litellm-vscode-chat/commit/1be8fa7394fdec286af1bf88ea23725592fa4f0f))
* group pricing and parameter capabilities into readable sections in the inspectors ([cc5ddc3](https://github.com/Vivswan/litellm-vscode-chat/commit/cc5ddc3c6cf6542e38629a30228187e4aa981b97))
* honor version-suffixed base URLs ([#252](https://github.com/Vivswan/litellm-vscode-chat/issues/252), thanks [@leovela69](https://github.com/leovela69)) ([23f393e](https://github.com/Vivswan/litellm-vscode-chat/commit/23f393e3dab953eec84224c5a61f915504cad9b7))
* judge global capability hints against cross-server evidence in the inspector ([5e996d2](https://github.com/Vivswan/litellm-vscode-chat/commit/5e996d2d86ec79d86ae531b0a0e9e02a6c654909))
* keep advisory capability notes out of the issue-report log budget ([5956bff](https://github.com/Vivswan/litellm-vscode-chat/commit/5956bff5334544ee648a6267d94356238c933dd9))
* lead the model inspector with answers and tuck the record machinery behind details ([896a005](https://github.com/Vivswan/litellm-vscode-chat/commit/896a0055382227371fdf4449ba76252c953e307b))
* one Inspect action per resolved-models row ([9d36924](https://github.com/Vivswan/litellm-vscode-chat/commit/9d36924c5e3371767dc108f5acf51193851275f7))
* sort the supported-parameters list in the caps inspector ([d990fcd](https://github.com/Vivswan/litellm-vscode-chat/commit/d990fcd0bbb3a1c72912514f9a0858378c42c755))
* tolerate the vulnerability-alerts permission scope in lint:actions ([e830082](https://github.com/Vivswan/litellm-vscode-chat/commit/e830082518c607e6b8d6b8510f4ee1e6fc4fbcac))

## [0.4.6](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.5...v0.4.6) (2026-08-10)


### Features

* add settings export, import, and undo ([2f7208a](https://github.com/Vivswan/litellm-vscode-chat/commit/2f7208a3bce0393671c1833df86f2deda265f24f))


### Bug Fixes

* allowlist the historical sk-your-key docs placeholder for gitleaks ([7da14f1](https://github.com/Vivswan/litellm-vscode-chat/commit/7da14f1da4e41e7f718f3b0fe2aee377d24634bb))
* back off usage polling against endpoints that never answer ([be38895](https://github.com/Vivswan/litellm-vscode-chat/commit/be38895efa7b075691d103b7fb61d630476cd397))
* hint before filing a repeat issue report ([6425152](https://github.com/Vivswan/litellm-vscode-chat/commit/64251528ea5d6a996737f8486d2da375549fa579))
* name hidden provider groups in status, diagnostics, and the issue-report gate ([#246](https://github.com/Vivswan/litellm-vscode-chat/issues/246), thanks [@leovela69](https://github.com/leovela69)) ([3a68f50](https://github.com/Vivswan/litellm-vscode-chat/commit/3a68f5092a9b1bf7c3af38fa93fe6e33aceeb9fb))

## [0.4.5](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.4...v0.4.5) (2026-08-10)


### Features

* _fallback and _force directives for capability and parameter records ([#228](https://github.com/Vivswan/litellm-vscode-chat/issues/228), thanks [@jiang-xiche](https://github.com/jiang-xiche)) ([0734433](https://github.com/Vivswan/litellm-vscode-chat/commit/073443329609906b304c41f20dbd956d26f01724))
* "*" catch-all prefix in modelParameters and modelCapabilities ([3cfa078](https://github.com/Vivswan/litellm-vscode-chat/commit/3cfa078d74aa27814c5e76af9bb0c4b46c553222))
* add the composed settings-redesign migration pipeline ([28c127a](https://github.com/Vivswan/litellm-vscode-chat/commit/28c127a4241a4a49137d8cfe7c3173716d921c61))
* add the usage data layer behind the usage settings ([#232](https://github.com/Vivswan/litellm-vscode-chat/issues/232), thanks [@jiang-xiche](https://github.com/jiang-xiche)) ([e5911fd](https://github.com/Vivswan/litellm-vscode-chat/commit/e5911fd289437316019bd46bd9f7ad34ec3341ed))
* dashboard redesign surfaces, usage UI, and inspector edit jumps ([d305425](https://github.com/Vivswan/litellm-vscode-chat/commit/d305425ce4192bb47f32bf0f6fe686c01f3efc94))
* **dev:** seed a rich demo state for bun run dev ([67562b6](https://github.com/Vivswan/litellm-vscode-chat/commit/67562b69cd4c07573d3e3f3cf471294ee3958c29))
* exact-match model keys with globs, regexes, record inheritance, and a precomputed resolution table ([9702037](https://github.com/Vivswan/litellm-vscode-chat/commit/9702037732bdfb3c0d21785f0f4d4127734c52af))
* fallback and force editing in the dashboard ([#228](https://github.com/Vivswan/litellm-vscode-chat/issues/228), thanks [@jiang-xiche](https://github.com/jiang-xiche)) ([5555082](https://github.com/Vivswan/litellm-vscode-chat/commit/55550828ca6a3706097c72ae39d568593854dbea))
* per-model capability overrides and declared models ([#228](https://github.com/Vivswan/litellm-vscode-chat/issues/228), thanks [@jiang-xiche](https://github.com/jiang-xiche)) ([498b2ea](https://github.com/Vivswan/litellm-vscode-chat/commit/498b2ea2f2bde4b563adabac45a2f52cc1b3d566))
* redesign the record editors around a compact matcher table ([25d4444](https://github.com/Vivswan/litellm-vscode-chat/commit/25d444402da17592ba76525fc929f95af7a9609b))
* render two-part errors across the webview and usage UI ([0d31413](https://github.com/Vivswan/litellm-vscode-chat/commit/0d31413ab4e5ec2c74927a821181e46b91f00a60))
* restructure server entries and move settings into namespaced sections ([7558722](https://github.com/Vivswan/litellm-vscode-chat/commit/75587228b4db269435a61aafdd2fa7f049359e71))
* rework chat transport errors into a human headline plus technical detail ([c77bfb4](https://github.com/Vivswan/litellm-vscode-chat/commit/c77bfb453bac4e8c6335086fe9ce82ac4705e030))
* rework dashboard suggestions, thresholds, and model inspectors ([e14b333](https://github.com/Vivswan/litellm-vscode-chat/commit/e14b333c371187e3363dcf056c64db69f883e5e1))
* show a usage card for servers whose key is refused usage access ([291d1d9](https://github.com/Vivswan/litellm-vscode-chat/commit/291d1d9470aa63f165f679186a621dda21555460))
* show per-server spend in the servers table ([dddc499](https://github.com/Vivswan/litellm-vscode-chat/commit/dddc499d3d98b8a9489b6f39f5b39255082beacf))
* two-part auth and discovery errors ([6622c9d](https://github.com/Vivswan/litellm-vscode-chat/commit/6622c9d4b3b33294c630d1ea5b00c35951420d1a))
* two-part dashboard and notifier errors with headline-keyed toast dedup ([a64fa12](https://github.com/Vivswan/litellm-vscode-chat/commit/a64fa12d448d09e643279c6a9d26abe2ee1c3185))
* widen the dashboard layout for wide viewports ([37e82c4](https://github.com/Vivswan/litellm-vscode-chat/commit/37e82c49702af9e9d89463e79b5d2750ce41a4e9))


### Bug Fixes

* absorb control-backed directives into the record editor controls ([27dc4e7](https://github.com/Vivswan/litellm-vscode-chat/commit/27dc4e73017847470d10fd612b3b1d520530f62f))
* apply the lead's migration rulings - _force coverage, auth halves, star keys ([00f93fc](https://github.com/Vivswan/litellm-vscode-chat/commit/00f93fc4ed1b874997537a4925c745d1344c8116))
* apply the overlay review follow-ups (flag wrap, hint measure, remove-button titles, dead branch) ([1071d4e](https://github.com/Vivswan/litellm-vscode-chat/commit/1071d4e213e701c8898790d659b526fc59c44343))
* assert inertness, not inactivity, in the production activation hook ([ff8da35](https://github.com/Vivswan/litellm-vscode-chat/commit/ff8da35d80a9d71488e88447cff11edaaaf5479d))
* drop unsendable virtual-key headers at migration and pin the parser round trip ([0580729](https://github.com/Vivswan/litellm-vscode-chat/commit/0580729b90540ec619d9ff5f6878e42766c28c4f))
* give the matcher column its content width in the record tables ([00515af](https://github.com/Vivswan/litellm-vscode-chat/commit/00515af2a73c3eaa9da3e6758f3bf48e660cc58c))
* keep forbidden-usage cards out of the servers-table usage join ([9d4d54f](https://github.com/Vivswan/litellm-vscode-chat/commit/9d4d54f7db643bfffa3c6ba28cd879d268e05e8f))
* keep record editor rows inside the card at every viewport width ([346357c](https://github.com/Vivswan/litellm-vscode-chat/commit/346357caf80283c33b99e4c7556f72353522a03e))
* keep scoped marks on fields surviving an entry-side true expansion ([b86bdb2](https://github.com/Vivswan/litellm-vscode-chat/commit/b86bdb2e0854fa761ce859e62ce9c29f484fcfdf))
* rearm the OpenRouter catalog scheduler after a refresh aborted while disabled ([c4f4642](https://github.com/Vivswan/litellm-vscode-chat/commit/c4f464205f04588a7bf46379ac692bc7bbac8a71))
* restructure the matcher editor overlay ([e6e1059](https://github.com/Vivswan/litellm-vscode-chat/commit/e6e105967da1e0174174531c2b4e38972c490827))
* review-fleet fixes - NUL literals, stale grammar copy, and oracle soundness ([15a281a](https://github.com/Vivswan/litellm-vscode-chat/commit/15a281a6be11aef17963c1c9982fd910249c9f75))
* route the capability inspector through the entry test seam too ([0a671b7](https://github.com/Vivswan/litellm-vscode-chat/commit/0a671b7bb4fe2a6dc0c8377b0f088c65706afa4f))
* scope discovery-cache invalidation per key and domain-separate credentialed group IDs ([8ecd3cb](https://github.com/Vivswan/litellm-vscode-chat/commit/8ecd3cbd2f9a8cf592eb9693433279a6741605d2))
* send the edited entry's custom headers on Test Connection probes ([eae92a8](https://github.com/Vivswan/litellm-vscode-chat/commit/eae92a8fbb44bda2b48b3f0ecc2370e576ce125d))
* set the technical detail apart from the headline in chat errors ([0f2fbf0](https://github.com/Vivswan/litellm-vscode-chat/commit/0f2fbf016a8a3aa7b0b4bafc47834a6a69f67df2))
* version the group-removal blobs so cross-window unhides propagate ([4569d23](https://github.com/Vivswan/litellm-vscode-chat/commit/4569d23d5e5527c0bceb9f56b909dbb91bda056e))

## [0.4.4](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.3...v0.4.4) (2026-08-02)


### Features

* **dashboard:** classify draft-test failures with a hint and docs link ([2b961e7](https://github.com/Vivswan/litellm-vscode-chat/commit/2b961e75a07af3f8c6cc33a06fa9f1f2360278e3))
* **dashboard:** link troubleshooting guidance from failed server rows ([d8cc71f](https://github.com/Vivswan/litellm-vscode-chat/commit/d8cc71ff01a4d5c69fef15222ffb4b6252a4a559))
* **status:** carry error classification to status surfaces with setup hints ([337ed50](https://github.com/Vivswan/litellm-vscode-chat/commit/337ed50e8b276875f8b395d20972985aa3635f03))
* **transport:** classify 404 responses with base-URL guidance ([6341117](https://github.com/Vivswan/litellm-vscode-chat/commit/6341117553c667b00c474490c4e65714848c9cad))
* **ui:** offer troubleshooting before opening setup-problem issue reports ([c269ff4](https://github.com/Vivswan/litellm-vscode-chat/commit/c269ff4b2b252cd9856dc4bd0fafb4f4c2fd3d4c))


### Bug Fixes

* **dashboard:** give the diagnostics tab room to breathe ([96336eb](https://github.com/Vivswan/litellm-vscode-chat/commit/96336eb169479892e1787ebb8fa2373e73eecb21))

## [0.4.3](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.2...v0.4.3) (2026-08-01)


### Bug Fixes

* **i18n:** localize the diagnostics documentation link aria-label ([f3ec351](https://github.com/Vivswan/litellm-vscode-chat/commit/f3ec3512d30b7fb6cdde7f31421ac0a62de334c7))
* **i18n:** localize the diagnostics feedback link labels ([fe2380d](https://github.com/Vivswan/litellm-vscode-chat/commit/fe2380da67cbb6d2cacdeec89a69ab8ae4af80dd))

## [0.4.2](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.1...v0.4.2) (2026-08-01)


### Features

* **i18n:** add the localization foundation ([df7c27b](https://github.com/Vivswan/litellm-vscode-chat/commit/df7c27bc1639b0a58606fa126c24d9c2564fb13c))
* **i18n:** add the Simplified Chinese translation ([98ebeaf](https://github.com/Vivswan/litellm-vscode-chat/commit/98ebeaf2b00ee34b2e8291d52fb8608169a73b56))
* **i18n:** add the Traditional Chinese translation ([cef60d7](https://github.com/Vivswan/litellm-vscode-chat/commit/cef60d738187c202e1a6102a2a391cd49d888a7c))
* **i18n:** externalize the manifest strings to package.nls ([8c256b8](https://github.com/Vivswan/litellm-vscode-chat/commit/8c256b830f4b53366fcb12d0466d73a1cc3ace11))
* **i18n:** gate the localization files in CI and packaging ([f44123b](https://github.com/Vivswan/litellm-vscode-chat/commit/f44123b34aec6dbbec10cf4e7700a0415970a86d))
* **i18n:** localize the dashboard webview strings ([ed12f2a](https://github.com/Vivswan/litellm-vscode-chat/commit/ed12f2a67e64c6b65a0c73983a30f22d69c15e6c))
* **i18n:** localize the extension-host UI strings ([8b7baa2](https://github.com/Vivswan/litellm-vscode-chat/commit/8b7baa24316d312734360215c74cb0a69111c0ca))
* **i18n:** localize the params inspector ([43b2634](https://github.com/Vivswan/litellm-vscode-chat/commit/43b2634a551f9816f3ffa093f625675d67a470ae))
* **i18n:** localize the provider-layer error messages ([2f03453](https://github.com/Vivswan/litellm-vscode-chat/commit/2f0345329e80e70aa8f26a5eedfd2751f0db113e))


### Bug Fixes

* **dashboard:** drop ghost rows for groups deleted from the models file ([756732d](https://github.com/Vivswan/litellm-vscode-chat/commit/756732d696b7a457ad84311941531b14763bde95))
* **dashboard:** even heading-icon spacing and duration-idiom default notes ([96a20d4](https://github.com/Vivswan/litellm-vscode-chat/commit/96a20d40b663f774705b057ba0fd4071896a032b))
* **dashboard:** finish the two-surface sweep - the models file replaces the native editor ([f511901](https://github.com/Vivswan/litellm-vscode-chat/commit/f51190167895a43f4e125743d95d909bbb4b2b98))
* **dashboard:** fit the models table and make Params discoverable ([d9bc934](https://github.com/Vivswan/litellm-vscode-chat/commit/d9bc934ee6834e09b262ee78e8e5a7bbd0ff093f))
* **dashboard:** give the record editors feedback, structure, and speed ([4947e8e](https://github.com/Vivswan/litellm-vscode-chat/commit/4947e8eae85ce4193a8afb9e4fbd82c4708250b9))
* **dashboard:** keep the slide-over scrim dim under the pointer ([460c992](https://github.com/Vivswan/litellm-vscode-chat/commit/460c99205e2df1c7ca3cf27b1aba139f4cf523b2))
* **dashboard:** make removing a server hide its leftover provider group ([6c0d807](https://github.com/Vivswan/litellm-vscode-chat/commit/6c0d8070f30ae0df3d987e8460e35a4b58de32bb))
* **dashboard:** make the params inspector self-contained with a model facts grid ([dac385a](https://github.com/Vivswan/litellm-vscode-chat/commit/dac385a786ae8f0cc1e7774557e1537a2d7000e8))
* **dashboard:** replace the inspector's prose blocks with structure ([eb4f715](https://github.com/Vivswan/litellm-vscode-chat/commit/eb4f715ab6c5a4eae3499857aa2b071218559481))
* **dashboard:** route every configuration dialog to the dashboard ([85e748b](https://github.com/Vivswan/litellm-vscode-chat/commit/85e748b46e6d939b1e10a4f67bbd0d009c586947))
* **dashboard:** settings field ergonomics - durations, filter, settings.json jump ([ef63447](https://github.com/Vivswan/litellm-vscode-chat/commit/ef63447869cf721833c53f3e3b5a77ea27f41165))
* **dashboard:** show each model's effective request parameters ([5bc937d](https://github.com/Vivswan/litellm-vscode-chat/commit/5bc937d1cb16aa807d6d7b5e02b5e4e27f327553))
* **dashboard:** show scope and defaults on settings rows, calm the validation ([af9b6a7](https://github.com/Vivswan/litellm-vscode-chat/commit/af9b6a78841f2c3d86d7105a09a70f30ae58c92f))
* **dashboard:** structure the Diagnostics tab and make its actions real ([ebec169](https://github.com/Vivswan/litellm-vscode-chat/commit/ebec16908900b567fee6c63d0f2b4ef829e41aae))
* **dashboard:** test a server's connection from the form before saving ([d745fce](https://github.com/Vivswan/litellm-vscode-chat/commit/d745fce78d8f5485850df18995868e5a8a512bba))
* **dev:** recover the dev profile when its seeded group was deleted ([11204f8](https://github.com/Vivswan/litellm-vscode-chat/commit/11204f8546c42279b3e31904f6b047f1b3f7966f))
* **fuzz:** upload nightly failure reports from the hidden .fuzz-failures dir ([#220](https://github.com/Vivswan/litellm-vscode-chat/issues/220)) ([e3b95f6](https://github.com/Vivswan/litellm-vscode-chat/commit/e3b95f64d56d31328704e6baec697783037eabaa))
* **i18n:** harden the CI gates after review ([7099a80](https://github.com/Vivswan/litellm-vscode-chat/commit/7099a800bbc0c15e8dd76a221efb6f3366683a11))
* **i18n:** harden the l10n foundation after review ([b08b6ae](https://github.com/Vivswan/litellm-vscode-chat/commit/b08b6ae4e09baf479138006389e0778984414097))
* **i18n:** keep the copied diagnostics timestamp English and localize the tab chrome ([1b0960d](https://github.com/Vivswan/litellm-vscode-chat/commit/1b0960d71e455b4989ee5bf97940b1a1e3a12ed4))
* **i18n:** keep the field-ID prefixes outside the localized message bodies ([4c4a232](https://github.com/Vivswan/litellm-vscode-chat/commit/4c4a2323650bc982458fbe66ce8f8be4a2390398))
* **i18n:** keep the output channel's stack print English for mirrored errors ([e2f8234](https://github.com/Vivswan/litellm-vscode-chat/commit/e2f8234d4ce9e9a0c3a0a23b8a2d660e8de41bcc))
* **i18n:** keep the pasted diagnostics block English and harden the l10n gate ([9079d7b](https://github.com/Vivswan/litellm-vscode-chat/commit/9079d7bbdc08d25c3a34c91af505324ce066d73d))
* **i18n:** keep the provider error log surfaces English behind the localized display ([5f06560](https://github.com/Vivswan/litellm-vscode-chat/commit/5f06560e4160300af5263428fbf5e0b4a8c63248))
* **i18n:** localize the review-caught host-side dashboard strings ([8f3a2c8](https://github.com/Vivswan/litellm-vscode-chat/commit/8f3a2c8595fc189b5fce4c90908ee16aacb4d8ba))
* **i18n:** parse module-scope localization offenses with the TypeScript AST ([6c632d8](https://github.com/Vivswan/litellm-vscode-chat/commit/6c632d8f05cc8a21dae11c62abc5d72697d42929))
* **i18n:** polish the Simplified Chinese translation ([f9e46d6](https://github.com/Vivswan/litellm-vscode-chat/commit/f9e46d6068eb7e119d137df7163d3aca33bb72f5))
* **i18n:** polish the Traditional Chinese translation ([c381aa9](https://github.com/Vivswan/litellm-vscode-chat/commit/c381aa9f2851db67148891632a920c7f7a625553))
* **readme:** move Marketplace badges to vsmarketplacebadges.dev ([022c2bd](https://github.com/Vivswan/litellm-vscode-chat/commit/022c2bd4d41a3458785172191a117bc5db9e5682))
* **release:** attach the VSIX before the GitHub release becomes immutable ([ac595de](https://github.com/Vivswan/litellm-vscode-chat/commit/ac595ded8f2ace5c96a0960228b0b2a31dbd971b))
* **servers:** prove a removal before tombstoning, and align the suites ([560ea53](https://github.com/Vivswan/litellm-vscode-chat/commit/560ea53e8ac67221ae25b8b335f86e36d97a6412))
* **servers:** stale-read-proof removal tombstones and identity ledger ([#220](https://github.com/Vivswan/litellm-vscode-chat/issues/220)) ([739b70e](https://github.com/Vivswan/litellm-vscode-chat/commit/739b70e947508a4b241efa6d0cfdcc977cc81e46))
* **servers:** state the tombstone journal's cross-window contract plainly ([#220](https://github.com/Vivswan/litellm-vscode-chat/issues/220)) ([53432fa](https://github.com/Vivswan/litellm-vscode-chat/commit/53432fa27982d1764f14275e939ab3437d6f5dec))

## [0.4.1](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.4.0...v0.4.1) (2026-08-01)


### Bug Fixes

* **dashboard:** add a Diagnostics tab and polish the webview surfaces ([abc99f6](https://github.com/Vivswan/litellm-vscode-chat/commit/abc99f6f2180a625c33d274b68e1a84ff309b00c))
* **dashboard:** open diagnostics in the dashboard instead of a dialog ([4efcc7c](https://github.com/Vivswan/litellm-vscode-chat/commit/4efcc7ce8f5974ae7fe46cf7fa113e442dcfb9b3))
* **dashboard:** sweep the seams the post-merge integration review found ([b3aea9f](https://github.com/Vivswan/litellm-vscode-chat/commit/b3aea9f5f3a891a613f25d8d7344e54c9bb96720))
* keep repo tooling files out of the VSIX and allowlist the package check ([668c8bd](https://github.com/Vivswan/litellm-vscode-chat/commit/668c8bd4d5b73c6d0329b18e7e04d5a4517376dc))
* **marketplace:** sharpen the listing metadata and add README badges ([6661a63](https://github.com/Vivswan/litellm-vscode-chat/commit/6661a6373c3876be736dc3a8bb3a15f2567907ca))
* **tests:** pin tooltip placement, models-table structure, and the blur guard ([84e9e6c](https://github.com/Vivswan/litellm-vscode-chat/commit/84e9e6ce8782240ca86b63ab74c02426678c2c31))

## [0.4.0](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.3.1...v0.4.0) (2026-07-31)


### ⚠ BREAKING CHANGES

* modelParameters keys scoped by a pre-migration server label (e.g. "Production/gpt-4") no longer match as label scopes. In user settings the migration copies each label-scoped reading into the declared server entry carrying that label - its per-entry modelParameters record, also new in this release - so two entries sharing a base URL keep their separate parameters; when no declared entry carries the label, it instead adds a base-URL-scoped copy (like "https://myproxy.example/v1/gpt-4") beside the original, covering seeded and still-unseeded registry servers alike. The original label-scoped keys stay in place but no longer match anything on their own. Workspace and folder settings are never rewritten: a label-shaped key there keeps matching only as an ordinary bare prefix, which applies only when a raw model ID literally starts with the "Production/" text. Rewrite such keys by hand - into per-entry modelParameters on the server entry, or the base-URL-scoped form above; the extension logs a count of them once per activation.
* the minimum supported VS Code version is now 1.129.0.

### Features

* add a getting-started walkthrough and a manage hub ([3644431](https://github.com/Vivswan/litellm-vscode-chat/commit/3644431c1a284530cf81f6bcdc9d551533b714d2))
* add a reasoning-effort picker to the model configuration menu ([616daad](https://github.com/Vivswan/litellm-vscode-chat/commit/616daad67b056518d830825465edca52221382b6))
* add a settings dashboard showing servers, models, and options in one pane ([23205f8](https://github.com/Vivswan/litellm-vscode-chat/commit/23205f85a078701424b61ccedcf3464c06b79583))
* add hover help to the dashboard sections and form fields ([7cc455d](https://github.com/Vivswan/litellm-vscode-chat/commit/7cc455da6664eec62024d62f026d8500f51f40ad))
* advertise long-context tiered pricing ([629b172](https://github.com/Vivswan/litellm-vscode-chat/commit/629b172dda126c65bf88337c81c3e643e890c49f))
* cache model discovery per group and add a Sync Models Now command ([a3094e4](https://github.com/Vivswan/litellm-vscode-chat/commit/a3094e428d053bb94b45477deeeb422dfb15a6e5))
* cache tools and conversation history for Claude, not just the system prompt ([eaf9c74](https://github.com/Vivswan/litellm-vscode-chat/commit/eaf9c74ad6ed3fedd72723cd75159159c30593b0))
* deepen the stream fuzzer and file issues from nightly runs ([fdb5af3](https://github.com/Vivswan/litellm-vscode-chat/commit/fdb5af3ac6a3222987b42d985c5256e1c8611c37))
* derive the model picker's priceCategory cost badge from declared pricing ([f045a76](https://github.com/Vivswan/litellm-vscode-chat/commit/f045a76966eb2532a02939591c678e87e80a261c))
* emit a compact pricing label so the picker hover shows cost without usage-based billing ([1ccda9b](https://github.com/Vivswan/litellm-vscode-chat/commit/1ccda9ba9eb1f2bcc03deb974583f2e1db313f5d))
* emit the usage trailer as an end-of-stream usage DataPart ([600c706](https://github.com/Vivswan/litellm-vscode-chat/commit/600c7068d1124509ba9e8fa7ca218156b8550b39))
* extend the reasoning-effort picker with Off, Minimal, and Extra High tiers ([8d9b92e](https://github.com/Vivswan/litellm-vscode-chat/commit/8d9b92ea6bcc11d0e3d10f86a908739f3e63581f))
* fold chunk-level citations and search results into the sources trailer ([9a6132b](https://github.com/Vivswan/litellm-vscode-chat/commit/9a6132b6c90612a691b5aaa086a1f6b5009eb2d5))
* forward tool-result images and audio input to capable models ([5806e83](https://github.com/Vivswan/litellm-vscode-chat/commit/5806e83cf6249c943e9f61a5192cf3f6524510f8))
* fuzz SSE framing, tool-call dedup, and config parsing; adopt the nightly fuzzer module ([fa9ae86](https://github.com/Vivswan/litellm-vscode-chat/commit/fa9ae8661ad0f5549a36814bca91c6989347ee1d))
* generate the docker LiteLLM config at runtime with key-conditional wildcards ([bcb09b1](https://github.com/Vivswan/litellm-vscode-chat/commit/bcb09b1a3f0f85acb324929a43aca503398dd011))
* group dashboard settings with per-scope reset and live validation ([21c9947](https://github.com/Vivswan/litellm-vscode-chat/commit/21c9947892c1a25a85afe47322bcb516d68b3e71))
* guided empty state, icon affordances, and loading-skeleton polish ([6fca50b](https://github.com/Vivswan/litellm-vscode-chat/commit/6fca50ba94079bb91e152df5173470f4df38d106))
* leveled, filterable output-channel logging ([bb2bd04](https://github.com/Vivswan/litellm-vscode-chat/commit/bb2bd04bc7f5096e404dfda1cd2183e7a911ed42))
* link each dashboard section to its docs page ([14faafe](https://github.com/Vivswan/litellm-vscode-chat/commit/14faafe017ad6269921f6a35881cc911d1573b2e))
* manage servers as VS Code-native language model provider groups ([17f28e7](https://github.com/Vivswan/litellm-vscode-chat/commit/17f28e7421fcf025ad991cb09c526f13303775d0))
* manage servers declaratively from settings and the dashboard ([87c19d9](https://github.com/Vivswan/litellm-vscode-chat/commit/87c19d903ac83acbfc125d9015bf5e73ad480fb0))
* merge the dashboard's Servers and Models tabs into one view ([b748a91](https://github.com/Vivswan/litellm-vscode-chat/commit/b748a918479289747092fb4e8e1e6e442588a8b6))
* move the server forms into a focus-trapped slide-over with discard confirm ([4885d2b](https://github.com/Vivswan/litellm-vscode-chat/commit/4885d2b8bf6fd4f7f15c6e21d4f1b2e834ed1726))
* open the dashboard from the status bar item ([1343d01](https://github.com/Vivswan/litellm-vscode-chat/commit/1343d01a5e9295679b766a4f67fb7892114cbc9f))
* prefill inline server secrets in the dashboard edit form ([fb5a9c6](https://github.com/Vivswan/litellm-vscode-chat/commit/fb5a9c61b56f003f48b2133ed07b2b47539b4f7e))
* register models with real families and modern picker metadata ([122f557](https://github.com/Vivswan/litellm-vscode-chat/commit/122f5576d1871e7638d87976c734bdc50234230c))
* replace mock server with dockerized LiteLLM test stack ([bca3f90](https://github.com/Vivswan/litellm-vscode-chat/commit/bca3f9028349aa0422b129f989c0fd08c6ebaa94))
* require VS Code 1.129 and retype the provider against the current LM API ([f930069](https://github.com/Vivswan/litellm-vscode-chat/commit/f930069b381bcd29503a0512dd3e79385922b201))
* retry transient model-discovery failures ([7400ac6](https://github.com/Vivswan/litellm-vscode-chat/commit/7400ac6be3e6dc4ffdb7ce56cd42abaa8e9ee4a1))
* scope model parameters to a declared server entry ([90fba33](https://github.com/Vivswan/litellm-vscode-chat/commit/90fba3342ce498f246912bd28155008196da79eb))
* scope modelParameters by base URL only ([4e23bff](https://github.com/Vivswan/litellm-vscode-chat/commit/4e23bff553a62edaeea15cd0b1f79df987e44088))
* section tabs on the dashboard with kept-mounted panels ([be69e8e](https://github.com/Vivswan/litellm-vscode-chat/commit/be69e8e9c2a6faa8316a5136715092cf01c515aa))
* send server-declared output limits uncapped ([dc3fbbc](https://github.com/Vivswan/litellm-vscode-chat/commit/dc3fbbcccae5409d4d22481bd117d7545aaccf7d))
* serve a failed group's last known models flagged stale with statusIcon and warningText ([71a0806](https://github.com/Vivswan/litellm-vscode-chat/commit/71a08065defb96f96c776b1436e8ccf4e0055d85))
* sortable, windowed models table with sticky header and copy-ID row action ([b897599](https://github.com/Vivswan/litellm-vscode-chat/commit/b897599fa471da37cb72925697ed04452a56a55d))
* status pills with relative check times on the dashboard ([7a0c842](https://github.com/Vivswan/litellm-vscode-chat/commit/7a0c8422f834c3c1711c7aacdc3fbdb0c30bba35))
* stop injecting a default temperature; send only user-set parameters ([2d0bab7](https://github.com/Vivswan/litellm-vscode-chat/commit/2d0bab7774e936ebb7d292ab040cdf6cc2a6daa8))
* success toasts, failure banners, and busy spinners for dashboard intents ([05d73e2](https://github.com/Vivswan/litellm-vscode-chat/commit/05d73e22b98996fb038563e694a7f12ec334d71a))
* support OAuth2 client-credentials authentication for LiteLLM servers ([8c52b72](https://github.com/Vivswan/litellm-vscode-chat/commit/8c52b72bff23017326ac74f8449e04d48a197de0))
* surface classified chat failures as stable LanguageModelError codes ([d35fd15](https://github.com/Vivswan/litellm-vscode-chat/commit/d35fd1594c7ad6c65e41ef13b8481a21c7e95035))
* surface LiteLLM pricing in the model picker ([1b3388f](https://github.com/Vivswan/litellm-vscode-chat/commit/1b3388f9a7b442a79e963d17f229b0e7bf22e51e))
* surface model-generated images and audio as data parts ([10e8daa](https://github.com/Vivswan/litellm-vscode-chat/commit/10e8daad0f0498779e3578f661405982adfc54c9))


### Bug Fixes

* add base-URL-scoped copies of label-scoped modelParameters keys ([8e629fe](https://github.com/Vivswan/litellm-vscode-chat/commit/8e629fe3f4fc419d779cf05b43effd48582ead07))
* anchor the stale banner to the last successful sync and pin the dashboard listing ([6cca935](https://github.com/Vivswan/litellm-vscode-chat/commit/6cca9355a1059e10cb70e317637e623bb9c96d88))
* bind adoption to opaque handles and make server sync failure-honest ([6fc932d](https://github.com/Vivswan/litellm-vscode-chat/commit/6fc932d9c6e738bcce157287fbb1cc22edccf395))
* bound stale serving by the last successful discovery ([08c6b90](https://github.com/Vivswan/litellm-vscode-chat/commit/08c6b90fe0ee2881a12fb72d097b6cbcbf2a1d6b))
* commit the copilot-token mountpoint so fresh checkouts can start the stack ([35ff20a](https://github.com/Vivswan/litellm-vscode-chat/commit/35ff20af57fb9ad74701e37e463f0567c505600e))
* complete legacy config migration before registering the provider ([1da6859](https://github.com/Vivswan/litellm-vscode-chat/commit/1da68597785823d569be8a5017776aad72dbc162))
* complete the group migration on fresh installs without legacy config ([a3f60c0](https://github.com/Vivswan/litellm-vscode-chat/commit/a3f60c029c6d1c72f890bec82de7c559a9914804))
* count object-valued prompt-tsx parts and pin the pricing blend and label edges ([0744499](https://github.com/Vivswan/litellm-vscode-chat/commit/0744499dbf5abaf406b49624ec39b6ce498db884))
* count tool-result content in provideTokenCount instead of 0 ([ab7586e](https://github.com/Vivswan/litellm-vscode-chat/commit/ab7586eb2f385ac4cc070313ef795105095314c6))
* declare machinery labels, protect release tags, realign docs ([7423f2c](https://github.com/Vivswan/litellm-vscode-chat/commit/7423f2cb924e9e68cfac84eedbd10c7901b00066))
* defer cold-start claims and bound the connecting state ([4355c8c](https://github.com/Vivswan/litellm-vscode-chat/commit/4355c8cef74a36f7ccf0b71cfbc85375dbad6684))
* drop malformed persisted status elements instead of crashing the status bar ([18dde96](https://github.com/Vivswan/litellm-vscode-chat/commit/18dde962c9fe8fb7dcda1ab8bb21147139266d00))
* emit stream trailers only after terminal checks at end of stream ([91fda70](https://github.com/Vivswan/litellm-vscode-chat/commit/91fda7017866dc9e2b9302466a2784767be4c5e6))
* emit the usage DataPart only at the true end of stream ([460f9f6](https://github.com/Vivswan/litellm-vscode-chat/commit/460f9f645d89d8636beccde1c44b5e5441a3dbd9))
* escape hatch for a hung adopt, AT-hidden windowing spacers, measured row heights, and no leftover titles ([2847d62](https://github.com/Vivswan/litellm-vscode-chat/commit/2847d62ee68c2073dac8cbbc4827e7d9ef3715a0))
* estimate audio input tokens instead of zero ([8ba0c70](https://github.com/Vivswan/litellm-vscode-chat/commit/8ba0c70e94937cce345124a2e0ea68df2677182f))
* filter blocked models and merge load-balanced deployments in discovery ([a97c39e](https://github.com/Vivswan/litellm-vscode-chat/commit/a97c39e2b8405701effb8154af9a62f4f67b18d4))
* give each declared server its own status identity ([c4175f5](https://github.com/Vivswan/litellm-vscode-chat/commit/c4175f595e0b8e892e1256fd5c8ec69e3094f942))
* guarded slide-over exits, plain-language form copy, destructive remove control, and a clean first run ([dd3b46f](https://github.com/Vivswan/litellm-vscode-chat/commit/dd3b46fd374b0aad0ddaa2eccc67e89acf23362a))
* hold the usage DataPart until the stream settles and reject non-finite counts ([5375b5c](https://github.com/Vivswan/litellm-vscode-chat/commit/5375b5ca239ce743a8a1ef13be2a50a5d6ef26b5))
* keep an overflowing header number literal instead of a silent no-op apply ([91be94c](https://github.com/Vivswan/litellm-vscode-chat/commit/91be94c9d6317d6a2dae3fdc93f8dbb457368096))
* keep dashboard help text short and example-led ([02ea5f4](https://github.com/Vivswan/litellm-vscode-chat/commit/02ea5f462e565cadd725ab62e50e7113ba73b572))
* keep mapSdkError total when a thrown value's string coercion throws ([dd23ccd](https://github.com/Vivswan/litellm-vscode-chat/commit/dd23ccd8bdf82c5c64d1136993fb9f8caf1fa14b))
* keep non-chat model_info modes out of the chat model picker ([4418f92](https://github.com/Vivswan/litellm-vscode-chat/commit/4418f928c0f2ba1f13cc9b132c313fda7fa6508a))
* keep response bodies out of the discovery fallback log ([f9fc784](https://github.com/Vivswan/litellm-vscode-chat/commit/f9fc78451c53d85aa9ff9c41fb09dae9d16b3e2c))
* keep server-sync fingerprints in memory so stale globalState reads cannot wedge a healthy entry ([79e8694](https://github.com/Vivswan/litellm-vscode-chat/commit/79e8694ba7eee0d98417826e7c7cde53f4e16d05))
* key stored server fingerprints by a per-install secret salt ([666b435](https://github.com/Vivswan/litellm-vscode-chat/commit/666b43582e1f2d916dedb02488b303e2aa9e9772))
* label migrated provider groups and flag entry parameters a pre-label group cannot serve ([9ca5737](https://github.com/Vivswan/litellm-vscode-chat/commit/9ca5737537e9e3db77d13900a5330384a3fc6700))
* list a shared group snapshot's models under every claiming server ([5ee76ae](https://github.com/Vivswan/litellm-vscode-chat/commit/5ee76aefe20bee450424fd0417181692b573403b))
* log thinking-part absence once and pin the streaming pass-through contract ([2775957](https://github.com/Vivswan/litellm-vscode-chat/commit/277595780324c1fd54bdfd97a1c2b5382ce279c2))
* migrate label-scoped modelParameters into their declared entries' per-entry records ([5a8befa](https://github.com/Vivswan/litellm-vscode-chat/commit/5a8befac4a50a8901f35295817fd972e1388bbeb))
* mirror the pricing fields on LanguageModelChat and pin them through a real host ([551c9ee](https://github.com/Vivswan/litellm-vscode-chat/commit/551c9ee94beed959e6b6160efc8e71c9d35d7a56))
* never advertise more input than the strictest provider accepts ([b16cc6d](https://github.com/Vivswan/litellm-vscode-chat/commit/b16cc6d13f9006d24f1d6eabf6e4067d8913090f))
* only invalidate the OAuth token a 401 actually rejected ([f8fdcc1](https://github.com/Vivswan/litellm-vscode-chat/commit/f8fdcc10e5c27ba58dd86facecc05611d038445e))
* price multimodal prompts per the model's capabilities in the pre-send token check ([6e5f5ef](https://github.com/Vivswan/litellm-vscode-chat/commit/6e5f5ef8e8a1f661e9c74585d567b3e83eda1b6b))
* price raw-string and stringified tool-result content in the token estimate ([736b4fa](https://github.com/Vivswan/litellm-vscode-chat/commit/736b4fae85ad672c3ceb1b6e3cb959ec411c0254))
* render help tooltips in the webview instead of relying on native titles ([c1612b0](https://github.com/Vivswan/litellm-vscode-chat/commit/c1612b05cceff108ad0864fa527bc5208023dc3f))
* require both label and base URL to match before applying entry modelParameters ([a193ae9](https://github.com/Vivswan/litellm-vscode-chat/commit/a193ae96a389d3e44e8bd5b630e26e77720a6535))
* rewrite label-scoped modelParameters keys before the provider starts ([e3be83d](https://github.com/Vivswan/litellm-vscode-chat/commit/e3be83dc18aa2eaaddeaef48e1f2380701ed1afd))
* rewrite stream processing with typed chunks and an extracted inline parser ([bd7312e](https://github.com/Vivswan/litellm-vscode-chat/commit/bd7312efdf6cb6150099ca40e16fa73d335c50a7))
* sanitize a broken persisted registry version that froze cross-window adoption ([afbc87d](https://github.com/Vivswan/litellm-vscode-chat/commit/afbc87d688a41a54e9e07999ac9ca4b8a962bfcf))
* satisfy the a11y lint rules on the scrim and windowing spacer rows ([d55b7a2](https://github.com/Vivswan/litellm-vscode-chat/commit/d55b7a28644a0ecde313bc147c7892d699ceb2b7))
* skip the pricing label and badge when both costs round to zero ([0c4f4ac](https://github.com/Vivswan/litellm-vscode-chat/commit/0c4f4acf79f075b635f8c73b22d4831e7f6f2fbe))
* stop a cleared secret's stale text from blocking Save ([274a7ae](https://github.com/Vivswan/litellm-vscode-chat/commit/274a7ae07513bcf1293340f070ce5b73e0e98f46))
* stop control tokens leaking into chat text when SSE chunks split them ([ede4349](https://github.com/Vivswan/litellm-vscode-chat/commit/ede4349cb404a39d24a127b563e6351887d13101))
* stop double-encoding generated GitHub issue URLs ([3a005f6](https://github.com/Vivswan/litellm-vscode-chat/commit/3a005f691d2222ee9193e0ae47a22b3ba2fe5830))
* stop losing server registrations to stale globalState broadcasts ([1bda2ee](https://github.com/Vivswan/litellm-vscode-chat/commit/1bda2ee769f49e432bbdadc1dcb0ab9292c50f51))
* stop packaging coverage output and dev log tees in the VSIX ([6565d7f](https://github.com/Vivswan/litellm-vscode-chat/commit/6565d7fea13e64460a57f0a31f9404da2391628f))
* surface dropped reasoning instead of resolving empty when the host lacks thinking parts ([#215](https://github.com/Vivswan/litellm-vscode-chat/issues/215), [@yongzhang](https://github.com/yongzhang)) ([9c7e070](https://github.com/Vivswan/litellm-vscode-chat/commit/9c7e0704986b014381de2bf167b4c06f3c9d34b1))
* surface mid-stream socket deaths and stream error frames as classified errors ([943b219](https://github.com/Vivswan/litellm-vscode-chat/commit/943b2194c186e97a394a8ce5bff1eb7b5cad497d))
* sweep orphans by recorded id and reopen seeding after completion ([83f3cac](https://github.com/Vivswan/litellm-vscode-chat/commit/83f3cac6401fe2e61a615e5b1679834dccec3d4b))
* treat LiteLLM's zero-stamped pricing as undeclared ([3d0c71d](https://github.com/Vivswan/litellm-vscode-chat/commit/3d0c71dc183161bf08bf12c41711c2f8f3b7026d))
* validate discovery payloads per element and abort requests on cancellation ([ac96ded](https://github.com/Vivswan/litellm-vscode-chat/commit/ac96dedf400b3df05cbe593d4af4257f62a722ef))
* viewport-sized models scrollport with row indices, focusable pricing detail, and a resting sort affordance ([58300df](https://github.com/Vivswan/litellm-vscode-chat/commit/58300df5aafc9222d1e47d83451eb4742a118f8b))

## [0.3.1](https://github.com/Vivswan/litellm-vscode-chat/compare/v0.3.0...v0.3.1) (2026-06-21)


### Bug Fixes

* Add support for custom HTTP headers in LiteLLM provider configuration ([#159](https://github.com/Vivswan/litellm-vscode-chat/issues/159)) ([5c07e9a](https://github.com/Vivswan/litellm-vscode-chat/commit/5c07e9a3805ca437aa2758c2cc12cb8ea606a323))

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
