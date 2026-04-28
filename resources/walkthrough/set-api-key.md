# Set your DeepSeek API key

DeepSeek V4 needs an API key from your DeepSeek account. The key is stored
securely in your OS keychain via VS Code's `SecretStorage` — it is **never**
written to `settings.json` or your project files.

1. Visit [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
   and create a new API key (it will start with `sk-`).
2. Run **Manage DeepSeek V4 Provider** from the Command Palette
   (`Ctrl+Shift+P` / `Cmd+Shift+P`).
3. Paste the key when prompted. The extension will validate it against the
   DeepSeek API before saving.

Once saved, the four DeepSeek V4 variants will be ready to pick from the
Copilot Chat model selector — including extended thinking and agent-mode
tool calling.
