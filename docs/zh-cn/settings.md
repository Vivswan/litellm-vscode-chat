# 设置

[English](../settings.md) | 简体中文 | [繁體中文](../zh-tw/settings.md)

每个 `litellm-vscode-chat.*` 设置, 及其默认值和作用。用 `Ctrl+,` / `Cmd+,` 打开设置并搜索 "litellm-vscode-chat", 或在[仪表板](dashboard.md)的设置标签页中以表单控件编辑同样的值。你配置过的仪表板行会说明其值存放在哪里 (「已在用户设置中修改」), 数字行还会显示该设置的内置默认值;「重置」会从该作用域删除值, 让下一作用域的值或默认值显现。

## 参考

| 设置 | 默认值 | 说明 |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | 声明的 LiteLLM 服务器; 参见[服务器](servers.md) |
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | 已弃用, 建议改用 `modelCapabilities`; 服务器未声明时模型的最大输出 token 数 |
| `litellm-vscode-chat.defaultContextLength` | `128000` | 已弃用, 建议改用 `modelCapabilities`; 服务器未声明时模型的上下文窗口 |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | 已弃用, 建议改用 `modelCapabilities`; 最大输入 token 数, 甚至覆盖服务器声明的限制 |
| `litellm-vscode-chat.requestTimeout` | `300000` | 聊天补全请求的超时时间, 毫秒 (5 分钟) |
| `litellm-vscode-chat.discoveryTimeout` | `30000` | 模型发现请求的超时时间, 毫秒 (30 秒) |
| `litellm-vscode-chat.discoveryCacheTtl` | `3600000` | 已发现的模型列表的复用时长, 毫秒 (1 小时) |
| `litellm-vscode-chat.modelParameters` | `{}` | 每模型请求参数; 参见[模型参数](model-parameters.md) |
| `litellm-vscode-chat.modelCapabilities` | `{}` | 每模型能力覆盖与 `_declare` 条目; 参见[模型能力](model-capabilities.md) |
| `litellm-vscode-chat.openRouterCatalog.enabled` | `true` | 用 OpenRouter 目录填充缺失的模型能力, 约每周刷新; 参见[下文](#openrouter-目录) |
| `litellm-vscode-chat.headers` | `{}` | 附加到每个请求的自定义 HTTP 标头 |
| `litellm-vscode-chat.promptCaching.enabled` | `true` | 在支持的模型上启用提示缓存 |
| `litellm-vscode-chat.maskApiKeyInput` | `true` | 配置服务器时遮盖 API 密钥输入框 |

下面各节介绍行为不止一句话的设置。

## Token 限制

扩展从你的 LiteLLM 服务器的模型信息读取 token 限制, 因此大多数模型在这里无需配置。三个 `default*` 设置都已弃用, 建议改用 [`modelCapabilities`](model-capabilities.md), 它可以定向到具体模型, 而且与这些回退值不同, 也能覆盖服务器已声明的限制; 它们仍然有效, 遵循两种不同的规则。

**`defaultMaxOutputTokens` 和 `defaultContextLength` 是回退值:**

- 它们只应用于服务器未声明输出限制或上下文长度的模型; 只要模型信息存在, 就以它为准。
- 一个需要知道的上限: 当模型的输出限制来自 `defaultMaxOutputTokens` 而非服务器时, 发往它的请求在线路上最多携带 4096 的 `max_tokens`, 无论设置写多少 (即 [max_tokens 例外](model-parameters.md#透传契约))。要向这类模型发送更多, 请在 [`modelParameters`](model-parameters.md) 中设置 `max_tokens`。

**`defaultMaxInputTokens` 是覆盖值, 不是回退值:**

- 保持 `null` (通常的选择) 时, 输入预算是服务器声明的输入限制; 服务器未声明时, 则是上下文长度减去最大输出 token 数。
- 一旦设置, 它就为每个模型固定输入限制, 甚至压过服务器声明的值。

输入预算在请求发送前根据本地 token 估算执行; 由此产生的「消息超出 token 限制」错误见[故障排除](troubleshooting.md#常见问题)。

## OpenRouter 目录

`litellm-vscode-chat.openRouterCatalog.enabled` (默认 `true`) 让扩展用内置的 OpenRouter 公开模型目录快照填补能力空缺, 并约每周从 `openrouter.ai` 刷新一次 - 这是唯一一个不发往你所配置服务器的出站请求 (只有公开的模型元数据; 不发送任何关于你或你的服务器的信息)。设为 `false` 可停止刷新和自动匹配; 显式的 `_openrouter_model` 指令继续离线工作。详情和隐私说明见[模型能力](model-capabilities.md#openrouter-目录)。

## 请求超时

```json
{
  "litellm-vscode-chat.requestTimeout": 600000,
  "litellm-vscode-chat.discoveryTimeout": 60000
}
```

- 两个超时都是整个调用的硬性上限, 包含流式传输和任何重试。
- 聊天补全从不重试, 因此 `requestTimeout` 是一个请求可用的总时间; 模型发现请求是幂等的, 失败时会重试, 全部在 `discoveryTimeout` 之内 (详见[故障排除](troubleshooting.md#超时与重试))。
- 当复杂提示或长推理运行被截断, 或你的服务器位于缓慢的基础设施之后时, 请调大它们。
- 两个设置的最小超时都是 1000ms (1 秒); 更低的值会被钳制。

## 模型列表缓存

```json
{
  "litellm-vscode-chat.discoveryCacheTtl": 3600000
}
```

VS Code 会频繁地重新解析语言模型提供程序, 有时一秒内多次。为避免频繁冲击你服务器的 `/v1/model/info` 终结点, 扩展默认把每个服务器已发现的模型列表缓存一小时。

- 失败的查询从不缓存, 同时发生的刷新共享一个请求。
- 如果你的服务器上模型经常变化, 请调低该值 (毫秒), 或设为 `0` 以在每次刷新时都重新获取。
- 要立即拾取服务器端变化, 从命令面板运行「LiteLLM: 立即同步模型」;「LiteLLM: 测试连接」也会通过网络刷新。

## 自定义 HTTP 标头

`litellm-vscode-chat.headers` 把自定义标头附加到每个 LiteLLM 请求上 (模型发现和聊天补全都包括)。当你的网关要求 `x-litellm-api-key` 等非标准身份验证标头时很有用:

```json
{
  "litellm-vscode-chat.headers": {
    "x-litellm-api-key": "your-gateway-key",
    "x-routing-env": "prod"
  }
}
```

- 自定义标头会合并进每个请求; 当服务器上配置了 API 密钥时, 扩展管理的身份验证标头 (`Authorization` 和 `X-API-Key`) 仍然优先。
- 标头值是普通设置, 不是密钥。如果某个值是机密, 请把它设在用户设置而非工作区设置中, 以免落入被提交的 `.vscode/settings.json`。
- 用户设置会随 Settings Sync 迁移, 因此机密值仍会复制到你同步的每台机器 (参见[多台机器与 Settings Sync](servers.md#多台机器与-settings-sync))。
- 对于每服务器的密钥, 优先使用服务器条目的虚拟密钥字段, 它们可以存放在密钥存储中且从不同步; 参见[服务器](servers.md#密钥与密钥存储)。

## 提示缓存

在 LiteLLM 模型信息中声明支持提示缓存的模型上 (目前是 Anthropic Claude 模型), 扩展把 Anthropic 的四个缓存断点花在 Agent 会话各轮之间保持不变的部分上:

- 最后一个工具定义
- 系统提示
- 第一条用户消息
- 最后一条含文本的消息 (只含工具调用或只含图像的末尾消息会被跳过)

之后每一轮都复用上一轮缓存的前缀, 而不是为工具和整个对话历史重新支付全额输入价格。节省在 Agent 模式中最明显, 那里工具和历史占请求的大头。

两个需要知道的限制:

- 这些标记是 Anthropic 的临时缓存标记, 没有显式 TTL, 因此缓存生存期是提供方的默认值 (Anthropic 目前约 5 分钟); 扩展不设置也不延长它。
- 未声明支持的模型从不发送缓存标记。

此功能默认开启; 将 `litellm-vscode-chat.promptCaching.enabled` 设为 `false` 可关闭。
