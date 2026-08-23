# 设置

[English](../settings.md) | 简体中文 | [繁體中文](../zh-tw/settings.md)

每个 `litellm-vscode-chat.*` 设置和每个服务器条目属性的查询参考: 名称、默认值、一段话的行为说明, 以及完整故事在哪里。要*学习*概念, 请改读支柱页面: [服务器](servers.md)、[模型](models.md)、[用量](usage.md)。

## 设置如何工作

两种等价的编辑方式:

- **设置 UI / settings.json** - `Ctrl+,` / `Cmd+,`, 搜索 "litellm-vscode-chat"。设置分组为几个区块 (服务器、模型、聊天、发现、用量、UI、内联补全、提交消息生成)。
- **仪表板** - "LiteLLM: Open Dashboard", 设置区块。同样的值以表单控件呈现, 验证、单位和默认值就地显示; 已配置的行说明其值存放在哪里, 「重置」清除该作用域。见[仪表板](dashboard.md)。

| 事实 | 细节 |
|---|---|
| 作用域 | `servers` 是机器作用域的: 仅限用户设置, 永远不能被工作区覆盖, 也永远不由 Settings Sync 携带。工作区 `.vscode/settings.json` 中的 `servers` 值会被 VS Code 自己忽略 (设置编辑器会说它只能应用于用户设置)。其他每个设置都像普通的用户/工作区设置一样工作并正常同步。 |
| 生效 | 更改立即应用 - 无需重新加载。影响模型的更改会刷新模型列表; 用量更改会重接轮询器; 超时更改应用于下一个请求。外观设置也一样: 打开着的仪表板会在 `ui.theme` 或 `ui.accent` 变化的那一刻换装, 无论更改来自仪表板自己的选择器还是 settings.json。 |
| 迁移 | 旧版本的设置在升级时自动重命名和重构; 见[重命名表](#重命名与移除的设置)。无需重新输入任何东西。当新名称的设置已经有值时 (比如 Settings Sync 先从已升级的机器送来了它), 迁移保留它, 只丢弃旧键 - 服务器 URL 限定键有一条注意事项 ([作用域说明](#重命名与移除的设置))。 |
| 未知键 | 扩展未声明的 `litellm-vscode-chat.*` 键 (打错字, 比如 `chat.timout`) 会被忽略, VS Code 的设置编辑器会在 settings.json 中把它标为未知设置。[重命名](#重命名与移除的设置)之后的旧名称同理。 |

## 导出与导入

Settings Sync 有意跳过这里最要紧的部分 - `servers` 是机器作用域的, 密钥存储中的值也从不同步 - 所以把配置搬到另一台机器有自己的一对命令。仪表板的设置区块以「导入与导出」按钮承载它们; 命令或按钮, 流程相同。

- **"LiteLLM: Export Settings..."** 把你在用户设置中配置过的每个 `litellm-vscode-chat.*` 设置写入一个 JSON 文件 (默认 `~/litellm-settings.json`)。先有一个关于密钥的提问: 「包含密钥」把密钥存储中的值复制进各自的服务器条目, 文件因此完整 - 但这些凭据以明文写入文件, 请谨慎保存和分享; 「不含密钥」则剥除每个密钥值, 内联的也一样, 文件不携带任何凭据 (自定义[标头](servers.md#自定义标头)值是普通设置, 不是密钥, 会留在文件里; 导入后重新输入凭据)。
- **"LiteLLM: Import Settings..."** 把这样的文件合并回来。在你确认预览之前什么都不写 (哪些设置会被写入、多少服务器冲突、文件携带多少密钥值); 每个已存在的服务器标签都会询问怎么办: 「覆盖」就地替换条目及其存储的密钥 - 当这改变连接设置 (基础 URL、凭据) 时, 已同步的提供程序组无法就地接收它们, 服务器在仪表板中的行会显示重连步骤 ([生命周期](servers.md#生命周期-重命名删除与隐藏的组)), 预览也会提前标出这类覆盖 - 「跳过」保留你的条目, 「重命名后导入」以新标签添加传入的条目。不冲突的服务器被追加, 其他设置整体写入, 文件中的密钥值进入 VS Code 密钥存储, 而不是你的设置文件。导入服务器会彻底替换该标签存储的密钥 - 不带密钥的文件让导入的条目处于无凭据状态, 而不是拾取同名旧服务器遗留的值。关闭任何提示都会中止整个导入, 什么都不写。
- **"LiteLLM: Undo Last Settings Import"** 把设置和存储的密钥恢复到导入前的状态 - 整体恢复, 所以导入之后对受影响键的编辑也会被回滚; 恢复前会先弹出确认, 说明快照的记录时间。只有一个槽位: 每次导入都替换它, 导入完成的通知带有「撤销导入」按钮, 运行的是同一个命令。

文件是带版本的信封 (其中的设置键去掉 `litellm-vscode-chat.` 前缀), 所以来自更新版本扩展的文件会被拒绝并提示更新, 而不是导入一半:

```jsonc
{
  "litellm-vscode-chat": 1,          // 格式版本和文件判别符
  "exportedBy": "0.4.5",             // 仅供参考
  "settings": { "servers": [ /* ... */ ] }
}
```

## 参考

| 设置 | 默认值 | 行为 |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | 声明的 LiteLLM 服务器; [条目属性见下](#服务器条目属性), 完整故事在[服务器](servers.md) |
| `litellm-vscode-chat.models.parameters` | `{}` | 按模型的请求参数, 以[匹配器](models.md#模型匹配)为键。只发送你设置的。完整故事: [模型 - 参数](models.md#参数) |
| `litellm-vscode-chat.models.capabilities` | `{}` | 按模型的能力覆盖, 以[匹配器](models.md#模型匹配)为键: token 限制、视觉、工具、推理、定价 - 任何 `model_info` 字段, 认识与否皆可; 词汇表是开放的。完整故事: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.models.openRouterCatalog` | `true` | 用每周刷新的 OpenRouter 公开目录快照填补缺失的能力; 手动刷新用 "LiteLLM: Refresh OpenRouter Catalog"。详情含隐私说明: [模型 - 能力](models.md#能力) |
| `litellm-vscode-chat.chat.timeout` | `300000` | 单次聊天补全调用, 以及单次提交消息生成、拉取请求描述生成、咨询工具、快速修复或评审评论调用的硬性时间预算, 毫秒。聊天请求从不重试, 所以这是一个请求可占用的总时间, 含流式传输。最小 1000; 更低的值会被钳制。为长推理运行或缓慢的基础设施调大它 |
| `litellm-vscode-chat.chat.maxToolsPerRequest` | `128` | 一次聊天请求最多可携带的工具数, 超过时扩展在本地拒绝该请求而不发送 (多数 OpenAI 兼容服务器强制 128)。调大到超出你的服务器或模型接受的范围, 只会把失败移到服务器端: 请求会被发送, 然后被服务器拒绝。最小 1 |
| `litellm-vscode-chat.chat.additionalToolSchemaKeywords` | `[]` | 工具输入 schema 中额外保留的 JSON-Schema 关键字, 例如 `["propertyNames"]`。发送前工具 schema 会按内置关键字白名单清理; 此处列出的关键字也会保留, 其值原样透传。内置白名单始终生效。服务器或模型不接受的关键字可能导致请求失败或工具调用变差 |
| `litellm-vscode-chat.chat.promptCaching` | `true` | 在宣布支持的模型上, 跨会话轮次复用提供方侧的提示缓存; [详情见下](#提示缓存) |
| `litellm-vscode-chat.chat.tokenEstimation` | `"auto"` | 本地 token 预算如何估算提示大小: `"auto"` (识别文字系统的启发式, 在 VS Code 显示语言不是英语, 或聊天中含足够多让纯字符计数低估的文本 - CJK 等非拉丁文字、emoji - 时加载 o200k_base 分词器)、`"heuristic"` (纯粹按每 4 字符 1 token 计, 从不加载分词器数据, 对 CJK 低估约 4 倍)、`"o200k_base"` 或 `"cl100k_base"` (始终加载该分词器)。加载的分词器在活跃期间约占用 10-30 MB 内存; 计数开销可忽略 |
| `litellm-vscode-chat.discovery.timeout` | `30000` | 每个模型发现请求的硬性时间预算, 毫秒, 含该请求的重试。模型信息列表、`/v1/models` 回退和 OAuth 令牌交换各自获得一份新预算, 所以一轮发现最长可能耗时到它们之和。最小 1000 |
| `litellm-vscode-chat.discovery.cacheTtl` | `3600000` | 已发现的模型列表复用多久, 毫秒。VS Code 重新解析提供程序很频繁 (有时一秒好几次); 缓存把那挡在你的服务器之外。`0` 表示每次都新取 (负值钳制为 `0`); 失败从不缓存; 同时发生的刷新共享一个请求; "LiteLLM: Sync Models Now" 绕过它 |
| `litellm-vscode-chat.discovery.staleServeWindow` | `600000` | 服务器停止响应后, 其最后已知的模型继续提供 (标记为过期) 的时长, 毫秒, 从最后一次成功发现起算。若服务器休眠或重启超过十分钟, 可调大它; `0` 表示从不提供过期模型 (刷新失败立即清空该服务器的列表)。详情: [模型 - 发现](models.md#发现) |
| `litellm-vscode-chat.usage.pollInterval` | `300000` | 后台支出/预算轮询节奏, 毫秒。`0` = 关闭: 没有后台请求, 没有警报; 仪表板打开时只在一次获取到期时才获取 (本次会话还没有完成过获取、距上一次获取已超过五分钟, 或 `servers` 设置有变更)。低于 `30000` 的非零值向上钳制到 30 秒。完整故事: [用量](usage.md) |
| `litellm-vscode-chat.usage.initialRefreshDelay` | `5000` | 扩展启动后多久运行首次用量轮询, 毫秒 |
| `litellm-vscode-chat.usage.serversChangeRefreshDelay` | `2000` | `servers` 设置变更后多久刷新用量数据, 毫秒; 足以合并 settings.json 中的连续按键 |
| `litellm-vscode-chat.usage.pollingOffFreshnessWindow` | `600000` | 轮询关闭时, 按需获取的用量数据算作新鲜的时长, 毫秒 (轮询开启时, 窗口改为轮询间隔的两倍)。`0` 则从不算新鲜, [状态栏项](usage.md#状态栏)会因此隐藏 |
| `litellm-vscode-chat.usage.alertThresholds` | `[0.8, 0.95]` | 各触发一次警报的预算比例; 每个值在 (0, 1] 内; 空列表 = 关闭警报。完整故事: [用量 - 警报](usage.md#警报) |
| `litellm-vscode-chat.usage.statusBar` | `"always"` | 用量状态栏项: `"always"`、`"alerts-only"`、`"off"`。完整故事: [用量 - 状态栏](usage.md#状态栏) |
| `litellm-vscode-chat.usage.currencySymbol` | `"$"` | 每个支出和价格数字前的前缀, 例如 `"EUR "`。仅用于显示: 金额从不换算, 完全按服务器报告的数值呈现; 空字符串只显示数字 |
| `litellm-vscode-chat.ui.maskSecretInputs` | `true` | 在输入框提示中输入凭据值时进行遮盖。仪表板的密钥字段始终遮盖, 各带自己的「显示」开关, 与此设置无关 |
| `litellm-vscode-chat.ui.theme` | `"auto"` | 仪表板如何着色: `"auto"` 跟随你的 VS Code 主题, `"light"` 和 `"dark"` 在编辑器变化时保持不动。[外观说明见下](#外观) |
| `litellm-vscode-chat.ui.accent` | `"blue"` | 仪表板的强调色: `"blue"`、`"violet"`、`"teal"`、`"amber"`。它标记主要操作、选中、焦点和链接, 仅此而已 - 状态色保持绿、黄、红。[外观说明见下](#外观) |
| `litellm-vscode-chat.inlineCompletions.enabled` | `false` | 选择启用由 LiteLLM 模型提供的内联(幽灵文本)补全, 随内联补全功能一起交付。默认关闭: 启用前不注册任何内容、不发送任何请求, 仪表板中显式的「测试模型」按钮除外; 只启用而不设置 `inlineCompletions.model` 时功能保持闲置 |
| `litellm-vscode-chat.inlineCompletions.model` | `null` | 提供内联补全的模型: `{ "server": "<条目 label>", "model": "<原始模型 ID>" }`, 指向一个 `servers` 条目及其一个模型 ID。模型始终由你显式选择 - 从不自动挑选; `null` 使功能保持闲置 |
| `litellm-vscode-chat.inlineCompletions.languageFilter` | `{"mode":"block","languages":[]}` | 内联补全的运行范围: mode 为 `"block"` 时在列出的 VS Code 语言 ID (精确匹配) 之外的所有语言中运行, `"allow"` 时仅在列出的语言中运行 (允许列表为空则不在任何语言中运行), 例如 `{ "mode": "block", "languages": ["markdown", "plaintext"] }`。默认不屏蔽任何语言 |
| `litellm-vscode-chat.commitGeneration.enabled` | `false` | 选择启用由 LiteLLM 模型生成提交消息, 随提交消息生成功能一起交付。默认关闭: 启用前命令保持隐藏、不发送任何请求; 只启用而不设置 `commitGeneration.model` 时功能保持闲置 |
| `litellm-vscode-chat.commitGeneration.model` | `null` | 起草提交消息的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则 |
| `litellm-vscode-chat.commitGeneration.prompt` | `""` | 生成提交消息时使用的自定义指令, 会整体替换内置指令。留空使用内置指令 (Conventional Commits 主题行加简短正文)。面向模型的文本, 按原样发送 |
| `litellm-vscode-chat.prGeneration.enabled` | `false` | 选择启用由 LiteLLM 模型生成拉取请求标题和描述。关闭时命令保持隐藏、不发送任何请求, 仪表板中显式的「测试模型」按钮除外 ([配方](getting-started.md#用你自己的模型生成拉取请求描述)) |
| `litellm-vscode-chat.prGeneration.model` | `null` | 起草 PR 描述的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则 |
| `litellm-vscode-chat.consultTool.enabled` | `false` | 选择启用咨询工具, 它让聊天代理向第二个 LiteLLM 模型征求意见。默认关闭: 启用前不会注册任何内容, 也不会发送任何请求, 仪表板中显式的「测试模型」按钮除外; 启用但未设置 `consultTool.model` 时, 工具保持未注册。两者都设置后, 代理会自行决定何时调用 |
| `litellm-vscode-chat.consultTool.model` | `null` | 咨询工具询问的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则 |
| `litellm-vscode-chat.quickFix.enabled` | `false` | 在诊断上显示「修复」和「解释」快速修复。两者都会打开聊天视图并把问题直接发送给 `@litellm`, 附上诊断及其所在的行; 聊天视图无法作答时改用 `quickFix.model`。参见[快速修复配方](getting-started.md#修复或解释一条诊断) |
| `litellm-vscode-chat.quickFix.model` | `null` | 仅用于快速修复的后备路径 - 聊天路径使用聊天选择器指定的模型。与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则; `null` 表示后备路径保持闲置 |
| `litellm-vscode-chat.reviewComments.enabled` | `false` | 选择启用对改动的 AI 评审评论。默认关闭; 启用前不存在任何评审会话, 也不会发出任何评审请求, 仪表板中显式的「测试模型」按钮除外 ([配方](getting-started.md#让模型评审你的代码)) |
| `litellm-vscode-chat.reviewComments.model` | `null` | 撰写评审评论的模型; 与 `inlineCompletions.model` 相同的 `{ "server", "model" }` 形状和规则 |
| `litellm-vscode-chat.chatParticipant.enabled` | `true` | @litellm 聊天参与者, 使用聊天请求自身的模型作答 (没有模型设置)。默认开启 |

有意不提供全局标头设置: 自定义 HTTP 标头描述的是如何与某一个服务器交谈, 所以它们存放在服务器条目上 ([`headers`](servers.md#自定义标头)) - 机器作用域, 在 Settings Sync 够不到的地方, 与全局设置不同。

## 服务器条目属性

`litellm-vscode-chat.servers` 的每个条目 (除 `label` 和 `baseUrl` 外全部可选); 每一行的完整故事在[服务器](servers.md):

| 属性 | 类型 | 行为 |
|---|---|---|
| `label` | 字符串 | 服务器的显示名称与标识 (连同 `baseUrl`); 在条目间唯一 - 重复的标签被跳过并报告, 第一个条目胜出。重命名的后果见[生命周期](servers.md#生命周期-重命名删除与隐藏的组) |
| `baseUrl` | 字符串 | 服务器的根 URL; 扩展会自行追加 `/v1`, 除非 URL 已以 `/v1` 或 `/v2` 这样的版本段结尾 (按原样使用) - `apiVersion` 可覆盖两者。路径前缀保留, 尾部斜杠去除 |
| `apiVersion` | 字符串 | 追加到基础 URL 的内容。未设置 = 自动 (`/v1`, 或 URL 中已有的版本段); `""` = 不追加任何内容; `"v2"` = 追加 `/v2` |
| `auth` | 对象 | `apiKey`、`oauth`、`virtualKey` 恰取一种形式 - 伴随凭据按此顺序分级: `oauth` 可带可选的 `apiKey`/`virtualKey` 伴随凭据, `apiKey` 可带可选的 `virtualKey` 伴随凭据, 供检查两个标头的网关使用。含混不清的形态按配置错误报告, 修复前条目不被使用。服务器不需要凭据时整个省略。完整故事: [服务器 - 身份验证](servers.md#身份验证) |
| `headers` | 对象 | 发往此服务器的每个请求上的自定义 HTTP 标头 (路由标签、跟踪); 冲突时扩展管理的身份验证标头胜出。[服务器 - 自定义标头](servers.md#自定义标头) |
| `models.parameters` | 记录 | 只针对此服务器的请求参数; 与全局设置相同的[匹配键](models.md#模型匹配), 逐字段应用在其之上 |
| `models.capabilities` | 记录 | 只针对此服务器的能力覆盖; 机制相同 |
| `discovery.declared` | 字符串数组 | 发现列不出时也要注册的精确模型 ID; [服务器 - 声明的模型](servers.md#声明的模型) |
| `discovery.expectedFailures` | 字符串数组 | 此处预期失败的发现终结点 (`"modelListing"`、`"modelInfo"`): 一次尝试, info 级日志, 不算故障 |
| `budget` | 数字 | 手动预算, 以服务器自身的计费货币计, 大于 0; 在[用量警报](usage.md#预算)中优先于密钥自身的 `max_budget`; 两者都显示 |
| `mcp` | `true` 或对象 | 让此服务器自身的 MCP 工具可在聊天中使用; `true` 发布 `<baseUrl>/mcp`, `{ "url": "..." }` 指定另一个端点 (仅在与条目同源时带上凭据); [服务器 - MCP 工具](servers.md#mcp-工具) |

可作密钥的字段 (`auth.apiKey`、`auth.oauth.clientSecret`、`auth.virtualKey.value`、OAuth 伴随凭据) 可以存放在 VS Code 密钥存储而非设置文件中: [服务器 - 密钥](servers.md#密钥与密钥存储)。

## 记录指令

在 `models.parameters` 或 `models.capabilities` 记录内 (全局或每条目), 以 `_` 开头的键是指令: 给扩展的指示, 从不发送到服务器。未知的 `_` 键被忽略; 其他每个键都是字段 - 两套词汇表都是开放的 ([能力](models.md#能力字段))。

| 指令 | 有效于 | 作用 |
|---|---|---|
| `"_force": true \| ["field", ...]` | `models.parameters` | 把全部/列出的参数字段标记为强制: 它们胜过运行时选项和模型选择器的每模型配置。提供程序拥有的字段 (`model`、`messages`、`stream`、`stream_options`、`tools`、`tool_choice`) 不能强制 - 点名会被报告并跳过。完整故事: [模型 - 参数](models.md#参数) |
| `"_fallback": true \| ["field", ...]` | `models.capabilities` | 把全部/列出的能力字段标记为回退: 它们填补在服务器报告之下, 而不是覆盖它。回退提供的最大输出 token 数算作用户设置 (没有 4096 上限)。完整故事: [模型 - 能力](models.md#能力) |
| `"_openrouter_model": "vendor/id"` | `models.capabilities` | 从 OpenRouter 目录拉取点名模型的能力数据 - 只有能力, 从不包括定价。由此得到的字段排在服务器报告之上 (这条指令的含义是: 对这个模型, 服务器的数据不可信), 但排在同记录中你显式写下的字段之下。离线也能用内置快照工作。完整故事: [模型 - 能力](models.md#能力) |
| `"_inheritable": true \| ["field", ...]` | 两种记录 | 把全部/列出的字段标记为可被匹配得更具体、且未另行声明的模型继承。完整故事: [模型 - 匹配](models.md#哪条记录生效) |
| `"_inherit_from": true \| false \| ["key", ...]` | 两种记录 | 本记录继承什么: 到达它的一切、什么都不继承 (`false` - 也是屏障: 任何东西都流不过一条什么都不继承的记录), 或恰好点名的记录 (绕过屏障)。完整故事: [模型 - 匹配](models.md#哪条记录生效) |
| `"_fim_template": "...{prefix}...{suffix}..."` | `models.parameters` | 在没有原生中间填充处理的后端上, [内联补全](getting-started.md#用-litellm-模型获得内联补全)使用的 FIM 提示: `{prefix}` 和 `{suffix}` 会被替换为光标周围的文本, 请求只携带构建好的 prompt, 不再有单独的 `suffix` 字段。缺少任一占位符的值会被忽略, 改用原生的 prompt 加 suffix 请求体。它只塑造内联补全, 也是唯一能到达内联补全的 `models.parameters` 字段 - 聊天会忽略它 |

```jsonc
"litellm-vscode-chat.models.capabilities": {
  "*": { "context_length": 128000, "_fallback": ["context_length"] },  // 补缺默认值, 服务器报告时以服务器为准
  "my-gw-r1": { "_openrouter_model": "deepseek/deepseek-r1" }          // 为这个 ID 借用目录的数据
},
"litellm-vscode-chat.models.parameters": {
  "*":      { "top_p": 0.9, "_inheritable": true },                    // 除非模型主动退出, 每个模型都继承
  "gpt-5*": { "temperature": 0.2, "_force": ["temperature"] }          // 连聊天工具也不能调高它
}
```

## 外观

`ui.theme` 和 `ui.accent` 决定仪表板的外观。两件事值得知道:

- **高对比度永远胜出。**在 VS Code 高对比度主题下, 两个设置都休眠, 仪表板完全像 `auto` 那样跟随编辑器。高对比度主题是一种无障碍选择, 外观偏好无权推翻它。
- **`auto` 跟随任何主题; 固定一种则用我们的。**在 `auto` 下, 仪表板读取你的编辑器自己的颜色, 所以它融入 Solarized、Monokai 或任何手工主题。固定 `light` 或 `dark` 则换上我们的配色 (VS Code 自己的 Light Modern 和 Dark Modern), 这正是仪表板能在编辑器变化时保持不动的原因。

在 `blue` 下, 强调色跟随你主题的按钮颜色, 所以从未改过这项设置的用户看到的仪表板和以前完全一样。其余三种是固定色相, 按主题调校, 在浅色和深色表面上都清晰可辨。

## 提示缓存

在 LiteLLM 模型信息宣布支持提示缓存的模型上 (目前是 Anthropic Claude 模型), 扩展把 Anthropic 的四个缓存断点花在代理会话各轮次之间保持不变的部分上: 最后一个工具定义、系统提示、第一条用户消息, 以及最后一条带文本的消息。之后每一轮都复用上一轮缓存的前缀, 而不是为工具和历史重付全额输入价 - 节省在代理模式下最明显。

两个限制: 标记用的是提供方的短时缓存标记 (Anthropic 的默认生存期, 约 5 分钟; 扩展无法延长), 未声明支持的模型从不被发送标记。把 `chat.promptCaching` 设为 `false` 可关闭该功能。

## 重命名与移除的设置

一次性升级迁移自动处理所有这些:

| 旧 | 新 |
|---|---|
| `requestTimeout` | `chat.timeout` |
| `promptCaching.enabled` | `chat.promptCaching` |
| `discoveryTimeout` | `discovery.timeout` |
| `discoveryCacheTtl` | `discovery.cacheTtl` |
| `modelParameters` | `models.parameters` |
| `modelCapabilities` | `models.capabilities` |
| `openRouterCatalog.enabled` | `models.openRouterCatalog` |
| `headers` (全局) | 每个服务器条目自己的 `headers`; 复制进每个声明的条目, 旧值则被搁置在一条仪表板提示之后 (见下文作用域说明) |
| `maskApiKeyInput` | `ui.maskSecretInputs` |
| 服务器条目扁平字段 (`apiKey`、`oauth*`、`virtualKey*`、...) | 条目的 `auth` / `models` / `discovery` 对象 ([服务器](servers.md#条目参考)) |
| 作为隐式前缀的记录键 | 显式匹配器 - 给既有键追加 `*` ([模型 - 匹配](models.md#模型匹配)) |
| 全局记录中的服务器 URL 限定键 | 移入匹配的服务器条目; 无匹配的留在原地休眠并附仪表板提示 |
| `modelCapabilities` 的 `_declare` 指令 | 条目的 `discovery.declared` 列表 ([服务器](servers.md#声明的模型)) |
| `defaultContextLength`、`defaultMaxOutputTokens` | 带 `_fallback` 的 `models.capabilities` `"*"` 记录 ([详情](models.md#从已移除的默认设置迁移)) |
| `defaultMaxInputTokens` | `models.capabilities` `"*"` 覆盖 |

关于迁移的五条作用域与边界说明:

- 旧的全局 `headers` 应用于每个服务器 - 声明的条目和[外部管理的组](servers.md#外部服务器与采用)都在内。新的每条目 `headers` 够不到没有条目的服务器, 所以迁移只把值复制进你声明的条目, 并把原值搁置; 只要外部管理的组还存在, 仪表板的诊断就会指出它不再收到那些标头 - 把该组[采用](servers.md#外部服务器与采用)进条目, 标头就回来了。

- 一条 Settings Sync 注意事项: 当另一台机器先升级时, 同步会在这台机器迁移之前送来新名称的记录 (以及旧键的删除)。迁移随即保留同步来的值, 不加处理地丢弃旧记录 - 包括它携带的任何服务器 URL 限定键, 而那些键的去处本是这台机器自己的机器作用域条目; 第一台机器把它们吸收进了*它的*条目, 所以在这里它们被丢弃而不是移动。在多机环境下, 请先把 URL 限定键复制进匹配的服务器条目, 再升级其余机器。
- 它只重写用户设置。设置在工作区作用域的旧名称 (比如提交进仓库的 `.vscode/settings.json`) 留在原地 - 计入日志, 从不重写 - 而由于扩展不再读取旧名称, 在你手动把它移到新名称之前它没有任何效果。
- 已存储的密钥原地不动: 条目重构只改动设置文本 - 密钥存储中的值保持原有的键, 无需重新输入任何东西。
- 之后旧名称就是普通的未知键: VS Code 的设置编辑器标记它们, 扩展忽略它们, 所以零星的残留是噪音, 不是行为。
