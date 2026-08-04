# 模型能力

[English](../model-capabilities.md) | 简体中文 | [繁體中文](../zh-tw/model-capabilities.md)

发现从你的 LiteLLM 服务器读取每个模型能做什么。当服务器报告有误 - 或什么都不报 - 时, `litellm-vscode-chat.modelCapabilities` 设置可以纠正和补充它: 修正上下文长度、打开视觉支持, 或声明一个发现列不出的模型。

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "gpt-4": { "context_length": 128000, "supports_vision": true },
    "my-gateway-model": { "max_output_tokens": 32000 }
  }
}
```

能力描述模型**能做什么**: 它们驱动注册、token 限制, 以及发送哪些附件。请求**要求什么** (temperature、`max_tokens` 等) 是[模型参数](model-parameters.md)的职责; 两个设置的键语法相同, 但从不混用。

## 能力字段

| 字段 | 类型 | 控制什么 |
|-------|------|------------------|
| `context_length` | 数字 | 模型的上下文窗口 |
| `max_input_tokens` | 数字 | 输入预算; 无处设置时为上下文长度减去最大输出 token 数 |
| `max_output_tokens` | 数字 | 输出限制, 也是 `max_tokens` 的回退值 ([透传例外](model-parameters.md#透传契约)) |
| `supports_function_calling` | 布尔 | 使用工具的请求 (Agent 模式) |
| `supports_vision` | 布尔 | 是否发送图像附件 |
| `supports_reasoning` | 布尔 | 选择器中的「Thinking Effort」控件 |
| `supports_audio_input` | 布尔 | 是否发送音频附件 |

与 `modelParameters` 不同, 这套词汇表是封闭的: 未知的键不会被转发到任何地方, 而是在仪表板的能力检查器中被标记出来。数字字段只接受正整数; 无效值同样会被标记, 由次优来源顶替。

键的匹配方式与模型参数相同: 最长的模型 ID 前缀胜出, `""` 匹配每个模型, 在键前面加上服务器的基础 URL 和 `/` 可将其限定到该服务器, 限定的匹配会整体取代未限定的键 (参见[前缀匹配](model-parameters.md#前缀匹配与服务器限定))。

## 每条目能力

`litellm-vscode-chat.servers` 条目可以携带自己的 `modelCapabilities`, 只应用于经该条目提供服务的模型 - 形状相同但没有基础 URL 限定, 与[每条目参数](model-parameters.md#每条目参数)对应:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Team A",
		"baseUrl": "https://litellm.example.com",
		"modelCapabilities": {
			"gpt-4": { "supports_vision": true }
		}
	}
]
```

当条目字段和全局字段匹配同一个模型时, 逐个键以条目的值为准。仪表板的服务器表单有对应的「此服务器的模型能力」区块。

## 声明发现列不出的模型

