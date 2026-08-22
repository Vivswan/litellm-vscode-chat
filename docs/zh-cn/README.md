# LiteLLM Provider for GitHub Copilot Chat: 文档

[English](../README.md) | 简体中文 | [繁體中文](../zh-tw/README.md)

本扩展把 GitHub Copilot Chat 连接到任意数量的 LiteLLM 服务器: 它们的模型出现在 Copilot 的模型选择器中, 支持流式输出、工具调用、图像和推理, 扩展还会随时跟踪每个服务器的支出与预算。一切都有两种等价的配置方式 - 仪表板面板和普通的 VS Code 设置。

## 我想要...

| 目标 | 阅读 |
|------|------|
| 设置第一个服务器并发送一次聊天 | [快速入门](getting-started.md) |
| 添加另一个服务器, 或查看条目能携带的每个字段 | [服务器: 条目参考](servers.md#条目参考) |
| 让 API 密钥不出现在 settings.json 中 | [服务器: 密钥与密钥存储](servers.md#密钥与密钥存储) |
| 用 OAuth 或自定义标头中的密钥进行身份验证 | [服务器: 身份验证](servers.md#身份验证) |
| 为服务器附加额外的 HTTP 标头 (跟踪、路由标签) | [服务器: 条目参考](servers.md#条目参考) |
| 使用无法列出自己模型的网关 (没有 `/v1/models`) | [服务器: 声明的模型](servers.md#声明的模型) |
| 在聊天中使用我的 LiteLLM 代理自身的 MCP 工具 | [服务器: MCP 工具](servers.md#mcp-工具) |
| 纠正错误的上下文长度, 或为模型打开视觉能力 | [模型: 能力](models.md#能力) |
| 为一个模型家族设置 temperature (或任何请求参数) | [模型: 参数](models.md#参数) |
| 理解 `"gpt-5*"` 等匹配键如何组合 | [模型: 模型匹配](models.md#模型匹配) |
| 用 LiteLLM 模型处理 Copilot 的提交消息、标题等后台任务 | [模型: Copilot 模型槽位](models.md#copilot-模型槽位) |
| 用我选择的 LiteLLM 模型生成提交消息 | [快速入门: 提交消息配方](getting-started.md#用你自己的模型生成提交消息) |
| 用我选择的 LiteLLM 模型起草拉取请求标题和描述 | [快速入门: 拉取请求描述配方](getting-started.md#用你自己的模型生成拉取请求描述) |
| 在编辑器里用我自己的模型获得幽灵文本补全 | [快速入门: 内联补全配方](getting-started.md#用-litellm-模型获得内联补全) |
| 在聊天里提问并让我自己的模型来回答 | [快速入门: @litellm 聊天配方](getting-started.md#用-litellm-聊天) |
| 让聊天代理向我的某个模型征求第二意见 | [快速入门: 咨询工具配方](getting-started.md#让代理向第二个模型提问) |
| 用我自己的模型修复或解释编辑器里的错误 | [快速入门: 快速修复配方](getting-started.md#修复或解释一条诊断) |
| 设置支出预算并在耗尽前收到提醒 | [用量: 预算](usage.md#预算)与[警报](usage.md#警报) |
| 查看模型的某个参数或能力为什么是这个值 | [模型: 检查器](models.md#检查器) |
| 弄清状态栏里某个东西为什么是红色或黄色 | [故障排除: 状态栏](troubleshooting.md#状态栏) |
| 接管一个在扩展之外添加的服务器 | [服务器: 外部服务器与采用](servers.md#外部服务器与采用) |
| 设置第二台机器, 或理解 Settings Sync 携带什么 | [服务器: 多台机器与 Settings Sync](servers.md#多台机器与-settings-sync) |
| 查询任何设置、它的默认值, 以及升级时发生了什么变化 | [设置: 参考](settings.md#参考) |
| 诊断故障, 从 401 到模型缺失 | [故障排除: 常见问题](troubleshooting.md#常见问题) |

## 页面列表

按阅读顺序:

1. [快速入门](getting-started.md) - 安装、第一个服务器、第一次聊天, 以及最常见的后续步骤的十二个简短配方。
2. [服务器](servers.md) - 完整的 `servers` 设置: 条目字段、三种身份验证形式、密钥存储、每服务器模型配置、同步生命周期、采用, 以及 Settings Sync。
3. [模型](models.md) - 模型如何出现在选择器中、匹配键与继承、能力、参数、每模型的选择器配置, 以及生效值检查器。
4. [用量](usage.md) - 支出与预算跟踪: 预算来自哪里、警报、状态栏项, 以及仪表板的用量面板。
5. [仪表板](dashboard.md) - 面板导览: 服务器列表与表单、模型列表、设置编辑器, 以及诊断。
6. [设置](settings.md) - 完整参考: 每个设置、它的默认值, 以及旧版本配置的重命名表。
7. [故障排除](troubleshooting.md) - 按症状索引: 你看到什么、它意味着什么、如何修复。
8. [开发](../development.md) (English) - 从源码构建, 以及用于针对真实 LiteLLM 代理测试的本地 Docker 栈。
