# 快速入门

[English](../getting-started.md) | 简体中文 | [繁體中文](../zh-tw/getting-started.md)

安装扩展, 把它指向一个 LiteLLM 代理, 它的模型就会出现在 GitHub Copilot Chat 的模型选择器中。本页把这条路径从头到尾走一遍, 然后给出七个简短配方, 覆盖最常见的后续步骤。

## 要求

- **VS Code 1.129.0 或更高版本**, 已安装并登录 GitHub Copilot Chat 扩展。本扩展接入的是 Copilot 的聊天视图, 没有它就没有聊天界面, 也没有模型选择器。如果你的 Copilot 席位来自组织 (Copilot Business 或 Enterprise), 组织还必须启用 GitHub 的「Bring your own language model key」策略 - 没有它, 即使这里的每项诊断都报告已连接, Copilot 也会隐藏来自本扩展这类提供程序扩展的模型。
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
   - **基础 URL** - 服务器的根 URL, 例如 `http://localhost:4000`。扩展会自行追加 `/v1`; 若 URL 已以 `/v1` 或 `/v2` 这样的版本段结尾, 则按原样使用。
   - **身份验证** - 恰好一种形式: API 密钥 (最常见的情况)、OAuth 客户端凭据, 或自定义标头中的密钥。对于密钥, 表单的「存储位置:」选择默认为「密钥存储」, 把它放进 VS Code [密钥存储](servers.md#密钥与密钥存储)而不是你的设置文件 - 这是任何你不会提交到仓库的值的正确选择; 「设置 (明文可见)」则把它写进 settings.json。
4. 单击**测试连接**。它会按当前输入原样探测草稿, 在保存任何东西之前, 回答模型数量或确切的错误。
5. 单击**保存**。

表单写入的是 `litellm-vscode-chat.servers` 设置, 因此同一个服务器在 settings.json 中就是一个条目:

```jsonc
"litellm-vscode-chat.servers": [
  {
    "label": "prod",
    "baseUrl": "http://localhost:4000",
    "auth": { "apiKey": "sk-..." }   // 或省略此字段, 把密钥放在密钥存储中
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

七个配方, 按人们通常需要的顺序排列。每个都展示完整的修复; 链接的页面有深入内容。

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

尾部的 `*` 让键成为家族匹配器。默认情况下, 最具体的匹配记录整体胜出 - 所以 `gpt-5-turbo` 得到 0.3, `claude-4` 得到 0.7; 更宽泛记录的字段只有标记了 `_inheritable` (或用 `_inherit_from` 显式引入) 才会作用到更具体的匹配上。详情: [模型: 参数](models.md#参数)与[模型匹配](models.md#模型匹配)。

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

给条目一个以服务器计费货币计的预算; 警报和状态栏负责其余部分:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "budget": 50 }
```

在默认的 `usage.alertThresholds` `[0.8, 0.95]` 下, 你会在 $50 的 80% 处收到一条通知, 在 95% 处收到另一条, 用量状态栏项显示支出百分比 - 未超线时是普通样式, 过 80% 后是警告背景, 过 95% 后是错误背景。如果你的密钥本身已带有 LiteLLM 的 `max_budget`, 那么不需要任何条目字段就能工作。一个要求: 支出跟踪需要有数据库支撑的 LiteLLM 服务器 ([要求](usage.md#要求)); 在没有数据库的代理上, 用量界面保持隐藏, `budget` 字段不改变任何东西。详情: [用量: 预算](usage.md#预算)与[警报](usage.md#警报)。

### 查看某个值为什么是这个值

当几个匹配键、一个服务器条目和选择器都有各自的意见时, 靠猜是最慢的办法。打开仪表板的模型页面, 对某个模型点「检查」: 面板列出每个生效的参数和能力, 以及设置它的确切来源 - 哪个匹配键、哪个服务器条目、服务器自己的报告, 还是 OpenRouter 目录。详情: [模型: 检查器](models.md#检查器)。

### 用你自己的模型生成提交消息

两个设置即可开启 - 选择加入开关和显式的模型选择 (`servers` 条目的标签加上它的一个原始模型 ID):

```jsonc
"litellm-vscode-chat.commitGeneration.enabled": true,
"litellm-vscode-chat.commitGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

源代码管理标题栏会出现一个闪光按钮, 命令面板也会新增 "LiteLLM: Generate Commit Message"。两者都会把你已暂存的差异 (未暂存任何内容时则是工作区差异加上未跟踪文件名) 发送给该模型, 并把起草的消息写入提交框。你最近五条提交主题会作为风格示例一同发送, 因此草稿会遵循你仓库的惯例。请求有固定上限: 差异在 80,000 个字符处截断, 未跟踪路径最多列出 100 条, 其余以数量标注代替。

这与把 Copilot 自己的 `chat.utilitySmallModel` 槽位指向 LiteLLM 模型 ([Copilot 模型槽位](models.md#copilot-模型槽位)) 不同: 它不需要 Copilot 订阅, 指令文本由你修改, 风格示例来自你仓库的历史。内置指令如下 (面向模型的文本, 保持英文), `litellm-vscode-chat.commitGeneration.prompt` 中的任何内容都会整体替换它:

```text
Write a commit message for the change in the diff below.
Use the Conventional Commits form: one subject line like "type(scope): summary" (types such as feat, fix, docs, refactor, test, chore), at most about 72 characters, in the imperative mood.
When the change needs explanation, add a blank line and a short body of one to three sentences saying what changed and why.
Answer with the commit message text only: no markdown fences, no surrounding quotes, no commentary.
```

隐私和成本与聊天一致: 差异、未跟踪文件名和你最近五条提交主题只在你显式调用时发送到你配置的 LiteLLM 服务器, 请求计入与其他请求相同的[用量跟踪与预算警报](usage.md)。

### 用 LiteLLM 模型获得内联补全

编辑器里的幽灵文本, 由你自己代理上的模型写出。两个设置即可开启 - 选择加入开关和显式的模型选择, 与上一个配方相同的 `{ "server", "model" }` 形状:

```jsonc
"litellm-vscode-chat.inlineCompletions.enabled": true,
"litellm-vscode-chat.inlineCompletions.model": { "server": "local", "model": "qwen2.5-coder-fim" },
"litellm-vscode-chat.inlineCompletions.languageFilter": { "mode": "block", "languages": ["markdown", "plaintext"] }
```

没有需要运行的命令: 这个功能完全由设置驱动。关闭时不注册任何内容, 也不会自动发出请求 (唯一的例外是仪表盘上显式的「测试补全」按钮, 无论功能是否开启, 点击都会发送一次探测请求); 开启但没有指定模型时, 功能保持闲置。

**要选补全模型, 不是聊天模型。** 内联补全 POST 到 `/v1/completions`, 因此模型必须是你的 LiteLLM 服务器在 `model_info` 中声明为 `mode: completion` 的那种 - 一个中间填充 (FIM) 模型。这类模型有意不出现在聊天模型选择器里, 所以模型 ID 要从代理的配置里取, 而不是从选择器里取。

还有一个设置决定它在哪里运行。`inlineCompletions.languageFilter` 保存一个模式加精确的 VS Code 语言 ID: `"block"` 表示补全在列出的语言之外的所有语言中运行, `"allow"` 表示仅在列出的语言中运行 (允许列表为空则不在任何语言中运行)。你不必手动编辑它: 功能启用后, 编辑器的 `{}` 语言状态菜单 (右下角) 会出现一行「LiteLLM inline suggestions」, 其开关会替你把当前语言写进这个过滤器。

请求的形状是固定的, 不可调节: 光标之前最多 8000 个字符 (从左侧截断)、之后最多 4000 个字符, 停止输入 200 毫秒后才发出请求, `max_tokens` 为 256, 超时 15 秒。一个小的内存缓存让相同的上下文不会被问第二次。失败按设计静默 - 超时、401 或格式错误的响应都只是不出现建议, 绝不会弹窗打断你输入。

在你想用匹配键之前有一条规则要知道: `models.parameters` 记录不适用于内联补全和提交消息生成请求。唯一的例外是 `_fim_template` 指令, 它塑造 FIM 提示, 并且从不发送到服务器。当你的后端没有原生的中间填充处理、需要把两半内容拼进一个提示时使用它:

```jsonc
"litellm-vscode-chat.models.parameters": {
  "qwen2.5-coder-fim": { "_fim_template": "<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>" }
}
```

模板生效时, 提示由模板构建, 线路上的 `suffix` 字段被省略; 缺少 `{prefix}` 或 `{suffix}` 占位符的值会退回到普通的 prompt 加 suffix 请求体。参考: [设置: 记录指令](settings.md#记录指令)。

隐私这一段值得读两遍: 内联补全会在你输入时自动把光标周围的文件内容发送到你配置的 LiteLLM 服务器。这与聊天是同一个信任边界 - 你自己的服务器, 没有第三方 - 但少了你逐次请求的动作, 这也正是该功能默认关闭并要求显式指定模型的原因。这些请求走与其他请求相同的服务器连接, 因此同样计入现有的[用量与支出跟踪和预算警报](usage.md)。

## 命令

扩展能按需做的一切都是命令面板命令 (`Ctrl+Shift+P` / `Cmd+Shift+P`, 然后输入 "LiteLLM"):

| 命令 | 作用 |
|---------|--------------|
| Manage LiteLLM Provider | 中心菜单: 管理服务器和模型、打开仪表板、运行诊断 |
| LiteLLM: Open Dashboard | [仪表板](dashboard.md)面板: 服务器、模型、用量和设置集中一处 |
| LiteLLM: Test Connection | 连接每个服务器并报告模型数量或确切的错误 |
| LiteLLM: Sync Models Now | 立即刷新模型列表, 绕过发现缓存 |
| LiteLLM: Show Diagnostics | 打开仪表板的诊断区块: 每服务器连接状态、模型数量、错误, 以及上次检查时间 |
| LiteLLM: Set Server Secret | 把服务器的 API 密钥、OAuth 客户端密钥或虚拟密钥存入[密钥存储](servers.md#密钥与密钥存储) |
| LiteLLM: Refresh Usage Now | 立即获取支出和预算数据, 不受轮询间隔约束 |
| LiteLLM: Refresh OpenRouter Catalog | 按需刷新能力目录 ([模型](models.md#能力)) |
| LiteLLM: Export Settings... | 把扩展的设置保存为 JSON 文件, 明确选择包含还是不含存储的密钥 |
| LiteLLM: Import Settings... | 合并之前导出的设置文件, 每个冲突的服务器都会询问 |
| LiteLLM: Undo Last Settings Import | 把设置和密钥恢复到上次导入前的状态 |
| LiteLLM: Generate Commit Message | 根据你已暂存的更改起草提交消息并填入源代码管理输入框 (选择加入; 见[配方](#用你自己的模型生成提交消息)) |
| LiteLLM: Report Issue | 打开预填好的 GitHub Issue; 见[它收集什么](troubleshooting.md#报告问题) |
| LiteLLM: Help & Feedback | 文档、Bug 报告和功能请求的快捷入口 |
