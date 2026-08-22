# LiteLLM Provider for GitHub Copilot Chat

[![Marketplace](https://vsmarketplacebadges.dev/version/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Installs](https://vsmarketplacebadges.dev/installs/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat)
[![Rating](https://vsmarketplacebadges.dev/rating-short/vivswan.litellm-vscode-chat.svg)](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat&ssr=false#review-details)
[![CI](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/Vivswan/litellm-vscode-chat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Individual%20%26%20Small%20Org%201.0.0-blue)](LICENSE.md)

[English](README.md) | 简体中文 | [繁體中文](README.zh-tw.md)

借助 [LiteLLM](https://docs.litellm.ai), 在 VS Code 的 GitHub Copilot Chat 中使用 100 多个 LLM。

## 功能

- 通过统一的 API 访问 100 多个 LLM (OpenAI、Anthropic、Google、AWS、Azure 等)
- 多服务器支持: 同时连接多个 LiteLLM 服务器并聚合模型
- 在会报告各提供方路由是否支持工具调用的网关上, 支持 `cheapest` 和 `fastest` 自动提供方选择模式 ([详情](docs/zh-cn/models.md))
- 多模态输入 (视觉、PDF/文档附件、文本/JSON 数据) 以及生成的图像/音频输出
- 流式传输、函数调用和思维/推理 token
- 广泛的模型选项透传 (`response_format`、`reasoning_effort`、`seed` 等)
- 每模型能力覆盖与声明的模型: 纠正网关报告的内容, 或注册它根本列不出的模型, 空缺由 OpenRouter 目录自动填补 ([详情](docs/zh-cn/models.md#能力))
- 用于管理服务器、模型和设置的仪表板面板, 背后是普通的 VS Code 设置
- 设置导出与导入: 把服务器、模型记录以及 (明确选择时) 存储的密钥搬到另一台机器, 并支持一条命令撤销 ([详情](docs/zh-cn/settings.md#导出与导入))
- 支持自托管或云端部署

## 要求

- VS Code 1.129.0 或更高版本, 已安装并登录 GitHub Copilot Chat 扩展
- 正在运行的 LiteLLM 代理 (自托管或云端)
- LiteLLM API 密钥 (如果你的部署需要)

## 快速开始

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安装扩展
2. 打开 VS Code 的聊天界面 (`Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或标题栏中的聊天图标)
3. 单击模型选择器 → "Manage Models..." → "LiteLLM"
4. 添加服务器: 输入标签、基础 URL (例如 `http://localhost:4000`) 和 API 密钥
5. 选择要添加的模型
6. 回到聊天, 在模型选择器中选择一个新模型并发送消息

你也可以把服务器声明为设置 (用户 settings.json); 仪表板的添加服务器表单 (「LiteLLM: 打开仪表板」) 写入的就是同样的条目:

```jsonc
"litellm-vscode-chat.servers": [
	{ "label": "Local", "baseUrl": "http://localhost:4000", "auth": { "apiKey": "sk-..." } }
]
```

扩展还附带了涵盖这些步骤的演练: 从命令面板运行 "Welcome: Open Walkthrough...", 然后选择「开始使用适用于 Copilot Chat 的 LiteLLM」。

## 文档

- [快速入门](docs/zh-cn/getting-started.md) - 第一个服务器、演练、命令以及在哪里配置各项内容
- [服务器](docs/zh-cn/servers.md) - 多服务器、密钥与密钥存储、OAuth、虚拟密钥、采用外部服务器
- [模型与能力](docs/zh-cn/models.md) - 哪些模型会注册、能力门控、多模态输入输出、用量报告
- [模型参数](docs/zh-cn/models.md#参数) - 每模型请求参数、前缀匹配、优先级、推理强度
- [模型能力](docs/zh-cn/models.md#能力) - 能力覆盖、声明的模型、OpenRouter 目录、预期的发现失败
- [设置](docs/zh-cn/settings.md) - 每个设置及其默认值: token 限制、超时、缓存、标头
- [仪表板](docs/zh-cn/dashboard.md) - 面板的各个页面、服务器表单和记录编辑器
- [故障排除](docs/zh-cn/troubleshooting.md) - 诊断、问题报告、常见问题、隐私、卸载清理、迁移说明
- [开发](docs/development.md) (English) - 从源码构建以及本地 Docker 测试栈

## 开发

```bash
git clone https://github.com/Vivswan/litellm-vscode-chat
cd litellm-vscode-chat
bun install
bun run compile
```

按 `F5` 启动扩展开发主机。[开发](docs/development.md)介绍了本地 LiteLLM 栈和测试套件; [CONTRIBUTING.md](CONTRIBUTING.md) 介绍了如何提交更改。

## 隐私

你的提示和补全只在 VS Code 与你配置的 LiteLLM 服务器之间传输。当你调用提交消息生成时, 已暂存或工作区的差异以及未跟踪文件的名称会发送到你为它配置的 LiteLLM 服务器 - 仅在你显式调用时发送, 并计入与聊天相同的用量跟踪和预算警报。一个默认开启的例外: 扩展约每周从 `https://openrouter.ai/api/v1/models` 刷新一次内置的模型能力目录, 这是一个公开的、无需身份验证的模型列表 - 该请求不携带提示、不携带用量, 也不携带任何关于你或你的服务器的信息。把 `litellm-vscode-chat.models.openRouterCatalog` 设为 `false` 可关闭刷新和自动匹配; 显式的 `_openrouter_model` 指令继续离线工作于内置快照。详情见[模型能力](docs/zh-cn/models.md#openrouter-目录)和[隐私与数据](docs/zh-cn/troubleshooting.md#隐私与数据)。

## 致谢

这个扩展之所以更好, 是因为有人花时间报告了哪里坏了, 并构建了缺失的东西。贡献者记录在 [ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) 中; 合入社区代码的提交带有共同作者尾注, 解决社区报告的提交会在标题中致谢报告者, release-please 会把它带入[更新日志](CHANGELOG.md)。

## 资源

- [隐私与数据](docs/zh-cn/troubleshooting.md#隐私与数据)
- [LiteLLM 文档](https://docs.litellm.ai)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [报告问题](https://github.com/Vivswan/litellm-vscode-chat/issues)
