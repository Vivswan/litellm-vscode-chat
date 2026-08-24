# 快速入门

[English](../getting-started.md) | 简体中文 | [繁體中文](../zh-tw/getting-started.md)

安装扩展, 把它指向一个 LiteLLM 代理, 它的模型就会出现在 GitHub Copilot Chat 的模型选择器中。本页把这条路径从头到尾走一遍, 然后给出一组简短配方, 覆盖最常见的后续步骤。

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

这些配方按人们通常需要的顺序排列。每个都展示完整的修复; 链接的页面有深入内容。

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

### 在聊天中使用你自己代理的 MCP 工具

如果你的 LiteLLM 服务器通过 Model Context Protocol 提供工具, 条目上的一个字段就能让它们在聊天中可用:

```jsonc
{ "label": "prod", "baseUrl": "https://litellm.example.com", "auth": { "apiKey": "sk-..." }, "mcp": true }
```

`true` 使用服务器自身位于 `<baseUrl>/mcp` 的端点; 端点在别处时写 `"mcp": { "url": "..." }`。这些工具会以条目的标签出现在聊天的工具选择器中, 而扩展只在编辑器启动会话的那一刻才附上此条目的凭据 - 与你聊天时用的密钥、虚拟密钥或 OAuth 令牌相同 - 绝不更早。详情: [服务器: MCP 工具](servers.md#mcp-工具)。

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

### 用你自己的模型生成拉取请求描述

与上一个配方相同的两个设置, 只是换了键名:

```jsonc
"litellm-vscode-chat.prGeneration.enabled": true,
"litellm-vscode-chat.prGeneration.model": { "server": "local", "model": "gpt-4o-mini" }
```

关闭时命令保持隐藏, 也不会发出任何请求; 仪表板中显式的「测试模型」按钮是唯一的例外, 它在你点击时发送一个固定的样本分支, 无论功能是否启用。启用后, 命令面板会新增 "LiteLLM: Generate Pull Request Description"。它会判断你的分支将被合入哪个分支, 从两者的合并基点开始比较, 并把该分支的提交消息以及每个改动文件的一份补丁发送给该模型; 起草的标题和描述会复制到剪贴板。

请求有固定上限: 最多 20 条提交消息和 100 个改动文件, 合并后的补丁在 120,000 个字符处截断。合并提交会被排除, 而分支上已跟踪文件的未提交改动会被包含在内, 因为它们也属于该描述要覆盖的内容 (未跟踪文件不在其中: git 不会对它们做差异比较)。过长的提交列表会从中间削减, 因此首尾的提交始终会一同发送; 字符预算按需分配: 短消息只取它所需要的, 余量留给长消息, 因此不会为了另一端而砍掉列表的某一端。

若已安装 GitHub Pull Requests 扩展, 此功能还会在其中注册为 "Generate with LiteLLM", 于是它的 Create Pull Request 视图中的生成按钮可以直接填入标题和描述, 无需经过剪贴板。

该扩展会把请求交给第一个在它那里注册的生成器, 因此当 Copilot 自己的生成器也已安装时, 由谁作答是那个扩展的选择, 而不是我们的; 命令面板中的命令始终使用你的 LiteLLM 模型。在那条路径上由该扩展组装上下文, 发送的内容也比命令面板中的命令更多: 你仓库的拉取请求模板, 以及提交中引用的每个议题的标题与正文 (包括私有议题)。

有四种仓库状态属于提示而非失败: 没有已检出的分支; VS Code 无法为其确定基础分支的分支 (请设置它的上游分支, 或推送它); 与基础分支持平的分支; 以及基础分支解析为其自身上游的分支 (请检出你真正想要的特性分支)。

隐私与提交消息配方一致: 分支名、该分支的提交消息和补丁只在你显式调用时发送到你配置的 LiteLLM 服务器, 请求计入与其他请求相同的[用量跟踪与预算警报](usage.md)。在进度通知上取消, 会在发送任何内容之前停止这次收集。

### 用 LiteLLM 模型获得内联补全

编辑器里的幽灵文本, 由你自己代理上的模型写出。两个设置即可开启 - 选择加入开关和显式的模型选择, 与上一个配方相同的 `{ "server", "model" }` 形状:

```jsonc
"litellm-vscode-chat.inlineCompletions.enabled": true,
"litellm-vscode-chat.inlineCompletions.model": { "server": "local", "model": "qwen2.5-coder-fim" },
"litellm-vscode-chat.inlineCompletions.languageFilter": { "mode": "block", "languages": ["markdown", "plaintext"] }
```

没有需要运行的命令: 这个功能完全由设置驱动。关闭时不注册任何内容, 也不会自动发出请求 (唯一的例外是仪表板上显式的「测试模型」按钮, 无论功能是否开启, 点击都会发送一次探测请求); 开启但没有指定模型时, 功能保持闲置。

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

### 用 @litellm 聊天

在聊天视图里输入 `@litellm` 然后提问。与上面的配方不同, 这个功能已经开着 - 它默认启用, 在你调用之前没有任何开销 - 所以唯一的设置是关掉它的那个:

```jsonc
"litellm-vscode-chat.chatParticipant.enabled": false
```

它使用**聊天模型选择器当前选中的那个模型**作答, 这就是它全部的模型策略: 没有另外的模型设置要填, 而把选择器指向你的某个 LiteLLM 模型, 正是让回答来自你自己代理的方式。每一轮都是一次普通的聊天请求, 因此请求只会去到那个模型所在的地方, 不会去别处 - 选中你自己的 LiteLLM 模型, 它就走你自己的服务器, 并和其他聊天一样计入[用量跟踪与预算警报](usage.md); 若选中的是内置的 Copilot 模型, 这一轮就像该模型一贯的那样发往 Copilot。无论哪种情况, 这都没有增加聊天本来就没有的数据外发路径。

它自带五个斜杠命令。`/tests`、`/docs`、`/fix` 和 `/explain` 会在你的文本前面加上一段固定指令再发给模型 - 后两个正是[快速修复](#修复或解释一条诊断)替你送出的内容, 你自己手动输入同样有效。`/models` 是个例外: 它只用扩展已经知道的信息作答, 列出每个已连接服务器及其模型、上下文窗口, 以及工具与图像支持情况, 完全不访问网络 - 想拿到确切的原始模型 ID 贴进 `servers` 条目或某个功能的模型设置时, 这是最快的办法。

你附加的内容会一起送出: 编辑器中的选区、当前打开的文件, 以及你添加的每个 `#file:` 都会被读取并附在你的文本下方, 因此「为这个写测试」指的就是你眼前的代码。附件总量上限为 4 万个字符, 被截断或被省略的部分都会明确标注, 不会被当作完整内容送出。

提问时留空提示词, 它会列出这些命令, 而不是发出一个空请求 - 只打开一个文件并不构成一个问题。先前的对话轮次会作为上下文一起带上, 总量上限 8 万个字符, 最旧的消息先被丢弃, 因此长对话始终有界, 而且任何一条消息都不会被从中间截断。

### 让代理向第二个模型提问

Copilot 的代理模式通过工具工作, 而这个工具交给代理一个第二意见: 你自己代理上的一个模型, 它可以在任务进行中向其提问。当你想让另一个模型帮忙核查一个方案、一个诊断, 或者一段你不太确定的论证时, 它很有用。两个设置即可开启, 形状与上面的配方相同:

```jsonc
"litellm-vscode-chat.consultTool.enabled": true,
"litellm-vscode-chat.consultTool.model": { "server": "local", "model": "gpt-4o-mini" }
```

两半都是必需的。开关打开但未选择模型时, 不会注册任何内容, 代理根本看不到这个工具。两者都设置后, 「咨询 LiteLLM 模型」会加入代理模式的工具列表, 你也可以在提示中用 `#litellmConsult` 单独指向它。

**由代理决定何时调用它**, 这是启用前需要权衡的部分。这正是它是工具而非命令的原因: 一旦开启, 代理可以自行发起咨询, 发送它认为另一个模型需要的问题和背景。工具本身是只读的 - 它向模型提问并把答案作为文本返回, 无法读取文件、运行命令或改动任何东西 - 但发送的文本由代理选择, 而不是你。

不会自动附带任何内容。被咨询的模型只拿到代理写进这次调用的东西 - 问题和可选的 `context` - 而不是你的聊天历史、打开的文件或工作区本身。这一点要读准: 代理被明确要求把相关的代码、错误和背景放进 `context`, 因此它从你的工作区读到的材料可能出现在那里。到达对方模型的, 就是代理选择写下的内容, 仅此而已。

外发提示上限为 60,000 个字符, 与提交配方的 diff 上限一样是固定值; 超出后先裁上下文, 并带上标记让被咨询的模型知道有内容被截断, 只有在上下文已经没有之后, 问题才会被缩短。返回时, 回复会被裁剪进调用方模型声明的 token 预算, 同样带标记。请求与聊天一样受 `chat.timeout` 设置约束, 且不发送 `max_tokens`, 因此答案的长度由被咨询模型自己的默认值决定。

隐私上, 这与聊天是同一个信任边界 - 你自己的服务器, 没有第三方 - 但与内联补全一样, 少了你逐次请求的动作, 而且由代理而不是你决定发送什么, 这也正是它默认关闭并要求显式指定模型的原因。代理写的问题和上下文会发往你为该工具指定的 LiteLLM 服务器, 这些请求同样计入现有的[用量与支出跟踪和预算警报](usage.md)。仪表板的「测试模型」按钮是唯一的例外: 它在你点击时发送一个固定的小问题, 绝不发送你的任何内容。

### 让模型评审你的代码

模型读你的代码, 并在相关的行上留下评论, 用的正是拉取请求评审那套会话界面。两个设置把它打开 - 选择加入, 以及一个显式的模型选择, 与上面几个配方相同的 `{ "server", "model" }` 形状:

```jsonc
"litellm-vscode-chat.reviewComments.enabled": true,
"litellm-vscode-chat.reviewComments.model": { "server": "local", "model": "gpt-4o-mini" }
```

之后由两个命令决定读什么, 你每次调用时自己选:

- **LiteLLM: Review Changes** 评审一个仓库里所有未提交的内容 - 已暂存和未暂存的一起, 每个文件一个请求。源代码管理标题栏的闪光按钮也运行它。未跟踪的文件不包含在内: git 对它们没有差异, 请用另一个命令评审。
- **LiteLLM: Review This File** 评审你正在看的那个文件的全部内容, 无论 git 是否知道它。

两者运行期间都可取消, 也都有边界: 一次改动评审最多发送 20 个文件 (通知会说明它省略了多少), 每个请求最多携带 80,000 个字符的差异或文件内容。

评论以锚定到行范围的会话形式出现, 而会话是对话, 不是判决:

- 在会话里**回复** (Reply), 模型会在那里作答, 并把锚定的那些行引用回给它 - 所以「不, `values.length` 就是数量」得到的是真正的答复, 而不是同一条评论的重复。
- 对处理完的用**解决** (Resolve), 改主意了用**取消解决** (Unresolve), 不同意的用**删除评审会话** (Delete Review Thread)。
- 再次评审一个文件会替换该文件中由模型撰写的评论, 所以第二遍绝不会堆叠重复项, 现在读起来干净的文件也会失去它们。你回复过的会话, 以及你自己发起的会话都会保留 - 那是你的话, 不是这次评审的。
- 你也可以从边栏在文件任意位置开启自己的会话, 直接就那些行提问。

会话按工作区保存, 重新打开工作区时会回来, 包括你没有打开过的文件。它们会回到当初撰写时对应的那些行: 文件打开期间编辑器会让会话跟着它的代码走, 但如果文件在这期间被改动过, 恢复出来的评论可能会偏几行 - 重新跑一次评审即可。关闭功能只是把评论从屏幕上拿走, 不会抹掉它们; 重新打开就会回来。文件已不存在的会话会在后台被丢弃。

有三件事评审不会悄悄做。有未保存改动的文件会被排除在改动评审之外 - 差异来自磁盘上的内容, 因此它的评论会落到模型根本没看过的行上 - 通知会提示你先保存, 再单独评审该文件。如果某个文件在它的评审进行中被改动, 出于同样的原因它的结论会被丢弃, 通知同样会说明。如果模型回的根本不是一份评审, 那个文件会保留它原有的评论, 而不会被当作「读起来干净」而清空。

隐私: 每个被评审文件的差异 - 或在文件模式下该文件的全部内容 - 会在你显式调用时发往你为它配置的 LiteLLM 服务器, 同时带上该文件相对工作区或仓库的路径 (两者都不属于时只带文件名, 因此不会发出绝对路径), 文件模式下还有它的语言标识符。回复会发送该会话的对话以及它锚定的那些行。

没有任何内容会被自动评审; 仪表板的「测试模型」按钮是你唯一能在不做评审的情况下发出的请求, 它只发送一小段固定的示例差异, 从不发送你的文件。这些请求同样计入现有的[用量跟踪与预算警报](usage.md)。

### 修复或解释一条诊断

打开快速修复, 并挑一个在聊天视图无法打开时作答的模型:

```jsonc
"litellm-vscode-chat.quickFix.enabled": true,
"litellm-vscode-chat.quickFix.model": { "server": "Team proxy", "model": "gpt-4o-mini" }
```

此后任何一条波浪线 - 编译器错误、代码检查警告, 或者任何扩展报告的问题 - 都会多出两个灯泡条目: **用 LiteLLM 修复**和**用 LiteLLM 解释**。选中其中之一, 会打开聊天视图并**直接发送** `@litellm /fix`(或 `/explain`), 后面跟着诊断消息, 并附上出问题的那几行代码; 因此答案来自**聊天选择器当前选中的那个模型** - 你选了自己的模型就是你的, 否则就是内置的 Copilot 模型 - 并落在一个你可以继续追问的对话里。你只是查看灯泡时不会发出任何请求; 请求发生在你选中某个操作时。

灯泡只出现在已保存的文件上。未保存缓冲区里的代码无法附加到聊天轮次上, 而让模型去修复它看不见的诊断比不提供更糟, 所以请先保存文件。

一个操作在该位置最多认领五条诊断, 严重的优先(错误排在警告前面), 并附上它们所在的行以及上下各两行。

`quickFix.model` 设置是后备路径, 不是主路径: 只有在聊天视图无法作答时才会用到 - 没有安装聊天扩展, 它被禁用或出故障, 或者 `@litellm` 参与者本身被关闭或注册被拒绝。

这时同样的问题 - 「修复」要的是修正后的代码, 「解释」要的是解释, 与聊天路径完全一致 - 会作为一次请求发给那个模型, 答案会在一个新的未命名 markdown 编辑器中打开, 你可以阅读后关掉; 任何内容都不会被写进你的文件。如果你有聊天视图, 不设这个模型也没问题 - 只是在少数会走后备路径的场合, 你得到的是一条提示而不是答案。仪表板上该行的「测试模型」按钮只发送一小段固定代码, 绝不发送你的代码。

隐私: 两条路径都会把诊断消息和附上的代码行送出你的机器 - 走聊天路径时发往选择器指定的模型 (除非你选了自己的模型, 否则就是内置的 Copilot 模型), 并且像任何聊天轮次一样带上该对话先前的轮次; 走后备路径时发往 `quickFix.model` 背后的服务器。

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
| LiteLLM: Generate Pull Request Description | 根据你的分支起草拉取请求标题和描述并复制到剪贴板 (选择加入; 见[配方](#用你自己的模型生成拉取请求描述)) |
| LiteLLM: Review Changes | 评审一个仓库里所有未提交的改动, 并在相关的行上留下评论 (选择加入; 见[配方](#让模型评审你的代码)) |
| LiteLLM: Review This File | 评审你正在看的那个文件的全部内容, 并在相关的行上留下评论 (同一个选择加入) |
| LiteLLM: Report Issue | 打开预填好的 GitHub Issue; 见[它收集什么](troubleshooting.md#报告问题) |
| LiteLLM: Help & Feedback | 文档、Bug 报告和功能请求的快捷入口 |
