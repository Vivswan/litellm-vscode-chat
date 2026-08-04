# 適用於 GitHub Copilot Chat 的 LiteLLM 提供者: 文件

[English](../README.md) | [简体中文](../zh-cn/README.md) | 繁體中文

## 入門

- [入門指南](getting-started.md) - 安裝、第一個伺服器、逐步解說, 以及之後各類設定存放在哪裡。

## 使用延伸模組

- [伺服器](servers.md) - `servers` 設定、項目欄位、祕密與祕密儲存體、OAuth 用戶端認證、虛擬金鑰, 以及採用在延伸模組之外新增的伺服器。
- [模型參數](model-parameters.md) - 請求直通合約、`modelParameters` 設定、前置詞比對與伺服器限定、各項目參數、推理程度與優先順序。
- [模型能力](model-capabilities.md) - 修正探索回報的內容、宣告探索列不出的模型、OpenRouter 目錄及其隱私開關, 以及預期的探索失敗。
- [儀表板](dashboard.md) - 面板的版面配置、伺服器清單與表單、模型表格, 以及設定編輯器。

## 參考

- [設定](settings.md) - 每個設定及其預設值: token 上限、逾時、模型清單快取、自訂標頭、提示快取。
- [模型與功能](models.md) - 伺服器的模型資訊會註冊哪些內容、每項功能決定什麼、多模態輸入與輸出、思考、來源, 以及 token 用量回報。
- [命令](getting-started.md#命令) - 一張表列出所有命令選擇區命令。

## 說明

- [疑難排解](troubleshooting.md) - 狀態列與診斷工具、問題回報及其收集的內容、隱私與資料流向、逾時與重試語意、常見問題、解除安裝時的清理, 以及舊版本的移轉說明。

## 參與貢獻

- [開發](../development.md) (English) - 從原始碼建置, 以及用來對照真實 LiteLLM Proxy 測試的本機 Docker 堆疊。
