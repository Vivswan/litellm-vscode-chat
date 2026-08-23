# 入門指南

[English](../getting-started.md) | [简体中文](../zh-cn/getting-started.md) | 繁體中文

安裝延伸模組, 把它指向一個 LiteLLM 代理, 其模型就會出現在 GitHub Copilot Chat 的模型選擇器中。本頁把這條路徑從頭到尾走一遍, 然後給出七個簡短配方, 涵蓋最常見的後續步驟。

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

七個配方, 依人們通常需要的順序排列。每個都展示完整的修法; 連結的頁面有深入內容。

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

### 用您自己的模型產生提交訊息

兩個設定即可開啟 - 選擇加入開關和明確的模型選擇 (`servers` 項目的標籤加上它的一個原始模型 ID):

```jsonc
"litellm-vscode-chat.commitGeneration.enabled": true,
"litellm-vscode-chat.commitGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

原始檔控制標題列會出現一個閃光按鈕, 命令選擇區也會新增 "LiteLLM: Generate Commit Message"。兩者都會把您已暫存的差異 (未暫存任何內容時則是工作區差異加上未追蹤檔案名稱) 送給該模型, 並把草擬的訊息寫入提交框。您最近五筆提交主旨會作為風格範例一同送出, 因此草稿會遵循您儲存庫的慣例。要求有固定上限: 差異在 80,000 個字元處截斷, 未追蹤路徑最多列出 100 條, 其餘以數量標註代替。

這與把 Copilot 自己的 `chat.utilitySmallModel` 插槽指向 LiteLLM 模型 ([Copilot 模型插槽](models.md#copilot-模型插槽)) 不同: 它不需要 Copilot 訂閱, 指令文字由您修改, 風格範例來自您儲存庫的歷史。內建指令如下 (面向模型的文字, 保持英文), `litellm-vscode-chat.commitGeneration.prompt` 中的任何內容都會整體取代它:

```text
Write a commit message for the change in the diff below.
Use the Conventional Commits form: one subject line like "type(scope): summary" (types such as feat, fix, docs, refactor, test, chore), at most about 72 characters, in the imperative mood.
When the change needs explanation, add a blank line and a short body of one to three sentences saying what changed and why.
Answer with the commit message text only: no markdown fences, no surrounding quotes, no commentary.
```

隱私與成本和聊天一致: 差異、未追蹤檔案名稱和您最近五筆提交主旨只在您明確叫用時送到您設定的 LiteLLM 伺服器, 請求計入與其他請求相同的[用量追蹤與預算警示](usage.md)。

### 用 LiteLLM 模型取得內嵌補全

編輯器裡的幽靈文字, 由您自己 Proxy 上的模型寫出。兩個設定即可開啟 - 選擇加入開關和明確的模型選擇, 與上一個配方相同的 `{ "server", "model" }` 形狀:

```jsonc
"litellm-vscode-chat.inlineCompletions.enabled": true,
"litellm-vscode-chat.inlineCompletions.model": { "server": "local", "model": "qwen2.5-coder-fim" },
"litellm-vscode-chat.inlineCompletions.languageFilter": { "mode": "block", "languages": ["markdown", "plaintext"] }
```

沒有需要執行的命令: 這個功能完全由設定驅動。關閉時不註冊任何內容, 也不會自動送出請求 (唯一的例外是儀表板上明確的「測試模型」按鈕, 無論功能是否開啟, 點擊都會發送一次探測請求); 開啟但未指定模型時, 功能保持閒置。

**要選補全模型, 不是聊天模型。** 內嵌補全會 POST 到 `/v1/completions`, 因此模型必須是您的 LiteLLM 伺服器在 `model_info` 中宣告為 `mode: completion` 的那一種 - 一個中間填充 (FIM) 模型。這類模型刻意不出現在聊天模型選擇器裡, 所以模型 ID 要從 Proxy 的設定檔取得, 而不是從選擇器取得。

還有一個設定決定它在哪裡執行。`inlineCompletions.languageFilter` 存放一個模式加精確的 VS Code 語言 ID: `"block"` 表示補全在列出的語言之外的所有語言中執行, `"allow"` 表示僅在列出的語言中執行 (允許清單為空則不在任何語言中執行)。您不必手動編輯它: 功能啟用後, 編輯器的 `{}` 語言狀態選單 (右下角) 會出現一列「LiteLLM inline suggestions」, 它的開關會替您把目前語言寫進這個篩選器。

請求的形狀是固定的, 不可調整: 游標之前最多 8000 個字元 (從左側截斷)、之後最多 4000 個字元, 停止輸入 200 毫秒後才送出請求, `max_tokens` 為 256, 逾時 15 秒。一個小型的記憶體快取讓相同的上下文不會被問第二次。失敗依設計靜默 - 逾時、401 或格式錯誤的回應都只是不出現建議, 絕不會跳出視窗打斷您輸入。

在您想動用比對鍵之前有一條規則要知道: `models.parameters` 記錄不適用於內嵌補全和提交訊息產生的請求。唯一的例外是 `_fim_template` 指示詞, 它塑造 FIM 提示, 而且從不送到伺服器。當您的後端沒有原生的中間填充處理、需要把兩半內容拼進單一提示時使用它:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "qwen2.5-coder-fim": { "_fim_template": "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>" }
}
```

