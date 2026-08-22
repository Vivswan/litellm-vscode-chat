## 產生提交訊息

兩個設定即可開啟此功能, 都在延伸模組設定中:

- `litellm-vscode-chat.commitGeneration.enabled`: 選擇加入開關; 啟用前不會送出任何內容
- `litellm-vscode-chat.commitGeneration.model`: 負責草擬訊息的模型, 例如 `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

兩者都設定後, 原始檔控制標題列會出現一個閃光按鈕 (命令選擇區也會新增「LiteLLM: 產生提交訊息」)。它會把您已暫存的差異 (未暫存任何內容時則是工作區差異) 送給模型, 並把草擬的訊息寫入提交框。

指令由您決定: `litellm-vscode-chat.commitGeneration.prompt` 會整體取代內建的 Conventional Commits 指令, 而您最近五筆提交主旨始終作為風格範例一同送出。
