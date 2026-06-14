/**
 * canvas-renderer.js — Canvas 2D renderer for chat export
 *
 * Draws chat messages as a high-fidelity image closely matching the
 * WeChat mini-program chat page UI.
 *
 * Two-phase architecture: layout -> paint
 *   layoutSessions(sessions, ctx, config) -> { commands, totalHeight }
 *   paintCommands(ctx, commands, canvas, dpr, config)
 *
 * Main export: layoutAndPaint(sessions, canvas, config) -> totalHeight
 */

// ── Constants ──

const FONT_BODY = '-apple-system, sans-serif'
const FONT_MONO = 'Menlo, Monaco, "Courier New", monospace'

const MAX_SAFE_HEIGHT = 8000
const DEFAULT_WIDTH = 750
const PADDING = 24

// ── Theme lookup ──

function getTheme(wallpaper, cardMode) {
  const t = {
    bg: '#f5f7fa',
    userBubble: '#667eea',
    userText: '#ffffff',
    agentBubble: cardMode ? 'rgba(255,255,255,0.45)' : 'transparent',
    agentText: '#1d2129',
    cardBg: cardMode ? 'rgba(255,255,255,0.88)' : '#ffffff',
    cardBorder: '#d4d0c8',
    footerBg: '#ffffff',
    footerText: '#86909c',
    footerBrand: '#667eea',
    codeBg: '#f6f8fa',
    codeHeaderText: '#86909c',
    codeText: '#1d2129',
    tableBorder: '#e5e6eb',
    tableHeaderBg: 'rgba(102,126,234,0.06)',
    tableAltBg: '#fafbfc',
    thinkingText: '#86909c',
    toolNameText: '#4e5969',
    toolParamText: '#86909c',
    statusRunning: '#667eea',
    statusCompleted: '#00a856',
    statusError: '#f53f3f',
    statusApproved: '#00a856',
    dividerColor: '#e5e6eb',
    sessionHeaderText: '#1d2129',
    sessionSubText: '#86909c',
    listDot: '#86909c',
    permBg: 'rgba(255,125,0,0.06)',
    permBorder: 'rgba(255,125,0,0.15)',
    permBadge: '#ff7d00',
    permBadgeText: '#ff7d00',
    permText: '#4e5969',
  }

  if (wallpaper === 'paper') {
    t.bg = '#fefcf3'
  } else if (wallpaper === 'misty') {
    t.bg = '#e8ecf1'
  } else if (wallpaper === 'peach') {
    t.bg = '#ffecd2'
  } else if (wallpaper === 'night') {
    t.bg = '#2f3136'
    t.agentBubble = cardMode ? 'rgba(40,40,40,0.7)' : 'transparent'
    t.agentText = '#e5eaf0'
    t.cardBg = cardMode ? 'rgba(40,40,40,0.7)' : '#2a2b2f'
    t.cardBorder = 'rgba(255,255,255,0.15)'
    t.footerBg = '#2a2b2f'
    t.footerText = '#86909c'
    t.codeBg = 'rgba(50,54,58,0.6)'
    t.codeHeaderText = 'rgba(255,255,255,0.5)'
    t.codeText = 'rgba(255,255,255,0.85)'
    t.tableBorder = 'rgba(255,255,255,0.12)'
    t.tableHeaderBg = 'rgba(102,126,234,0.12)'
    t.tableAltBg = 'rgba(255,255,255,0.04)'
    t.thinkingText = 'rgba(255,255,255,0.45)'
    t.toolNameText = 'rgba(255,255,255,0.7)'
    t.toolParamText = 'rgba(255,255,255,0.45)'
    t.statusRunning = '#818cf8'
    t.statusCompleted = '#34d399'
    t.statusError = '#f87171'
    t.dividerColor = 'rgba(255,255,255,0.08)'
    t.sessionHeaderText = 'rgba(255,255,255,0.95)'
    t.sessionSubText = 'rgba(255,255,255,0.45)'
    t.listDot = 'rgba(255,255,255,0.4)'
    t.permBg = 'rgba(80,60,20,0.3)'
    t.permBorder = 'rgba(255,180,0,0.2)'
    t.permBadge = '#fbbf24'
    t.permBadgeText = '#fbbf24'
    t.permText = 'rgba(255,255,255,0.6)'
  }

  return t
}

// ══════════════════════════════════════
//  Canvas drawing helpers
// ══════════════════════════════════════

/**
 * Draw a rounded rectangle with per-corner radii.
 * radii = [topLeft, topRight, bottomRight, bottomLeft]
 */
