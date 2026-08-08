# 快速入门

[English](../getting-started.md) | 简体中文 | [繁體中文](../zh-tw/getting-started.md)

安装扩展, 把它指向一个 LiteLLM 代理, 它的模型就会出现在 GitHub Copilot Chat 的模型选择器中。本页把这条路径从头到尾走一遍, 然后给出五个简短配方, 覆盖最常见的后续步骤。

## 要求

- **VS Code 1.129.0 或更高版本**, 已安装并登录 GitHub Copilot Chat 扩展。本扩展接入的是 Copilot 的聊天视图, 没有它就没有聊天界面, 也没有模型选择器。
- **一个正在运行的 LiteLLM 代理**, 自托管或云端均可。LiteLLM 代理是一台把众多 LLM 提供方置于单个 OpenAI 兼容终结点之后的服务器; 如果你还没有, LiteLLM 官方的[代理快速入门](https://docs.litellm.ai/docs/proxy/quick_start)几条命令就能在本地跑起来一个。
- **一个 LiteLLM API 密钥** (如果你的代理需要): 通常是 `sk-...` 形式的值, 要么是代理配置中的主密钥, 要么是由代理运营者签发的[虚拟密钥](servers.md#身份验证)。
  - 如果服务器由公司运营, 请询问其管理员。
  - 不确定自己的代理是否需要? 需要时, 仪表板的「测试连接」会报告身份验证错误。

仓库还附带一个可脚本化的本地代理供你试验; 参见[开发](../development.md) (English)。

## 安装并添加服务器

1. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=vivswan.litellm-vscode-chat) 安装扩展。
2. 从命令面板 (`Ctrl+Shift+P` / `Cmd+Shift+P`) 运行 "LiteLLM: Open Dashboard", 单击**添加服务器**。
3. 填写表单:
   - **标签** - 模型选择器将显示的名称, 例如 `prod`。
   - **基础 URL** - 服务器的根 URL, 例如 `http://localhost:4000`。不要写 `/v1` 后缀; 扩展会自行追加。
   - **身份验证** - 恰好一种形式: API 密钥 (最常见的情况)、OAuth 客户端凭据, 或自定义标头中的密钥。对于密钥, 表单的「安全存储」选项会把它放进 VS Code [密钥存储](servers.md#密钥与密钥存储)而不是你的设置文件 - 这是默认选项, 也是任何你不会提交到仓库的值的正确选择。
4. 单击**测试连接**。它会按当前输入原样探测草稿, 在保存任何东西之前, 回答模型数量或确切的错误。
5. 单击**保存**。

表单写入的是 `litellm-vscode-chat.servers` 设置, 因此同一个服务器在 settings.json 中就是一个条目:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "http://localhost:4000",
    "auth": { "apiKey": "sk-..." }   // 或省略此字段, 把密钥安全存储
  }
]
```

两条途径等价 - 编辑你喜欢的那个, 仪表板和设置始终保持一致。条目的每个字段、其他身份验证形式, 以及密钥可以存放在哪里, 都在[服务器](servers.md#条目参考)页面上。

扩展还附带涵盖这些步骤的演练: 从命令面板运行 "Welcome: Open Walkthrough...", 然后选择 "Get started with LiteLLM for Copilot Chat"。

> 服务器也可以通过 VS Code 自己的模型管理添加 (模型选择器中的 "Manage Models...")。那些也能用, 但存在于 `servers` 设置之外 - 仪表板会把它们标记为「外部」, 直到你[采用它们](servers.md#外部服务器与采用)。从仪表板开始可以跳过这段弯路。

## 第一次聊天

保存后片刻之内, 服务器的模型就注册好了:

1. 打开 VS Code 的聊天界面: `Ctrl+Alt+I` / `Cmd+Ctrl+I`, 或标题栏中的聊天图标。
2. 打开模型选择器, 在你的服务器标签下选择一个模型 - 在你选择之前, Copilot 一直停留在它的默认模型上。
3. 发送一条消息。

LiteLLM 状态栏项 (右下角) 一眼展示连接状态 - 对勾 (`$(check) LiteLLM`) 表示每个服务器都可达, 其工具提示携带模型数量。如果模型没有出现, 或有什么显示为红色, [故障排除](troubleshooting.md#常见问题)能解决常见情况。

## 接下来做什么

五个配方, 按人们通常需要的顺序排列。每个都展示完整的修复; 链接的页面有深入内容。

### 纠正服务器报告错误的能力

你的网关说某个模型只有 8k 上下文窗口, 但你知道它能接受 131072 个 token? 能力来自服务器, 而你在 `models.capabilities` 中设置的任何值都会覆盖它们:

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "deepseek-r1": { "context_length": 131072, "supports_reasoning": true }
}
```

