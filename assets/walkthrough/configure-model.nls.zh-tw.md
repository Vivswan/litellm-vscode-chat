## 設定各模型選項

支援推理的模型會在模型選擇器中取得推理程度控制項: 選取該模型, 然後按一下聊天輸入框中模型名稱旁的「Thinking Effort」標籤。從 Off 到 Extra High 之間挑選一個等級, 它會隨每個送往該模型的請求傳送;「Provider default」不會傳送任何值, 因此套用伺服器自己的預設。只接受部分等級的模型會以其自己的錯誤訊息拒絕其他等級。

自由形式的請求參數 (temperature、top_p、停止序列等) 則改在 `litellm-vscode-chat.modelParameters` 設定中依模型設定。
