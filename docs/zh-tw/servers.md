# 伺服器

[English](../servers.md) | [简体中文](../zh-cn/servers.md) | 繁體中文

延伸模組可同時連線任意數量的 LiteLLM 伺服器, 並將它們的模型彙整到同一份選擇器清單。伺服器在單一設定中宣告; 每個項目的祕密可以內嵌在設定檔中, 也可以放在 VS Code 加密的祕密儲存體。

## servers 設定

伺服器在 `litellm-vscode-chat.servers` 設定中宣告。[儀表板](dashboard.md)的新增/編輯表單寫入的是同一個設定, 所以兩條路徑始終同步:

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

這個設定的行為:

- 延伸模組會在啟用時以及設定變更時, 自動將項目同步為 VS Code 提供者群組。這裡的一切也都可以從儀表板操作 (「LiteLLM: 開啟儀表板」, 或命令選擇區 -> 「管理 LiteLLM 提供者」 -> 管理伺服器)。
- 這個設定是機器範圍的: 只存在於您的使用者設定, 工作區無法覆寫它 (所以複製下來的儲存庫永遠無法把您的伺服器重新指向另一台主機), 設定同步也不會把它帶到其他機器。
- `label` 是項目的身分。提供者群組以它命名, 因此重新命名項目會建立新群組。舊群組會以舊名稱留下; 延伸模組的通知會點名它並開啟模型檔案, 讓您刪除其物件, 儀表板則把殘留的列標成「外部」, 並在徽章提示中說明這次重新命名。
- 移除項目會隱藏其群組。VS Code 沒有提供移除群組本身的 API, 所以延伸模組會記住這次移除, 對該群組回應空的模型清單 (其模型從選擇器消失), 儀表板則把該列折疊進「隱藏的群組」一行, 並提供「取消隱藏」動作。空殼群組仍存在於主機端: 移除通知會點名確切的群組, 其按鈕會開啟模型檔案 (`<profile>/User/chatLanguageModels.json`) - 從 JSON 陣列刪除該群組的物件, 重新載入視窗, 再執行「立即同步模型」, 空殼就永久消失了。
- 若您重新加入標籤與基底 URL 相同的項目, 隱藏的群組會自行恢復; 也可以透過「隱藏的群組」一行的「取消隱藏」明確恢復。

有一項主機限制貫穿以上所有行為: VS Code 的提供者群組命令能建立群組, 但無法更新或移除。

- 當宣告項目的連線 (URL 或認證) 變更時, 延伸模組無法把變更推入既有群組。伺服器列會顯示錯誤, 提示您從模型檔案刪除該群組的物件、重新載入視窗, 再執行「立即同步模型」, 由項目重新建立群組。
- 基於同樣的原因, 對宣告群組直接進行的原生編輯也會一直保留, 直到該群組被移除並重新同步。
- 模型檔案: VS Code 把群組存放在您使用者資料下的 `<profile>/User/chatLanguageModels.json` (一個有文件說明、可由使用者編輯的檔案), 移除群組就是從那個 JSON 陣列刪除其物件。VS Code 在啟動時讀取此檔並保留在記憶體中, 所以編輯後請結束或重新載入視窗 - 執行中的視窗可能覆寫外部編輯。

## 項目欄位

每個項目帶有標籤、基底 URL, 以及選填的認證、各伺服器模型參數與能力覆寫, 還有該伺服器預期出現的探索失敗。儀表板的新增/編輯表單涵蓋相同欄位。

