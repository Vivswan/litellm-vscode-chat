/**
 * The behavior column of each locale's settings reference table. Completeness
 * is a type, not a check: Record<SettingId, ...> makes a setting with no prose
 * a compile error, so a feature cannot ship a setting the docs never mention.
 */
import type { SettingId } from "../../src/shared/config/settingSpec";

/** One setting's behavior prose in every shipped docs locale. */
export interface SettingProse {
	readonly en: string;
	readonly zhCn: string;
	readonly zhTw: string;
}

/** Behavior prose per setting ID (the name without the config section prefix). */
export const SETTING_PROSE: Readonly<Record<SettingId, SettingProse>> = {
	servers: {
		en: "The declared LiteLLM servers; [entry properties below](#server-entry-properties), full story in [Servers](servers.md)",
		zhCn: "声明的 LiteLLM 服务器; [条目属性见下](#服务器条目属性), 完整故事在[服务器](servers.md)",
		zhTw: "宣告的 LiteLLM 伺服器; [項目屬性見下](#伺服器項目屬性), 完整故事在[伺服器](servers.md)",
	},
	"models.parameters": {
		en: "Request parameters per model, keyed by [matchers](models.md#model-matching). Only what you set is sent. Full story: [Models - Parameters](models.md#parameters)",
		zhCn: "按模型的请求参数, 以[匹配器](models.md#模型匹配)为键。只发送你设置的。完整故事: [模型 - 参数](models.md#参数)",
		zhTw: "按模型的請求參數, 以[比對器](models.md#模型比對)為鍵。只送出您設定的。完整故事: [模型 - 參數](models.md#參數)",
	},
	"models.capabilities": {
		en: "Capability overrides per model, keyed by [matchers](models.md#model-matching): token limits, vision, tools, reasoning, pricing - any `model_info` field, known or not; the vocabulary is open. Full story: [Models - Capabilities](models.md#capabilities)",
		zhCn: "按模型的能力覆盖, 以[匹配器](models.md#模型匹配)为键: token 限制、视觉、工具、推理、定价 - 任何 `model_info` 字段, 认识与否皆可; 词汇表是开放的。完整故事: [模型 - 能力](models.md#能力)",
		zhTw: "按模型的能力覆寫, 以[比對器](models.md#模型比對)為鍵: token 上限、視覺、工具、推理、定價 - 任何 `model_info` 欄位, 認識與否皆可; 詞彙表是開放的。完整故事: [模型 - 能力](models.md#能力)",
	},
	"models.openRouterCatalog": {
		en: 'Fill missing capabilities from a weekly-refreshed snapshot of OpenRouter\'s public catalog; manual refresh via "LiteLLM: Refresh OpenRouter Catalog". Details incl. privacy notes: [Models - Capabilities](models.md#capabilities)',
		zhCn: '用每周刷新的 OpenRouter 公开目录快照填补缺失的能力; 手动刷新用 "LiteLLM: Refresh OpenRouter Catalog"。详情含隐私说明: [模型 - 能力](models.md#能力)',
		zhTw: '用每週重新整理的 OpenRouter 公開目錄快照填補缺少的能力; 手動重新整理用 "LiteLLM: Refresh OpenRouter Catalog"。詳情含隱私說明: [模型 - 能力](models.md#能力)',
	},
	"chat.timeout": {
		en: "Hard time budget for one chat completion call, and for one commit-message, pull-request-description, consult-tool, quick-fix or review-comment call, in milliseconds. Chat requests are never retried, so this is the total time one request may take, streaming included. Minimum 1000; lower values are clamped. Raise it for long reasoning runs or slow infrastructure",
		zhCn: "单次聊天补全调用, 以及单次提交消息生成、拉取请求描述生成、咨询工具、快速修复或评审评论调用的硬性时间预算, 毫秒。聊天请求从不重试, 所以这是一个请求可占用的总时间, 含流式传输。最小 1000; 更低的值会被钳制。为长推理运行或缓慢的基础设施调大它",
		zhTw: "單次聊天補全呼叫, 以及單次提交訊息產生、提取要求描述產生、諮詢工具、快速修復或審查評論呼叫的硬性時間預算, 毫秒。聊天請求從不重試, 所以這是一個請求可占用的總時間, 含串流。最小 1000; 更低的值會被箝制。為長推理運行或緩慢的基礎設施調大它",
	},
	"chat.maxToolsPerRequest": {
		en: "How many tools one chat request may carry before the extension refuses it locally instead of sending it (most OpenAI-compatible servers enforce 128). Raising it past what your server or model accepts moves the failure server-side: the request is sent and the server rejects it. Minimum 1",
		zhCn: "一次聊天请求最多可携带的工具数, 超过时扩展在本地拒绝该请求而不发送 (多数 OpenAI 兼容服务器强制 128)。调大到超出你的服务器或模型接受的范围, 只会把失败移到服务器端: 请求会被发送, 然后被服务器拒绝。最小 1",
		zhTw: "一次聊天請求最多可攜帶的工具數, 超過時延伸模組在本機拒絕該請求而不送出 (多數 OpenAI 相容伺服器強制 128)。調高到超出你的伺服器或模型接受的範圍, 只會把失敗移到伺服器端: 請求會被送出, 然後被伺服器拒絕。最小 1",
	},
	"chat.additionalToolSchemaKeywords": {
		en: 'Extra JSON-Schema keywords kept in tool input schemas, e.g. `["propertyNames"]`. Tool schemas are sanitized to a built-in keyword allowlist before sending; keywords listed here are kept too, values passed through unchanged. The built-in set always applies. A keyword your server or model does not accept can fail requests or degrade tool calling',
		zhCn: '工具输入 schema 中额外保留的 JSON-Schema 关键字, 例如 `["propertyNames"]`。发送前工具 schema 会按内置关键字白名单清理; 此处列出的关键字也会保留, 其值原样透传。内置白名单始终生效。服务器或模型不接受的关键字可能导致请求失败或工具调用变差',
		zhTw: '工具輸入 schema 中額外保留的 JSON-Schema 關鍵字, 例如 `["propertyNames"]`。送出前工具 schema 會按內建關鍵字允許清單清理; 此處列出的關鍵字也會保留, 其值原樣透傳。內建允許清單始終生效。伺服器或模型不接受的關鍵字可能導致請求失敗或工具呼叫變差',
	},
	"chat.promptCaching": {
		en: "Reuse provider-side prompt caches across the turns of a session on models that advertise support; [details below](#prompt-caching)",
		zhCn: "在宣布支持的模型上, 跨会话轮次复用提供方侧的提示缓存; [详情见下](#提示缓存)",
		zhTw: "在宣告支援的模型上, 跨工作階段回合沿用提供者端的提示快取; [詳情見下](#提示快取)",
	},
	"chat.tokenEstimation": {
		en: 'How prompt sizes are estimated for the local token budget: `"auto"` (script-aware heuristic that loads the o200k_base tokenizer when the VS Code display language is not English, or when the chat contains enough text that plain character counting underestimates - CJK and other non-Latin scripts, emoji), `"heuristic"` (plain 4-characters-per-token, never loads tokenizer data, undercounts CJK roughly 4x), `"o200k_base"` or `"cl100k_base"` (always load that tokenizer). A loaded tokenizer keeps roughly 10-30 MB in memory while active; counting cost is negligible',
		zhCn: '本地 token 预算如何估算提示大小: `"auto"` (识别文字系统的启发式, 在 VS Code 显示语言不是英语, 或聊天中含足够多让纯字符计数低估的文本 - CJK 等非拉丁文字、emoji - 时加载 o200k_base 分词器)、`"heuristic"` (纯粹按每 4 字符 1 token 计, 从不加载分词器数据, 对 CJK 低估约 4 倍)、`"o200k_base"` 或 `"cl100k_base"` (始终加载该分词器)。加载的分词器在活跃期间约占用 10-30 MB 内存; 计数开销可忽略',
		zhTw: '本地 token 預算如何估算提示大小: `"auto"` (識別文字系統的啟發式, 在 VS Code 顯示語言不是英文, 或聊天中含足夠多讓純字元計數低估的文字 - CJK 等非拉丁文字、emoji - 時載入 o200k_base 分詞器)、`"heuristic"` (純粹按每 4 字元 1 token 計, 從不載入分詞器資料, 對 CJK 低估約 4 倍)、`"o200k_base"` 或 `"cl100k_base"` (始終載入該分詞器)。載入的分詞器在活躍期間約佔用 10-30 MB 記憶體; 計數開銷可忽略',
	},
	"discovery.timeout": {
		en: "Hard time budget for each model-discovery request, in milliseconds, its retries included. The model-info listing, the `/v1/models` fallback, and the OAuth token exchange each get a fresh budget, so a discovery pass may take up to their sum. Minimum 1000",
		zhCn: "每个模型发现请求的硬性时间预算, 毫秒, 含该请求的重试。模型信息列表、`/v1/models` 回退和 OAuth 令牌交换各自获得一份新预算, 所以一轮发现最长可能耗时到它们之和。最小 1000",
		zhTw: "每個模型探索請求的硬性時間預算, 毫秒, 含該請求的重試。模型資訊清單、`/v1/models` 退回和 OAuth 權杖交換各自獲得一份新預算, 所以一輪探索最長可能耗時到它們之和。最小 1000",
	},
	"discovery.cacheTtl": {
		en: 'How long a discovered model list is reused, in milliseconds. VS Code re-resolves providers often (sometimes several times a second); the cache keeps that off your server. `0` fetches fresh every time (negative values clamp to `0`); failures are never cached; simultaneous refreshes share one request; "LiteLLM: Sync Models Now" bypasses it',
		zhCn: '已发现的模型列表复用多久, 毫秒。VS Code 重新解析提供程序很频繁 (有时一秒好几次); 缓存把那挡在你的服务器之外。`0` 表示每次都新取 (负值钳制为 `0`); 失败从不缓存; 同时发生的刷新共享一个请求; "LiteLLM: Sync Models Now" 绕过它',
		zhTw: '已探索的模型清單沿用多久, 毫秒。VS Code 重新解析提供者很頻繁 (有時一秒好幾次); 快取把那擋在您的伺服器之外。`0` 表示每次都重新擷取 (負值箝制為 `0`); 失敗從不快取; 同時發生的重新整理共用一個請求; "LiteLLM: Sync Models Now" 略過它',
	},
	"discovery.staleServeWindow": {
		en: "How long a server that stops answering keeps serving its last known models flagged stale, counted from its last successful discovery, in milliseconds. Raise it for a server that sleeps or restarts for longer than ten minutes; `0` never serves stale models (a failed refresh empties that server's list at once). Details: [Models - Discovery](models.md#discovery)",
		zhCn: "服务器停止响应后, 其最后已知的模型继续提供 (标记为过期) 的时长, 毫秒, 从最后一次成功发现起算。若服务器休眠或重启超过十分钟, 可调大它; `0` 表示从不提供过期模型 (刷新失败立即清空该服务器的列表)。详情: [模型 - 发现](models.md#发现)",
		zhTw: "伺服器停止回應後, 其最後已知的模型繼續提供 (標記為過時) 的時長, 毫秒, 從最後一次成功探索起算。若伺服器休眠或重啟超過十分鐘, 可調高它; `0` 表示永不提供過時模型 (重新整理失敗立即清空該伺服器的清單)。詳情: [模型 - 探索](models.md#探索)",
	},
	"usage.pollInterval": {
		en: "Background spend/budget polling cadence, in milliseconds. `0` = off: no background requests and no alerts; the dashboard fetches on open only when a fetch is due (no completed fetch this session, the last one older than five minutes, or a changed `servers` setting). Nonzero values below `30000` clamp up to 30 seconds. Full story: [Usage](usage.md)",
		zhCn: "后台支出/预算轮询节奏, 毫秒。`0` = 关闭: 没有后台请求, 没有警报; 仪表板打开时只在一次获取到期时才获取 (本次会话还没有完成过获取、距上一次获取已超过五分钟, 或 `servers` 设置有变更)。低于 `30000` 的非零值向上钳制到 30 秒。完整故事: [用量](usage.md)",
		zhTw: "背景支出/預算輪詢節奏, 毫秒。`0` = 關閉: 沒有背景請求, 沒有警示; 儀表板開啟時只在一次擷取到期時才擷取 (本次工作階段還沒有完成過擷取、距上一次擷取已超過五分鐘, 或 `servers` 設定有變更)。低於 `30000` 的非零值向上箝制到 30 秒。完整故事: [用量](usage.md)",
	},
	"usage.initialRefreshDelay": {
		en: "How long after extension startup the first usage poll runs, in milliseconds",
		zhCn: "扩展启动后多久运行首次用量轮询, 毫秒",
		zhTw: "延伸模組啟動後多久執行首次用量輪詢, 毫秒",
	},
	"usage.serversChangeRefreshDelay": {
		en: "How long after a `servers` change usage data refreshes, in milliseconds; long enough to coalesce a burst of settings.json keystrokes",
		zhCn: "`servers` 设置变更后多久刷新用量数据, 毫秒; 足以合并 settings.json 中的连续按键",
		zhTw: "`servers` 設定變更後多久重新整理用量資料, 毫秒; 足以合併 settings.json 中的連續按鍵",
	},
	"usage.pollingOffFreshnessWindow": {
		en: "How long on-demand usage data counts as fresh while polling is off, in milliseconds (while polling is on, the window is twice the poll interval instead). `0` never counts it fresh, which hides the [status bar item](usage.md#the-status-bar)",
		zhCn: "轮询关闭时, 按需获取的用量数据算作新鲜的时长, 毫秒 (轮询开启时, 窗口改为轮询间隔的两倍)。`0` 则从不算新鲜, [状态栏项](usage.md#状态栏)会因此隐藏",
		zhTw: "輪詢關閉時, 隨需取得的用量資料算作新鮮的時長, 毫秒 (輪詢開啟時, 視窗改為輪詢間隔的兩倍)。`0` 則從不算新鮮, [狀態列項目](usage.md#狀態列)會因此隱藏",
	},
	"usage.alertThresholds": {
		en: "Budget fractions that trigger a one-time alert each; every value in (0, 1]; empty list = alerts off. Full story: [Usage - Alerts](usage.md#alerts)",
		zhCn: "各触发一次警报的预算比例; 每个值在 (0, 1] 内; 空列表 = 关闭警报。完整故事: [用量 - 警报](usage.md#警报)",
		zhTw: "各觸發一次警示的預算比例; 每個值在 (0, 1] 內; 空清單 = 關閉警示。完整故事: [用量 - 警示](usage.md#警示)",
	},
	"usage.statusBar": {
		en: 'The usage status bar item: `"always"`, `"alerts-only"`, `"off"`. Full story: [Usage - The status bar](usage.md#the-status-bar)',
		zhCn: '用量状态栏项: `"always"`、`"alerts-only"`、`"off"`。完整故事: [用量 - 状态栏](usage.md#状态栏)',
		zhTw: '用量狀態列項目: `"always"`、`"alerts-only"`、`"off"`。完整故事: [用量 - 狀態列](usage.md#狀態列)',
	},
	"usage.currencySymbol": {
		en: 'Prefix on every spend and price figure, e.g. `"EUR "`. Display only: amounts are never converted - they render exactly as the server reports them; an empty string shows bare numbers',
		zhCn: '每个支出和价格数字前的前缀, 例如 `"EUR "`。仅用于显示: 金额从不换算, 完全按服务器报告的数值呈现; 空字符串只显示数字',
		zhTw: '每個支出與價格數字前的前綴, 例如 `"EUR "`。僅用於顯示: 金額從不換算, 完全按伺服器回報的數值呈現; 空字串只顯示數字',
	},
	"ui.maskSecretInputs": {
		en: "Mask credential values while typing them into input-box prompts. The dashboard's secret fields always mask, each behind its own Show toggle, regardless of this setting",
		zhCn: "在输入框提示中输入凭据值时进行遮盖。仪表板的密钥字段始终遮盖, 各带自己的「显示」开关, 与此设置无关",
		zhTw: "在輸入方塊提示中輸入認證值時進行遮罩。儀表板的祕密欄位始終遮罩, 各帶自己的「顯示」切換, 與此設定無關",
	},
	"ui.theme": {
		en: 'How the dashboard colors itself: `"auto"` follows your VS Code theme, `"light"` and `"dark"` hold still while the editor changes around them. [Appearance notes below](#appearance)',
		zhCn: '仪表板如何着色: `"auto"` 跟随你的 VS Code 主题, `"light"` 和 `"dark"` 在编辑器变化时保持不动。[外观说明见下](#外观)',
		zhTw: '儀表板如何著色: `"auto"` 跟隨您的 VS Code 佈景主題, `"light"` 與 `"dark"` 在編輯器變化時保持不動。[外觀說明見下](#外觀)',
	},
	"ui.accent": {
		en: 'The dashboard\'s accent hue: `"blue"`, `"violet"`, `"teal"`, `"amber"`. It marks primary actions, selection, focus and links, and nothing else - status colors stay green, yellow and red. [Appearance notes below](#appearance)',
		zhCn: '仪表板的强调色: `"blue"`、`"violet"`、`"teal"`、`"amber"`。它标记主要操作、选中、焦点和链接, 仅此而已 - 状态色保持绿、黄、红。[外观说明见下](#外观)',
		zhTw: '儀表板的強調色: `"blue"`、`"violet"`、`"teal"`、`"amber"`。它標記主要動作、選取、焦點與連結, 僅此而已 - 狀態色保持綠、黃、紅。[外觀說明見下](#外觀)',
	},
	"inlineCompletions.enabled": {
		en: 'Opt-in for inline (ghost text) completions from a LiteLLM model, shipping with the inline completions feature. Off by default: nothing is registered and nothing is sent until enabled, except the dashboard\'s explicit "Test model" button, and enabling without `inlineCompletions.model` keeps the feature idle',
		zhCn: "选择启用由 LiteLLM 模型提供的内联(幽灵文本)补全, 随内联补全功能一起交付。默认关闭: 启用前不注册任何内容、不发送任何请求, 仪表板中显式的「测试模型」按钮除外; 只启用而不设置 `inlineCompletions.model` 时功能保持闲置",
		zhTw: "選擇啟用由 LiteLLM 模型提供的內嵌(幽靈文字)補全, 隨內嵌補全功能一起交付。預設關閉: 啟用前不註冊任何內容、不送出任何要求, 儀表板中明確的「測試模型」按鈕除外; 只啟用而不設定 `inlineCompletions.model` 時功能保持閒置",
	},
	"inlineCompletions.model": {
		en: 'The model that serves inline completions: `{ "server": "<entry label>", "model": "<raw model id>" }`, naming a `servers` entry and one of its model IDs. The model is always your explicit choice - never auto-picked; `null` keeps the feature idle',
		zhCn: '提供内联补全的模型: `{ "server": "<条目 label>", "model": "<原始模型 ID>" }`, 指向一个 `servers` 条目及其一个模型 ID。模型始终由你显式选择 - 从不自动挑选; `null` 使功能保持闲置',
		zhTw: '提供內嵌補全的模型: `{ "server": "<項目 label>", "model": "<原始模型 ID>" }`, 指向一個 `servers` 項目及其一個模型 ID。模型永遠由你明確選擇 - 從不自動挑選; `null` 使功能保持閒置',
	},
	"inlineCompletions.languageFilter": {
		en: 'Where inline completions run: mode `"block"` runs them everywhere except the listed exact VS Code language IDs, `"allow"` only in the listed ones (an empty allow list runs nowhere), e.g. `{ "mode": "block", "languages": ["markdown", "plaintext"] }`. The default blocks nothing',
		zhCn: '内联补全的运行范围: mode 为 `"block"` 时在列出的 VS Code 语言 ID (精确匹配) 之外的所有语言中运行, `"allow"` 时仅在列出的语言中运行 (允许列表为空则不在任何语言中运行), 例如 `{ "mode": "block", "languages": ["markdown", "plaintext"] }`。默认不屏蔽任何语言',
		zhTw: '內嵌補全的執行範圍: mode 為 `"block"` 時在列出的 VS Code 語言 ID (精確比對) 之外的所有語言中執行, `"allow"` 時僅在列出的語言中執行 (允許清單為空則不在任何語言中執行), 例如 `{ "mode": "block", "languages": ["markdown", "plaintext"] }`。預設不封鎖任何語言',
	},
	"commitGeneration.enabled": {
		en: "Opt-in for commit message generation from a LiteLLM model, shipping with the commit generation feature. Off by default: the command stays hidden and nothing is sent until enabled, and enabling without `commitGeneration.model` keeps the feature idle",
		zhCn: "选择启用由 LiteLLM 模型生成提交消息, 随提交消息生成功能一起交付。默认关闭: 启用前命令保持隐藏、不发送任何请求; 只启用而不设置 `commitGeneration.model` 时功能保持闲置",
		zhTw: "選擇啟用由 LiteLLM 模型產生提交訊息, 隨提交訊息產生功能一起交付。預設關閉: 啟用前命令保持隱藏、不送出任何要求; 只啟用而不設定 `commitGeneration.model` 時功能保持閒置",
	},
	"commitGeneration.model": {
		en: 'The model that drafts commit messages; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model`',
		zhCn: '起草提交消息的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则',
		zhTw: '起草提交訊息的模型; 與 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形狀和規則',
	},
	"commitGeneration.prompt": {
		en: "Custom instruction for the generated commit message, replacing the built-in instruction wholesale. Empty uses the built-in (a Conventional Commits subject plus a short body). Model-facing text, sent as written",
		zhCn: "生成提交消息时使用的自定义指令, 会整体替换内置指令。留空使用内置指令 (Conventional Commits 主题行加简短正文)。面向模型的文本, 按原样发送",
		zhTw: "產生提交訊息時使用的自訂指示, 會整體取代內建指示。留空使用內建指示 (Conventional Commits 主旨行加簡短內文)。面向模型的文字, 按原樣送出",
	},
	"prGeneration.enabled": {
		en: 'Opt-in for pull request title and description generation from a LiteLLM model. Off means the command stays hidden and no requests are sent, except the dashboard\'s explicit "Test model" button ([the recipe](getting-started.md#generate-pull-request-descriptions-with-your-own-model))',
		zhCn: "选择启用由 LiteLLM 模型生成拉取请求标题和描述。关闭时命令保持隐藏、不发送任何请求, 仪表板中显式的「测试模型」按钮除外 ([配方](getting-started.md#用你自己的模型生成拉取请求描述))",
		zhTw: "選擇啟用由 LiteLLM 模型產生提取要求標題和描述。關閉時命令保持隱藏、不送出任何要求, 儀表板中明確的「測試模型」按鈕除外 ([配方](getting-started.md#用您自己的模型產生提取要求描述))",
	},
	"prGeneration.model": {
		en: 'The model that drafts PR descriptions; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model`',
		zhCn: '起草 PR 描述的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则',
		zhTw: '起草 PR 描述的模型; 與 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形狀和規則',
	},
	"consultTool.enabled": {
		en: 'Opt-in for the consult tool, which lets a chat agent ask a second LiteLLM model for its opinion. Off by default: nothing is registered and nothing is sent until enabled, except the dashboard\'s explicit "Test model" button, and enabling without `consultTool.model` keeps the tool unregistered. Once both are set the agent calls it on its own initiative',
		zhCn: "选择启用咨询工具, 它让聊天代理向第二个 LiteLLM 模型征求意见。默认关闭: 启用前不会注册任何内容, 也不会发送任何请求, 仪表板中显式的「测试模型」按钮除外; 启用但未设置 `consultTool.model` 时, 工具保持未注册。两者都设置后, 代理会自行决定何时调用",
		zhTw: "選擇啟用諮詢工具, 它讓聊天代理向第二個 LiteLLM 模型徵求意見。預設關閉: 啟用前不會註冊任何內容, 也不會傳送任何請求, 儀表板中明確的「測試模型」按鈕除外; 啟用但未設定 `consultTool.model` 時, 工具保持未註冊。兩者都設定後, 代理會自行決定何時呼叫",
	},
	"consultTool.model": {
		en: 'The model the consult tool asks; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model`',
		zhCn: '咨询工具询问的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则',
		zhTw: '諮詢工具詢問的模型; 與 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形狀和規則',
	},
	"quickFix.enabled": {
		en: "Show Fix and Explain quick fixes on diagnostics. Both open the chat view and send the question to `@litellm`, with the diagnostics and the lines they sit on attached; when the chat view cannot answer they fall back to `quickFix.model`. See [the quick fix recipe](getting-started.md#fix-or-explain-a-diagnostic)",
		zhCn: "在诊断上显示「修复」和「解释」快速修复。两者都会打开聊天视图并把问题直接发送给 `@litellm`, 附上诊断及其所在的行; 聊天视图无法作答时改用 `quickFix.model`。参见[快速修复配方](getting-started.md#修复或解释一条诊断)",
		zhTw: "在診斷上顯示「修復」和「解釋」快速修復。兩者都會開啟聊天檢視並把問題直接傳送給 `@litellm`, 附上診斷及其所在的行; 聊天檢視無法作答時改用 `quickFix.model`。參見[快速修復配方](getting-started.md#修復或解釋一條診斷)",
	},
	"quickFix.model": {
		en: 'The model behind the quick-fix FALLBACK path only - the chat path uses whichever model the chat picker names. Same `{ "server", "model" }` shape and rules as `inlineCompletions.model`; `null` leaves the fallback idle',
		zhCn: '仅用于快速修复的后备路径 - 聊天路径使用聊天选择器指定的模型。与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则; `null` 表示后备路径保持闲置',
		zhTw: '僅用於快速修復的後備路徑 - 聊天路徑使用聊天選擇器指定的模型。與 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形狀和規則; `null` 表示後備路徑保持閒置',
	},
	"reviewComments.enabled": {
		en: 'Opt-in for AI review comments on your changes. Off by default; no comment threads exist and no review is sent until enabled, except the dashboard\'s explicit "Test model" button ([recipe](getting-started.md#get-review-comments-on-your-code))',
		zhCn: "选择启用对改动的 AI 评审评论。默认关闭; 启用前不存在任何评审会话, 也不会发出任何评审请求, 仪表板中显式的「测试模型」按钮除外 ([配方](getting-started.md#让模型评审你的代码))",
		zhTw: "選擇啟用對變更的 AI 審查評論。預設關閉; 啟用前不存在任何審查討論串, 也不會送出任何審查請求, 儀表板中明確的「測試模型」按鈕除外 ([配方](getting-started.md#讓模型審查您的程式碼))",
	},
	"reviewComments.model": {
		en: 'The model that writes review comments; the same `{ "server", "model" }` shape and rules as `inlineCompletions.model`',
		zhCn: '撰写评审评论的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则',
		zhTw: '撰寫審查評論的模型; 與 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形狀和規則',
	},
	"chatParticipant.enabled": {
		en: "The @litellm chat participant, answering with the chat request's own model (no model setting). On by default",
		zhCn: "@litellm 聊天参与者, 使用聊天请求自身的模型作答 (没有模型设置)。默认开启",
		zhTw: "@litellm 聊天參與者, 使用聊天請求自身的模型作答 (沒有模型設定)。預設開啟",
	},
};
