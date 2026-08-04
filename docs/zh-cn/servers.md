# 服务器

[English](../servers.md) | 简体中文 | [繁體中文](../zh-tw/servers.md)

扩展可以同时连接任意数量的 LiteLLM 服务器, 并把它们的模型聚合进同一个选择器列表。服务器在一个设置中声明; 每个条目的密钥可以内联写在设置文件中, 也可以存放在 VS Code 的加密密钥存储中。

## servers 设置

服务器在 `litellm-vscode-chat.servers` 设置中声明。[仪表板](dashboard.md)的添加/编辑表单写入的是同一个设置, 因此两条途径始终一致:

```jsonc
// user settings.json
"litellm-vscode-chat.servers": [
	{
		"label": "Production",
		"baseUrl": "https://litellm.example.com",
		"apiKey": "sk-..." // inline: visible in this file
	},
	{
		"label": "Local",
		"baseUrl": "http://localhost:4000"
		// no apiKey here: either the server needs none, or the key lives in
		// VS Code secret storage (dashboard form, or "LiteLLM: Set Server Secret")
	}
]
```

此设置的行为:

- 扩展会在激活时以及设置每次变化时, 自动把条目同步为 VS Code 提供程序组。这里的一切同样可以从仪表板操作 (「LiteLLM: 打开仪表板」, 或命令面板 -> 「管理 LiteLLM 提供程序」 -> 管理服务器)。
- 此设置是机器作用域的: 它只存在于你的用户设置中, 工作区无法覆盖它 (因此克隆下来的仓库永远无法把你的服务器重新指向另一台主机), Settings Sync 也不会把它带到其他机器。
- `label` 是条目的标识。提供程序组以它命名, 因此重命名条目会创建一个新组。旧组会以旧名称留在原处; 扩展的通知会点名它并打开模型文件, 你可以在其中删除它的对象, 仪表板则把遗留行标记为「外部」, 并在徽章提示中注明这次重命名。
- 删除条目会隐藏其组。VS Code 没有提供删除组本身的 API, 因此扩展会记住这次删除, 用空模型列表应答该组 (它的模型从选择器中消失), 仪表板把该行折叠进「N 个隐藏的组」一行, 并提供「取消隐藏」操作。空壳在宿主侧仍然存在: 删除通知会点名确切的组, 其按钮会打开模型文件 (`<profile>/User/chatLanguageModels.json`) - 从 JSON 数组中删除该组的对象, 重新加载窗口, 再运行「立即同步模型」, 空壳就彻底消失了。
- 如果你重新添加一个具有相同标签和基础 URL 的条目, 隐藏的组会自行回来; 也可以通过隐藏组一行的「取消隐藏」显式恢复。

一个宿主限制贯穿这一切: VS Code 的提供程序组命令可以创建组, 但无法更新或删除组。

- 当声明条目的连接发生变化 (URL 或凭据) 时, 扩展无法把变化推入现有的组。服务器行会显示一条错误, 提示你从模型文件中删除该组的对象、重新加载窗口并运行「立即同步模型」, 这会从条目重新创建它。
- 出于同样的原因, 对已声明的组在原生界面所做的编辑会一直保留, 直到该组被删除并重新同步。
- 关于模型文件: VS Code 把这些组存放在你用户数据下的 `<profile>/User/chatLanguageModels.json` 中 (一个有文档说明、用户可编辑的文件), 删除组就是从该 JSON 数组中删除它的对象。VS Code 在启动时读取该文件并驻留内存, 所以编辑后请退出或重新加载窗口 - 运行中的窗口可能覆盖外部编辑。

## 条目字段

每个条目包含标签、基础 URL, 以及可选的凭据、每服务器模型参数和能力覆盖, 还有该服务器预期出现的发现失败。仪表板的添加/编辑表单覆盖同样的字段。

