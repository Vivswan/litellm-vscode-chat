# 模型參數

[English](../model-parameters.md) | [简体中文](../zh-cn/model-parameters.md) | 繁體中文

延伸模組絕不替您決定請求參數: 除了它擁有的欄位 (模型、訊息、串流管線、`max_tokens` 與工具接線) 之外, 只有您在某處設定的參數會送達 LiteLLM, 而且原封不動地送達。本頁涵蓋可以設定參數的各個位置, 以及多處同時比對到同一個請求時它們如何組合。

## 直通合約

當您什麼都沒設定時, 套用的是您模型提供者自己的預設值:

- 延伸模組不注入預設 temperature, 沒有允許清單, 什麼都沒有。
- 所有非保留的參數鍵都會直通; 延伸模組不限制您能設定哪些參數。
- 提供者擁有的欄位 (`model`、`messages`、`stream` 等) 無法覆寫。
- 以 `_` 開頭的鍵保留給延伸模組中繼資料, 永不轉送。

唯一有文件說明的例外是 `max_tokens`: 當沒有任何來源設定它時, 延伸模組會送出您伺服器在模型資訊中宣告的輸出上限, 或在伺服器未宣告時最多送出 4096。

## 全域設定

用 `litellm-vscode-chat.modelParameters` 設定覆寫特定模型的請求參數。這對有特殊要求的模型 (例如 gpt-5 要求 `temperature: 1`), 或想逐模型自訂行為時很有用:

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

常見參數: `max_tokens`、`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`stop`、`response_format`、`reasoning_effort`、`seed`, 以及您的 LiteLLM 部署與模型提供者接受的任何其他參數。

原生設定 GUI 無法編輯物件型設定, 所以[儀表板](dashboard.md)為這個設定提供列編輯器: 前置詞欄位會建議您已探索的模型 ID, 「以 JSON 編輯」切換可接受貼上的記錄, 而編輯只在您按下「套用」時才生效。您也可以直接在 settings.json 中編輯 JSON。

## 前置詞比對與伺服器限定

設定鍵使用最長前置詞比對: `"gpt-4"` 符合 `"gpt-4-turbo:openai"`、`"gpt-4:azure"` 等等, 較具體的鍵優先於較短的鍵。前置詞比對的是您伺服器回報的模型確切 ID, 選擇器不會顯示它; [儀表板的模型表格](dashboard.md#模型)每一列都有它的複製動作。

在鍵前面加上伺服器的基底 URL 與 `/`, 即可將它限定於該伺服器 (基底 URL 結尾不要加斜線)。伺服器限定的項目優先於未限定者, 同一範圍內則以較長的模型前置詞獲勝:

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

伺服器限定對每一種伺服器都以基底 URL 比對: `servers` 設定中的項目、外部新增的伺服器與舊版伺服器, 全都以指向的位置識別伺服器。

以移轉前伺服器標籤限定的鍵 (例如 `Production/gpt-4`) 已不再比對; 取而代之的是各項目的 `modelParameters`, 而延伸模組在提供者群組移轉期間已自動改寫使用者設定中的鍵。移轉做了什麼、哪些鍵必須手動搬移, 參閱[疑難排解](troubleshooting.md#以標籤限定的參數鍵已移轉)。

## 各項目參數

當兩個 `litellm-vscode-chat.servers` 項目指向同一個基底 URL (例如各用一把虛擬金鑰) 時, 基底 URL 限定會同等套用於兩者。要精準鎖定其中一個, 請改把 `modelParameters` 放在那個項目上:

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

項目鍵的運作方式:

- 項目鍵是純模型 ID 前置詞 (最長者優先; 沒有基底 URL 限定, 因為項目本身已指明其伺服器)。
- 當項目參數與全域參數比對到同一個模型時, 該鍵以項目的值為準, 其餘仍由全域設定補齊。
- 只有當請求經過的提供者群組在標籤與基底 URL 上都與項目相符時, 請求才會帶上該項目的參數。沒有設定項目的外部群組, 以及標籤或 `baseUrl` 編輯留下的過時群組, 只會拿到全域設定; 儀表板會以[「參數未生效」通知](troubleshooting.md#各伺服器模型參數未生效)標示這種情況。

## 模型選擇器中的推理程度

宣告推理支援的模型 (`supports_reasoning`, 或支援參數中包含 `reasoning_effort`) 會在 Copilot 的模型選擇器中獲得程度控制項:

1. 在選擇器中選取該模型。
2. 按一下聊天輸入框中模型名稱旁的「Thinking Effort」標籤。
3. 從 Off 到 Extra High 挑一個等級; VS Code 會為該模型記住這個選擇。

每個選擇送出什麼:

- 之後每個請求都相應攜帶 `reasoning_effort`; 「Off」會以 `reasoning_effort: "none"` 送出, 在支援的模型上關閉推理。
- 「Provider default」(初始狀態) 不送出任何值, 交由您的提供者決定。
- 每個推理模型的選單都一樣, 因為 LiteLLM 只回報哪些模型接受 `reasoning_effort`, 不回報各自接受哪些值。若您挑了模型拒絕的等級 (例如在只到 High 的模型上選 Extra High), 請求會以伺服器自己的錯誤訊息失敗; 換一個等級再試即可。

temperature 刻意留在 `modelParameters` 中自由設定: 選擇器的「設定模型」(Configure Model) 選單只能呈現固定選項, 所以延伸模組不在那裡加入 temperature 預設集。

## 優先順序

當多個來源為同一個請求設定相同參數時, 位階較高者獲勝:

1. 執行階段選項 - 聊天用戶端 (Copilot, 或呼叫模型的其他延伸模組) 直接設定在請求上的值
2. 模型選擇器的選擇
3. 項目 `modelParameters`
4. 全域 `modelParameters`

四層都未設定的參數, 就落回您模型提供者的預設值, 加上前述的 `max_tokens` 例外。

想看這些層次對特定模型如何解析 - 哪個值獲勝、什麼被遮蔽、送出的 `max_tokens` 是多少 - 請使用[儀表板的有效參數檢視器](dashboard.md#有效參數), 也就是模型表格每一列的「參數」動作。