function drawRoundRect(ctx, x, y, w, h, radii, fill) {
  const [tl, tr, br, bl] = radii
  ctx.beginPath()
  ctx.moveTo(x + tl, y)
  ctx.lineTo(x + w - tr, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + tr)
  ctx.lineTo(x + w, y + h - br)
  ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h)
  ctx.lineTo(x + bl, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - bl)
  ctx.lineTo(x, y + tl)
  ctx.quadraticCurveTo(x, y, x + tl, y)
  ctx.closePath()
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
}

/**
 * Word-wrap text into lines. Returns array of strings.
 */
function wrapText(ctx, text, maxWidth) {
  const lines = []
  const paragraphs = text.split('\n')
  for (const para of paragraphs) {
    if (!para) {
      lines.push('')
      continue
    }
    let line = ''
    for (const ch of para) {
      const test = line + ch
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line)
        line = ch
      } else {
        line = test
      }
    }
    lines.push(line)
  }
  return lines
}

/**
 * Draw text with word-wrap. Returns the height used.
 */
function drawText(ctx, text, x, y, font, fill, maxWidth) {
  ctx.font = font
  ctx.fillStyle = fill
  const lines = wrapText(ctx, text, maxWidth)
  const lh = parseInt(font, 10) * 1.75
  lines.forEach((l, i) => {
    ctx.fillText(l, x, y + i * lh)
  })
  return lines.length * lh
}

// ══════════════════════════════════════
//  Inline markdown segment renderer
// ══════════════════════════════════════

/**
 * Strip HTML tags from inline-formatted text for canvas rendering.
 * Returns plain text with no HTML.
 */
function stripInline(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

/**
 * Parse inline-formatted text (with HTML tags) into styled spans.
 * Returns [{ text, bold, italic, code }]
 */
function parseInlineSpans(text) {
  const spans = []
  // Strategy: walk through the text, extract styled segments
  let remaining = text

  // Replace <br/> with newline markers
  remaining = remaining.replace(/<br\s*\/?>/gi, '\n')

  // Match styled elements: <strong>, <em>, <code>
  const tagRe = /<(strong|em|code)\s+[^>]*>([\s\S]*?)<\/\1>|<(strong|em|code)>([\s\S]*?)<\/\3>/g

  let lastIndex = 0
  let match
  const re = /<(strong|em|code)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g
  while ((match = re.exec(remaining)) !== null) {
    // Plain text before this match
    if (match.index > lastIndex) {
      const plain = remaining.slice(lastIndex, match.index)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      if (plain) spans.push({ text: plain, bold: false, italic: false, code: false })
    }
    const tag = match[1]
    const content = match[2]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    spans.push({
      text: content,
      bold: tag === 'strong',
      italic: tag === 'em',
      code: tag === 'code',
    })
    lastIndex = re.lastIndex
  }

  // Remaining plain text
  if (lastIndex < remaining.length) {
    const plain = remaining.slice(lastIndex)
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    if (plain) spans.push({ text: plain, bold: false, italic: false, code: false })
  }

  if (spans.length === 0 && text) {
    spans.push({ text: stripInline(text), bold: false, italic: false, code: false })
  }

  return spans
}

/**
 * Measure width of inline spans (with mixed styles).
 */
function measureInlineWidth(ctx, spans, baseFont, monoFont) {
  let w = 0
  for (const s of spans) {
    ctx.font = s.bold ? baseFont.replace('sans-serif', 'sans-serif') && ('bold ' + baseFont) :
               s.code ? monoFont : baseFont
    // Fix font for bold
    if (s.bold) {
      ctx.font = 'bold ' + baseFont
    } else if (s.code) {
      ctx.font = monoFont
    } else {
      ctx.font = baseFont
    }
    w += ctx.measureText(s.text).width
  }
  return w
}

/**
 * Draw inline spans at position, wrapping to maxWidth.
 * Returns { height, lines: number }
 */
function drawInlineSpans(ctx, spans, x, y, baseFont, monoFont, fill, maxWidth) {
  ctx.fillStyle = fill
  const baseFontSize = parseInt(baseFont, 10) || 28
  const lineHeight = baseFontSize * 1.75

  // Flatten all text into a word-wrapable structure, then render spans inline.
  // Simplified approach: render spans sequentially, wrapping at word boundaries.
  let curX = x
  let curY = y
  let linesUsed = 1

  for (const span of spans) {
    if (span.code) {
      ctx.font = '22px ' + FONT_MONO
    } else if (span.bold) {
      ctx.font = 'bold ' + baseFont
    } else if (span.italic) {
      ctx.font = 'italic ' + baseFont
    } else {
      ctx.font = baseFont
    }

    // Break text into characters for wrapping
    const chars = span.text
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]
      if (ch === '\n') {
        curX = x
        curY += lineHeight
        linesUsed++
        continue
      }
      const cw = ctx.measureText(ch).width
      if (curX + cw > x + maxWidth && curX > x) {
        curX = x
        curY += lineHeight
        linesUsed++
      }
      ctx.fillText(ch, curX, curY)
      curX += cw
    }
  }

  return { height: linesUsed * lineHeight, lines: linesUsed }
}

