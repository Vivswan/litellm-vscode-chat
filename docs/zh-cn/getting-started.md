# 快速入门

[English](../getting-started.md) | 简体中文 | [繁體中文](../zh-tw/getting-started.md)

安装扩展, 将它指向一个 LiteLLM 代理, 它的模型就会出现在 GitHub Copilot Chat 的模型选择器中。本页介绍首次设置, 以及之后每类配置存放在哪里。

## 要求

- **VS Code 1.129.0 或更高版本**, 已安装并登录 GitHub Copilot Chat 扩展。本扩展接入的是 Copilot 的聊天视图, 没有它就没有聊天界面, 也没有模型选择器。
- **一个正在运行的 LiteLLM 代理**, 自托管或云端均可。LiteLLM 代理是一台在单个兼容 OpenAI 的终结点背后暴露众多 LLM 提供方的服务器; 如果你还没有, LiteLLM 官方的[代理快速入门](https://docs.litellm.ai/docs/proxy/quick_start)几条命令就能在本地跑起来一个。
- **一个 LiteLLM API 密钥** (如果你的代理需要): 通常是 `sk-...` 形式的值, 要么是代理配置中的主密钥, 要么是由代理运营者签发的[虚拟密钥](servers.md#虚拟密钥)。
  - 如果服务器由公司运营, 请询问其管理员。
  - 不确定自己的代理是否需要? 需要时「LiteLLM: 测试连接」会报告身份验证错误。

仓库还附带一个可脚本化的本地代理供你试验; 参见 [Development](../development.md) (English)。

## 第一个服务器

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安装扩展
2. 打开 VS Code 的聊天界面: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或标题栏中的聊天图标
3. 单击模型选择器 → "Manage Models..." → "LiteLLM"
4. 添加服务器: 输入标签、基础 URL (例如 `http://localhost:4000`) 和 API 密钥
5. 选择要添加的模型
6. 回到聊天, 打开模型选择器, 在你的服务器标签下选择一个新模型, 然后发送消息; 在你选择之前, Copilot 会一直使用它的默认模型

扩展还附带涵盖这些步骤的演练: 从命令面板运行 "Welcome: Open Walkthrough...", 然后选择「开始使用适用于 Copilot Chat 的 LiteLLM」。

你也可以从仪表板开始: 从命令面板运行「LiteLLM: 打开仪表板」, 使用其中的添加服务器表单。两种途径存储服务器的方式不同:

| 途径 | 创建什么 | 带来什么 |
|------|-----------------|--------------------|
| 仪表板的添加服务器表单 | `litellm-vscode-chat.servers` 设置中的一个声明条目 | 能力更全的一种: 可在仪表板中编辑, 支持每服务器的[模型参数](model-parameters.md#每条目参数) |
| 原生的 Manage Models 编辑器 | 一个由 VS Code 管理的组 | 在仪表板中显示为「外部」, 直到你[采用它](servers.md#外部服务器与采用) |

## 在哪里配置

配置存放在两个可互换的地方: [仪表板](dashboard.md) (覆盖全部配置的 GUI) 和普通的 VS Code 设置。每模型选项和一次性操作有各自的入口:

| 配置什么 | 在哪里 | 如何打开 |
|------|-------|-------------|
| 服务器: 标签、基础 URL、API 密钥、OAuth | 仪表板, 或 `litellm-vscode-chat.servers` 设置 | 命令面板 → 「LiteLLM: 打开仪表板」, 或设置 → 搜索 "litellm-vscode-chat" |
| 每模型选项 (推理强度) | Copilot Chat 模型选择器 | 选择一个 LiteLLM 模型, 然后单击聊天输入框中模型名称旁的强度标签 |
| 全局选项 (超时、缓存、标头、`modelParameters`) | 仪表板或 VS Code 设置 | 同上 |
| 操作 (测试连接、同步模型、诊断、报告问题) | 命令 | 命令面板 → 输入 "LiteLLM", 或「管理 LiteLLM 提供程序」菜单 |

## 命令

扩展能按需做的一切都是命令面板命令 (`Ctrl+Shift+P` / `Cmd+Shift+P`, 然后输入 "LiteLLM"):

| 命令 | 作用 |
|---------|--------------|
| 管理 LiteLLM 提供程序 | 中心菜单: 管理服务器和模型、打开仪表板、运行诊断 |
| LiteLLM: 打开仪表板 | [仪表板](dashboard.md)面板: 服务器、模型和设置尽在一处 |
| LiteLLM: 测试连接 | 连接每个服务器, 报告模型数量或确切错误 |
| LiteLLM: 立即同步模型 | 绕过[发现缓存](settings.md#模型列表缓存), 立即刷新模型列表 |
| LiteLLM: 显示诊断信息 | 打开仪表板的[诊断标签页](dashboard.md#诊断): 每个服务器的连接状态、模型数量、错误和上次检查时间 |
| LiteLLM: 设置服务器密钥 | 将服务器的 API 密钥、OAuth 客户端密钥或虚拟密钥存入[密钥存储](servers.md#密钥与密钥存储) |
| LiteLLM: 报告问题 | 打开预填好的 GitHub Issue; 参见[它收集哪些内容](troubleshooting.md#报告问题) |
| LiteLLM: 帮助与反馈 | 通往文档、Bug 报告和功能请求的快捷方式 |

## 检查设置是否就绪

LiteLLM 状态栏项 (右下角) 一眼展示连接状态; 运行「LiteLLM: 测试连接」可端到端验证服务器。如果哪里不对, [故障排除](troubleshooting.md)会带你使用诊断工具并排查常见故障。

## 进一步了解

- [服务器](servers.md) - 多服务器、密钥与密钥存储、OAuth、虚拟密钥, 以及采用在扩展之外添加的服务器
- [模型与能力](models.md) - 哪些模型会注册、能力门控、多模态输入输出、思维、来源和 token 用量
- [模型参数](model-parameters.md) - 按模型发送 `temperature` 或 `reasoning_effort` 等请求参数, 以及扩展如何决定哪些内容上线路
- [设置](settings.md) - 每个设置及其默认值: token 限制、超时、缓存、标头
- [仪表板](dashboard.md) - 仪表板面板各部分的作用