- 表單的「測試連線」按鈕會以草稿當下輸入的內容直接探測 - 包含尚未儲存的編輯, 已保存的祕密則從其存放處讀取 - 發出一次探索呼叫, 並回報模型數或確切的錯誤 (當失敗看起來是設定問題時, 會附上指向[疑難排解指南](troubleshooting.md#常見問題)對應小節的連結)。它不會儲存或同步任何東西。探測會遵循草稿的 `expectedFailures` 與 `_declare` 項目: 預期的探索失敗會回報該項目將提供的宣告模型, 而不是硬性錯誤。

| 設定鍵 | 說明 |
|-------------|-------------|
| `label` | 伺服器在模型選擇器中的名稱; 項目的身分 (見上文) |
| `baseUrl` | 伺服器的根 URL, 例如 `http://localhost:4000`。延伸模組會自行附加 `/v1`, 所以請省略任何 `/v1` 結尾; 貼上 `.../v1` 的 URL 會請求 `/v1/v1/...` 而失敗 |
| `apiKey` | 以 `Authorization` bearer 加上一份 `X-API-Key` 副本傳送; 伺服器不需要時可省略 |
| `oauthTokenUrl` | 身分識別提供者的權杖端點, 例如 `https://idp.example.com/oauth2/token` |
| `oauthClientId` | 用戶端認證授與的用戶端 ID; 必須與權杖 URL 一併設定 |
| `oauthClientSecret` | 用戶端密碼; 未核發密碼的公用用戶端請省略。可存放在祕密儲存體, 或內嵌寫入 |
| `oauthScopes` | 選填, 隨權杖請求的範圍, 以空格分隔 |
| `virtualKeyHeader` | 選填, 攜帶 LiteLLM 虛擬金鑰的自訂標頭名稱, 例如 `x-litellm-api-key`。命名為 `Authorization` 時, 整個標頭交給虛擬金鑰使用, 且不會為此伺服器取得 OAuth 權杖 |
| `virtualKeyValue` | 虛擬金鑰本身; 可存放在祕密儲存體, 或內嵌寫入 |
| `modelParameters` | 只套用於此項目請求的請求參數; 參閱[模型參數](model-parameters.md#各項目參數) |
| `modelCapabilities` | 此項目模型的能力覆寫, 包含 `_declare` 項目; 參閱[模型能力](model-capabilities.md#各項目能力) |
| `expectedFailures` | 此處預期失敗的探索端點 (`"modelListing"`、`"modelInfo"`): 各只嘗試一次, 記錄為預期, 不計入伺服器錯誤; 參閱[模型能力](model-capabilities.md#預期的探索失敗) |

## 祕密與祕密儲存體

祕密欄位 (`apiKey`、`oauthClientSecret`、`virtualKeyValue`) 可逐項目選擇存放方式:

- 若可以接受設定檔中出現純文字值, 就內嵌寫入祕密。
- 或者省略它, 改存 VS Code 祕密儲存體: 透過儀表板表單的「儲存於: 祕密儲存體」選項, 或「LiteLLM: 設定伺服器祕密」命令。
- 內嵌值優先於已儲存的值。

哪些值會回顯到儀表板:

- 祕密儲存體中的值永遠不會; 表單顯示的是值存放在哪裡, 而不是值本身。
- 內嵌值會預填到編輯表單 (以「顯示」切換遮罩), 因為它們本來就以純文字存在您的 settings.json 中。

當延伸模組需要為認證保留一個非祕密的識別 (例如維持同步狀態一致的變更偵測器) 時, 它儲存的是以隨機的每次安裝專屬祕密為鍵的指紋, 而非一般雜湊, 所以那些記錄對「能讀取延伸模組狀態但讀不到祕密儲存體」的任何程式都不會洩漏認證的任何資訊 - 即使是短而易猜的 API 金鑰也一樣。

編輯已儲存的項目時:

- 清空的祕密欄位會保留原本儲存的值; 這不會清除祕密。
- 刪除祕密是明確的選擇: 編輯表單會在每個已有值的祕密欄位下方顯示「儲存時移除已儲存的...」核取方塊。

解除安裝延伸模組前移除祕密的方式, 參閱[疑難排解](troubleshooting.md#解除安裝與清理)。

## 虛擬金鑰

虛擬金鑰是 LiteLLM Proxy 自己核發的金鑰, 可限定於某個預算、團隊或一組模型 (參閱 [LiteLLM 的虛擬金鑰文件](https://docs.litellm.ai/docs/proxy/virtual_keys))。

- 大多數閘道把虛擬金鑰當成一般的 bearer token 接受, 這種情況下它和其他金鑰一樣放進 `apiKey` 即可。
- `virtualKeyHeader`/`virtualKeyValue` 這一對欄位只給改用自訂標頭接收金鑰的閘道使用, 例如 `x-litellm-api-key`:

```jsonc
{
	"label": "Team A",
	"baseUrl": "https://litellm.example.com",
	"virtualKeyHeader": "x-litellm-api-key",
	"virtualKeyValue": "sk-..." // or keep it in secret storage instead
}
```

## OAuth 用戶端認證驗證

有些 LiteLLM 閘道位於身分識別提供者之後, 拒絕靜態 API 金鑰。針對這類閘道, 請在伺服器項目上設定 OAuth2 用戶端認證驗證:

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

在儀表板表單中, 相同欄位位於「OAuth 與虛擬金鑰 (選填)」之下; 對於延伸模組不管理的外部伺服器, 它們存放在模型檔案中。

權杖 URL 與用戶端 ID 都設定後會發生什麼:

- 延伸模組用用戶端認證交換短效 bearer token, 在每個送往該伺服器的請求上以 `Authorization` 標頭傳送, 並在到期前不久自行更新。
- 未核發密碼的公用用戶端可省略用戶端密碼。
- 同一伺服器上設定的靜態 API 金鑰仍會以 `X-API-Key` 標頭與 bearer token 一併送出, 供同時檢查兩者的閘道使用。
- 若閘道另外要求[虛擬金鑰](#虛擬金鑰), 請設定兩個虛擬金鑰欄位, 該標頭就會隨每個請求傳送。例外是把虛擬金鑰標頭命名為 `Authorization`: 這會把整個標頭交給虛擬金鑰, 並完全略過該伺服器的 OAuth 權杖交換。
- 權杖交換受探索逾時約束; 被拒絕的權杖會被捨棄, 下一個請求會重新取得。

## 各伺服器模型參數

項目可以攜帶自己的 `modelParameters`: 與全域 `litellm-vscode-chat.modelParameters` 設定相同的前置詞鍵記錄, 但只套用於經由此項目的請求。

- 基底 URL 限定無法分辨指向同一主機的兩個項目 (例如各用一把虛擬金鑰), 這就是鎖定其中一個的方式。
- 儀表板的編輯表單有對應的「此伺服器的模型參數」區段。
- 比對與優先順序規則以及完整範例, 參閱[模型參數](model-parameters.md)。

## 各伺服器能力與預期失敗

另外兩個項目欄位針對探索資料錯誤或缺失的伺服器:

- `modelCapabilities` 修正探索為此項目模型回報的內容, 其 `_declare` 項目會註冊探索列不出的模型。
- `expectedFailures` 指名此伺服器預期失敗的探索端點, 讓這些失敗被記錄為預期, 而不是計作故障。

兩者連同範例參閱[模型能力](model-capabilities.md)。

## 外部伺服器與採用

群組在本延伸模組之外新增的伺服器仍可運作; 由於它們沒有設定項目, 儀表板會把它們標示為「外部」。當延伸模組知道來歷時, 徽章的提示會說明該列從何而來: 已移除項目的殘留 (點名該項目), 或重新命名的殘留 (列出新舊標籤)。沒有記錄時, 該群組是在本延伸模組之外新增, 或早於這項追蹤。

外部列提供兩個動作:

- **移除**會隱藏群組: 其模型從選擇器消失, 該列移入「隱藏的群組」一行, 與移除宣告項目相同。後續通知會點名該群組, 其按鈕開啟模型檔案, 您可以在那裡刪除空殼的物件以永久清除。
- **編輯**會把群組採用進設定:

1. 在外部列上按一下「編輯」; 那就是採用動作。
2. 挑選項目的標籤。表單會預填群組目前的標籤, 但通常值得改名: 名稱仍被現有 VS Code 群組使用的項目, 在該群組的物件從模型檔案刪除之前無法同步。
3. 挑選每個祕密的存放位置 (祕密儲存體, 或內嵌於設定)。認證值在延伸模組內部複製, 絕不經過儀表板頁面。
4. 儲存: 群組的連線細節成為新的 `litellm-vscode-chat.servers` 項目, 這個伺服器就和任何宣告的伺服器一樣可以編輯。
5. 從模型檔案刪除原始群組的物件並重新載入視窗。採用無法移除它 (VS Code 沒有這樣的 API), 所以在您動手之前其模型會重複出現; 採用完成後儀表板會提醒您這件事。

## 多台機器與設定同步

伺服器及其認證停留在您輸入它們的那台機器上:

- `servers` 設定是機器範圍的; 設定同步 (Settings Sync) 永遠不會攜帶它。
- VS Code 祕密儲存體中的值也不會同步。
- 在第二台機器上, 請重新加入伺服器及其金鑰。

其他一切都會自行到位: 其餘每個 `litellm-vscode-chat.*` 設定都正常同步, 包括逾時、`modelParameters` 與 `headers`。最後這一項是雙面刃: 放在 [`headers` 設定](settings.md#自訂-http-標頭)中的閘道金鑰會複寫到您同步的每一台機器。