// ══════════════════════════════════════
//  Phase 1: Layout
// ══════════════════════════════════════

/**
 * Layout all sessions into draw commands.
 *
 * @param {Array} sessions - Array of session objects:
 *   { name, agent, path, messages: [{ role, blocks, text, timeStr }] }
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context (for measureText)
 * @param {Object} config - { width, wallpaper, cardMode, maxMsgPerSession, maxTextLen }
 * @returns {{ commands: Array, totalHeight: number }}
 */
function layoutSessions(sessions, ctx, config) {
  const W = config.width || DEFAULT_WIDTH
  const wallpaper = config.wallpaper || ''
  const cardMode = !!config.cardMode
  const maxMsg = config.maxMsgPerSession || 20
  const maxTextLen = config.maxTextLen || 500
  const theme = getTheme(wallpaper, cardMode)

  // Font definitions
  const F_BODY = '28px ' + FONT_BODY
  const F_BODY_SMALL = '22px ' + FONT_BODY
  const F_HEADING = 'bold 32px ' + FONT_BODY
  const F_MONO = '22px ' + FONT_MONO
  const F_MONO_SMALL = '20px ' + FONT_MONO
  const F_SESSION_NAME = 'bold 30px ' + FONT_BODY
  const F_SESSION_SUB = '22px ' + FONT_BODY
  const F_FOOTER_BRAND = 'bold 24px ' + FONT_BODY
  const F_FOOTER_TAG = '22px ' + FONT_BODY
  const F_THINKING = 'italic 22px ' + FONT_BODY
  const F_TOOL_NAME = '500 22px ' + FONT_MONO
  const F_TOOL_PARAM = '22px ' + FONT_MONO
  const F_PERM_BADGE = 'bold 22px ' + FONT_BODY

  const LINE_H = 28 * 1.75 // ~49
  const MONO_LINE_H = 22 * 1.6  // ~35
  const MSG_PADDING_H = 18
  const MSG_PADDING_V = 24

  const commands = []
  let y = 20 // top margin

  for (let si = 0; si < sessions.length; si++) {
    const session = sessions[si]
    const msgs = (session.messages || []).slice(-maxMsg)
    if (!msgs.length) continue

    // ── Session header ──
    if (si > 0) {
      // Divider line
      const divY = y + 10
      commands.push({ type: 'line', x1: PADDING, y1: divY, x2: W - PADDING, y2: divY, stroke: theme.dividerColor, width: 0.5 })
      y = divY + 16
    }

    const sessName = session.name || 'CodePocket'
    ctx.font = F_SESSION_NAME
    commands.push({ type: 'text', text: sessName, x: PADDING, y: y + 30, font: F_SESSION_NAME, fill: theme.sessionHeaderText })
    y += 38

    const subParts = []
    if (session.agent) subParts.push(session.agent)
    if (session.path) subParts.push(session.path)
    if (subParts.length > 0) {
      const subText = subParts.join(' \u00B7 ')
      commands.push({ type: 'text', text: subText, x: PADDING, y: y + 22, font: F_SESSION_SUB, fill: theme.sessionSubText })
      y += 30
    }
    y += 8

    // ── Messages ──
    for (const msg of msgs) {
      const isUser = msg.role === 'user'
      const blocks = msg.blocks || []

      if (isUser) {
        // User bubble
        let text = ''
        if (msg.text) {
          text = msg.text
        } else {
          for (const b of blocks) {
            if (b.type === 'text' && b.text) text += (text ? '\n' : '') + b.text
          }
        }
        if (!text) continue
        if (text.length > maxTextLen) text = text.slice(0, maxTextLen) + '...'

        ctx.font = F_BODY
        const BUBBLE_MAX_W = W - PADDING * 2 - 32 - 40 - 48
        const lines = wrapText(ctx, text, BUBBLE_MAX_W)
        const textW = Math.max(120, ...lines.map(l => ctx.measureText(l).width))
        const bubbleW = Math.min(BUBBLE_MAX_W + 48, textW + 48)
        const bubbleH = lines.length * LINE_H + MSG_PADDING_H * 2

        const bx = W - PADDING - 32 - bubbleW
        const by = y

        // border-radius: 20rpx 6rpx 20rpx 20rpx (10, 3, 10, 10 in px)
        commands.push({
          type: 'roundRect',
          x: bx, y: by, w: bubbleW, h: bubbleH,
          radii: [10, 3, 10, 10],
          fill: theme.userBubble,
        })

        lines.forEach((l, i) => {
          commands.push({
            type: 'text',
            text: l,
            x: bx + 24,
            y: by + MSG_PADDING_H + 28 + i * LINE_H,
            font: F_BODY,
            fill: theme.userText,
          })
        })

        y += bubbleH + 24

      } else {
        // Agent message — render each block
        for (const block of blocks) {
          y = layoutAgentBlock(ctx, block, y, W, theme, cardMode, maxTextLen, commands,
            F_BODY, F_BODY_SMALL, F_HEADING, F_MONO, F_MONO_SMALL,
            F_THINKING, F_TOOL_NAME, F_TOOL_PARAM, F_PERM_BADGE,
            LINE_H, MONO_LINE_H)
        }
      }
    }
  }

  // ── Footer ──
  y += 20
  const footerH = 90
  commands.push({ type: 'rect', x: 0, y: y, w: W, h: footerH, fill: theme.footerBg })
  commands.push({ type: 'text', text: 'CodePocket', x: PADDING, y: y + 36, font: F_FOOTER_BRAND, fill: theme.footerBrand })
  commands.push({ type: 'text', text: 'Code in your pocket', x: PADDING, y: y + 64, font: F_FOOTER_TAG, fill: theme.footerText })
  y += footerH

  // Cap to safe height
  if (y > MAX_SAFE_HEIGHT) y = MAX_SAFE_HEIGHT

  return { commands, totalHeight: y }
}

