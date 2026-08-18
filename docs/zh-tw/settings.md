# 設定

[English](../settings.md) | [简体中文](../zh-cn/settings.md) | 繁體中文

每個 `litellm-vscode-chat.*` 設定與每個伺服器項目屬性的查詢參考: 名稱、預設值、一段話的行為說明, 以及完整故事在哪裡。要*學習*概念, 請改讀支柱頁面: [伺服器](servers.md)、[模型](models.md)、[用量](usage.md)。

## 設定如何運作

兩種等價的編輯方式:

- **設定 UI / settings.json** - `Ctrl+,` / `Cmd+,`, 搜尋 "litellm-vscode-chat"。設定分組為幾個區段 (伺服器、模型、聊天、探索、用量、UI)。
- **儀表板** - "LiteLLM: Open Dashboard", 設定區段。同樣的值以表單控制項呈現, 驗證、單位與預設值就地顯示; 已設定的列說明其值存放在哪裡, 「重設」清除該範圍。見[儀表板](dashboard.md)。

| 事實 | 細節 |
|---|---|
| 範圍 | `servers` 是機器範圍的: 僅限使用者設定, 永遠不能被工作區覆寫, 也永遠不由設定同步攜帶。工作區 `.vscode/settings.json` 中的 `servers` 值會被 VS Code 自己忽略 (設定編輯器會說它只能套用於使用者設定)。其他每個設定都像一般的使用者/工作區設定一樣運作並正常同步。 |
| 生效 | 變更立即套用 - 不需重新載入。影響模型的變更會重新整理模型清單; 用量變更會重接輪詢器; 逾時變更套用於下一個請求。外觀設定也一樣: 開啟著的儀表板會在 `ui.theme` 或 `ui.accent` 變化的那一刻換裝, 無論變更來自儀表板自己的選擇器還是 settings.json。 |
| 移轉 | 舊版本的設定在升級時自動重新命名與重構; 見[重新命名表](#重新命名與移除的設定)。不需重新輸入任何東西。當新名稱的設定已經有值時 (比如設定同步先從已升級的機器送來了它), 移轉保留它, 只捨棄舊鍵 - 伺服器 URL 限定鍵有一條注意事項 ([範圍說明](#重新命名與移除的設定))。 |
| 未知鍵 | 延伸模組未宣告的 `litellm-vscode-chat.*` 鍵 (打錯字, 比如 `chat.timout`) 會被忽略, VS Code 的設定編輯器會在 settings.json 中把它標為未知設定。[重新命名](#重新命名與移除的設定)之後的舊名稱同理。 |

## 匯出與匯入

設定同步有意跳過這裡最要緊的部分 - `servers` 是機器範圍的, 祕密儲存體中的值也從不同步 - 所以把配置搬到另一台機器有自己的一對命令。儀表板的設定區段以「匯入與匯出」按鈕承載它們; 命令或按鈕, 流程相同。

- **"LiteLLM: Export Settings..."** 把您在使用者設定中設定過的每個 `litellm-vscode-chat.*` 設定寫入一個 JSON 檔案 (預設 `~/litellm-settings.json`)。先有一個關於祕密的提問: 「包含祕密」把祕密儲存體中的值複製進各自的伺服器項目, 檔案因此完整 - 但這些認證以明文寫入檔案, 請謹慎保存與分享; 「不含祕密」則剝除每個祕密值, 行內的也一樣, 檔案不攜帶任何認證 (自訂[標頭](servers.md#自訂標頭)值是一般設定, 不是祕密, 會留在檔案裡; 匯入後重新輸入認證)。
- **"LiteLLM: Import Settings..."** 把這樣的檔案合併回來。在您確認預覽之前什麼都不寫 (哪些設定會被寫入、多少伺服器衝突、檔案攜帶多少祕密值); 每個已存在的伺服器標籤都會詢問怎麼辦: 「覆寫」就地取代項目及其儲存的祕密 - 當這改變連線設定 (基底 URL、認證) 時, 已同步的提供者群組無法就地接收它們, 伺服器在儀表板中的列會顯示重連步驟 ([生命週期](servers.md#生命週期-重新命名移除與隱藏的群組)), 預覽也會提前標出這類覆寫 - 「略過」保留您的項目, 「重新命名後匯入」以新標籤加入傳入的項目。不衝突的伺服器被附加, 其他設定整體寫入, 檔案中的祕密值進入 VS Code 祕密儲存體, 而不是您的設定檔。匯入伺服器會徹底取代該標籤儲存的祕密 - 不帶祕密的檔案讓匯入的項目處於無認證狀態, 而不是拾取同名舊伺服器遺留的值。關閉任何提示都會中止整個匯入, 什麼都不寫。
- **"LiteLLM: Undo Last Settings Import"** 把設定與儲存的祕密還原到匯入前的狀態 - 整體還原, 所以匯入之後對受影響鍵的編輯也會被回復; 還原前會先跳出確認, 說明快照的記錄時間。只有一個槽位: 每次匯入都取代它, 匯入完成的通知帶有「復原匯入」按鈕, 執行的是同一個命令。

檔案是帶版本的信封 (其中的設定鍵去掉 `litellm-vscode-chat.` 前綴), 所以來自較新版本延伸模組的檔案會被拒絕並提示更新, 而不是匯入一半:

```jsonc
{
  "litellm-vscode-chat": 1,          // 格式版本與檔案判別符
  "exportedBy": "0.4.5",             // 僅供參考
  "settings": { "servers": [ /* ... */ ] }
}
```

## 參考

| 設定 | 預設值 | 行為 |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | 宣告的 LiteLLM 伺服器; [項目屬性見下](#伺服器項目屬性), 完整故事在[伺服器](servers.md) |
| `litellm-vscode-chat.models.parameters` | `{}` | 按模型的請求參數, 以[比對器](models.md#模型比對)為鍵。只送出您設定的。完整故事: [模型 - 參數](models.md#參數) |
| `litellm-vscode-chat.models.capabilities` | `{}` | 按模型的能力覆寫, 以[比對器](models.md#模型比對)為鍵: token 上限、視覺、工具、推理、定價 - 任何 `model_info` 欄位, 認識與否皆可; 詞彙表是開放的。完整故事: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.models.openRouterCatalog` | `true` | 用每週重新整理的 OpenRouter 公開目錄快照填補缺少的能力; 手動重新整理用 "LiteLLM: Refresh OpenRouter Catalog"。詳情含隱私說明: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.chat.timeout` | `300000` | 單次聊天補全的硬性時間預算, 毫秒。聊天請求從不重試, 所以這是一個請求可占用的總時間, 含串流。最小 1000; 更低的值會被箝制。為長推理運行或緩慢的基礎設施調大它 |
| `litellm-vscode-chat.chat.maxToolsPerRequest` | `128` | 一次聊天請求最多可攜帶的工具數, 超過時延伸模組在本機拒絕該請求而不送出 (多數 OpenAI 相容伺服器強制 128)。調高到超出你的伺服器或模型接受的範圍, 只會把失敗移到伺服器端: 請求會被送出, 然後被伺服器拒絕。最小 1 |
| `litellm-vscode-chat.chat.additionalToolSchemaKeywords` | `[]` | 工具輸入 schema 中額外保留的 JSON-Schema 關鍵字, 例如 `["propertyNames"]`。送出前工具 schema 會按內建關鍵字允許清單清理; 此處列出的關鍵字也會保留, 其值原樣透傳。內建允許清單始終生效。伺服器或模型不接受的關鍵字可能導致請求失敗或工具呼叫變差 |
| `litellm-vscode-chat.chat.promptCaching` | `true` | 在宣告支援的模型上, 跨工作階段回合沿用提供者端的提示快取; [詳情見下](#提示快取) |
| `litellm-vscode-chat.chat.tokenEstimation` | `"auto"` | 本地 token 預算如何估算提示大小: `"auto"` (識別文字系統的啟發式, 在 VS Code 顯示語言不是英文, 或聊天中含足夠多讓純字元計數低估的文字 - CJK 等非拉丁文字、emoji - 時載入 o200k_base 分詞器)、`"heuristic"` (純粹按每 4 字元 1 token 計, 從不載入分詞器資料, 對 CJK 低估約 4 倍)、`"o200k_base"` 或 `"cl100k_base"` (始終載入該分詞器)。載入的分詞器在活躍期間約佔用 10-30 MB 記憶體; 計數開銷可忽略 |
| `litellm-vscode-chat.discovery.timeout` | `30000` | 每個模型探索請求的硬性時間預算, 毫秒, 含該請求的重試。模型資訊清單、`/v1/models` 退回和 OAuth 權杖交換各自獲得一份新預算, 所以一輪探索最長可能耗時到它們之和。最小 1000 |
| `litellm-vscode-chat.discovery.cacheTtl` | `3600000` | 已探索的模型清單沿用多久, 毫秒。VS Code 重新解析提供者很頻繁 (有時一秒好幾次); 快取把那擋在您的伺服器之外。`0` 表示每次都重新擷取 (負值箝制為 `0`); 失敗從不快取; 同時發生的重新整理共用一個請求; "LiteLLM: Sync Models Now" 略過它 |
| `litellm-vscode-chat.discovery.staleServeWindow` | `600000` | 伺服器停止回應後, 其最後已知的模型繼續提供 (標記為過時) 的時長, 毫秒, 從最後一次成功探索起算。若伺服器休眠或重啟超過十分鐘, 可調高它; `0` 表示永不提供過時模型 (重新整理失敗立即清空該伺服器的清單)。詳情: [模型 - 探索](models.md#探索) |
| `litellm-vscode-chat.usage.pollInterval` | `300000` | 背景支出/預算輪詢節奏, 毫秒。`0` = 關閉: 沒有背景請求, 沒有警示; 儀表板開啟時只在一次擷取到期時才擷取 (本次工作階段還沒有完成過擷取、距上一次擷取已超過五分鐘, 或 `servers` 設定有變更)。低於 `30000` 的非零值向上箝制到 30 秒。完整故事: [用量](usage.md) |
| `litellm-vscode-chat.usage.initialRefreshDelay` | `5000` | 延伸模組啟動後多久執行首次用量輪詢, 毫秒 |
| `litellm-vscode-chat.usage.serversChangeRefreshDelay` | `2000` | `servers` 設定變更後多久重新整理用量資料, 毫秒; 足以合併 settings.json 中的連續按鍵 |
| `litellm-vscode-chat.usage.pollingOffFreshnessWindow` | `600000` | 輪詢關閉時, 隨需取得的用量資料算作新鮮的時長, 毫秒 (輪詢開啟時, 視窗改為輪詢間隔的兩倍)。`0` 則從不算新鮮, [狀態列項目](usage.md#狀態列)會因此隱藏 |
| `litellm-vscode-chat.usage.alertThresholds` | `[0.8, 0.95]` | 各觸發一次警示的預算比例; 每個值在 (0, 1] 內; 空清單 = 關閉警示。完整故事: [用量 - 警示](usage.md#警示) |
| `litellm-vscode-chat.usage.statusBar` | `"always"` | 用量狀態列項目: `"always"`、`"alerts-only"`、`"off"`。完整故事: [用量 - 狀態列](usage.md#狀態列) |
| `litellm-vscode-chat.usage.currencySymbol` | `"$"` | 每個支出與價格數字前的前綴, 例如 `"EUR "`。僅用於顯示: 金額從不換算, 完全按伺服器回報的數值呈現; 空字串只顯示數字 |
| `litellm-vscode-chat.ui.maskSecretInputs` | `true` | 在輸入方塊提示中輸入認證值時進行遮罩。儀表板的祕密欄位始終遮罩, 各帶自己的「顯示」切換, 與此設定無關 |
| `litellm-vscode-chat.ui.theme` | `"auto"` | 儀表板如何著色: `"auto"` 跟隨您的 VS Code 佈景主題, `"light"` 與 `"dark"` 在編輯器變化時保持不動。[外觀說明見下](#外觀) |
| `litellm-vscode-chat.ui.accent` | `"blue"` | 儀表板的強調色: `"blue"`、`"violet"`、`"teal"`、`"amber"`。它標記主要動作、選取、焦點與連結, 僅此而已 - 狀態色保持綠、黃、紅。[外觀說明見下](#外觀) |

刻意不提供全域標頭設定: 自訂 HTTP 標頭描述的是如何與某一個伺服器交談, 所以它們存放在伺服器項目上 ([`headers`](servers.md#自訂標頭)) - 機器範圍, 在設定同步搆不到的地方, 與全域設定不同。

## 伺服器項目屬性

`litellm-vscode-chat.servers` 的每個項目 (除 `label` 與 `baseUrl` 外全部選填); 每一列的完整故事在[伺服器](servers.md):

| 屬性 | 型別 | 行為 |
|---|---|---|
| `label` | 字串 | 伺服器的顯示名稱與身分 (連同 `baseUrl`); 在項目間唯一 - 重複的標籤被略過並回報, 第一個項目勝出。重新命名的後果見[生命週期](servers.md#生命週期-重新命名移除與隱藏的群組) |
| `baseUrl` | 字串 | 伺服器的根 URL; 延伸模組會自行附加 `/v1`, 除非 URL 已以 `/v1` 或 `/v2` 這樣的版本區段結尾 (按原樣使用) - `apiVersion` 可覆寫兩者。路徑前置詞保留, 結尾斜線去除 |
| `apiVersion` | 字串 | 附加到基礎 URL 的內容。未設定 = 自動 (`/v1`, 或 URL 中已有的版本區段); `""` = 不附加任何內容; `"v2"` = 附加 `/v2` |
| `auth` | 物件 | `apiKey`、`oauth`、`virtualKey` 恰取一種形式 - 附隨認證依此順序分級: `oauth` 可帶選填的 `apiKey`/`virtualKey` 附隨認證, `apiKey` 可帶選填的 `virtualKey` 附隨認證, 供檢查兩個標頭的閘道使用。含糊不清的形態按設定錯誤回報, 修復前項目不被使用。伺服器不需要認證時整個省略。完整故事: [伺服器 - 身分驗證](servers.md#身分驗證) |
| `headers` | 物件 | 發往此伺服器的每個請求上的自訂 HTTP 標頭 (路由標籤、追蹤); 衝突時延伸模組管理的驗證標頭勝出。[伺服器 - 自訂標頭](servers.md#自訂標頭) |
| `models.parameters` | 記錄 | 只針對此伺服器的請求參數; 與全域設定相同的[比對鍵](models.md#模型比對), 逐欄位套用在其之上 |
| `models.capabilities` | 記錄 | 只針對此伺服器的能力覆寫; 機制相同 |
| `discovery.declared` | 字串陣列 | 探索列不出時也要註冊的精確模型 ID; [伺服器 - 宣告的模型](servers.md#宣告的模型) |
| `discovery.expectedFailures` | 字串陣列 | 此處預期失敗的探索端點 (`"modelListing"`、`"modelInfo"`): 一次嘗試, info 層級記錄, 不算故障 |
| `budget` | 數字 | 手動預算, 以伺服器自身的計費貨幣計, 大於 0; 在[用量警示](usage.md#預算)中優先於金鑰自身的 `max_budget`; 兩者都顯示 |

可作祕密的欄位 (`auth.apiKey`、`auth.oauth.clientSecret`、`auth.virtualKey.value`、OAuth 附隨認證) 可以存放在 VS Code 祕密儲存體而非設定檔中: [伺服器 - 祕密](servers.md#祕密與祕密儲存體)。

## 記錄指示詞

在 `models.parameters` 或 `models.capabilities` 記錄內 (全域或各項目), 以 `_` 開頭的鍵是指示詞: 給延伸模組的指示, 從不送到伺服器。未知的 `_` 鍵被忽略; 其他每個鍵都是欄位 - 兩套詞彙表都是開放的 ([能力](models.md#能力欄位))。

| 指示詞 | 有效於 | 作用 |
|---|---|---|
| `"_force": true \| ["field", ...]` | `models.parameters` | 把全部/列出的參數欄位標記為強制: 它們勝過執行階段選項與模型選擇器的各模型設定。提供者擁有的欄位 (`model`、`messages`、`stream`、`stream_options`、`tools`、`tool_choice`) 不能強制 - 指名會被回報並略過。完整故事: [模型 - 參數](models.md#參數) |
| `"_fallback": true \| ["field", ...]` | `models.capabilities` | 把全部/列出的能力欄位標記為後備: 它們填補在伺服器回報之下, 而不是覆寫它。後備提供的最大輸出 token 數算作使用者設定 (沒有 4096 上限)。完整故事: [模型 - 能力](models.md#能力) |
| `"_openrouter_model": "vendor/id"` | `models.capabilities` | 從 OpenRouter 目錄拉取指名模型的能力資料 - 只有能力, 從不包括定價。由此得到的欄位排在伺服器回報之上 (這條指示詞的含義是: 對這個模型, 伺服器的資料不可信), 但排在同記錄中您明確寫下的欄位之下。離線也能用內建快照運作。完整故事: [模型 - 能力](models.md#能力) |
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

## 外觀

`ui.theme` 與 `ui.accent` 決定儀表板的外觀。兩件事值得知道:

- **高對比永遠勝出。**在 VS Code 高對比佈景主題下, 兩個設定都休眠, 儀表板完全像 `auto` 那樣跟隨編輯器。高對比佈景主題是一種無障礙選擇, 外觀偏好無權推翻它。
- **`auto` 跟隨任何佈景主題; 固定一種則用我們的。**在 `auto` 下, 儀表板讀取您的編輯器自己的顏色, 所以它融入 Solarized、Monokai 或任何手工佈景主題。固定 `light` 或 `dark` 則換上我們的配色 (VS Code 自己的 Light Modern 與 Dark Modern), 這正是儀表板能在編輯器變化時保持不動的原因。

在 `blue` 下, 強調色跟隨您佈景主題的按鈕顏色, 所以從未改過這項設定的使用者看到的儀表板和以前完全一樣。其餘三種是固定色相, 按佈景主題調校, 在淺色和深色表面上都清晰可辨。

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

關於移轉的五條範圍與邊界說明:

- 舊的全域 `headers` 套用於每個伺服器 - 宣告的項目與[外部管理的群組](servers.md#外部伺服器與採用)都在內。新的各項目 `headers` 搆不到沒有項目的伺服器, 所以移轉只把值複製進您宣告的項目, 並把原值擱置; 只要外部管理的群組還存在, 儀表板的診斷就會指出它不再收到那些標頭 - 把該群組[採用](servers.md#外部伺服器與採用)進項目, 標頭就回來了。

- 一條設定同步注意事項: 當另一台機器先升級時, 同步會在這台機器移轉之前送來新名稱的記錄 (以及舊鍵的刪除)。移轉隨即保留同步來的值, 不加處理地捨棄舊記錄 - 包括它攜帶的任何伺服器 URL 限定鍵, 而那些鍵的去處本是這台機器自己的機器範圍項目; 第一台機器把它們吸收進了*它的*項目, 所以在這裡它們被捨棄而不是移動。在多機環境下, 請先把 URL 限定鍵複製進相符的伺服器項目, 再升級其餘機器。
- 它只重寫使用者設定。設定在工作區範圍的舊名稱 (比如提交進儲存庫的 `.vscode/settings.json`) 留在原地 - 計入記錄, 從不重寫 - 而由於延伸模組不再讀取舊名稱, 在您手動把它移到新名稱之前它沒有任何效果。
- 已儲存的祕密原地不動: 項目重構只改動設定文字 - 祕密儲存體中的值保持原有的鍵, 不需重新輸入任何東西。
- 之後舊名稱就是一般的未知鍵: VS Code 的設定編輯器標記它們, 延伸模組忽略它們, 所以零星的殘留是噪音, 不是行為。
