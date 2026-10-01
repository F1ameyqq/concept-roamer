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
- Discuss selected note excerpts from the context menu, with a source card and retained context for follow-up questions.
- Desktop pop-out chat using Obsidian's window support.

## Requirements and external service

Requires Obsidian 1.11.4 or later and your own DeepSeek API key. DeepSeek account access and API usage may require payment. The plugin itself does not include API credits.

Requests go directly to `https://api.deepseek.com/chat/completions`. Chat requests send your messages, personality note, manual memory note, and the selected conversation branch. Messages with note excerpts also send the selected text, note title, and relative vault path. Choosing **在漫游中讨论** stages the excerpt locally; pressing **发送** submits it with your question. Concept organization also sends snippets of up to eight relevant Markdown notes, selected by titles, aliases, and quoted sources. Quoted source candidates use the selected excerpt; other candidates use opening snippets. A separate model request is made when you click **开始整理**.

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

To discuss a note, select text in editing, live preview, or reading mode and choose **在漫游中讨论** from the context menu. This starts a new conversation for the excerpt. The plugin reuses an open chat window; desktop creates a pop-out if no chat is open, and mobile opens a chat tab. Review the source card, enter a question, and press **发送**. Sending just the excerpt requests an explanation. The source card links back to the note; **移除** detaches it. Use **在当前漫游中继续** to add the selection to the current conversation instead. The previous conversation stays in history, and returning to it in the same view restores its unsent question and selection. Start a new discussion after the current reply is saved; the continuation option can stage an excerpt while a reply is running. Excerpts are limited to 8,000 characters and count toward the message and conversation budgets. For Android, the commands **在漫游中讨论选中文字** and **在当前漫游中继续讨论选中文字** provide additional entry points.

Saved messages retain the excerpt separately from the typed question, including its source. Follow-up questions, conversation export, automatic naming, and concept organization can use it. Selecting an excerpt alone does not establish the user's authorship or agreement with it.

Sources mentioned in the conversation are marked as unverified. Review model output before relying on it. Automated memory extraction, long-conversation context compression, and lossless archive compression are not included in this release.

## Compatibility and validation

Windows uses a desktop-only HTTPS transport; Android uses browser `fetch` and `ReadableStream`. Desktop Node APIs are guarded by `Platform.isDesktopApp`.

Version 0.2.4 fixes the desktop module-loading failure exposed by upgrading from 0.2.0. The build lowers guarded imports to CommonJS loading, so the renderer does not resolve Node modules as browser URLs. Runtime errors retain their details; browser connection failures are handled at the request boundary.

The current build passes 93 local tests, including compiled desktop requests, module loading, note selection menus, fresh discussion isolation, explicit continuation, excerpt persistence, follow-up context, source links, input limits, and concurrent selection handling. Chrome checks using a simulated Obsidian host and model covered selection menus in editing and reading modes, separate window documents, preserved drafts, source cards, and sending at desktop and narrow widths. The emitted module loader also passed isolated Chrome checks for desktop and mobile routing. Its automatic title display, manual naming, preview, edit, save, and reading behavior were tested in Chrome using a simulated Obsidian host and model response. Android WebView streaming, selection menus, and device synchronization still require real-device validation before a public compatibility claim. Desktop behavior has been tried by the project owner; this does not establish compatibility across other installations.

## Development

```sh
npm ci
npm run build
npm test
```

Output: `dist/concept-roamer/`.

## License

MIT. See [LICENSE](LICENSE). Copyright 2026 F1ameyqq.