这个键是精确的: 它只匹配模型 ID `deepseek-r1`, 不匹配其他任何东西。视觉、工具调用和 token 限制的用法相同。详情: [模型: 能力](models.md#能力)。

### 为一个模型家族调整请求参数

你设置的参数会随发往匹配模型的每个请求发送 - 而且只有你设置的参数; 扩展不注入任何自己的默认值:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "*":       { "temperature": 0.7 },   // 每个模型
  "gpt-5*":  { "temperature": 0.3 }    // gpt-5 家族跑得更冷静
}
```

尾部的 `*` 让键成为家族匹配器。每个匹配的键都会应用, 而对每个单独的字段, 最具体的匹配胜出 - 所以 `gpt-5-turbo` 得到 0.3, `claude-4` 得到 0.7。详情: [模型: 参数](models.md#参数)与[模型匹配](models.md#模型匹配)。

### 连接无法列出模型的网关

有些网关提供聊天但没有 `/v1/models`。在条目上声明模型, 并告诉发现机制不要把缺失的终结点当作故障:

```jsonc
{
  "label": "gateway",
  "baseUrl": "https://gateway.internal",
  "auth": { "apiKey": "sk-..." },
  "discovery": {
    "expectedFailures": ["modelListing", "modelInfo"],
    "declared": ["gpt-5", "claude-4-sonnet"]
  }
}
```

声明的模型会像被发现找到一样注册, 服务器保持绿色。详情: [服务器: 声明的模型](servers.md#声明的模型)。

### 设置预算并在耗尽前收到提醒

给条目一个以美元计的预算; 警报和状态栏负责其余部分:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "budget": 50 }
```

在默认的 `usage.alertThresholds` `[0.8, 0.95]` 下, 你会在 $50 的 80% 处收到一条通知, 在 95% 处收到另一条, 用量状态栏项显示支出百分比 - 未超线时是普通样式, 过 80% 后是警告背景, 过 95% 后是错误背景。如果你的密钥本身已带有 LiteLLM 的 `max_budget`, 那么不需要任何条目字段就能工作。一个要求: 支出跟踪需要有数据库支撑的 LiteLLM 服务器 ([要求](usage.md#要求)); 在没有数据库的代理上, 用量界面保持隐藏, `budget` 字段不改变任何东西。详情: [用量: 预算](usage.md#预算)与[警报](usage.md#警报)。

### 查看某个值为什么是这个值

当几个匹配键、一个服务器条目和选择器都有各自的意见时, 靠猜是最慢的办法。打开仪表板的模型标签页, 展开某个模型的检查器: 它们列出每个生效的参数和能力, 以及设置它的确切来源 - 哪个匹配键、哪个服务器条目、服务器自己的报告, 还是 OpenRouter 目录。详情: [模型: 检查器](models.md#检查器)。

## 命令

扩展能按需做的一切都是命令面板命令 (`Ctrl+Shift+P` / `Cmd+Shift+P`, 然后输入 "LiteLLM"):

| 命令 | 作用 |
|---------|--------------|
| Manage LiteLLM Provider | 中心菜单: 管理服务器和模型、打开仪表板、运行诊断 |
| LiteLLM: Open Dashboard | [仪表板](dashboard.md)面板: 服务器、模型、用量和设置集中一处 |
| LiteLLM: Test Connection | 连接每个服务器并报告模型数量或确切的错误 |
| LiteLLM: Sync Models Now | 立即刷新模型列表, 绕过发现缓存 |
| LiteLLM: Show Diagnostics | 打开仪表板的诊断标签页: 每服务器连接状态、模型数量、错误, 以及上次检查时间 |
| LiteLLM: Set Server Secret | 把服务器的 API 密钥、OAuth 客户端密钥或虚拟密钥存入[密钥存储](servers.md#密钥与密钥存储) |
| LiteLLM: Refresh Usage Now | 立即获取支出和预算数据, 不受轮询间隔约束 |
| LiteLLM: Refresh OpenRouter Catalog | 按需刷新能力目录 ([模型](models.md#能力)) |
| LiteLLM: Report Issue | 打开预填好的 GitHub Issue; 见[它收集什么](troubleshooting.md#报告问题) |
| LiteLLM: Help & Feedback | 文档、Bug 报告和功能请求的快捷入口 |
