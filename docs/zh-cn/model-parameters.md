# 模型参数

[English](../model-parameters.md) | 简体中文 | [繁體中文](../zh-tw/model-parameters.md)

扩展从不替你决定请求参数: 除它拥有的字段 (model、messages、流式管线、`max_tokens` 和工具接线) 之外, 只有你在某处设置的参数才会到达 LiteLLM, 而且原样到达。本页介绍可以设置参数的地方, 以及多处匹配同一请求时它们如何组合。

## 透传契约

当你什么都不配置时, 应用的是你的模型提供方自己的默认值:

- 扩展不注入默认 temperature, 没有允许列表, 什么都没有。
- 所有非保留的参数键都会透传; 扩展不限制你可以设置哪些参数。
- 提供程序拥有的字段 (`model`、`messages`、`stream` 等) 无法覆盖。
- 以 `_` 开头的键保留给扩展元数据, 从不转发。

唯一有文档说明的例外是 `max_tokens`: 当没有任何地方设置它时, 扩展发送你的服务器在模型信息中声明的输出限制; 服务器未声明时最多发送 4096。

## 全局设置

用 `litellm-vscode-chat.modelParameters` 设置为特定模型覆盖请求参数。这对有特定要求的模型 (比如 gpt-5 要求 `temperature: 1`), 或按模型自定义行为很有用:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-5": {
      "temperature": 1
    },
    "gpt-4": {
      "max_tokens": 8000,
      "temperature": 0.8,
      "top_p": 0.9
    },
    "claude-opus": {
      "max_tokens": 16000,
      "temperature": 0.5
    }
  }
}
```

常用参数: `max_tokens`、`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`stop`、`response_format`、`reasoning_effort`、`seed`, 以及你的 LiteLLM 部署和模型提供方接受的任何其他参数。

原生设置 GUI 无法编辑对象设置, 因此[仪表板](dashboard.md)为此设置提供了行编辑器: 前缀字段会建议你已发现的模型 ID,「以 JSON 编辑」开关接受粘贴的记录, 编辑只在你按下「应用」时落地。你也可以直接在 settings.json 中编辑 JSON。

## 前缀匹配与服务器限定

配置键使用最长前缀匹配: `"gpt-4"` 匹配 `"gpt-4-turbo:openai"`、`"gpt-4:azure"` 等, 更具体的键优先于更短的键。前缀匹配的是你的服务器报告的模型的确切 ID, 而选择器不显示它; [仪表板的模型表格](dashboard.md#模型)在每行上提供复制它的操作。

在键前面加上服务器的基础 URL 和 `/`, 可将其限定到该服务器 (基础 URL 不要写尾部斜杠)。限定到服务器的条目优先于未限定的条目, 同一限定范围内更长的模型前缀胜出:

```json
{
  "litellm-vscode-chat.modelParameters": {
    "gpt-4": {
      "temperature": 0.7
    },
    "https://litellm.example.com/gpt-4": {
      "temperature": 0.3
    },
    "http://localhost:4000/gpt-4": {
      "temperature": 0.9
    }
  }
}
```

服务器限定对每种服务器都按基础 URL 匹配: `servers` 设置中的条目、在外部添加的服务器和旧版服务器, 都以指向的地址标识服务器。

以迁移前的服务器标签限定的键 (例如 `Production/gpt-4`) 不再匹配; 替代方案是每条目 `modelParameters`, 而扩展在提供程序组迁移期间已自动重写用户设置中的键。迁移做了什么、哪些键需要你手动移动, 参见[故障排除](troubleshooting.md#标签限定的参数键已迁移)。

## 每条目参数

当两个 `litellm-vscode-chat.servers` 条目指向同一个基础 URL 时 (例如每个虚拟密钥一个), 基础 URL 限定对两者同等适用。要精确定向其中一个, 请把 `modelParameters` 放到该条目上:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Team A",
		"baseUrl": "https://litellm.example.com",
		"virtualKeyHeader": "x-litellm-api-key",
		"modelParameters": {
			"gpt-4": { "temperature": 0.2 }
		}
	},
	{
		"label": "Team B",
		"baseUrl": "https://litellm.example.com",
		"virtualKeyHeader": "x-litellm-api-key"
	}
]
```

条目键的工作方式:

- 条目键是纯模型 ID 前缀 (最长匹配胜出; 没有基础 URL 限定, 因为条目已经指明了自己的服务器)。
- 当条目参数和全局参数匹配同一个模型时, 该键以条目的值为准, 其余键仍由全局设置补齐。
- 只有当请求经过的提供程序组在标签和基础 URL 两方面都与条目匹配时, 请求才会拾取该条目的参数。没有设置条目的外部组, 以及标签或 `baseUrl` 编辑留下的过期组, 只获得全局设置; 仪表板以[「参数未生效」通知](troubleshooting.md#每服务器模型参数未生效)标记这种情况。

## 模型选择器中的推理强度

声明推理支持的模型 (`supports_reasoning`, 或受支持参数中含 `reasoning_effort`) 会在 Copilot 的模型选择器中获得一个强度控件:

1. 在选择器中选中该模型。
2. 单击聊天输入框中模型名称旁的「Thinking Effort」标签。
3. 从 Off 到 Extra High 之间选择一档; VS Code 会为该模型记住这个选择。

每档发送什么:

- 之后每个请求都会相应携带 `reasoning_effort`;「Off」以 `reasoning_effort: "none"` 发出, 在支持这一取值的模型上关闭思维。
- 「Provider default」(初始状态) 不发送任何内容, 由你的提供方决定。
- 每个推理模型的菜单都相同, 因为 LiteLLM 报告哪些模型接受 `reasoning_effort`, 但不报告每个模型接受哪些值。如果你选了模型拒绝的档位 (比如在最高只到 High 的模型上选 Extra High), 请求会带着服务器自己的错误消息失败; 换一档重试即可。

temperature 有意留在 `modelParameters` 中自由设置: 选择器的 Configure Model 菜单只能呈现固定选项, 因此扩展不在那里添加 temperature 预设。

## 优先级

当多个来源为同一请求设置同一参数时, 层级更高者胜出:

1. 运行时选项 - 聊天客户端 (Copilot, 或调用该模型的其他扩展) 在请求本身上设置的内容
2. 模型选择器中的选择
3. 条目 `modelParameters`
4. 全局 `modelParameters`

四层都未设置的参数落到你的模型提供方的默认值, 外加上文描述的 `max_tokens` 例外。

要查看这些层为某个模型如何解析 - 哪个值胜出、什么被遮蔽、`max_tokens` 会发出什么 - 请使用[仪表板的生效参数检查器](dashboard.md#生效参数), 即模型表格每行的「参数」操作。
