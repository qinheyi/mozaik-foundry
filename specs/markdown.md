# Tiny Markdown to HTML converter

Build a small Markdown-to-HTML library in plain JavaScript.

- Headings `#` to `######` become `<h1>`..`<h6>`.
- Paragraphs are separated by blank lines and wrapped in `<p>`.
- Inline: `**bold**` → `<strong>`, `*italic*` → `<em>`, `` `code` `` → `<code>`, `[text](url)` → `<a href="url">text</a>`.
- Unordered lists (`- item`) and ordered lists (`1. item`) become `<ul>/<ol>` with `<li>`.
- Fenced code blocks (```) become `<pre><code>` with the content HTML-escaped and no inline formatting applied.
- All text content is HTML-escaped (`<`, `>`, `&`, `"`).
- `render(markdown: string): string` is the public entry point.
