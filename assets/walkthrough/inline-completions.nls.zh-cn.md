## 内联补全

两个设置即可开启此功能, 都在扩展设置中:

- `litellm-vscode-chat.inlineCompletions.enabled`: 选择加入开关; 启用前不注册任何内容, 也不发送任何请求
- `litellm-vscode-chat.inlineCompletions.model`: 写出建议的模型, 例如 `{ "server": "Team proxy", "model": "qwen2.5-coder-fim" }`

要选一个补全模型 - 你的 LiteLLM 服务器声明为 `mode: completion` 的那种, 这也正是它不出现在聊天模型选择器里的原因。之后建议会在你输入时以幽灵文本出现, 光标周围的文件内容也会自动发送到该服务器。

还有一个设置让它不进入不该进的文件: `inlineCompletions.languageFilter` 接受一个模式加精确的 VS Code 语言 ID (block 表示在列出的语言之外的所有语言中运行, allow 表示仅在列出的语言中运行), 而编辑器 `{}` 语言状态菜单里的「LiteLLM inline suggestions」一行会替你切换当前语言。
