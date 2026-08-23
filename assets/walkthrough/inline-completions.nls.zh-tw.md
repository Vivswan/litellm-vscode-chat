## 內嵌補全

兩個設定即可開啟此功能, 都在延伸模組設定中:

- `litellm-vscode-chat.inlineCompletions.enabled`: 選擇加入開關; 啟用前不註冊任何內容, 也不送出任何請求, 儀表板中明確的「測試模型」按鈕除外
- `litellm-vscode-chat.inlineCompletions.model`: 寫出建議的模型, 例如 `{ "server": "Team proxy", "model": "qwen2.5-coder-fim" }`

要選一個補全模型 - 您的 LiteLLM 伺服器宣告為 `mode: completion` 的那一種, 這也正是它不出現在聊天模型選擇器裡的原因。之後建議會在您輸入時以幽靈文字出現, 游標周圍的檔案內容也會自動送到該伺服器。

還有一個設定讓它不進入不該進的檔案: `inlineCompletions.languageFilter` 接受一個模式加精確的 VS Code 語言 ID (block 表示在列出的語言之外的所有語言中執行, allow 表示僅在列出的語言中執行), 而編輯器 `{}` 語言狀態選單裡的「LiteLLM inline suggestions」那一列會替您切換目前語言。
