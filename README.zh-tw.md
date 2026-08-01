# 適用於 GitHub Copilot Chat 的 LiteLLM 提供者

[English](README.md) | [简体中文](README.zh-cn.md) | 繁體中文

[![Marketplace](https://vsmarketplacebadges.dev/version/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Installs](https://vsmarketplacebadges.dev/installs/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Rating](https://vsmarketplacebadges.dev/rating-short/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat&ssr=false#review-details)
[![CI](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/Vivswan/litellm-vscode-chat)](LICENSE)

透過 [LiteLLM](https://docs.litellm.ai) 在 VS Code 中與 GitHub Copilot Chat 搭配使用 100 多個 LLM。

## 功能

- 透過統一的 API 存取 100 多個 LLM (OpenAI、Anthropic、Google、AWS、Azure 等)
- 多伺服器支援: 同時連線多個 LiteLLM 伺服器並彙總模型
- 以 `cheapest` 與 `fastest` 模式自動選擇提供者, 適用於會回報各提供者工具能力路由的閘道 ([詳細資料](docs/zh-tw/models.md))
- 多模態輸入 (視覺、PDF/文件附件、文字/JSON 資料) 與產生的影像/音訊輸出
- 串流、函式呼叫與思考/推理 token
- 廣泛的模型選項傳遞 (`response_format`、`reasoning_effort`、`seed` 等)
- 管理伺服器、模型與設定的儀表板面板, 背後是純 VS Code 設定
- 可自架或使用雲端部署

## 需求

- VS Code 1.129.0 或更新版本, 已安裝 GitHub Copilot Chat 延伸模組並登入
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
	{ "label": "Local", "baseUrl": "http://localhost:4000", "apiKey": "sk-..." }
]
```

延伸模組也附有涵蓋這些步驟的逐步解說: 從命令選擇區執行「Welcome: Open Walkthrough...」, 然後挑選「開始在 Copilot Chat 中使用 LiteLLM」。

## 文件

- [快速入門](docs/zh-tw/getting-started.md) - 第一個伺服器、逐步解說、命令, 以及各項設定的位置
- [伺服器](docs/zh-tw/servers.md) - 多伺服器、祕密與祕密儲存體、OAuth、虛擬金鑰、採用外部伺服器
- [模型與功能](docs/zh-tw/models.md) - 會註冊哪些模型、功能門檻、多模態輸入與輸出、用量回報
- [模型參數](docs/zh-tw/model-parameters.md) - 各模型請求參數、前置詞比對、優先順序、推理程度
- [設定](docs/zh-tw/settings.md) - 每個設定與其預設值: token 上限、逾時、快取、標頭
- [儀表板](docs/zh-tw/dashboard.md) - 面板的索引標籤、伺服器表單與記錄編輯器
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

## 誌謝

這個延伸模組之所以更好, 是因為有人花時間回報壞掉的部分、打造缺少的功能。貢獻者名列於 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md); 收錄社群程式碼的提交帶有共同作者簽名, 解決社群回報的提交會在主旨中致謝回報者, 並由 release-please 帶入[變更記錄](CHANGELOG.md)。

## 資源

- [隱私權與資料](docs/zh-tw/troubleshooting.md#隱私與資料)
- [LiteLLM 文件](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [回報問題](https://github.com/Vivswan/litellm-vscode-chat/issues)