/**
 * Layout a single agent block. Returns the new y position.
 */
function layoutAgentBlock(ctx, block, y, W, theme, cardMode, maxTextLen, commands,
  F_BODY, F_BODY_SMALL, F_HEADING, F_MONO, F_MONO_SMALL,
  F_THINKING, F_TOOL_NAME, F_TOOL_PARAM, F_PERM_BADGE,
  LINE_H, MONO_LINE_H) {

  const LEFT_X = PADDING + 16
  const TEXT_MAX_W = W - PADDING * 2 - 40 - 16

  switch (block.type) {

    case 'text': {
      let text = block.text || ''
      if (!text.trim()) return y
      if (text.length > maxTextLen) text = text.slice(0, maxTextLen) + '...'

      // Check if this has segments (parsed markdown)
      const segments = block.segments
      if (segments && segments.length > 0) {
        for (const seg of segments) {
          y = layoutSegment(ctx, seg, y, LEFT_X, TEXT_MAX_W, W, theme, cardMode, commands,
            F_BODY, F_BODY_SMALL, F_HEADING, F_MONO, F_MONO_SMALL, LINE_H, MONO_LINE_H)
        }
      } else {
        // Plain text
        ctx.font = F_BODY
        const lines = wrapText(ctx, text, TEXT_MAX_W)
        lines.forEach((l, i) => {
          commands.push({
            type: 'text',
            text: l,
            x: LEFT_X,
            y: y + 28 + i * LINE_H,
            font: F_BODY,
            fill: theme.agentText,
          })
        })
        y += lines.length * LINE_H + 12
      }
      break
    }

    case 'thinking': {
      const summary = block.summary || block.text?.split('\n')[0]?.slice(0, 60) || 'Thought complete'
      const displayText = 'Thought complete \u2014 ' + summary
      commands.push({
        type: 'text',
        text: displayText,
        x: LEFT_X,
        y: y + 22,
        font: F_THINKING,
        fill: theme.thinkingText,
      })
      y += 34
      break
    }

    case 'tool-call': {
      y = layoutToolCard(ctx, block, y, LEFT_X, TEXT_MAX_W, W, theme, cardMode, commands,
        F_TOOL_NAME, F_TOOL_PARAM, F_MONO, F_MONO_SMALL, MONO_LINE_H)
      break
    }

    case 'tool-group': {
      const tools = block.tools || []
      const count = tools.length

      // Header row
      const headerH = 44
      // Circle icon
      commands.push({
        type: 'circle',
        x: LEFT_X + 10, y: y + headerH / 2, r: 10,
        fill: theme.statusCompleted,
      })
      ctx.font = F_TOOL_PARAM
      const groupLabel = count + ' steps \u00B7 View Steps'
      commands.push({
        type: 'text',
        text: groupLabel,
        x: LEFT_X + 28,
        y: y + headerH / 2 + 8,
        font: F_TOOL_PARAM,
        fill: theme.toolParamText,
      })
      y += headerH + 4

      // If expanded, show each tool
      if (block.expanded !== false) {
        for (const tool of tools) {
          y = layoutToolCard(ctx, tool, y, LEFT_X + 12, TEXT_MAX_W - 12, W, theme, cardMode, commands,
            F_TOOL_NAME, F_TOOL_PARAM, F_MONO, F_MONO_SMALL, MONO_LINE_H)
        }
      }
      break
    }

    case 'permission': {
      y = layoutPermissionCard(ctx, block, y, LEFT_X, TEXT_MAX_W, W, theme, commands,
        F_PERM_BADGE, F_TOOL_PARAM, F_BODY)
      break
    }
  }

  return y
}