- 表单的「测试连接」按钮会按当前输入原样探测草稿 - 包括未保存的编辑, 已保留的密钥从其存放处读取 - 发出一次发现调用, 报告模型数量或确切错误 (当失败看起来是设置问题时, 会附上指向[故障排除指南](troubleshooting.md#常见问题)对应小节的链接)。它不保存也不同步任何内容。探测会遵循草稿的 `expectedFailures` 和 `_declare` 条目: 预期的发现失败会报告该条目将提供的声明模型, 而不是硬性错误。

| 设置键 | 说明 |
|-------------|-------------|
| `label` | 在模型选择器中为服务器命名; 条目的标识 (见上文) |
| `baseUrl` | 服务器的根 URL, 例如 `http://localhost:4000`。扩展会自行追加 `/v1`, 因此请去掉任何 `/v1` 后缀; 粘贴的 `.../v1` URL 会请求 `/v1/v1/...` 并失败 |
| `apiKey` | 以 `Authorization` bearer 发送, 并附带一份 `X-API-Key` 副本; 服务器不需要时省略 |
| `oauthTokenUrl` | 身份提供方的令牌终结点, 例如 `https://idp.example.com/oauth2/token` |
| `oauthClientId` | 客户端凭据授权的客户端 ID; 需要与令牌 URL 一起设置 |
| `oauthClientSecret` | 客户端密钥; 签发时没有密钥的公共客户端请省略。可存放在密钥存储中, 也可内联写入 |
| `oauthScopes` | 可选, 请求令牌时附带的作用域, 以空格分隔 |
| `virtualKeyHeader` | 可选, 携带 LiteLLM 虚拟密钥的自定义标头名称, 例如 `x-litellm-api-key`。命名为 `Authorization` 时, 虚拟密钥独占整个该标头, 且不再为此服务器获取 OAuth 令牌 |
| `virtualKeyValue` | 虚拟密钥本身; 可存放在密钥存储中, 也可内联写入 |
| `modelParameters` | 只应用于此条目请求的请求参数; 参见[模型参数](model-parameters.md#每条目参数) |
| `modelCapabilities` | 此条目模型的能力覆盖, 包括 `_declare` 条目; 参见[模型能力](model-capabilities.md#每条目能力) |
| `expectedFailures` | 此处预期失败的发现终结点 (`"modelListing"`、`"modelInfo"`): 各只尝试一次, 记录为预期, 不计入服务器错误; 参见[模型能力](model-capabilities.md#预期的发现失败) |

## 密钥与密钥存储

密钥字段 (`apiKey`、`oauthClientSecret`、`virtualKeyValue`) 由每个条目自行选择存放方式:

- 当设置文件中出现明文值可以接受时, 将密钥内联写入。
- 或者省略它, 改存于 VS Code 密钥存储中: 通过仪表板表单的「密钥存储」存放选项, 或「LiteLLM: 设置服务器密钥」命令。
- 内联值优先于存储的值。

哪些会回显到仪表板:

- 密钥存储中的值从不回显; 表单只显示值存放在哪里, 不显示值是什么。
- 内联值会预填到编辑表单中 (遮盖在「显示」开关之后), 因为它们本来就以明文存在于你的 settings.json 中。

当扩展需要为某个凭据保留一个非机密的标识时 (例如让同步状态保持一致的变更检测器), 它存储的是以随机的每安装密钥为键的指纹, 而不是简单哈希, 因此这些记录不会向能读取扩展状态但读不到密钥存储的任何东西泄露关于凭据的任何信息 - 即使是一个短到可猜的 API 密钥。

编辑已保存的条目时:

- 清空的密钥字段会保留已存储的值; 它不会清除密钥。
- 删除密钥是一个显式选择: 编辑表单会在每个有值的密钥字段下方显示「保存时删除已存储的...」复选框。

卸载扩展前删除密钥的方法见[故障排除](troubleshooting.md#卸载与清理)。

## 虚拟密钥

虚拟密钥是 LiteLLM 代理自己签发的密钥, 限定到某个预算、团队或一组模型 (参见 [LiteLLM 的虚拟密钥文档](https://docs.litellm.ai/docs/proxy/virtual_keys))。

- 大多数网关把虚拟密钥当作普通 bearer 令牌接收, 这种情况下它和其他密钥一样放在 `apiKey` 中。
- `virtualKeyHeader`/`virtualKeyValue` 这对字段只用于要求把密钥放在自定义标头中的网关, 例如 `x-litellm-api-key`:

```jsonc
{
	"label": "Team A",
	"baseUrl": "https://litellm.example.com",
	"virtualKeyHeader": "x-litellm-api-key",
	"virtualKeyValue": "sk-..." // or keep it in secret storage instead
}
```

## OAuth 客户端凭据身份验证

有些 LiteLLM 网关位于身份提供方之后, 拒绝静态 API 密钥。对于这类网关, 在服务器条目上配置 OAuth2 客户端凭据身份验证:

```jsonc
{
	"label": "Corp gateway",
	"baseUrl": "https://litellm.example.com",
	"oauthTokenUrl": "https://idp.example.com/oauth2/token",
	"oauthClientId": "my-client-id",
	"oauthClientSecret": "...", // omit for public clients; may live in secret storage
	"oauthScopes": "read write"  // optional, space-separated
}
```

在仪表板表单中, 这些字段位于「OAuth 和虚拟密钥 (可选)」之下; 对于扩展不管理的外部服务器, 它们存放在模型文件中。

令牌 URL 和客户端 ID 都设置后会发生什么:

- 扩展用客户端凭据换取一个短期 bearer 令牌, 并在发往该服务器的每个请求上作为 `Authorization` 标头发送, 在其过期前不久刷新。
- 签发时没有客户端密钥的公共客户端可以省略它。
- 同一服务器上配置的静态 API 密钥会继续以 `X-API-Key` 标头随 bearer 令牌一同发出, 供同时检查两者的网关使用。
- 如果网关还要求[虚拟密钥](#虚拟密钥), 设置两个虚拟密钥字段, 该标头就会随每个请求一起发送。例外是把 `Authorization` 命名为虚拟密钥标头, 这会让虚拟密钥独占整个该标头, 并完全跳过该服务器的 OAuth 令牌交换。
- 令牌交换受发现超时约束; 被拒绝的令牌会被丢弃, 下一个请求会获取新令牌。

## 每服务器模型参数

条目可以携带自己的 `modelParameters`: 与全局 `litellm-vscode-chat.modelParameters` 设置相同的按前缀键控的记录, 只应用于经此条目发出的请求。

- 基础 URL 限定无法区分指向同一主机的两个条目 (比如每个虚拟密钥一个), 而这就是把参数定向到其中一个的方法。
- 仪表板的编辑表单有对应的「此服务器的模型参数」区块。
- 匹配和优先级规则以及一个完整示例, 参见[模型参数](model-parameters.md)。

## 每服务器能力与预期失败

另外两个条目字段面向发现数据错误或缺失的服务器:

- `modelCapabilities` 纠正发现为此条目模型报告的内容, 其 `_declare` 条目会注册发现列不出的模型。
- `expectedFailures` 指明此服务器预期失败的发现终结点, 让这些失败被记录为预期, 而不是计作故障。

两者连同示例见[模型能力](model-capabilities.md)。

## 外部服务器与采用

其组在此扩展之外添加的服务器仍然可用; 由于没有设置条目, 仪表板把它们标记为「外部」。当扩展知道来历时, 徽章的悬停提示会说明该行来自哪里: 已删除条目的遗留 (注明名称), 或重命名的遗留 (注明新旧标签)。没有记录时, 该组要么是在此扩展之外添加的, 要么早于此跟踪。

外部行提供两个操作:

- **删除**会隐藏该组: 它的模型从选择器中消失, 该行移入「隐藏的组」一行, 与删除声明条目相同。后续通知会点名该组, 其按钮会打开模型文件, 你可以在其中彻底删除空壳的对象。
- **编辑**会把该组采用进设置:

1. 在外部行上单击「编辑」; 这就是采用操作。
2. 选择条目的标签。表单会预填该组当前的标签, 但通常值得重命名: 名称仍被某个现有 VS Code 组占用的条目, 在该组的对象从模型文件中删除之前无法同步。
3. 选择每个密钥的存放位置 (密钥存储或内联在设置中)。凭据值在扩展内部复制, 从不经过仪表板页面。
4. 保存: 该组的连接详情成为一个新的 `litellm-vscode-chat.servers` 条目, 该服务器变得像任何声明的服务器一样可编辑。
5. 从模型文件中删除原组的对象并重新加载窗口。采用无法删除它 (VS Code 没有相应 API), 在你删除之前它的模型会重复显示; 采用之后仪表板会提醒你这一点。

## 多台机器与 Settings Sync

服务器及其凭据留在你录入它们的那台机器上:

- `servers` 设置是机器作用域的; Settings Sync 从不携带它。
- VS Code 密钥存储中的值同样不同步。
- 在第二台机器上, 请重新添加服务器及其密钥。

其余一切都会自行到达: 其他每个 `litellm-vscode-chat.*` 设置都正常同步, 包括超时、`modelParameters` 和 `headers`。最后这一项是把双刃剑: 放在 [`headers` 设置](settings.md#自定义-http-标头)中的网关密钥会复制到你同步的每台机器上。
