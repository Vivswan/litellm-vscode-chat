# 入門指南

[English](../getting-started.md) | [简体中文](../zh-cn/getting-started.md) | 繁體中文

安裝延伸模組, 將它指向 LiteLLM Proxy, 其模型就會出現在 GitHub Copilot Chat 的模型選擇器中。本頁涵蓋這段初次設定, 以及之後各類設定存放在哪裡。

## 需求

- **VS Code 1.129.0 或更新版本**, 並已安裝 GitHub Copilot Chat 延伸模組且完成登入。本延伸模組是接入 Copilot 的聊天檢視, 少了它就沒有聊天介面, 也沒有模型選擇器。
- **一個運作中的 LiteLLM Proxy**, 自架或雲端皆可。LiteLLM Proxy 是一台在單一 OpenAI 相容端點背後匯集多家 LLM 提供者的伺服器; 如果您還沒有, LiteLLM 官方的 [Proxy 快速入門](https://docs.litellm.ai/docs/proxy/quick_start)只要幾個命令就能在本機啟動一個。
- **一把 LiteLLM API 金鑰**, 如果您的 Proxy 需要驗證: 通常是 `sk-...` 形式的值, 可能是 Proxy 設定中的主金鑰, 也可能是由 Proxy 營運者核發的[虛擬金鑰](servers.md#虛擬金鑰)。
  - 如果伺服器由公司營運, 請詢問其管理員。
  - 不確定您的伺服器是否需要金鑰? 需要時, 「LiteLLM: 測試連線」會回報驗證錯誤。

本儲存庫也附帶一個可指令碼化的本機 Proxy 供試用; 請參閱[開發](../development.md) (English)。

## 第一個伺服器

1. 從 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安裝延伸模組
2. 開啟 VS Code 的聊天介面: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或標題列上的聊天圖示
3. 按一下模型選擇器 → "Manage Models..." → "LiteLLM"
4. 新增伺服器: 輸入標籤、基底 URL (例如 `http://localhost:4000`) 與 API 金鑰
5. 選取要加入的模型
6. 回到聊天, 開啟模型選擇器, 在您的伺服器標籤下挑一個新模型, 然後送出訊息; 在您挑選之前, Copilot 會一直使用它的預設模型

延伸模組也附帶涵蓋這些步驟的逐步解說: 在命令選擇區執行 "Welcome: Open Walkthrough...", 然後挑選「開始在 Copilot Chat 中使用 LiteLLM」。

您同樣可以從儀表板開始: 在命令選擇區執行「LiteLLM: 開啟儀表板」, 使用其「新增伺服器」表單。兩條路徑儲存伺服器的方式不同:

| 路徑 | 建立的東西 | 帶來的好處 |
|------|-----------------|--------------------|
| 儀表板的「新增伺服器」表單 | `litellm-vscode-chat.servers` 設定中的一個宣告項目 | 功能較完整的一種: 可在儀表板中編輯, 支援各伺服器的[模型參數](model-parameters.md#各項目參數) |
| 原生的 Manage Models 編輯器 | 一個由 VS Code 管理的群組 | 在儀表板中標示為「外部」, 直到您[採用它](servers.md#外部伺服器與採用) |

## 在哪裡設定

設定分佈在兩個可互換的地方: [儀表板](dashboard.md) (涵蓋一切的 GUI) 與一般的 VS Code 設定。各模型選項與單次動作則有自己的介面:

| 項目 | 位置 | 開啟方式 |
|------|-------|-------------|
| 伺服器: 標籤、基底 URL、API 金鑰、OAuth | 儀表板, 或 `litellm-vscode-chat.servers` 設定 | 命令選擇區 → 「LiteLLM: 開啟儀表板」, 或設定 → 搜尋 "litellm-vscode-chat" |
| 各模型選項 (推理程度) | Copilot Chat 模型選擇器 | 選取 LiteLLM 模型, 然後按一下聊天輸入框中模型名稱旁的程度標籤 |
| 全域選項 (逾時、快取、標頭、`modelParameters`) | 儀表板或 VS Code 設定 | 同上 |
| 動作 (測試連線、同步模型、診斷、回報問題) | 命令 | 命令選擇區 → 輸入 "LiteLLM", 或「管理 LiteLLM 提供者」選單 |

## 命令

延伸模組能隨選執行的一切都是命令選擇區命令 (`Ctrl+Shift+P` / `Cmd+Shift+P`, 然後輸入 "LiteLLM"):

| 命令 | 功能 |
|---------|--------------|
| 管理 LiteLLM 提供者 | 中樞選單: 管理伺服器與模型、開啟儀表板、執行診斷 |
| LiteLLM: 開啟儀表板 | [儀表板](dashboard.md)面板: 伺服器、模型與設定集中一處 |
| LiteLLM: 測試連線 | 連線到每個伺服器, 回報模型數或確切的錯誤 |
| LiteLLM: 立即同步模型 | 立即重新整理模型清單, 略過[探索快取](settings.md#模型清單快取) |
| LiteLLM: 顯示診斷 | 開啟儀表板的[診斷分頁](dashboard.md#診斷): 各伺服器連線狀態、模型數、錯誤與上次檢查時間 |
| LiteLLM: 設定伺服器祕密 | 將伺服器的 API 金鑰、OAuth 用戶端密碼或虛擬金鑰存入[祕密儲存體](servers.md#祕密與祕密儲存體) |
| LiteLLM: 回報問題 | 開啟預先填寫的 GitHub 問題; 參閱[它收集哪些內容](troubleshooting.md#回報問題) |
| LiteLLM: 說明與意見回饋 | 文件、錯誤回報與功能建議的捷徑 |

## 檢查設定

LiteLLM 狀態列項目 (右下角) 一眼呈現連線狀態; 執行「LiteLLM: 測試連線」可對伺服器做端對端驗證。若有異常, [疑難排解](troubleshooting.md)會逐一介紹診斷工具與常見的失敗情況。

## 更進一步

- [伺服器](servers.md) - 多伺服器、祕密與祕密儲存體、OAuth、虛擬金鑰, 以及採用在延伸模組之外新增的伺服器
- [模型與功能](models.md) - 註冊哪些模型、功能閘控、多模態輸入與輸出、思考、來源與 token 用量
- [模型參數](model-parameters.md) - 針對各模型傳送 `temperature` 或 `reasoning_effort` 之類的請求參數, 以及延伸模組如何決定送上線路的內容
- [設定](settings.md) - 每個設定及其預設值: token 上限、逾時、快取、標頭
- [儀表板](dashboard.md) - 儀表板面板各部分的功能
