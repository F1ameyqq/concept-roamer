# Concept Roamer / 概念漫游

Discuss concepts with DeepSeek in Obsidian and turn a conversation into an editable Markdown concept note. Connect the note to existing notes and keep a linked conversation summary.

[中文说明](README.zh-CN.md)

## Features

- Streaming chat with cancellation and recovery of interrupted replies.
- Editable personality and a shared, manually maintained memory note.
- Concept notes covering definitions, mechanisms, examples, boundaries, applications, and open questions.
- Preview and edit generated Markdown before saving.
- Suggestions for links to existing notes, plus a conversation summary.
- Separate export of the original conversation.
- Automatic conversation titles that evolve with the discussion, plus manual naming.
- Desktop pop-out chat using Obsidian's window support.

## Requirements and external service

Requires Obsidian 1.11.4 or later and your own DeepSeek API key. DeepSeek account access and API usage may require payment. The plugin itself does not include API credits.

Requests go directly to `https://api.deepseek.com/chat/completions`. Chat requests send your messages, personality note, manual memory note, and the selected conversation branch. Concept organization also sends the opening snippets of up to eight relevant Markdown notes, selected by titles and aliases. A separate model request is made when you click **开始整理**.

Automatic titles are enabled by default. Naming runs in the background after the first complete reply, then after every three additional complete replies. Opening an older conversation can also name it if it has no generated title. Each naming operation makes an additional DeepSeek request with bounded opening and recent conversation excerpts, without the personality or memory notes; normal API charges apply. Disable it in settings or use **标题** to save a fixed manual title. Naming failures preserve the current title and do not block chat.

The plugin does not include analytics, a developer-operated proxy, or an updater. DeepSeek handles submitted content according to its own service terms and [privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html).

The API key is managed through Obsidian SecretStorage. Plugin settings store the secret's name. Conversation JSON, generated notes, personality, and memory live inside your vault under `概念漫游/`. Recovery drafts are stored locally through Obsidian's local storage API.

## Installation and use

This plugin has not yet been published to the community directory. For manual installation, copy `main.js`, `manifest.json`, and `styles.css` from a GitHub release into `.obsidian/plugins/concept-roamer/` inside your vault, then enable **Concept Roamer** in Community plugins. The chat interface and commands use Chinese labels.

1. Set your DeepSeek key and a model available to your account in plugin settings.
2. Open the chat with the ribbon icon or the **打开聊天** command.
3. Enter sends a message; Shift+Enter inserts a newline.
4. After a discussion, select **整理并保存**, optionally specify a concept, and click **开始整理**.
5. Review or edit the result, then select **保存到知识库**.

Concept notes are saved in `概念漫游/概念/`; conversation summaries are stored alongside the corresponding session. Existing files are preserved when names conflict.

Sources mentioned in the conversation are marked as unverified. Review model output before relying on it. Automated memory extraction, long-conversation context compression, and lossless archive compression are not included in this release.

## Compatibility and validation

Windows uses a desktop-only HTTPS transport; Android uses browser `fetch` and `ReadableStream`. Desktop Node APIs are guarded by `Platform.isDesktopApp`.

Version 0.2.4 fixes the desktop module-loading failure exposed by upgrading from 0.2.0. The build lowers guarded imports to CommonJS loading, so the renderer does not resolve Node modules as browser URLs. Runtime errors retain their details; browser connection failures are handled at the request boundary.

The current build passes 63 local tests, including the compiled desktop chat and title request path, guarded module loading, and error reporting. The emitted module loader also passed isolated Chrome checks for desktop and mobile routing. Its automatic title display, manual naming, preview, edit, save, and reading behavior were tested in Chrome using a simulated Obsidian host and model response. Android WebView streaming and device synchronization still require real-device validation before a public compatibility claim. Desktop behavior has been tried by the project owner; this does not establish compatibility across other installations.

## Development

```sh
npm ci
npm run build
npm test
```

Output: `dist/concept-roamer/`.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 F1ameyqq.
