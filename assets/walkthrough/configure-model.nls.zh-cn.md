## 配置每个模型的选项

支持推理的模型会在模型选择器中获得一个推理强度控件: 选择该模型, 然后单击聊天输入框中模型名称旁的「Thinking Effort」标签。从 Off 到 Extra High 选择一个级别, 它会随发往该模型的每个请求发送; 「Provider default」不发送任何内容, 因此服务器自己的默认值生效。只接受部分级别的模型会用它们自己的错误消息拒绝其他级别。

自由形式的请求参数 (temperature、top_p、停止序列等) 则通过 `litellm-vscode-chat.modelParameters` 设置按模型配置。
