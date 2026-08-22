## 生成提交消息

两个设置即可开启此功能, 都在扩展设置中:

- `litellm-vscode-chat.commitGeneration.enabled`: 选择加入开关; 启用前不会发送任何内容
- `litellm-vscode-chat.commitGeneration.model`: 起草消息的模型, 例如 `{ "server": "Team proxy", "model": "gpt-4o-mini" }`

两者都设置后, 源代码管理标题栏会出现一个闪光按钮 (命令面板也会新增「LiteLLM: 生成提交消息」)。它会把你已暂存的差异 (未暂存任何内容时则是工作区差异) 发送给模型, 并把起草的消息写入提交框。

指令由你决定: `litellm-vscode-chat.commitGeneration.prompt` 会整体替换内置的 Conventional Commits 指令, 而你最近五条提交主题始终作为风格示例一同发送。
