// Render a markdown-ish agent reply into the small HTML subset Telegram accepts
// (parse_mode "HTML"), so fenced code shows as a real code frame instead of
// literal backticks. Everything outside code is HTML-escaped, so stray angle
// brackets (e.g. "/use <id>") render as literal text rather than broken tags.
//
// Telegram HTML supports: <b> <i> <u> <s> <a> <code> <pre>. We convert fenced
// and inline code; other markdown (**, *, links) is left as escaped text — the
// point is the code frame, and heavier conversion means fragile escaping.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// NUL sentinels can't occur in real text and survive HTML-escaping.
const FENCE = /```([\w+#.-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const INLINE = /`([^`\n]+)`/g;
const PLACEHOLDER = /\x00(\d+)\x00/g;

export function toTelegramHtml(input: string): string {
  const blocks: string[] = [];
  // 1. Pull fenced code blocks out first (placeholder) so inline rules and the
  //    global escape don't touch their content.
  let text = input.replace(FENCE, (_m, lang, code) => {
    const cls = lang ? ` class="language-${String(lang).toLowerCase()}"` : "";
    const body = escapeHtml(String(code).replace(/\r?\n$/, ""));
    blocks.push(`<pre><code${cls}>${body}</code></pre>`);
    return "\x00" + (blocks.length - 1) + "\x00";
  });

  // 2. Escape the remaining text.
  text = escapeHtml(text);

  // 3. Inline code -> <code> (content is already HTML-escaped).
  text = text.replace(INLINE, (_m, c) => `<code>${c}</code>`);

  // 4. Restore the fenced code blocks.
  text = text.replace(PLACEHOLDER, (_m, i) => blocks[Number(i)] ?? "");
  return text;
}
