# 設定

[English](../settings.md) | [简体中文](../zh-cn/settings.md) | 繁體中文

每個 `litellm-vscode-chat.*` 設定, 及其預設值與作用。用 `Ctrl+,` / `Cmd+,` 開啟設定並搜尋 "litellm-vscode-chat", 或在[儀表板](dashboard.md)的設定分頁以表單控制項編輯相同的值。您已設定過的儀表板列會標明其值存放在哪裡 (「已在使用者設定中修改」), 數字列還會標明設定的內建預設值; 「重設」會移除該範圍的值, 讓下一個範圍的值或預設值生效。

## 參考

| 設定 | 預設值 | 說明 |
|---------|---------|-------------|
| `litellm-vscode-chat.servers` | `[]` | 宣告的 LiteLLM 伺服器; 參閱[伺服器](servers.md) |
| `litellm-vscode-chat.defaultMaxOutputTokens` | `16000` | 已淘汰, 建議改用 `modelCapabilities`; 伺服器未宣告時, 模型的最大輸出 token 數 |
| `litellm-vscode-chat.defaultContextLength` | `128000` | 已淘汰, 建議改用 `modelCapabilities`; 伺服器未宣告時, 模型的上下文視窗 |
| `litellm-vscode-chat.defaultMaxInputTokens` | `null` | 已淘汰, 建議改用 `modelCapabilities`; 最大輸入 token 數, 甚至覆寫伺服器宣告的上限 |
| `litellm-vscode-chat.requestTimeout` | `300000` | 聊天完成請求的逾時, 以毫秒計 (5 分鐘) |
| `litellm-vscode-chat.discoveryTimeout` | `30000` | 模型探索請求的逾時, 以毫秒計 (30 秒) |
| `litellm-vscode-chat.discoveryCacheTtl` | `3600000` | 已探索的模型清單重複使用多久, 以毫秒計 (1 小時) |
| `litellm-vscode-chat.modelParameters` | `{}` | 各模型的請求參數; 參閱[模型參數](model-parameters.md) |
| `litellm-vscode-chat.modelCapabilities` | `{}` | 各模型能力覆寫與 `_declare` 項目; 參閱[模型能力](model-capabilities.md) |
| `litellm-vscode-chat.openRouterCatalog.enabled` | `true` | 以 OpenRouter 目錄填補缺少的模型能力, 約每週重新整理; 參閱[下文](#openrouter-目錄) |
| `litellm-vscode-chat.headers` | `{}` | 加到每個請求的自訂 HTTP 標頭 |
| `litellm-vscode-chat.promptCaching.enabled` | `true` | 在支援的模型上啟用提示快取 |
| `litellm-vscode-chat.maskApiKeyInput` | `true` | 設定伺服器時遮罩 API 金鑰輸入欄位 |

以下各節說明行為不只一句話能講完的設定。

## Token 上限

延伸模組從您 LiteLLM 伺服器的模型資訊讀取 token 上限, 所以大多數模型在這裡不需要任何設定。三個 `default*` 設定都已淘汰, 建議改用 [`modelCapabilities`](model-capabilities.md), 它可以鎖定特定模型, 而且與這些後備值不同, 也能覆寫伺服器已宣告的上限; 它們仍然有效, 遵循兩種不同的規則。

**`defaultMaxOutputTokens` 與 `defaultContextLength` 是後備值:**

- 它們只套用於伺服器未宣告輸出上限或上下文長度的模型; 只要模型資訊存在, 一律以它為準。
- 有一個上限要知道: 當模型的輸出上限來自 `defaultMaxOutputTokens` 而非伺服器時, 送往該模型的請求在線路上最多只帶 4096 個 token 的 `max_tokens`, 無論設定值多大 ([max_tokens 例外](model-parameters.md#直通合約))。要對這種模型送出更多, 請在 [`modelParameters`](model-parameters.md) 中設定 `max_tokens`。

**`defaultMaxInputTokens` 是覆寫, 不是後備值:**

- 保持 `null` (通常的選擇) 時, 輸入額度是伺服器宣告的輸入上限, 或在未宣告時以上下文長度減去最大輸出 token 數計算。
- 一旦設定, 它就固定每個模型的輸入上限, 連伺服器宣告的也會被蓋過。

輸入額度會在請求送出前, 依本機的 token 估計強制執行; 由此產生的「訊息超過 token 上限」錯誤參閱[疑難排解](troubleshooting.md#常見問題)。

## OpenRouter 目錄

`litellm-vscode-chat.openRouterCatalog.enabled` (預設 `true`) 讓延伸模組以內建的 OpenRouter 公開模型目錄快照填補能力缺口, 並約每週從 `openrouter.ai` 重新整理一次 - 這是唯一一個不送往您所設定伺服器的對外請求 (只有公開的模型中繼資料; 不會傳送任何關於您或您伺服器的資訊)。設為 `false` 可停止重新整理與自動比對; 明確的 `_openrouter_model` 指示詞繼續離線運作。詳細資料與隱私說明參閱[模型能力](model-capabilities.md#openrouter-目錄)。

## 請求逾時

```json
{
  "litellm-vscode-chat.requestTimeout": 600000,
  "litellm-vscode-chat.discoveryTimeout": 60000
}
```

- 兩個逾時都是整個呼叫的硬性上限, 包含串流與任何重試。
- 聊天完成永不重試, 所以 `requestTimeout` 就是一個請求可以花費的總時間; 模型探索請求是冪等的, 失敗會重試, 全部仍在 `discoveryTimeout` 之內 (詳見[疑難排解](troubleshooting.md#逾時與重試))。
- 當複雜的提示或長時間的推理被中斷, 或伺服器位於緩慢的基礎架構之後時, 請調高它們。
- 兩個設定的最小逾時都是 1000ms (1 秒); 更低的值會被拉高到下限。

## 模型清單快取

```json
{
  "litellm-vscode-chat.discoveryCacheTtl": 3600000
}
```

VS Code 會頻繁重新解析語言模型提供者, 有時一秒內好幾次。為了避免轟炸您伺服器的 `/v1/model/info` 端點, 延伸模組預設將每個伺服器已探索的模型清單快取一小時。

- 失敗的查詢永不快取, 同時發生的重新整理共用一個請求。
- 若您伺服器上的模型經常變動, 請調低此值 (毫秒), 或設為 `0` 讓每次重新整理都重新擷取。
- 要立即取得伺服器端變更, 請在命令選擇區執行「LiteLLM: 立即同步模型」; 「LiteLLM: 測試連線」也會透過網路重新整理。

## 自訂 HTTP 標頭

`litellm-vscode-chat.headers` 會把自訂標頭附加到每個 LiteLLM 請求 (模型探索與聊天完成皆然)。當閘道要求 `x-litellm-api-key` 之類的非標準驗證標頭時很有用:

```json
{
  "litellm-vscode-chat.headers": {
    "x-litellm-api-key": "your-gateway-key",
    "x-routing-env": "prod"
  }
}
```

- 自訂標頭會合併進每個請求; 當伺服器上設定了 API 金鑰時, 延伸模組管理的驗證標頭 (`Authorization` 與 `X-API-Key`) 仍優先。
- 標頭值是一般設定, 不是祕密。若值屬於祕密, 請設定在使用者設定而非工作區設定, 以免它落入被提交的 `.vscode/settings.json`。
- 使用者設定會隨設定同步移動, 所以祕密值仍會複寫到您同步的每一台機器 (參閱[多台機器與設定同步](servers.md#多台機器與設定同步))。
- 各伺服器的金鑰建議改用伺服器項目的虛擬金鑰欄位, 它們可以存放在祕密儲存體且永不同步; 參閱[伺服器](servers.md#祕密與祕密儲存體)。

## 提示快取

在 LiteLLM 模型資訊宣告支援提示快取的模型上 (目前為 Anthropic Claude 模型), 延伸模組會把 Anthropic 每個請求的四個快取中斷點, 用在代理程式工作階段各回合間保持不變的部分:

- 最後一個工具定義
- 系統提示
- 第一則使用者訊息
- 最後一則含文字的訊息 (結尾只有工具呼叫或只有圖片的訊息會被略過)

之後每一回合就重複使用前一回合快取的前段, 而不必為工具與整段對話歷史重新支付完整的輸入價格。省下的費用在代理程式模式最明顯, 因為那裡的請求由工具與歷史主導。

兩個要知道的限制:

- 這些標記是 Anthropic 的暫時性快取標記, 沒有明確的 TTL, 所以快取存留期由提供者的預設值決定 (Anthropic 目前約 5 分鐘); 延伸模組不會設定或延長它。
- 未宣告支援的模型永遠不會收到快取標記。

此功能預設開啟; 將 `litellm-vscode-chat.promptCaching.enabled` 設為 `false` 即可關閉。
