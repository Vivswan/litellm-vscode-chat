# 適用於 GitHub Copilot Chat 的 LiteLLM 提供者

[English](README.md) | [简体中文](README.zh-cn.md) | 繁體中文

[![Marketplace](https://vsmarketplacebadges.dev/version/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Installs](https://vsmarketplacebadges.dev/installs/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Rating](https://vsmarketplacebadges.dev/rating-short/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat&ssr=false#review-details)
[![CI](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Individual%20%26%20Small%20Org%201.0.0-blue)](LICENSE.md)

透過 [LiteLLM](https://docs.litellm.ai) 在 VS Code 中與 GitHub Copilot Chat 搭配使用 100 多個 LLM。

## 功能

- 透過統一的 API 存取 100 多個 LLM (OpenAI、Anthropic、Google、AWS、Azure 等)
- 多伺服器支援: 同時連線多個 LiteLLM 伺服器並彙總模型
- 以 `cheapest` 與 `fastest` 模式自動選擇提供者, 適用於會回報各提供者工具能力路由的閘道 ([詳細資料](docs/zh-tw/models.md))
- 多模態輸入 (視覺、PDF/文件附件、文字/JSON 資料) 與產生的影像/音訊輸出
- 串流、函式呼叫與思考/推理 token
- 廣泛的模型選項傳遞 (`response_format`、`reasoning_effort`、`seed` 等)
- 各模型能力覆寫與宣告的模型: 修正閘道回報的內容, 或註冊它根本列不出的模型, 缺口由 OpenRouter 目錄自動填補 ([詳細資料](docs/zh-tw/models.md#能力))
- 內嵌補全: 選擇加入的幽靈文字, 由您自己 Proxy 上的補全 (FIM) 模型寫出, 範圍限定在您選擇的語言 ([詳細資料](docs/zh-tw/getting-started.md#用-litellm-模型取得內嵌補全))
- 管理伺服器、模型與設定的儀表板面板, 背後是純 VS Code 設定
- 設定匯出與匯入: 把伺服器、模型記錄以及 (明確選擇時) 儲存的祕密搬到另一台機器, 並支援一條命令復原 ([詳情](docs/zh-tw/settings.md#匯出與匯入))
- 可自架或使用雲端部署

## 需求

- VS Code 1.134.0 或更新版本, 已安裝 GitHub Copilot Chat 延伸模組並登入
- 執行中的 LiteLLM Proxy (自架或雲端)
- LiteLLM API 金鑰 (視您的環境需要)

## 快速開始

1. 從 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安裝延伸模組
2. 開啟 VS Code 的聊天介面 (`Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或標題列的聊天圖示)
3. 按一下模型選擇器 → 「Manage Models...」 → 「LiteLLM」
4. 新增伺服器: 輸入標籤、基底 URL (例如 `http://localhost:4000`) 與 API 金鑰
5. 選取要加入的模型
6. 回到聊天, 在模型選擇器中挑選其中一個新模型並送出訊息

您也可以把伺服器直接宣告為設定 (使用者 settings.json); 儀表板的「新增伺服器」表單 (「LiteLLM: 開啟儀表板」) 寫入的就是同一個項目:

```jsonc
"litellm-vscode-chat.servers": [
	{ "label": "Local", "baseUrl": "http://localhost:4000", "auth": { "apiKey": "sk-..." } }
]
```

延伸模組也附有涵蓋這些步驟的逐步解說: 從命令選擇區執行「Welcome: Open Walkthrough...」, 然後挑選「開始在 Copilot Chat 中使用 LiteLLM」。

## 文件

- [快速入門](docs/zh-tw/getting-started.md) - 第一個伺服器、逐步解說、命令, 以及各項設定的位置
- [伺服器](docs/zh-tw/servers.md) - 多伺服器、祕密與祕密儲存體、OAuth、虛擬金鑰、採用外部伺服器
- [模型與功能](docs/zh-tw/models.md) - 會註冊哪些模型、功能門檻、多模態輸入與輸出、用量回報
- [模型參數](docs/zh-tw/models.md#參數) - 各模型請求參數、前置詞比對、優先順序、推理程度
- [模型能力](docs/zh-tw/models.md#能力) - 能力覆寫、宣告的模型、OpenRouter 目錄、預期的探索失敗
- [設定](docs/zh-tw/settings.md) - 每個設定與其預設值: token 上限、逾時、快取、標頭
- [儀表板](docs/zh-tw/dashboard.md) - 面板的各個頁面、伺服器表單與記錄編輯器
- [疑難排解](docs/zh-tw/troubleshooting.md) - 診斷、問題回報、常見問題、隱私權、解除安裝清理、移轉注意事項
- [開發](docs/development.md) (English) - 從原始碼建置與本機 Docker 測試堆疊

## 開發

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
bun install
bun run compile
```

按 `F5` 啟動延伸模組開發主機。[開發](docs/development.md)涵蓋本機 LiteLLM 堆疊與測試套件; [CONTRIBUTING.md](CONTRIBUTING.md) 說明如何提交變更。

## 隱私

您的提示與完成內容只在 VS Code 與您設定的 LiteLLM 伺服器之間傳輸, 但有一條邊界值得點明: 任何作為聊天輪次送出的內容, 都會去到聊天選擇器所指模型所在的地方 - 除非您選了自己的模型, 否則那就是內建的 Copilot 模型。

- **內嵌補全。**啟用內嵌補全後, 游標周圍的檔案內容會在您輸入時自動送到您為它設定的 LiteLLM 伺服器 - 與聊天是同一個信任邊界, 但少了您逐次請求的動作, 這正是該功能預設關閉並要求明確指定模型的原因。
- **提交訊息產生。**當您叫用提交訊息產生時, 已暫存或工作區的差異、未追蹤檔案的名稱以及您最近五筆提交主旨會送到您為它設定的 LiteLLM 伺服器 - 僅在您明確叫用時送出, 並計入與聊天相同的用量追蹤和預算警示。
- **快速修復。**當您從快速修復燈泡中選擇「修復」或「解釋」時, 診斷訊息以及它們所在的行會作為一次普通的聊天輪次發往聊天選擇器指定的模型 - 您選了自己的 LiteLLM 模型就是您的伺服器, 否則就是內建的 Copilot 模型, 與任何聊天輪次一樣去到該模型所在的地方 - 或者在聊天檢視無法作答時, 發往 `quickFix.model` 背後的伺服器。

一個預設開啟的例外: 延伸模組約每週從 `https://openrouter.ai/api/v1/models` 重新整理一次內建的模型能力目錄, 這是一份公開、無需驗證的模型清單 - 該請求不帶提示、不帶用量, 也不帶任何關於您或您伺服器的資訊。把 `litellm-vscode-chat.models.openRouterCatalog` 設為 `false` 可關閉重新整理與自動比對; 明確的 `_openrouter_model` 指示詞繼續離線使用內建快照。

詳細資料參閱[模型能力](docs/zh-tw/models.md#openrouter-目錄)與[隱私與資料](docs/zh-tw/troubleshooting.md#隱私與資料)。

## 誌謝

這個延伸模組之所以更好, 是因為有人花時間回報壞掉的部分、打造缺少的功能。貢獻者名列於 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md); 收錄社群程式碼的提交帶有共同作者簽名, 解決社群回報的提交會在主旨中致謝回報者, 並由 release-please 帶入[變更記錄](CHANGELOG.md)。

## 資源

- [隱私權與資料](docs/zh-tw/troubleshooting.md#隱私與資料)
- [LiteLLM 文件](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [回報問題](https://github.com/Vivswan/litellm-vscode-chat/issues)