/**
 * Layout a markdown segment within an agent message.
 */
function layoutSegment(ctx, seg, y, x, maxW, W, theme, cardMode, commands,
  F_BODY, F_BODY_SMALL, F_HEADING, F_MONO, F_MONO_SMALL, LINE_H, MONO_LINE_H) {

  switch (seg.type) {

    case 'heading': {
      const text = stripInline(seg.text || '')
      ctx.font = F_HEADING
      const lines = wrapText(ctx, text, maxW)
      lines.forEach((l, i) => {
        commands.push({
          type: 'text',
          text: l,
          x: x,
          y: y + 32 + i * (32 * 1.5),
          font: F_HEADING,
          fill: theme.agentText,
        })
      })
      y += lines.length * (32 * 1.5) + 16
      break
    }

    case 'code': {
      const lang = seg.lang || ''
      const codeText = seg.text || ''
      const maxCodeLen = 500
      const truncatedCode = codeText.length > maxCodeLen ? codeText.slice(0, maxCodeLen) + '...' : codeText

      ctx.font = F_MONO
      const codeLines = wrapText(ctx, truncatedCode, maxW - 40)
      const headerH = lang ? 36 : 0
      const codeH = codeLines.length * MONO_LINE_H + 24

      // Background
      commands.push({
        type: 'roundRect',
        x: x, y: y, w: Math.min(maxW, W - x - PADDING), h: headerH + codeH,
        radii: [6, 6, 6, 6],
        fill: theme.codeBg,
      })

      // Lang header
      if (lang) {
        commands.push({
          type: 'line',
          x1: x, y1: y + headerH, x2: x + Math.min(maxW, W - x - PADDING), y2: y + headerH,
          stroke: theme.dividerColor, width: 0.5,
        })
        commands.push({
          type: 'text',
          text: lang,
          x: x + 16,
          y: y + 24,
          font: F_BODY_SMALL,
          fill: theme.codeHeaderText,
        })
      }

      // Code lines
      codeLines.forEach((l, i) => {
        commands.push({
          type: 'text',
          text: l,
          x: x + 16,
          y: y + headerH + 16 + 20 + i * MONO_LINE_H,
          font: F_MONO,
          fill: theme.codeText,
        })
      })

      y += headerH + codeH + 12
      break
    }

    case 'table': {
      // Parse HTML table back into rows
      const rows = parseTableHtml(seg.html || '')
      if (rows.length === 0) break

      ctx.font = F_BODY_SMALL
      const cellPadding = 12
      const colCount = rows[0].length
      const tableW = Math.min(maxW, W - x - PADDING)
      const colW = tableW / colCount

      let tableH = 0
      for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri]
        let rowH = 36
        for (let ci = 0; ci < row.length; ci++) {
          const cellText = stripInline(row[ci] || '')
          const cellLines = wrapText(ctx, cellText, colW - cellPadding * 2)
          rowH = Math.max(rowH, cellLines.length * (22 * 1.5) + 16)
        }

        // Row background
        const rowFill = ri === 0 ? theme.tableHeaderBg : (ri % 2 === 0 ? theme.tableAltBg : 'transparent')

        commands.push({
          type: 'tableRow',
          x: x,
          y: y + tableH,
          w: tableW,
          h: rowH,
          fill: rowFill,
          cells: row.map((cell, ci) => ({
            text: stripInline(cell || ''),
            x: x + ci * colW,
            y: y + tableH,
            w: colW,
            h: rowH,
            isHeader: ri === 0,
          })),
          border: theme.tableBorder,
          font: F_BODY_SMALL,
          fill_text: theme.agentText,
          colW,
          cellPadding,
        })

        tableH += rowH
      }

      // Table outer border
      commands.push({
        type: 'roundRect',
        x: x, y: y, w: tableW, h: tableH,
        radii: [4, 4, 4, 4],
        fill: null,
        stroke: theme.tableBorder,
        strokeWidth: 0.5,
      })

      y += tableH + 12
      break
    }

    case 'list-item': {
      const text = seg.text || ''
      const plainText = stripInline(text)
      const indent = 16
      const dotX = x + indent
      const textX = dotX + 18

      // Bullet dot
      commands.push({
        type: 'text',
        text: '\u2022',
        x: dotX,
        y: y + 28,
        font: F_BODY,
        fill: theme.listDot,
      })

      ctx.font = F_BODY
      const itemLines = wrapText(ctx, plainText, maxW - indent - 18)
      itemLines.forEach((l, i) => {
        commands.push({
          type: 'text',
          text: l,
          x: textX,
          y: y + 28 + i * LINE_H,
          font: F_BODY,
          fill: theme.agentText,
        })
      })
      y += itemLines.length * LINE_H + 6
      break
    }

    case 'text':
    default: {
      // Paragraph — may contain inline formatting
      const rawText = seg.text || ''
      if (!rawText) break

      // Check for inline HTML (bold, italic, code)
      const hasInline = /<(strong|em|code)/.test(rawText)

      if (hasInline) {
        // Render with inline spans
        const spans = parseInlineSpans(rawText)
        // Measure total height by simulating wrap
        const { height } = measureInlineHeight(ctx, spans, x, maxW, F_BODY, F_MONO)
        commands.push({
          type: 'inline',
          spans,
          x: x,
          y: y + 28,
          maxW,
          font: F_BODY,
          monoFont: F_MONO,
          fill: theme.agentText,
          height,
        })
        y += height + 12
      } else {
        const plainText = stripInline(rawText)
        ctx.font = F_BODY
        const lines = wrapText(ctx, plainText, maxW)
        lines.forEach((l, i) => {
          commands.push({
            type: 'text',
            text: l,
            x: x,
            y: y + 28 + i * LINE_H,
            font: F_BODY,
            fill: theme.agentText,
          })
        })
        y += lines.length * LINE_H + 12
      }
      break
    }
  }

  return y
}

