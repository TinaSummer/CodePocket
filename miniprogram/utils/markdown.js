/**
 * Simple markdown parser for WeChat mini-program
 * Converts markdown text to structured segments for rendering
 */

function parseMarkdown(text) {
  if (!text) return []
  const segments = []
  const lines = text.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block: ```lang ... ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip closing ```
      segments.push({ type: 'code', lang, text: codeLines.join('\n') })
      continue
    }

    // Heading (h1–h6)
    if (/^#{1,6}\s/.test(line.trimStart())) {
      segments.push({ type: 'heading', text: formatInline(line.trimStart().replace(/^#{1,6}\s+/, '')) })
      i++
      continue
    }

    // Table: lines starting and ending with |
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const tableLines = []
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      segments.push({ type: 'table', html: parseTable(tableLines) })
      continue
    }

    // List item
    if (/^(\s*[-*]\s|\s*\d+\.\s)/.test(line)) {
      const content = line.replace(/^\s*[-*]\s|\s*\d+\.\s/, '')
      segments.push({ type: 'list-item', text: formatInline(content) })
      i++
      continue
    }

    // Paragraph — collect consecutive non-empty lines
    const paraLines = []
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trimStart().startsWith('```') && !/^#{1,6}\s/.test(lines[i].trimStart()) && !/^(\s*[-*]\s|\s*\d+\.\s)/.test(lines[i]) && !(lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|'))) {
      paraLines.push(lines[i])
      i++
    }
    if (paraLines.length > 0) {
      segments.push({ type: 'text', text: formatInline(paraLines.join('\n')) })
    } else {
      i++
    }
  }

  return segments
}

// Parse markdown table lines into HTML for rich-text
function parseTable(lines) {
  if (lines.length === 0) return ''
  const rows = lines.map(l => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()))
  // Skip separator row (---)
  const dataRows = rows.filter(r => !r.every(c => /^[-:]+$/.test(c)))
  if (dataRows.length === 0) return ''

  let html = '<table style="width:100%;border-collapse:collapse;margin:12rpx 0;font-size:26rpx;line-height:1.6;">'
  dataRows.forEach((row, idx) => {
    const tag = idx === 0 ? 'th' : 'td'
    const bg = idx === 0 ? 'background:rgba(102,126,234,0.06);font-weight:600;' : (idx % 2 === 0 ? 'background:#fafbfc;' : '')
    html += '<tr>'
    row.forEach(cell => {
      html += '<' + tag + ' style="border:1rpx solid #e5e6eb;padding:12rpx 16rpx;' + bg + '">' + formatInline(cell) + '</' + tag + '>'
    })
    html += '</tr>'
  })
  html += '</table>'
  return html
}

// Format inline markdown → HTML for rich-text component
function formatInline(text) {
  // Escape HTML entities
  text = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // Inline code: `code` → styled <code>
  text = text.replace(/`([^`]+)`/g, '<code style="background:#f2f3f5;padding:2px 6px;border-radius:3px;font-family:Menlo,Monaco,monospace;font-size:0.9em;">$1</code>')

  // Bold: **text** → <strong>
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Italic: *text* → <em> (avoid matching **)
  text = text.replace(/(^|[^*])\*([^*]+?)\*([^*]|$)/g, '$1<em>$2</em>$3')

  // Newlines → <br/>
  text = text.replace(/\n/g, '<br/>')

  return text
}

module.exports = { parseMarkdown }
