# 入門指南

[English](../getting-started.md) | [简体中文](../zh-cn/getting-started.md) | 繁體中文

安裝延伸模組, 把它指向一個 LiteLLM 代理, 其模型就會出現在 GitHub Copilot Chat 的模型選擇器中。本頁把這條路徑從頭到尾走一遍, 然後給出一組簡短配方, 涵蓋最常見的後續步驟。

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

這些配方依人們通常需要的順序排列。每個都展示完整的修法; 連結的頁面有深入內容。

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

### 在聊天中使用您自己代理的 MCP 工具

如果您的 LiteLLM 伺服器透過 Model Context Protocol 提供工具, 項目上的一個欄位就能讓它們在聊天中可用:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "auth": { "apiKey": "sk-..." }, "mcp": true }
```

`true` 使用伺服器自身位於 `<baseUrl>/mcp` 的端點; 端點位於他處時寫 `"mcp": { "url": "..." }`。這些工具會以項目的標籤出現在聊天的工具選擇器中, 而擴充功能只在編輯器啟動工作階段的那一刻才附上此項目的認證 - 與您聊天時使用的金鑰、虛擬金鑰或 OAuth 權杖相同 - 絕不更早。詳情: [伺服器: MCP 工具](servers.md#mcp-工具)。

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

### 用您自己的模型產生提取要求描述

與上一個配方相同的兩個設定, 只是換了鍵名:

```jsonc
"litellm-vscode-chat.prGeneration.enabled": true,
"litellm-vscode-chat.prGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

關閉時命令保持隱藏, 也不會發出任何要求; 儀表板中明確的「測試模型」按鈕是唯一的例外, 它在您點擊時送出一個固定的範例分支, 無論功能是否啟用。啟用後, 命令選擇區會新增 "LiteLLM: Generate Pull Request Description"。它會判斷您的分支將被合入哪個分支, 從兩者的合併基準點開始比較, 並把該分支的提交訊息以及每個變更檔案的一份修補檔送給該模型; 草擬的標題和描述會複製到剪貼簿。要求有固定上限: 最多 20 筆提交訊息和 100 個變更檔案, 合併後的修補檔在 120,000 個字元處截斷。合併提交會被排除, 而分支上已追蹤檔案的未提交變更會被包含在內, 因為它們也屬於該描述要涵蓋的內容 (未追蹤檔案不在其中: git 不會對它們做差異比較)。過長的提交清單會從中間削減, 因此首尾的提交始終會一同送出; 字元預算按需分配: 短訊息只取它所需要的, 餘量留給長訊息, 因此不會為了另一端而砍掉清單的某一端。

若已安裝 GitHub Pull Requests 延伸模組, 此功能還會在其中註冊為 "Generate with LiteLLM", 於是它的 Create Pull Request 檢視中的產生按鈕可以直接填入標題和描述, 無需經過剪貼簿。該延伸模組會把要求交給第一個在它那裡註冊的產生器, 因此當 Copilot 自己的產生器也已安裝時, 由誰作答是那個延伸模組的選擇, 而不是我們的; 命令選擇區中的命令始終使用您的 LiteLLM 模型。在那條路徑上由該延伸模組組裝內容, 送出的內容也比命令選擇區中的命令更多: 您儲存庫的提取要求範本, 以及提交中引用的每個議題的標題與內文 (包括私有議題)。

有四種儲存庫狀態屬於提示而非失敗: 沒有已簽出的分支; VS Code 無法為其確定基礎分支的分支 (請設定它的上游分支, 或推送它); 與基礎分支持平的分支; 以及基礎分支解析為其自身上游的分支 (請簽出您真正想要的特性分支)。

隱私與提交訊息配方一致: 分支名稱、該分支的提交訊息和修補檔只在您明確叫用時送到您設定的 LiteLLM 伺服器, 請求計入與其他請求相同的[用量追蹤與預算警示](usage.md)。在進度通知上取消, 會在送出任何內容之前停止這次收集。

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

