/**
 * help.js — Fetch API.md and render it as HTML in the help modal.
 *
 * Uses a minimal inline Markdown renderer (no external dependencies).
 * Handles: headings, bold, italic, inline code, fenced code blocks,
 * blockquotes, horizontal rules, unordered/ordered lists, paragraphs.
 */

const Help = (() => {
  let _loaded = false;

  // ── Minimal Markdown → HTML renderer ─────────────────────────────────────
  function renderMarkdown(md) {
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    function escHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function inlineFormat(s) {
      // Escape HTML first
      s = escHtml(s);
      // Inline code: `code`
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      // Bold: **text** or __text__
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
      // Italic: *text* or _text_
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
      // Links: [text](url)
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return s;
    }

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          codeLines.push(escHtml(lines[i]));
          i++;
        }
        out.push(`<pre><code${lang ? ` class="lang-${escHtml(lang)}"` : ''}>${codeLines.join('\n')}</code></pre>`);
        i++;
        continue;
      }

      // Horizontal rule
      if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
        out.push('<hr>');
        i++;
        continue;
      }

      // Headings
      const hm = line.match(/^(#{1,6})\s+(.*)/);
      if (hm) {
        const level = hm[1].length;
        out.push(`<h${level}>${inlineFormat(hm[2])}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote
      if (/^>\s?/.test(line)) {
        const bqLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bqLines.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${renderMarkdown(bqLines.join('\n'))}</blockquote>`);
        continue;
      }

      // Unordered list
      if (/^[-*+]\s/.test(line)) {
        out.push('<ul>');
        while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
          out.push(`<li>${inlineFormat(lines[i].replace(/^[-*+]\s/, ''))}</li>`);
          i++;
        }
        out.push('</ul>');
        continue;
      }

      // Ordered list
      if (/^\d+\.\s/.test(line)) {
        out.push('<ol>');
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          out.push(`<li>${inlineFormat(lines[i].replace(/^\d+\.\s/, ''))}</li>`);
          i++;
        }
        out.push('</ol>');
        continue;
      }

      // Blank line
      if (line.trim() === '') {
        i++;
        continue;
      }

      // Paragraph — collect consecutive non-special lines
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^#{1,6}\s/.test(lines[i]) &&
        !/^```/.test(lines[i]) &&
        !/^[-*+]\s/.test(lines[i]) &&
        !/^\d+\.\s/.test(lines[i]) &&
        !/^>\s?/.test(lines[i]) &&
        !/^---+$/.test(lines[i].trim()) &&
        !/^\*\*\*+$/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        out.push(`<p>${inlineFormat(paraLines.join(' '))}</p>`);
      }
    }

    return out.join('\n');
  }

  // ── Open modal and load content ───────────────────────────────────────────
  async function open() {
    const modal   = document.getElementById('modal-help');
    const content = document.getElementById('help-content');
    if (!modal || !content) return;

    modal.style.display = 'flex';

    if (_loaded) return; // already fetched

    content.textContent = 'Loading…';
    try {
      const resp = await fetch('API.md');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      content.innerHTML = renderMarkdown(text);
      _loaded = true;
    } catch (e) {
      content.innerHTML = `<p style="color:var(--red)">Failed to load API.md: ${e.message}</p>`;
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    const btn = document.getElementById('help-btn');
    if (btn) btn.addEventListener('click', open);

    // Close on backdrop click or data-close button (handled by app.js initModalClose,
    // but also wire the backdrop here for safety)
    const modal = document.getElementById('modal-help');
    if (modal) {
      modal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
        modal.style.display = 'none';
      });
    }
  }

  return { init };
})();
