## 生成拉取请求描述

两个设置即可开启此功能, 都在扩展设置中:

- `litellm-vscode-chat.prGeneration.enabled`: 选择加入开关; 启用前不会发送任何内容, 仪表盘中显式的「测试模型」按钮除外
- `litellm-vscode-chat.prGeneration.model`: 起草描述的模型, 例如 `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

两者都设置后, 命令面板会新增「LiteLLM: 生成拉取请求描述」。它会把你的分支与它将要合入的分支比较, 把提交消息和补丁发送给模型, 并把起草的标题和描述复制到剪贴板。

若已安装 GitHub Pull Requests 扩展, 此功能还会在其 Create Pull Request 视图中注册为「Generate with LiteLLM」, 该视图的生成按钮便可直接填入标题和描述。
