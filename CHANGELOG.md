# Changelog

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
