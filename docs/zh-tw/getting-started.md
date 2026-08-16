# 入門指南

[English](../getting-started.md) | [简体中文](../zh-cn/getting-started.md) | 繁體中文

安裝延伸模組, 把它指向一個 LiteLLM 代理, 其模型就會出現在 GitHub Copilot Chat 的模型選擇器中。本頁把這條路徑從頭到尾走一遍, 然後給出五個簡短配方, 涵蓋最常見的後續步驟。

## 需求

- **VS Code 1.129.0 或更高版本**, 已安裝並登入 GitHub Copilot Chat 延伸模組。本延伸模組接入的是 Copilot 的聊天檢視, 沒有它就沒有聊天介面, 也沒有模型選擇器。如果您的 Copilot 席次來自組織 (Copilot Business 或 Enterprise), 組織還必須啟用 GitHub 的「Bring your own language model key」原則 - 沒有它, 即使這裡的每項診斷都回報已連線, Copilot 也會隱藏來自本延伸模組這類提供者延伸模組的模型。
- **一個執行中的 LiteLLM 代理**, 自架或雲端皆可。LiteLLM 代理是一台把眾多 LLM 提供者放在單一 OpenAI 相容端點之後的伺服器; 如果您還沒有, LiteLLM 官方的[代理快速上手](https://docs.litellm.ai/docs/proxy/quick_start)幾條命令就能在本機跑起來一個。
- **一把 LiteLLM API 金鑰** (如果您的代理需要): 通常是 `sk-...` 形式的值, 可能是代理設定中的主金鑰, 也可能是由代理營運者核發的[虛擬金鑰](servers.md#身分驗證)。
  - 如果伺服器由公司營運, 請詢問其管理員。
  - 不確定自己的代理是否需要? 需要時, 儀表板的「測試連線」會回報驗證錯誤。

儲存庫還附帶一個可指令碼化的本機代理供您試驗; 參閱[開發](../development.md) (English)。

## 安裝並新增伺服器

1. 從 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安裝延伸模組。
2. 從命令選擇區 (`Ctrl+Shift+P` / `Cmd+Shift+P`) 執行 "LiteLLM: Open Dashboard", 按一下**新增伺服器**。
3. 填寫表單:
   - **標籤** - 模型選擇器將顯示的名稱, 例如 `prod`。
   - **基底 URL** - 伺服器的根 URL, 例如 `http://localhost:4000`。延伸模組會自行附加 `/v1`; 若 URL 已以 `/v1` 或 `/v2` 這樣的版本區段結尾, 則按原樣使用。
   - **驗證** - 恰好一種形式: API 金鑰 (最常見的情況)、OAuth 用戶端認證, 或自訂標頭中的金鑰。對於金鑰, 表單的「儲存於:」選擇預設為「祕密儲存體」, 把它放進 VS Code [祕密儲存體](servers.md#祕密與祕密儲存體)而不是您的設定檔 - 這是任何您不會提交進儲存庫的值的正確選擇; 「設定 (可見)」則把它寫進 settings.json。
4. 按一下**測試連線**。它會依當下輸入的內容原樣探測草稿, 在儲存任何東西之前, 回答模型數量或確切的錯誤。
5. 按一下**儲存**。

表單寫入的是 `litellm-vscode-chat.servers` 設定, 因此同一個伺服器在 settings.json 中就是一個項目:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "http://localhost:4000",
    "auth": { "apiKey": "sk-..." }   // 或省略此欄位, 把金鑰放在祕密儲存體中
  }
]
```

兩條路徑等價 - 編輯您偏好的那個, 儀表板與設定始終保持一致。項目的每個欄位、其他驗證形式, 以及祕密可以存放在哪裡, 都在[伺服器](servers.md#項目參考)頁面。

延伸模組還附帶涵蓋這些步驟的逐步解說: 從命令選擇區執行 "Welcome: Open Walkthrough...", 然後選擇 "Get started with LiteLLM for Copilot Chat"。

> 伺服器也可以透過 VS Code 自己的模型管理新增 (模型選擇器中的 "Manage Models...")。那些也能用, 但存在於 `servers` 設定之外 - 儀表板會把它們標示為「外部」, 直到您[採用它們](servers.md#外部伺服器與採用)。從儀表板開始可以省掉這段彎路。

## 第一次聊天

儲存後片刻之內, 伺服器的模型就註冊好了:

1. 開啟 VS Code 的聊天介面: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或標題列中的聊天圖示。
2. 開啟模型選擇器, 在您的伺服器標籤下選擇一個模型 - 在您選擇之前, Copilot 一直停留在它的預設模型上。
3. 送出一則訊息。

LiteLLM 狀態列項目 (右下角) 一眼呈現連線狀態 - 勾號 (`$(check) LiteLLM`) 表示每個伺服器都可連線, 其工具提示帶有模型數量。如果模型沒有出現, 或有什麼顯示為紅色, [疑難排解](troubleshooting.md#常見問題)能解決常見情況。

## 接下來做什麼

五個配方, 依人們通常需要的順序排列。每個都展示完整的修法; 連結的頁面有深入內容。

### 修正伺服器回報錯誤的能力

您的閘道說某個模型只有 8k 上下文視窗, 但您知道它能接受 131072 個 token? 能力來自伺服器, 而您在 `models.capabilities` 中設定的任何值都會覆寫它們:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "deepseek-r1": { "context_length": 131072, "supports_reasoning": true }
}
```

這個鍵是精確的: 它只比對模型 ID `deepseek-r1`, 不比對其他任何東西。視覺、工具呼叫與 token 上限的用法相同。詳情: [模型: 能力](models.md#能力)。

### 為一個模型家族調整請求參數

您設定的參數會隨發往相符模型的每個請求送出 - 而且只有您設定的參數; 延伸模組不注入任何自己的預設值:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "*":       { "temperature": 0.7 },   // 每個模型
  "gpt-5*":  { "temperature": 0.3 }    // gpt-5 家族跑得更冷靜
}
```

結尾的 `*` 讓鍵成為家族比對器。預設情況下, 最具體的相符記錄整體勝出 - 所以 `gpt-5-turbo` 得到 0.3, `claude-4` 得到 0.7; 更寬泛記錄的欄位只有標記了 `_inheritable` (或用 `_inherit_from` 明確引入) 才會作用到更具體的比對上。詳情: [模型: 參數](models.md#參數)與[模型比對](models.md#模型比對)。

### 連接無法列出模型的閘道

有些閘道提供聊天但沒有 `/v1/models`。在項目上宣告模型, 並告訴探索機制不要把缺少的端點當成故障:

```jsonc
{
  "label": "gateway",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["gpt-5", "claude-4-sonnet"]
  }
}
```

宣告的模型會像被探索找到一樣註冊, 伺服器保持綠色。詳情: [伺服器: 宣告的模型](servers.md#宣告的模型)。

### 設定預算並在用完前收到警示

給項目一個以伺服器計費貨幣計的預算; 警示與狀態列負責其餘部分:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "budget": 50 }
```

