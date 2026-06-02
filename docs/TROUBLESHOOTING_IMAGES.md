# Troubleshooting Image Recognition Issues

This guide helps you diagnose and fix issues when images aren't being recognized or processed correctly in GitHub Copilot Chat with the LiteLLM extension.

## Quick Checklist

- [ ] Is your model configured with `supports_vision: true` in LiteLLM config?
- [ ] Are you using a supported image format (PNG, JPEG, GIF, WebP)?
- [ ] Have you checked the LiteLLM output logs for warnings?
- [ ] Is your LiteLLM server properly forwarding image data to the backend provider?

## Understanding Image Support

The LiteLLM VS Code extension supports sending images to vision-enabled models. Here's how it works:

### Supported Image Formats
- PNG (`image/png`)
- JPEG (`image/jpeg`)
- GIF (`image/gif`)
- WebP (`image/webp`)
- PDF documents (`application/pdf`)

### How Images Are Sent

When you attach an image to a chat message:

1. **Extension Processing**: The extension detects the image in your message
2. **Base64 Encoding**: The image is converted to a base64 data URL
3. **OpenAI Format**: The image is sent as an `image_url` content block in the request
4. **LiteLLM Forwarding**: LiteLLM forwards the image to your configured backend provider
5. **Model Processing**: The vision model analyzes the image and responds

## Common Issues and Solutions

### Issue 1: "Images on stickers cannot be seen"

**Symptoms**: You attach images but the model doesn't seem to recognize or respond to them.

**Possible Causes**:
1. **Model doesn't support vision**: Not all models can process images
2. **Vision capability not advertised**: Model info doesn't include `supports_vision: true`
3. **Backend provider issue**: LiteLLM successfully forwards the image but the backend provider rejects it

**Solutions**:

#### Check Model Vision Support

1. Open the Output panel in VS Code (View → Output)
2. Select "LiteLLM" from the dropdown
3. Look for log entries like:
   ```
   [timestamp] Multimodal content detected
   { images: 1, pdfs: 0, modelSupportsVision: false }
   ```

4. If `modelSupportsVision: false`, you need to:
   - Use a different model that supports vision, OR
   - Update your LiteLLM configuration to advertise vision support

#### Update LiteLLM Model Configuration

In your LiteLLM `config.yaml`, ensure your vision model has the correct flags:

```yaml
model_list:
  - model_name: gpt-4-vision
    litellm_params:
      model: gpt-4-vision-preview
      api_key: os.environ/OPENAI_API_KEY
    model_info:
      supports_vision: true          # Required for image support
      supports_function_calling: true
      max_tokens: 4096
```

#### Restart VS Code

After updating your LiteLLM configuration:
1. Restart your LiteLLM server
2. In VS Code, run "Developer: Reload Window" or restart VS Code
3. The extension will fetch the updated model capabilities

### Issue 2: Warning About Non-Vision Model

**Symptoms**: You see a warning in logs: "Sending images to a model that does not advertise vision support"

**What This Means**: The extension is sending your image, but the model you selected doesn't advertise that it can process images. The request may fail or the image may be ignored.

**Solution**: Select a model that supports vision:
1. Click the model picker in Copilot Chat
2. Look for models in the LiteLLM section that support vision
3. Common vision models:
   - `gpt-4-vision-preview`
   - `gpt-4-turbo` (supports vision)
   - `claude-3-opus`
   - `claude-3-sonnet`
   - `gemini-pro-vision`

### Issue 3: Images Not Appearing in Logs

**Symptoms**: No multimodal content detection logs appear when you send images

**Possible Causes**:
1. Image format not supported
2. Image not properly attached to the message
3. Extension not processing the image data part

**Solutions**:

1. **Verify Image Format**: Ensure your image is PNG, JPEG, GIF, or WebP
2. **Check Attachment**: Make sure the image is attached to the message (not just mentioned)
3. **Check Extension Logs**: Look for any error messages in the LiteLLM output channel

### Issue 4: LiteLLM Server Rejects Image Requests

**Symptoms**: Request fails with 400 or 500 error after sending images

**Possible Causes**:
1. Backend provider doesn't support images
2. Image too large
3. Provider API key lacks vision access
4. LiteLLM configuration error

**Solutions**:

1. **Check LiteLLM Server Logs**: Look at your LiteLLM server logs for specific error messages
2. **Verify Provider Support**: Confirm your backend provider (OpenAI, Anthropic, etc.) supports vision
3. **Check Image Size**: Very large images may exceed API limits
   - Try resizing the image before attaching
   - Most providers support images up to 20MB
4. **Test with cURL**: Verify your LiteLLM setup works with a manual request:

```bash
curl -X POST "http://localhost:4000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "gpt-4-vision-preview",
    "messages": [
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "What is in this image?"
          },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            }
          }
        ]
      }
    ]
  }'
```

## Diagnostic Information

When reporting image recognition issues, please include:

1. **Extension Output Logs**:
   - Open Output panel (View → Output)
   - Select "LiteLLM" from dropdown
   - Copy relevant log entries

2. **Model Information**:
   - Which model are you using?
   - Run "LiteLLM: Show Diagnostics" to see model capabilities

3. **Image Details**:
   - Image format (PNG, JPEG, etc.)
   - Approximate file size
   - How you attached it (drag-drop, paste, etc.)

4. **LiteLLM Configuration**:
   - Relevant portion of your `config.yaml`
   - Backend provider (OpenAI, Anthropic, etc.)

5. **Error Messages**:
   - Any error messages from VS Code
   - Any error messages from LiteLLM server logs

## Advanced Debugging

### Enable Verbose Logging

To see detailed request/response information:

1. Open your `config.yaml`
2. Add debug logging:
   ```yaml
   litellm_settings:
     set_verbose: true
   ```
3. Restart LiteLLM server
4. Check server logs for full request/response bodies

### Inspect Request Body

The extension logs the request being sent. To see if images are included:

1. Open Output panel → LiteLLM
2. Look for "Sending chat request" entries
3. Check if `image_url` blocks appear in the messages

### Test Image Encoding

Verify the extension is correctly encoding images:

1. Use the developer console (Help → Toggle Developer Tools)
2. Send a message with an image
3. Check the Console tab for any JavaScript errors
4. Network tab shows the actual request to LiteLLM

## Getting Help

If you're still experiencing issues:

1. **GitHub Issues**: Open an issue at https://github.com/Vivswan/litellm-vscode-chat/issues
2. **Include**: All diagnostic information listed above
3. **Privacy**: Redact any API keys or sensitive information before sharing logs

## Related Documentation

- [LiteLLM Vision Documentation](https://docs.litellm.ai/docs/completion/vision)
- [OpenAI Vision Guide](https://platform.openai.com/docs/guides/vision)
- [Anthropic Claude Vision](https://docs.anthropic.com/claude/docs/vision)