它自帶五個斜線命令。`/tests`、`/docs`、`/fix` 和 `/explain` 會在您的文字前面加上一段固定指令再送給模型 - 後兩個正是[快速修復](#修復或解釋一條診斷)替您送出的內容, 您自己手動輸入同樣有效。`/models` 是個例外: 它只用擴充功能已經知道的資訊作答, 列出每個已連線伺服器及其模型、上下文視窗, 以及工具與影像支援情況, 完全不存取網路 - 想拿到確切的原始模型 ID 貼進 `servers` 條目或某個功能的模型設定時, 這是最快的辦法。

您附加的內容會一起送出: 編輯器中的選取範圍、目前開啟的檔案, 以及您加入的每個 `#file:` 都會被讀取並附在您的文字下方, 因此「為這個寫測試」指的就是您眼前的程式碼。附件總量上限為 4 萬個字元, 被截斷或被省略的部分都會明確標註, 不會被當作完整內容送出。

提問時留空提示詞, 它會列出這些命令, 而不是送出一個空請求 - 只開啟一個檔案並不構成一個問題。先前的對話輪次會作為上下文一起帶上, 總量上限 8 萬個字元, 最舊的訊息先被丟棄, 因此長對話始終有界, 而且任何一條訊息都不會被從中間截斷。

### 讓代理向第二個模型提問

Copilot 的代理模式透過工具運作, 而這個工具交給代理一個第二意見: 您自己代理上的一個模型, 它可以在任務進行中向其提問。當您想讓另一個模型幫忙核對一個方案、一個診斷, 或一段您不太確定的論證時, 它很有用。兩個設定即可開啟, 形狀與上面的配方相同:

```jsonc
"litellm-vscode-chat.consultTool.enabled": true,
"litellm-vscode-chat.consultTool.model": { "server": "local", "model": "gpt-4o-mini" }
```

兩半都是必要的。開關打開但未選擇模型時, 不會註冊任何內容, 代理根本看不到這個工具。兩者都設定後, 「諮詢 LiteLLM 模型」會加入代理模式的工具清單, 您也可以在提示中用 `#litellmConsult` 單獨指向它。

**由代理決定何時呼叫它**, 這是啟用前需要權衡的部分。這正是它是工具而非命令的原因: 一旦開啟, 代理可以自行發起諮詢, 傳送它認為另一個模型需要的問題和背景。工具本身是唯讀的 - 它向模型提問並把答案當作文字回傳, 無法讀取檔案、執行命令或變更任何東西 - 但傳送的文字由代理選擇, 而不是您。

不會自動附帶任何內容。被諮詢的模型只拿到代理寫進這次呼叫的東西 - 問題和選用的 `context` - 而不是您的聊天歷史、開啟的檔案或工作區本身。這一點要讀準: 代理被明確要求把相關的程式碼、錯誤和背景放進 `context`, 因此它從您的工作區讀到的材料可能出現在那裡。到達對方模型的, 就是代理選擇寫下的內容, 僅此而已。

外送提示上限為 60,000 個字元, 與提交配方的 diff 上限一樣是固定值; 超出後先裁上下文, 並帶上標記讓被諮詢的模型知道有內容被截斷, 只有在上下文已經沒有之後, 問題才會被縮短。回傳時, 回覆會被裁剪進呼叫方模型宣告的 token 預算, 同樣帶標記。要求與聊天一樣受 `chat.timeout` 設定約束, 且不傳送 `max_tokens`, 因此答案的長度由被諮詢模型自己的預設值決定。

隱私上, 這與聊天是同一個信任邊界 - 您自己的伺服器, 沒有第三方 - 但與內嵌補全一樣, 少了您逐次要求的動作, 而且由代理而不是您決定傳送什麼, 這也正是它預設關閉並要求明確指定模型的原因。代理寫的問題和上下文會發往您為該工具指定的 LiteLLM 伺服器, 這些要求同樣計入現有的[用量與支出追蹤和預算警示](usage.md)。儀表板的「測試模型」按鈕是唯一的例外: 它在您點擊時傳送一個固定的小問題, 絕不傳送您的任何內容。

### 讓模型審查您的程式碼

模型讀您的程式碼, 並在相關的行上留下評論, 用的正是提取請求審查那套討論串介面。兩個設定把它打開 - 選擇啟用, 以及一個明確的模型選擇, 與上面幾個配方相同的 `{ "server", "model" }` 形狀:

```jsonc
"litellm-vscode-chat.reviewComments.enabled": true,
"litellm-vscode-chat.reviewComments.model": { "server": "local", "model": "gpt-4o-mini" }
```

之後由兩個命令決定讀什麼, 您每次叫用時自己選:

- **LiteLLM: Review Changes** 審查一個存放庫裡所有未提交的內容 - 已暫存與未暫存的一起, 每個檔案一個請求。原始檔控制標題列的閃光按鈕也會執行它。未追蹤的檔案不包含在內: git 對它們沒有差異, 請用另一個命令審查。
- **LiteLLM: Review This File** 審查您正在看的那個檔案的全部內容, 無論 git 是否知道它。

兩者執行期間都可取消, 也都有邊界: 一次變更審查最多送出 20 個檔案 (通知會說明它省略了多少), 每個請求最多攜帶 80,000 個字元的差異或檔案內容。

評論以錨定到行範圍的討論串形式出現, 而討論串是對話, 不是判決:

- 在討論串裡**回覆** (Reply), 模型會在那裡作答, 並把錨定的那些行引用回給它 - 所以「不, `values.length` 就是數量」得到的是真正的答覆, 而不是同一則評論的重複。
- 對處理完的用**解決** (Resolve), 改變主意了用**取消解決** (Unresolve), 不同意的用**刪除審查討論串** (Delete Review Thread)。
- 再次審查一個檔案會取代該檔案中由模型撰寫的評論, 所以第二遍絕不會堆疊重複項, 現在讀起來乾淨的檔案也會失去它們。您回覆過的討論串, 以及您自己發起的討論串都會保留 - 那是您的話, 不是這次審查的。
- 您也可以從邊欄在檔案任意位置開啟自己的討論串, 直接就那些行提問。

討論串依工作區儲存, 重新開啟工作區時會回來, 包括您沒有開啟過的檔案。它們會回到當初撰寫時對應的那些行: 檔案開啟期間編輯器會讓討論串跟著它的程式碼走, 但如果檔案在這期間被變更過, 還原出來的評論可能會偏幾行 - 重新跑一次審查即可。關閉功能只是把評論從畫面上拿走, 不會抹掉它們; 重新開啟就會回來。檔案已不存在的討論串會在背景被丟棄。

有三件事審查不會悄悄做。有未儲存變更的檔案會被排除在變更審查之外 - 差異來自磁碟上的內容, 因此它的評論會落到模型根本沒看過的行上 - 通知會提示您先儲存, 再單獨審查該檔案。如果某個檔案在它的審查進行中被變更, 基於同樣的原因它的結論會被丟棄, 通知同樣會說明。如果模型回的根本不是一份審查, 那個檔案會保留它原有的評論, 而不會被當作「讀起來乾淨」而清空。

隱私: 每個被審查檔案的差異 - 或在檔案模式下該檔案的全部內容 - 會在您明確叫用時發往您為它設定的 LiteLLM 伺服器, 同時帶上該檔案相對工作區或存放庫的路徑 (兩者都不屬於時只帶檔案名稱, 因此不會送出絕對路徑), 檔案模式下還有它的語言識別碼。回覆會送出該討論串的對話以及它錨定的那些行。沒有任何內容會被自動審查; 儀表板的「測試模型」按鈕是您唯一能在不做審查的情況下發出的請求, 它只送出一小段固定的範例差異, 從不送出您的檔案。這些請求同樣計入現有的[用量追蹤與預算警報](usage.md)。

### 修復或解釋一條診斷

打開快速修復, 並挑一個在聊天檢視無法開啟時作答的模型:

```jsonc
"litellm-vscode-chat.quickFix.enabled": true,
"litellm-vscode-chat.quickFix.model": { "server": "Team proxy", "model": "gpt-4o-mini" }
```

此後任何一條波浪線 - 編譯器錯誤、程式碼檢查警告, 或者任何擴充功能回報的問題 - 都會多出兩個燈泡項目: **用 LiteLLM 修復**和**用 LiteLLM 解釋**。選取其中之一, 會開啟聊天檢視並**直接送出** `@litellm /fix`(或 `/explain`), 後面跟著診斷訊息, 並附上出問題的那幾行程式碼; 因此答案來自**聊天選擇器目前選取的那個模型** - 您選了自己的模型就是您的, 否則就是內建的 Copilot 模型 - 並落在一個您可以繼續追問的對話裡。您只是查看燈泡時不會發出任何請求; 請求發生在您選取某個操作時。

燈泡只出現在已儲存的檔案上。未儲存緩衝區裡的程式碼無法附加到聊天輪次上, 而讓模型去修復它看不見的診斷比不提供更糟, 所以請先儲存檔案。

一個操作在該位置最多認領五條診斷, 嚴重的優先(錯誤排在警告前面), 並附上它們所在的行以及上下各兩行。

`quickFix.model` 設定是後備路徑, 不是主路徑: 只有在聊天檢視無法作答時才會用到 - 沒有安裝聊天擴充功能, 它被停用或出故障, 或者 `@litellm` 參與者本身被關閉或註冊被拒絕。這時同樣的問題 - 「修復」要的是修正後的程式碼, 「解釋」要的是解釋, 與聊天路徑完全一致 - 會作為一次請求送給那個模型, 答案會在一個新的未命名 markdown 編輯器中開啟, 您可以閱讀後關掉; 任何內容都不會被寫進您的檔案。如果您有聊天檢視, 不設這個模型也沒問題 - 只是在少數會走後備路徑的場合, 您得到的是一條提示而不是答案。儀表板上該行的「測試模型」按鈕只送出一小段固定程式碼, 絕不送出您的程式碼。

隱私: 兩條路徑都會把診斷訊息和附上的程式碼行送出您的機器 - 走聊天路徑時發往選擇器指定的模型 (除非您選了自己的模型, 否則就是內建的 Copilot 模型), 並且像任何聊天輪次一樣帶上該對話先前的輪次; 走後備路徑時發往 `quickFix.model` 背後的伺服器。

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
| LiteLLM: Generate Pull Request Description | 依您的分支草擬提取要求標題和描述並複製到剪貼簿 (選擇加入; 見[配方](#用您自己的模型產生提取要求描述)) |
| LiteLLM: Review Changes | 審查一個存放庫裡所有未提交的變更, 並在相關的行上留下評論 (選擇加入; 見[配方](#讓模型審查您的程式碼)) |
| LiteLLM: Review This File | 審查您正在看的那個檔案的全部內容, 並在相關的行上留下評論 (同一個選擇啟用) |
| LiteLLM: Report Issue | 開啟預先填好的 GitHub Issue; 見[它收集什麼](troubleshooting.md#回報問題) |
| LiteLLM: Help & Feedback | 文件、bug 回報與功能請求的捷徑 |