樣板生效時, 提示由樣板建構, 線路上的 `suffix` 欄位會被省略; 缺少 `{prefix}` 或 `{suffix}` 佔位符的值會退回普通的 prompt 加 suffix 要求主體。參考: [設定: 記錄指示詞](settings.md#記錄指示詞)。

隱私這一段值得讀兩遍: 內嵌補全會在您輸入時自動把游標周圍的檔案內容送到您設定的 LiteLLM 伺服器。這與聊天是同一個信任邊界 - 您自己的伺服器, 沒有第三方 - 但少了您逐次請求的動作, 這正是該功能預設關閉並要求明確指定模型的原因。這些請求走與其他請求相同的伺服器連線, 因此同樣計入現有的[用量與支出追蹤和預算警示](usage.md)。

### 用 @litellm 聊天

在聊天檢視裡輸入 `@litellm` 然後提問。與上面的配方不同, 這個功能已經開著 - 它預設啟用, 在您呼叫之前沒有任何開銷 - 所以唯一的設定是關掉它的那個:

```jsonc
"litellm-vscode-chat.chatParticipant.enabled": false
```

它使用**聊天模型選擇器目前選取的那個模型**作答, 這就是它全部的模型政策: 沒有另外的模型設定要填, 而把選擇器指向您的某個 LiteLLM 模型, 正是讓回答來自您自己 Proxy 的方式。每一輪都是一次普通的聊天請求, 因此請求只會去到那個模型所在的地方, 不會去別處 - 選取您自己的 LiteLLM 模型, 它就走您自己的伺服器, 並和其他聊天一樣計入[用量追蹤與預算警示](usage.md); 若選取的是內建的 Copilot 模型, 這一輪就像該模型一貫的那樣發往 Copilot。無論哪種情況, 這都沒有增加聊天本來就沒有的資料外送路徑。

它自帶三個斜線命令。`/tests` 和 `/docs` 會在您的文字前面加上一段固定指令再送給模型。`/models` 是個例外: 它只用擴充功能已經知道的資訊作答, 列出每個已連線伺服器及其模型、上下文視窗, 以及工具與影像支援情況, 完全不存取網路 - 想拿到確切的原始模型 ID 貼進 `servers` 條目或某個功能的模型設定時, 這是最快的辦法。

您附加的內容會一起送出: 編輯器中的選取範圍、目前開啟的檔案, 以及您加入的每個 `#file:` 都會被讀取並附在您的文字下方, 因此「為這個寫測試」指的就是您眼前的程式碼。附件總量上限為 4 萬個字元, 被截斷或被省略的部分都會明確標註, 不會被當作完整內容送出。

提問時留空提示詞, 它會列出這些命令, 而不是送出一個空請求 - 只開啟一個檔案並不構成一個問題。先前的對話輪次會作為上下文一起帶上, 總量上限 8 萬個字元, 最舊的訊息先被丟棄, 因此長對話始終有界, 而且任何一條訊息都不會被從中間截斷。

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
| LiteLLM: Generate Commit Message | 依您已暫存的變更草擬提交訊息並填入原始檔控制輸入框 (選擇加入; 見[配方](#用您自己的模型產生提交訊息)) |
| LiteLLM: Report Issue | 開啟預先填好的 GitHub Issue; 見[它收集什麼](troubleshooting.md#回報問題) |
| LiteLLM: Help & Feedback | 文件、bug 回報與功能請求的捷徑 |
