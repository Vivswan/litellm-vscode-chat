## 產生提取要求描述

兩個設定即可開啟此功能, 都在延伸模組設定中:

- `litellm-vscode-chat.prGeneration.enabled`: 選擇加入開關; 啟用前不會送出任何內容, 儀表板中明確的「測試模型」按鈕除外
- `litellm-vscode-chat.prGeneration.model`: 負責草擬描述的模型, 例如 `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

兩者都設定後, 命令選擇區會新增「LiteLLM: 產生提取要求描述」。它會把您的分支與它將要合入的分支比較, 把提交訊息和修補檔送給模型, 並把草擬的標題和描述複製到剪貼簿。

若已安裝 GitHub Pull Requests 延伸模組, 此功能還會在其 Create Pull Request 檢視中註冊為「Generate with LiteLLM」, 該檢視的產生按鈕便可直接填入標題和描述。