在預設的 `usage.alertThresholds` `[0.8, 0.95]` 下, 您會在 $50 的 80% 收到一則通知, 在 95% 收到另一則, 用量狀態列項目顯示支出百分比 - 未超線時是一般樣式, 過 80% 後是警告背景, 過 95% 後是錯誤背景。如果您的金鑰本身已帶有 LiteLLM 的 `max_budget`, 那麼不需要任何項目欄位就能運作。一個前提: 支出追蹤需要有資料庫支撐的 LiteLLM 伺服器 ([需求](usage.md#需求)); 在沒有資料庫的代理上, 用量介面保持隱藏, `budget` 欄位不會改變任何東西。詳情: [用量: 預算](usage.md#預算)與[警示](usage.md#警示)。

### 查看某個值為什麼是這個值

當幾個比對鍵、一個伺服器項目和選擇器各有意見時, 用猜的最慢。開啟儀表板的模型頁面, 對某個模型點「檢查」: 面板列出每個有效的參數與能力, 以及設定它的確切來源 - 哪個比對鍵、哪個伺服器項目、伺服器自己的回報, 還是 OpenRouter 目錄。詳情: [模型: 檢查器](models.md#檢查器)。

## 命令

延伸模組能隨選執行的一切都是命令選擇區命令 (`Ctrl+Shift+P` / `Cmd+Shift+P`, 然後輸入 "LiteLLM"):

| 命令 | 作用 |
|---------|--------------|
| Manage LiteLLM Provider | 中樞選單: 管理伺服器與模型、開啟儀表板、執行診斷 |
| LiteLLM: Open Dashboard | [儀表板](dashboard.md)面板: 伺服器、模型、用量與設定集中一處 |
| LiteLLM: Test Connection | 連線每個伺服器並回報模型數量或確切的錯誤 |
| LiteLLM: Sync Models Now | 立即重新整理模型清單, 略過探索快取 |
| LiteLLM: Show Diagnostics | 開啟儀表板的診斷區段: 各伺服器連線狀態、模型數量、錯誤, 以及上次檢查時間 |
| LiteLLM: Set Server Secret | 把伺服器的 API 金鑰、OAuth 用戶端密碼或虛擬金鑰存入[祕密儲存體](servers.md#祕密與祕密儲存體) |
| LiteLLM: Refresh Usage Now | 立即擷取支出與預算資料, 不受輪詢間隔約束 |
| LiteLLM: Refresh OpenRouter Catalog | 隨選重新整理能力目錄 ([模型](models.md#能力)) |
| LiteLLM: Export Settings... | 把延伸模組的設定儲存為 JSON 檔案, 明確選擇包含還是不含儲存的祕密 |
| LiteLLM: Import Settings... | 合併之前匯出的設定檔案, 每個衝突的伺服器都會詢問 |
| LiteLLM: Undo Last Settings Import | 把設定與祕密還原到上次匯入前的狀態 |
| LiteLLM: Report Issue | 開啟預先填好的 GitHub Issue; 見[它收集什麼](troubleshooting.md#回報問題) |
| LiteLLM: Help & Feedback | 文件、bug 回報與功能請求的捷徑 |
