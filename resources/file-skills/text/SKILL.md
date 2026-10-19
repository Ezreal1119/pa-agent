---
name: text-file-output
description: Create downloadable UTF-8 text, HTML, Markdown and source-code files in the current session outputs without executing their content.
---

Use text_file_create only when the user asks for a file. Provide a filename with an allowed text extension and its complete content. Do not wrap file contents in Markdown code fences unless those fences belong in the file itself. Preserve whitespace and line breaks. HTML and source code are delivered as attachments, never executed, compiled or deployed.

Only new files may be created. No directory paths, overwriting, configuration edits, or knowledge/memory writes are allowed. Keep content within the tool limits; if too large, ask to narrow the export or split into useful separate files. Successful files are registered by backend code and displayed as download cards. Do not invent a file ID, link or filesystem path. Failed tool calls do not produce a downloadable file.
