# 設定

[English](../settings.md) | [简体中文](../zh-cn/settings.md) | 繁體中文

每個 `litellm-vscode-chat.*` 設定與每個伺服器項目屬性的查詢參考: 名稱、預設值、一段話的行為說明, 以及完整故事在哪裡。要*學習*概念, 請改讀支柱頁面: [伺服器](servers.md)、[模型](models.md)、[用量](usage.md)。

## 設定如何運作

兩種等價的編輯方式:

- **設定 UI / settings.json** - `Ctrl+,` / `Cmd+,`, 搜尋 "litellm-vscode-chat"。設定分組為幾個區段 (伺服器、模型、聊天、探索、用量、UI)。
- **儀表板** - "LiteLLM: Open Dashboard", 設定分頁。同樣的值以表單控制項呈現, 驗證、單位與預設值就地顯示; 已設定的列說明其值存放在哪裡, 「重設」清除該範圍。見[儀表板](dashboard.md)。

| 事實 | 細節 |
|---|---|
| 範圍 | `servers` 是機器範圍的: 僅限使用者設定, 永遠不能被工作區覆寫, 也永遠不由設定同步攜帶。工作區 `.vscode/settings.json` 中的 `servers` 值會被 VS Code 自己忽略 (設定編輯器會說它只能套用於使用者設定)。其他每個設定都像一般的使用者/工作區設定一樣運作並正常同步。 |
| 生效 | 變更立即套用 - 不需重新載入。影響模型的變更會重新整理模型清單; 用量變更會重接輪詢器; 逾時變更套用於下一個請求。 |
| 移轉 | 舊版本的設定在升級時自動重新命名與重構; 見[重新命名表](#重新命名與移除的設定)。不需重新輸入任何東西。當新名稱的設定已經有值時 (比如設定同步先從已升級的機器送來了它), 移轉保留它, 只捨棄舊鍵。 |
| 未知鍵 | 延伸模組未宣告的 `litellm-vscode-chat.*` 鍵 (打錯字, 比如 `chat.timout`) 會被忽略, VS Code 的設定編輯器會在 settings.json 中把它標為未知設定。[重新命名](#重新命名與移除的設定)之後的舊名稱同理。 |

## 參考

| 設定 | 預設值 | 行為 |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | 宣告的 LiteLLM 伺服器; [項目屬性見下](#伺服器項目屬性), 完整故事在[伺服器](servers.md) |
| `litellm-vscode-chat.models.parameters` | `{}` | 按模型的請求參數, 以[比對器](models.md#模型比對)為鍵。只送出您設定的。完整故事: [模型 - 參數](models.md#參數) |
| `litellm-vscode-chat.models.capabilities` | `{}` | 按模型的能力覆寫, 以[比對器](models.md#模型比對)為鍵: token 上限、視覺、工具、推理。完整故事: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.models.openRouterCatalog` | `true` | 用每週重新整理的 OpenRouter 公開目錄快照填補缺少的能力; 手動重新整理用 "LiteLLM: Refresh OpenRouter Catalog"。詳情含隱私說明: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.chat.timeout` | `300000` | 單次聊天補全的硬性時間預算, 毫秒。聊天請求從不重試, 所以這是一個請求可占用的總時間, 含串流。最小 1000; 更低的值會被箝制。為長推理運行或緩慢的基礎設施調大它 |
| `litellm-vscode-chat.chat.promptCaching` | `true` | 在宣告支援的模型上, 跨工作階段回合沿用提供者端的提示快取; [詳情見下](#提示快取) |
| `litellm-vscode-chat.discovery.timeout` | `30000` | 單輪模型探索的硬性時間預算, 毫秒 - 含重試與 OAuth 權杖交換。最小 1000 |
| `litellm-vscode-chat.discovery.cacheTtl` | `3600000` | 已探索的模型清單沿用多久, 毫秒。VS Code 重新解析提供者很頻繁 (有時一秒好幾次); 快取把那擋在您的伺服器之外。`0` 表示每次都重新擷取 (負值箝制為 `0`); 失敗從不快取; 同時發生的重新整理共用一個請求; "LiteLLM: Sync Models Now" 略過它 |
| `litellm-vscode-chat.usage.pollInterval` | `300000` | 背景支出/預算輪詢節奏, 毫秒。`0` = 關閉: 儀表板開啟時仍會擷取, 但沒有背景請求, 沒有警示。完整故事: [用量](usage.md) |
| `litellm-vscode-chat.usage.alertThresholds` | `[0.8, 0.95]` | 各觸發一次警示的預算比例; 每個值在 (0, 1] 內; 空清單 = 關閉警示。完整故事: [用量 - 警示](usage.md#警示) |
| `litellm-vscode-chat.usage.statusBar` | `"always"` | 用量狀態列項目: `"always"`、`"alerts-only"`、`"off"`。完整故事: [用量 - 狀態列](usage.md#狀態列) |
| `litellm-vscode-chat.ui.maskSecretInputs` | `true` | 在儀表板中輸入時遮罩祕密輸入欄位 (API 金鑰與其他認證) |

刻意不提供全域標頭設定: 自訂 HTTP 標頭描述的是如何與某一個伺服器交談, 所以它們存放在伺服器項目上 ([`headers`](servers.md#自訂標頭)) - 機器範圍, 在設定同步搆不到的地方, 與全域設定不同。

## 伺服器項目屬性

`litellm-vscode-chat.servers` 的每個項目 (除 `label` 與 `baseUrl` 外全部選填); 每一列的完整故事在[伺服器](servers.md):

| 屬性 | 型別 | 行為 |
|---|---|---|
| `label` | 字串 | 伺服器的顯示名稱與身分 (連同 `baseUrl`); 在項目間唯一 - 重複的標籤被略過並回報, 第一個項目勝出。重新命名的後果見[生命週期](servers.md#生命週期-重新命名移除與隱藏的群組) |
| `baseUrl` | 字串 | 伺服器的根 URL; 延伸模組自行附加 `/v1` - 請去掉任何 `/v1` 結尾。路徑前置詞保留, 結尾斜線去除 |
| `auth` | 物件 | `apiKey`、`oauth`、`virtualKey` 恰取一種形式 - 附隨認證依此順序分級: `oauth` 可帶選填的 `apiKey`/`virtualKey` 附隨認證, `apiKey` 可帶選填的 `virtualKey` 附隨認證, 供檢查兩個標頭的閘道使用。含糊不清的形態按設定錯誤回報, 修復前項目不被使用。伺服器不需要認證時整個省略。完整故事: [伺服器 - 身分驗證](servers.md#身分驗證) |
| `headers` | 物件 | 發往此伺服器的每個請求上的自訂 HTTP 標頭 (路由標籤、追蹤); 衝突時延伸模組管理的驗證標頭勝出。[伺服器 - 自訂標頭](servers.md#自訂標頭) |
| `models.parameters` | 記錄 | 只針對此伺服器的請求參數; 與全域設定相同的[比對鍵](models.md#模型比對), 逐欄位套用在其之上 |
| `models.capabilities` | 記錄 | 只針對此伺服器的能力覆寫; 機制相同 |
| `discovery.declared` | 字串陣列 | 探索列不出時也要註冊的精確模型 ID; [伺服器 - 宣告的模型](servers.md#宣告的模型) |
| `discovery.expectedFailures` | 字串陣列 | 此處預期失敗的探索端點 (`"modelListing"`、`"modelInfo"`): 一次嘗試, info 層級記錄, 不算故障 |
| `budget` | 數字 | 手動預算, 美元, 大於 0; 在[用量警示](usage.md#預算)中優先於金鑰自身的 `max_budget`; 兩者都顯示 |

可作祕密的欄位 (`auth.apiKey`、`auth.oauth.clientSecret`、`auth.virtualKey.value`、OAuth 附隨認證) 可以存放在 VS Code 祕密儲存體而非設定檔中: [伺服器 - 祕密](servers.md#祕密與祕密儲存體)。

## 記錄指示詞

在 `models.parameters` 或 `models.capabilities` 記錄內 (全域或各項目), 以 `_` 開頭的鍵是指示詞: 給延伸模組的指示, 從不送到伺服器。未知的 `_` 鍵被忽略。

| 指示詞 | 有效於 | 作用 |
|---|---|---|
| `"_force": true \| ["field", ...]` | `models.parameters` | 把全部/列出的參數欄位標記為強制: 它們勝過執行階段選項與模型選擇器的各模型設定。提供者擁有的欄位 (`model`、`messages`、`stream`、`stream_options`、`tools`、`tool_choice`) 不能強制 - 指名會被回報並略過。完整故事: [模型 - 參數](models.md#參數) |
| `"_fallback": true \| ["field", ...]` | `models.capabilities` | 把全部/列出的能力欄位標記為後備: 它們填補在伺服器回報之下, 而不是覆寫它。後備提供的最大輸出 token 數算作使用者設定 (沒有 4096 上限)。完整故事: [模型 - 能力](models.md#能力) |
| `"_openrouter_model": "vendor/id"` | `models.capabilities` | 從 OpenRouter 目錄拉取指名模型的能力資料, 填補您與伺服器留下的空缺。離線也能用內建快照運作。完整故事: [模型 - 能力](models.md#能力) |
| `"_inheritable": true \| ["field", ...]` | 兩種記錄 | 把全部/列出的欄位標記為可被比對得更具體、且未另行聲明的模型繼承。完整故事: [模型 - 比對](models.md#哪筆記錄生效) |
| `"_inherit_from": true \| false \| ["key", ...]` | 兩種記錄 | 本記錄繼承什麼: 到達它的一切、什麼都不繼承 (`false` - 也是屏障: 任何東西都流不過一筆什麼都不繼承的記錄), 或恰好指名的記錄 (繞過屏障)。完整故事: [模型 - 比對](models.md#哪筆記錄生效) |

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "*": { "context_length": 128000, "_fallback": ["context_length"] },  // 補缺預設值, 伺服器回報時以伺服器為準
  "my-gw-r1": { "_openrouter_model": "deepseek/deepseek-r1" }          // 為這個 ID 借用目錄的資料
},
"litellm-vscode-chat.models.parameters": {
  "*":      { "top_p": 0.9, "_inheritable": true },                    // 除非模型主動退出, 每個模型都繼承
  "gpt-5*": { "temperature": 0.2, "_force": ["temperature"] }          // 連聊天工具也不能調高它
}
```

## 提示快取

在 LiteLLM 模型資訊宣告支援提示快取的模型上 (目前是 Anthropic Claude 模型), 延伸模組把 Anthropic 的四個快取中斷點花在代理工作階段各回合之間保持不變的部分上: 最後一個工具定義、系統提示、第一則使用者訊息, 以及最後一則帶文字的訊息。之後每一回合都沿用上一回合快取的前綴, 而不是為工具與歷史重付全額輸入價 - 節省在代理模式下最明顯。

兩個限制: 標記用的是提供者的短時快取標記 (Anthropic 的預設存留期, 約 5 分鐘; 延伸模組無法延長), 未宣告支援的模型從不被送出標記。把 `chat.promptCaching` 設為 `false` 可關閉該功能。

## 重新命名與移除的設定

一次性升級移轉自動處理所有這些:

| 舊 | 新 |
|---|---|
| `requestTimeout` | `chat.timeout` |
| `promptCaching.enabled` | `chat.promptCaching` |
| `discoveryTimeout` | `discovery.timeout` |
| `discoveryCacheTtl` | `discovery.cacheTtl` |
| `modelParameters` | `models.parameters` |
| `modelCapabilities` | `models.capabilities` |
| `openRouterCatalog.enabled` | `models.openRouterCatalog` |
| `headers` (全域) | 每個伺服器項目自己的 `headers`; 複製進每個宣告的項目, 舊值則被擱置在一條儀表板提示之後 (見下文範圍說明) |
| `maskApiKeyInput` | `ui.maskSecretInputs` |
| 伺服器項目扁平欄位 (`apiKey`、`oauth*`、`virtualKey*`、...) | 項目的 `auth` / `models` / `discovery` 物件 ([伺服器](servers.md#項目參考)) |
| 作為隱含前置詞的記錄鍵 | 明確比對器 - 給既有鍵附加 `*` ([模型 - 比對](models.md#模型比對)) |
| 全域記錄中的伺服器 URL 限定鍵 | 移入相符的伺服器項目; 無相符者留在原地休眠並附儀表板提示 |
| `modelCapabilities` 的 `_declare` 指示詞 | 項目的 `discovery.declared` 清單 ([伺服器](servers.md#宣告的模型)) |
| `defaultContextLength`、`defaultMaxOutputTokens` | 帶 `_fallback` 的 `models.capabilities` `"*"` 記錄 ([詳情](models.md#從已移除的預設設定移轉)) |
| `defaultMaxInputTokens` | `models.capabilities` `"*"` 覆寫 |

關於移轉的四條範圍與邊界說明:

- 舊的全域 `headers` 套用於每個伺服器 - 宣告的項目與[外部管理的群組](servers.md#外部伺服器與採用)都在內。新的各項目 `headers` 搆不到沒有項目的伺服器, 所以移轉只把值複製進您宣告的項目, 並把原值擱置; 只要外部管理的群組還存在, 儀表板的診斷就會指出它不再收到那些標頭 - 把該群組[採用](servers.md#外部伺服器與採用)進項目, 標頭就回來了。

- 它只重寫使用者設定。設定在工作區範圍的舊名稱 (比如提交進儲存庫的 `.vscode/settings.json`) 留在原地 - 計入記錄, 從不重寫 - 而由於延伸模組不再讀取舊名稱, 在您手動把它移到新名稱之前它沒有任何效果。
- 已儲存的祕密原地不動: 項目重構只改動設定文字 - 祕密儲存體中的值保持原有的鍵, 不需重新輸入任何東西。
- 之後舊名稱就是一般的未知鍵: VS Code 的設定編輯器標記它們, 延伸模組忽略它們, 所以零星的殘留是噪音, 不是行為。