/**
 * Measure height needed for inline spans with wrapping.
 */
function measureInlineHeight(ctx, spans, startX, maxW, baseFont, monoFont) {
  const baseFontSize = parseInt(baseFont, 10) || 28
  const lineHeight = baseFontSize * 1.75
  let curX = startX
  let lines = 1

  for (const span of spans) {
    if (span.code) {
      ctx.font = monoFont
    } else if (span.bold) {
      ctx.font = 'bold ' + baseFont
    } else if (span.italic) {
      ctx.font = 'italic ' + baseFont
    } else {
      ctx.font = baseFont
    }

    for (let i = 0; i < span.text.length; i++) {
      const ch = span.text[i]
      if (ch === '\n') {
        curX = startX
        lines++
        continue
      }
      const cw = ctx.measureText(ch).width
      if (curX + cw > startX + maxW && curX > startX) {
        curX = startX
        lines++
      }
      curX += cw
    }
  }

  return { height: lines * lineHeight, lines }
}

/**
 * Layout a tool-call card.
 */
function layoutToolCard(ctx, block, y, x, maxW, W, theme, cardMode, commands,
  F_TOOL_NAME, F_TOOL_PARAM, F_MONO, F_MONO_SMALL, MONO_LINE_H) {

  const headerH = 50

  // Status dot color
  let dotColor = theme.statusCompleted
  if (block.state === 'running') dotColor = theme.statusRunning
  else if (block.state === 'error' || block.isError) dotColor = theme.statusError
  else if (block.state === 'approved') dotColor = theme.statusApproved

  // Status dot
  commands.push({
    type: 'circle',
    x: x + 8, y: y + headerH / 2, r: 4,
    fill: dotColor,
  })

  // Tool name
  const toolName = block.name || 'tool'
  ctx.font = F_TOOL_NAME
  const nameW = ctx.measureText(toolName).width
  commands.push({
    type: 'text',
    text: toolName,
    x: x + 22,
    y: y + headerH / 2 + 8,
    font: F_TOOL_NAME,
    fill: theme.toolNameText,
  })

  // Param summary
  let paramSummary = ''
  if (block.inputDisplay) {
    paramSummary = block.inputDisplay
  } else if (block.input) {
    const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input).slice(0, 200)
    paramSummary = inputStr
  }
  if (paramSummary.length > 80) paramSummary = paramSummary.slice(0, 80) + '...'

  if (paramSummary) {
    const paramX = x + 22 + nameW + 12
    const paramMaxW = maxW - (paramX - x)
    if (paramMaxW > 60) {
      commands.push({
        type: 'text',
        text: paramSummary,
        x: paramX,
        y: y + headerH / 2 + 8,
        font: F_TOOL_PARAM,
        fill: theme.toolParamText,
      })
    }
  }

  y += headerH

  // If there's a result, show truncated
  if (block.result && block.state !== 'running') {
    let resultText = ''
    if (block.resultDisplay) {
      resultText = block.resultDisplay
    } else {
      resultText = typeof block.result === 'string' ? block.result : JSON.stringify(block.result)
    }
    if (resultText.length > 200) resultText = resultText.slice(0, 200) + '...'

    if (resultText.trim()) {
      const resultX = x + 12
      ctx.font = F_MONO_SMALL
      const resultLines = wrapText(ctx, resultText, maxW - 24)
      const resultH = resultLines.length * MONO_LINE_H + 12

      const resultBg = block.isError ? 'rgba(245,63,63,0.06)' : theme.codeBg
      commands.push({
        type: 'roundRect',
        x: resultX, y: y, w: Math.min(maxW, W - resultX - PADDING), h: resultH,
        radii: [4, 4, 4, 4],
        fill: resultBg,
      })

      resultLines.forEach((l, i) => {
        commands.push({
          type: 'text',
          text: l,
          x: resultX + 10,
          y: y + 12 + 18 + i * MONO_LINE_H,
          font: F_MONO_SMALL,
          fill: block.isError ? theme.statusError : theme.codeText,
        })
      })

      y += resultH + 8
    }
  }

  return y
}