有些网关提供聊天服务, 却没有可用的模型列表。`"_declare": true` 把键的确切模型 ID 注册到其服务器上, 即使发现列不出它 - 通常与 [`expectedFailures`](#预期的发现失败) 搭配使用, 让失败的发现不被当作故障:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Gateway",
		"baseUrl": "https://gateway.example.com",
		"apiKey": "sk-...",
		"expectedFailures": ["modelListing", "modelInfo"],
		"modelCapabilities": {
			"claude-sonnet-4": { "_declare": true, "context_length": 200000, "supports_vision": true }
		}
	}
]
```

- 键就是要注册的确切模型 ID; 前缀匹配从不创建模型。
- `_declare` 需要一个它能指明的服务器: 条目键, 或以基础 URL 限定的全局键 (`https://gateway.example.com/claude-sonnet-4`)。在未限定的全局键上, 它会被忽略。
- 服务器同样列出的已声明 ID 是惰性的 - 使用发现的数据, 并照常由记录的其他字段纠正。
- 声明的模型在[仪表板的模型表格](dashboard.md#模型)中带有「声明」徽章; 移除 `_declare` 会立即移除该模型。

## 用 OpenRouter 目录填补空缺

扩展内置了 [OpenRouter](https://openrouter.ai) 公开模型目录的快照, 可以用它填充你未设置的能力字段。`"_openrouter_model"` 显式指定目录条目:

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "my-alias": { "_openrouter_model": "anthropic/claude-sonnet-4" }
  }
}
```

- 目录数据只填充匹配记录留空的字段; 你显式设置的字段始终胜出。
- 以这种方式派生的字段排在服务器报告的值之上 - 该指令表示这个模型的服务器数据不可信。
- 未知的目录 ID 会在能力检查器中显示警告, 模型回落到其他来源; 它从不是错误。
- 仪表板的能力编辑器为该 ID 提供搜索选择器。

即使没有指令, 自身 ID 与目录条目完全匹配 (或在只有一个条目匹配时, 与 `vendor/` 前缀之后的部分匹配) 的模型仍会从目录回填 - 但只作为高于内置默认值的最弱来源, 因此它永远无法顶替服务器报告的数据或你的设置。

## 优先级

对每个字段, 设置了它的最高来源胜出:

1. 条目 `modelCapabilities`
2. 全局 `modelCapabilities` (以基础 URL 限定的匹配整体取代未限定的键)
3. 从 `_openrouter_model` 派生的字段
4. 服务器报告的值 (声明的模型没有这一层; 已弃用的 `defaultMaxInputTokens` 仍压过服务器的输入限制)
5. 已弃用的 `default*` 设置, 当显式设置时
6. 隐式的 OpenRouter 目录匹配
7. 内置默认值: 工具开、视觉/音频/推理关、上下文 128000、最大输出 16000

两个值得知道的推论:

- 来自第 1-3 层的 `max_output_tokens` 算作用户声明, 会原样发送; 模型的每个部署都声明了的服务器限制同样如此; 其他任何胜出者 - 某个部署未声明的合并限制、`default*` 设置、目录匹配或内置默认值 - 会把线路上的 `max_tokens` 限制在 4096 (参见[透传契约](model-parameters.md#透传契约))。
- 定价从不被覆盖: 服务器报告的定价始终胜出, 目录定价只在服务器未报告时补位。

要查看某个模型每个字段的解析值和来源 - 包括被遮蔽的值 - 请使用[仪表板的能力检查器](dashboard.md#生效能力), 即模型表格每行的「能力」操作。

## OpenRouter 目录

目录数据来自哪里, 以及唯一的网络影响:

- 扩展在 VSIX 中附带一份目录快照, 并约每周从 `https://openrouter.ai/api/v1/models` 刷新一次 - 这是一个公开的、无需身份验证的模型列表。该请求不携带提示、不携带用量、不携带账户数据, 也不携带任何关于你的服务器的信息; 刷新后的副本缓存在 VS Code 的全局存储中, 刷新失败会静默回落到缓存或内置快照。
- **选择退出**: 把 `litellm-vscode-chat.openRouterCatalog.enabled` 设为 `false`, 即可停止周期刷新 (所有目录网络请求) 和隐式匹配。显式的 `_openrouter_model` 指令继续离线工作于内置或缓存的快照 - 它们是你声明的意图, 不需要网络。

## 预期的发现失败

当一个服务器*预期*会发现失败 - 提供聊天但没有模型列表的网关 - 条目的 `expectedFailures` 字段可以说明这一点, 让扩展不再把这些失败当作故障:

```jsonc
{
	"label": "Gateway",
	"baseUrl": "https://gateway.example.com",
	"expectedFailures": ["modelListing", "modelInfo"]
}
```

- 两个类别是 `"modelListing"` (`/models` 列表) 和 `"modelInfo"` (`/model/info` 终结点)。
- 列出的终结点在每次发现流程中仍会尝试 - 因此它一旦恢复工作, 模型会被自动拾取 - 但只尝试一次, 不做通常的重试。
- 它的失败以 info 级别记录为预期, 且不计入服务器的失败: 有声明的模型时, 该行保持「已连接」(附说明); 没有时显示「预期失败」, 仪表板会指向 `_declare`。
- 该字段只存在于服务器条目上, 因为它必须指明具体的服务器。
