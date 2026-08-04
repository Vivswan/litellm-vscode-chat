# 模型能力

[English](../model-capabilities.md) | [简体中文](../zh-cn/model-capabilities.md) | 繁體中文

探索從您的 LiteLLM 伺服器讀取每個模型能做什麼。當伺服器回報有誤 - 或什麼都不回報 - 時, `litellm-vscode-chat.modelCapabilities` 設定可以修正並補充它: 修正上下文長度、打開視覺支援, 或宣告一個探索列不出的模型。

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "gpt-4": { "context_length": 128000, "supports_vision": true },
    "my-gateway-model": { "max_output_tokens": 32000 }
  }
}
```

能力描述模型**能做什麼**: 它們驅動註冊、token 上限, 以及送出哪些附件。請求**要求什麼** (temperature、`max_tokens` 等) 是[模型參數](model-parameters.md)的職責; 兩個設定的鍵語法相同, 但絕不混用。

## 能力欄位

| 欄位 | 型別 | 控制什麼 |
|-------|------|------------------|
| `context_length` | 數字 | 模型的上下文視窗 |
| `max_input_tokens` | 數字 | 輸入額度; 無處設定時為上下文長度減去最大輸出 token 數 |
| `max_output_tokens` | 數字 | 輸出上限, 也是 `max_tokens` 的後備值 ([直通例外](model-parameters.md#直通合約)) |
| `supports_function_calling` | 布林 | 使用工具的請求 (Agent 模式) |
| `supports_vision` | 布林 | 是否送出圖片附件 |
| `supports_reasoning` | 布林 | 選擇器中的「Thinking Effort」控制項 |
| `supports_audio_input` | 布林 | 是否送出音訊附件 |

與 `modelParameters` 不同, 這套詞彙是封閉的: 未知的鍵不會被轉送到任何地方, 而是在儀表板的能力檢查器中被標示出來。數字欄位只接受正整數; 無效的值同樣會被標示, 改由次佳來源勝出。

鍵的比對方式與模型參數相同: 最長的模型 ID 前置詞獲勝, `""` 比對每個模型, 在鍵前加上伺服器的基底 URL 與 `/` 可將它限定到該伺服器, 限定的比對會整筆取代未限定的鍵 (參閱[前置詞比對](model-parameters.md#前置詞比對與伺服器限定))。

## 各項目能力

`litellm-vscode-chat.servers` 項目可以攜帶自己的 `modelCapabilities`, 只套用於經該項目服務的模型 - 形狀相同但沒有基底 URL 限定, 對應[各項目參數](model-parameters.md#各項目參數):

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

當項目欄位與全域欄位比對到同一個模型時, 逐鍵以項目的值為準。儀表板的伺服器表單有對應的「此伺服器的模型能力」區段。

## 宣告探索列不出的模型

有些閘道提供聊天服務, 卻沒有可用的模型清單。`"_declare": true` 會把鍵的確切模型 ID 註冊到其伺服器上, 即使探索列不出它 - 通常與 [`expectedFailures`](#預期的探索失敗) 搭配使用, 讓失敗的探索不被當作故障:

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

- 鍵就是要註冊的確切模型 ID; 前置詞比對絕不建立模型。
- `_declare` 需要一個它能指名的伺服器: 項目鍵, 或以基底 URL 限定的全域鍵 (`https://gateway.example.com/claude-sonnet-4`)。放在未限定的全域鍵上會被忽略。
- 伺服器同樣列出的已宣告 ID 是惰性的 - 使用探索到的資料, 並照常由記錄的其他欄位修正。
- 宣告的模型在[儀表板的模型表格](dashboard.md#模型)中帶有「宣告」徽章; 移除 `_declare` 會立即移除該模型。

## 以 OpenRouter 目錄填補缺口

延伸模組內建 [OpenRouter](https://openrouter.ai) 公開模型目錄的快照, 可以用它填補您未設定的能力欄位。`"_openrouter_model"` 明確指名目錄項目:

```json
{
  "litellm-vscode-chat.modelCapabilities": {
    "my-alias": { "_openrouter_model": "anthropic/claude-sonnet-4" }
  }
}
```

- 目錄資料只填補比對到的記錄留空的欄位; 您明確設定的欄位一律獲勝。
- 以這種方式導出的欄位排在伺服器回報的值之上 - 這個指示詞表示此模型的伺服器資料不可信。
- 未知的目錄 ID 會在能力檢查器中顯示警告, 模型回落到其他來源; 它絕不是錯誤。
- 儀表板的能力編輯器為該 ID 提供搜尋選擇器。

即使沒有指示詞, 自身 ID 與目錄項目完全相符 (或在只有一個項目相符時, 與 `vendor/` 前置詞之後的部分相符) 的模型仍會從目錄回填 - 但只作為高於內建預設值的最弱來源, 因此它永遠無法取代伺服器回報的資料或您的設定。

## 優先順序

對每個欄位, 設定了它的最高來源獲勝:

1. 項目 `modelCapabilities`
2. 全域 `modelCapabilities` (以基底 URL 限定的比對整筆取代未限定的鍵)
3. 從 `_openrouter_model` 導出的欄位
4. 伺服器回報的值 (宣告的模型沒有這一層; 已淘汰的 `defaultMaxInputTokens` 仍蓋過伺服器的輸入上限)
5. 已淘汰的 `default*` 設定, 當明確設定時
6. 隱含的 OpenRouter 目錄比對
7. 內建預設值: 工具開、視覺/音訊/推理關、上下文 128000、最大輸出 16000

兩個值得知道的推論:

- 來自第 1-3 層的 `max_output_tokens` 算作使用者宣告, 會原樣送出; 模型的每個部署都宣告了的伺服器上限同樣如此; 其他任何勝出者 - 某個部署未宣告的合併上限、`default*` 設定、目錄比對或內建預設值 - 會把線路上的 `max_tokens` 限制在 4096 (參閱[直通合約](model-parameters.md#直通合約))。
- 價格絕不被覆寫: 伺服器回報的價格一律獲勝, 目錄價格只在伺服器未回報時補位。

要查看某個模型每個欄位的解析值與來源 - 包含被遮蔽的值 - 請使用[儀表板的能力檢查器](dashboard.md#有效能力), 即模型表格每列的「能力」動作。

## OpenRouter 目錄

目錄資料來自哪裡, 以及唯一的網路影響:

- 延伸模組在 VSIX 中附帶一份目錄快照, 並約每週從 `https://openrouter.ai/api/v1/models` 重新整理一次 - 這是一份公開、無需驗證的模型清單。該請求不帶提示、不帶用量、不帶帳戶資料, 也不帶任何關於您伺服器的資訊; 重新整理後的副本快取在 VS Code 的全域儲存體中, 重新整理失敗會靜默回落到快取或內建快照。
- **選擇退出**: 把 `litellm-vscode-chat.openRouterCatalog.enabled` 設為 `false`, 即可停止週期性重新整理 (所有目錄網路請求) 與隱含比對。明確的 `_openrouter_model` 指示詞繼續離線使用內建或快取的快照 - 它們是您明示的意圖, 不需要網路。

## 預期的探索失敗

當一個伺服器*預期*會探索失敗 - 提供聊天但沒有模型清單的閘道 - 項目的 `expectedFailures` 欄位可以說明這一點, 讓延伸模組不再把這些失敗當作故障:

```jsonc
{
	"label": "Gateway",
	"baseUrl": "https://gateway.example.com",
	"expectedFailures": ["modelListing", "modelInfo"]
}
```

- 兩個類別是 `"modelListing"` (`/models` 清單) 與 `"modelInfo"` (`/model/info` 端點)。
- 列出的端點在每次探索時仍會嘗試 - 所以它一旦恢復運作, 模型會被自動接手 - 但只嘗試一次, 不做平常的重試。
- 它的失敗以 info 層級記錄為預期, 且不計入伺服器的失敗: 有宣告的模型時, 該列保持「已連線」(附註記); 沒有時顯示「預期失敗」, 儀表板會指向 `_declare`。
- 該欄位只存在於伺服器項目上, 因為它必須指名特定的伺服器。