/**
 * Layout a permission card.
 */
function layoutPermissionCard(ctx, block, y, x, maxW, W, theme, commands,
  F_PERM_BADGE, F_TOOL_PARAM, F_BODY) {

  const cardW = Math.min(maxW * 0.85, W - x - PADDING)
  const innerX = x + 16
  const innerW = cardW - 32
  let cardH = 16 // top padding

  // Badge
  cardH += 28

  // Tool name / detail
  const toolDetail = block.tool || ''
  if (toolDetail) {
    ctx.font = F_TOOL_PARAM
    const detailLines = wrapText(ctx, toolDetail, innerW)
    cardH += detailLines.length * 33 + 12
  }

  // Question text
  if (block.questions && block.questions.length > 0) {
    for (const q of block.questions) {
      const qText = typeof q === 'string' ? q : (q.text || q.question || '')
      if (qText) {
        ctx.font = F_BODY
        const qLines = wrapText(ctx, qText, innerW)
        cardH += qLines.length * 49 + 8
      }
    }
  } else {
    cardH += 8
  }

  cardH += 16 // bottom padding

  // Card background
  commands.push({
    type: 'roundRect',
    x: x, y: y, w: cardW, h: cardH,
    radii: [10, 10, 10, 10],
    fill: theme.permBg,
    stroke: theme.permBorder,
    strokeWidth: 0.5,
  })

  // Badge text
  commands.push({
    type: 'text',
    text: 'PERMISSION RESOLVED',
    x: innerX,
    y: y + 30,
    font: F_PERM_BADGE,
    fill: theme.permBadgeText,
  })

  let cy = y + 46

  // Tool detail
  if (toolDetail) {
    ctx.font = F_TOOL_PARAM
    const detailLines = wrapText(ctx, toolDetail, innerW)
    detailLines.forEach((l, i) => {
      commands.push({
        type: 'text',
        text: l,
        x: innerX,
        y: cy + 18 + i * 33,
        font: F_TOOL_PARAM,
        fill: theme.permText,
      })
    })
    cy += detailLines.length * 33 + 12
  }

  // Questions
  if (block.questions && block.questions.length > 0) {
    for (const q of block.questions) {
      const qText = typeof q === 'string' ? q : (q.text || q.question || '')
      if (qText) {
        ctx.font = F_BODY
        const qLines = wrapText(ctx, qText, innerW)
        qLines.forEach((l, i) => {
          commands.push({
            type: 'text',
            text: l,
            x: innerX,
            y: cy + 28 + i * 49,
            font: F_BODY,
            fill: theme.agentText,
          })
        })
        cy += qLines.length * 49 + 8
      }
    }
  }

  y += cardH + 16
  return y
}

/**
 * Parse table HTML back into 2D string array.
 */
function parseTableHtml(html) {
  if (!html) return []
  const rows = []
  const trRe = /<tr>([\s\S]*?)<\/tr>/g
  let trMatch
  while ((trMatch = trRe.exec(html)) !== null) {
    const cells = []
    const cellRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g
    let cellMatch
    while ((cellMatch = cellRe.exec(trMatch[1])) !== null) {
      cells.push(stripInline(cellMatch[1]))
    }
    if (cells.length > 0) rows.push(cells)
  }
  return rows
}

// ══════════════════════════════════════
//  Phase 2: Paint
// ══════════════════════════════════════

/**
 * Paint all layout commands onto the canvas.
 */
function paintCommands(ctx, commands, canvas, dpr, config) {
  const W = config.width || DEFAULT_WIDTH
  const theme = getTheme(config.wallpaper || '', !!config.cardMode)

  // Setup canvas dimensions
  let totalH = 0
  for (const cmd of commands) {
    const maxY = (cmd.y || 0) + (cmd.h || 0) + (cmd.height || 0)
    if (maxY > totalH) totalH = maxY
  }
  // Find the max y from text commands too
  for (const cmd of commands) {
    if (cmd.type === 'text' && cmd.y) {
      if (cmd.y > totalH) totalH = cmd.y
    }
    if (cmd.type === 'line' && cmd.y1) {
      if (cmd.y1 > totalH) totalH = cmd.y1
    }
  }
  totalH += 10

  if (totalH > MAX_SAFE_HEIGHT) totalH = MAX_SAFE_HEIGHT

  canvas.width = W * dpr
  canvas.height = totalH * dpr
  ctx.scale(dpr, dpr)

  // Background
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, W, totalH)

  // Draw commands
  for (const cmd of commands) {
    paintCommand(ctx, cmd)
  }

  return totalH
}

function paintCommand(ctx, cmd) {
  switch (cmd.type) {
    case 'rect':
      ctx.fillStyle = cmd.fill
      ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h)
      break

    case 'roundRect':
      drawRoundRect(ctx, cmd.x, cmd.y, cmd.w, cmd.h, cmd.radii, cmd.fill || null)
      if (cmd.stroke) {
        ctx.strokeStyle = cmd.stroke
        ctx.lineWidth = cmd.strokeWidth || 1
        ctx.stroke()
      }
      break

    case 'text':
      ctx.font = cmd.font
      ctx.fillStyle = cmd.fill
      ctx.fillText(cmd.text, cmd.x, cmd.y)
      break

    case 'inline':
      drawInlineSpans(ctx, cmd.spans, cmd.x, cmd.y, cmd.font, cmd.monoFont, cmd.fill, cmd.maxW)
      break

    case 'line':
      ctx.strokeStyle = cmd.stroke || cmd.fill
      ctx.lineWidth = cmd.width || 1
      ctx.beginPath()
      ctx.moveTo(cmd.x1, cmd.y1)
      ctx.lineTo(cmd.x2, cmd.y2)
      ctx.stroke()
      break

    case 'circle':
      ctx.beginPath()
      ctx.arc(cmd.x, cmd.y, cmd.r, 0, Math.PI * 2)
      ctx.fillStyle = cmd.fill
      ctx.fill()
      break

    case 'tableRow':
      // Draw row background
      if (cmd.fill && cmd.fill !== 'transparent') {
        ctx.fillStyle = cmd.fill
        ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h)
      }
      // Draw cells
      ctx.font = cmd.font
      for (const cell of cmd.cells) {
        // Cell border
        ctx.strokeStyle = cmd.border
        ctx.lineWidth = 0.5
        ctx.strokeRect(cell.x, cmd.y, cmd.w / cmd.cells.length, cmd.h)
        // Cell text
        ctx.fillStyle = cmd.fill_text
        const lines = wrapText(ctx, cell.text, cmd.colW - cmd.cellPadding * 2)
        lines.forEach((l, i) => {
          ctx.fillText(l, cell.x + cmd.cellPadding, cmd.y + 20 + i * (22 * 1.5))
        })
      }
      break
  }
}

// ══════════════════════════════════════
//  Main export
// ══════════════════════════════════════

/**
 * Layout and paint all sessions onto a canvas.
 *
 * @param {Array} sessions - Session objects with messages
 * @param {Object} canvas - WeChat canvas node
 * @param {Object} config - { width, wallpaper, cardMode, maxMsgPerSession, maxTextLen }
 * @returns {number} totalHeight of the rendered image
 */
function layoutAndPaint(sessions, canvas, config) {
  if (!config) config = {}
  if (!sessions || sessions.length === 0) return 0
  const ctx = canvas.getContext('2d')
  let dpr = 2
  try { dpr = wx.getWindowInfo().pixelRatio || 2 } catch (_) {
    try { dpr = wx.getSystemInfoSync().pixelRatio || 2 } catch (__) {}
  }

  // Phase 1: Layout (uses ctx for measureText)
  const { commands, totalHeight } = layoutSessions(sessions, ctx, config)

  // Phase 2: Paint
  const paintedHeight = paintCommands(ctx, commands, canvas, dpr, config)

  return paintedHeight || totalHeight
}

module.exports = { layoutAndPaint }
