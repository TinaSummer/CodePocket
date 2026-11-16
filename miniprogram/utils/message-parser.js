/**
 * Shared message parser — used by chat page and share preview page.
 *
 * Creates isolated parser instances so multiple sessions can be parsed
 * without shared mutable state (tool-call tracking maps).
 */

const { parseMarkdown } = require('./markdown')

// ── Utility functions (stateless) ──

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  if (isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v) }

function generateId() { return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }

function extractUserText(content) {
  if (typeof content === 'string') return content
  if (isObject(content) && content.type === 'text' && typeof content.text === 'string') return content.text
  if (Array.isArray(content)) {
    return content
      .filter(b => isObject(b) && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('\n')
  }
  return ''
}

function stripPersonaPrefix(text) {
  if (!text || typeof text !== 'string') return text
  return text.replace(/^\[系统人设指令\][\s\S]*?\n\n/, '')
}

function extractToolResultText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(c => isObject(c) && typeof c.text === 'string')
      .map(c => c.text).join('\n')
  }
  if (isObject(content) && typeof content.text === 'string') return content.text
  return ''
}

function unwrapEnvelope(raw) {
  const c = raw.content
  if (!c || typeof c !== 'object') return null
  if (c.role && 'content' in c) return c
  if (isObject(c.message) && c.message.role) return c.message
  if (isObject(c.data) && isObject(c.data.message) && c.data.message.role) return c.data.message
  if (isObject(c.payload) && isObject(c.payload.message) && c.payload.message.role) return c.payload.message
  return null
}

function buildInputDisplay(name, input) {
  if (!isObject(input)) return ''
  switch (name) {
    case 'Edit': case 'MultiEdit': case 'Write': return input.file_path || ''
    case 'Bash': return input.command || input.cmd || ''
    case 'Grep': return input.pattern || input.query || ''
    case 'Glob': return input.pattern || ''
    case 'Read': return input.file_path || ''
    case 'List': return input.dir_path || input.path || ''
    default: return input.file_path || input.path || input.query || input.command || ''
  }
}

function buildDiff(name, input) {
  if (!isObject(input)) return null
  if (name === 'Edit') {
    const lines = []
    ;(input.old_string || '').split('\n').forEach(l => lines.push({ type: 'old', text: l }))
    ;(input.new_string || '').split('\n').forEach(l => lines.push({ type: 'new', text: l }))
    return { filePath: input.file_path || '', lines }
  }
  if (name === 'MultiEdit') {
    const lines = []
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const edit of edits) {
      ;(edit.old_string || '').split('\n').forEach(l => lines.push({ type: 'old', text: l }))
      ;(edit.new_string || '').split('\n').forEach(l => lines.push({ type: 'new', text: l }))
    }
    return { filePath: input.file_path || '', lines }
  }
  if (name === 'Write') {
    const content = input.content || input.text || ''
    const lines = content.split('\n').map(l => ({ type: 'new', text: l }))
    return { filePath: input.file_path || '', lines }
  }
  return null
}

function buildParamSummary(name, input) {
  if (!isObject(input)) return ''
  switch (name) {
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': {
      const p = input.file_path || ''
      return p ? p.split('/').pop() : ''
    }
    case 'Bash': return input.command || input.cmd || ''
    case 'Grep': {
      const parts = []
      if (input.pattern) parts.push(`"${input.pattern}"`)
      if (input.path) parts.push(`in ${input.path.split('/').pop()}`)
      else if (input.glob) parts.push(`in ${input.glob}`)
      return parts.join(' ')
    }
    case 'Glob': return input.pattern || ''
    case 'List': {
      const d = input.dir_path || input.path || ''
      return d ? d.split('/').pop() : ''
    }
    default: return input.file_path || input.path || input.query || input.command || ''
  }
}

function extractPreviewFilePath(toolName, input, resultDisplay) {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return (input && input.file_path) || ''
  }
  if (toolName === 'Bash') {
    const match = (resultDisplay || '').match(/(?:wrote to|created|saved|written to)\s+(\/[^\s]+\.\w+)/i)
    if (match) return match[1]
    const extPattern = /\.(?:txt|md|html|css|js|ts|py|go|rs|json|yaml|yml|xml|svg|png|jpg|jpeg|gif|pdf|doc|xls|ppt|sh|sql)$/i
    const pathMatch = (resultDisplay || '').match(/(\/[^\s]+\.\w{1,10})/g)
    if (pathMatch) {
      const found = pathMatch.find(p => extPattern.test(p))
      if (found) return found
    }
    return ''
  }
  return ''
}

// ── Parser factory ──

/**
 * Create an isolated message parser instance.
 * Each instance tracks its own tool-call state so multiple
 * sessions can be parsed independently.
 */
function createParser() {
  const _toolCallBlocks = new Map()
  const _submittedQuestions = new Set()

  function parseAgentBlocks(contentArray) {
    const blocks = []
    if (!Array.isArray(contentArray)) return blocks

    for (const block of contentArray) {
      if (!isObject(block)) continue

      // Text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        blocks.push({
          type: 'text',
          text: block.text,
          segments: parseMarkdown(block.text),
        })
      }

      // Thinking block
      else if (block.type === 'thinking') {
        const thinkingText = typeof block.text === 'string' ? block.text : (block.thinking || '')
        if (thinkingText.trim()) {
          blocks.push({
            type: 'thinking',
            text: thinkingText,
            summary: thinkingText.split('\n')[0].slice(0, 60),
            collapsed: true,
          })
        }
        continue
      }

      // Tool use block
      else if (block.type === 'tool_use') {
        const name = block.name || 'Tool'
        const toolId = block.id || generateId()

        if (name === 'AskUserQuestion' || name === 'ask_user_question') {
          if (_submittedQuestions.has(toolId)) continue
          const permBlock = {
            type: 'permission',
            requestId: null,
            toolId,
            tool: name,
            input: block.input,
            questions: (isObject(block.input) && Array.isArray(block.input.questions))
              ? block.input.questions : [],
            selectedAnswers: {},
          }
          blocks.push(permBlock)
          _toolCallBlocks.set(toolId, permBlock)
        } else {
          const toolBlock = {
            type: 'tool-call',
            toolId,
            name,
            input: block.input || {},
            inputDisplay: buildInputDisplay(name, block.input),
            paramSummary: buildParamSummary(name, block.input),
            state: 'running',
            result: null,
            resultDisplay: '',
            expanded: false,
            resultExpanded: false,
            diff: buildDiff(name, block.input),
            isError: false,
          }
          blocks.push(toolBlock)
          _toolCallBlocks.set(toolId, toolBlock)
        }
      }

      // Tool result block
      else if (block.type === 'tool_result') {
        const toolUseId = block.tool_use_id
        const toolBlock = _toolCallBlocks.get(toolUseId)
        if (toolBlock) {
          if (toolBlock.type === 'permission') {
            toolBlock.hidden = true
            continue
          }
          toolBlock.state = 'completed'
          toolBlock.result = block.content
          toolBlock.resultDisplay = extractToolResultText(block.content)
          toolBlock.isError = !!block.is_error

          if (!toolBlock.isError) {
            const filePath = extractPreviewFilePath(toolBlock.name, toolBlock.input, toolBlock.resultDisplay)
            if (filePath) {
              toolBlock.hasPreviewableFile = true
              toolBlock.previewFilePath = filePath
            }
          }

          if (isObject(block.content) && block.content.permissions) {
            if (block.content.result === 'approved') {
              toolBlock.state = 'approved'
            }
          }
        }
      }
    }

    return blocks
  }

  function parseOutputData(data) {
    if (!isObject(data)) return null

    if (data.type === 'assistant') {
      const msg = isObject(data.message) ? data.message : null
      if (!msg) return null
      const contentArray = Array.isArray(msg.content) ? msg.content : [msg.content]
      const blocks = parseAgentBlocks(contentArray)
      if (blocks.length === 0) return null
      return { role: 'agent', blocks }
    }

    if (data.type === 'user') {
      const msg = isObject(data.message) ? data.message : null
      if (!msg) return null
      const contentArray = Array.isArray(msg.content) ? msg.content : [msg.content]
      for (const block of contentArray) {
        if (isObject(block) && block.type === 'tool_result') {
          const toolUseId = block.tool_use_id
          const toolBlock = _toolCallBlocks.get(toolUseId)
          if (toolBlock) {
            toolBlock.state = 'completed'
            toolBlock.result = block.content
            toolBlock.resultDisplay = extractToolResultText(block.content)
            toolBlock.isError = !!block.is_error
          }
        }
      }
      return null
    }

    if (data.type === 'summary' && typeof data.summary === 'string' && data.summary.trim()) {
      return {
        role: 'agent',
        blocks: [{ type: 'text', text: data.summary, segments: parseMarkdown(data.summary) }],
      }
    }

    return null
  }

  function parseMessage(m) {
    if (!m || !m.id) return null

    const unwrapped = unwrapEnvelope(m)
    if (!unwrapped) {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return {
        id: m.id, role: 'agent', timeStr: formatTime(m.createdAt),
        blocks: [{ type: 'text', text, segments: parseMarkdown(text) }],
      }
    }

    const { role, content } = unwrapped

    // User message
    if (role === 'user') {
      const rawText = extractUserText(content)
      const text = stripPersonaPrefix(rawText)
      const attachments = []
      if (isObject(m.content)) {
        const att = m.content.attachments || m.content.meta?.attachments
        if (Array.isArray(att)) attachments.push(...att.filter(Boolean))
      }
      return {
        id: m.id, role: 'user', timeStr: formatTime(m.createdAt), text,
        blocks: [{ type: 'text', text, segments: [] }],
        attachments,
      }
    }

    // Agent message
    if (role === 'agent') {
      if (!isObject(content) || typeof content.type !== 'string') {
        const text = typeof content === 'string' ? content : JSON.stringify(content)
        return {
          id: m.id, role: 'agent', timeStr: formatTime(m.createdAt),
          blocks: [{ type: 'text', text, segments: parseMarkdown(text) }],
        }
      }

      if (content.type === 'output') {
        const result = parseOutputData(content.data)
        if (result) {
          return { id: m.id, role: result.role, timeStr: formatTime(m.createdAt), blocks: result.blocks }
        }
        return null
      }

      // Process crash / fatal events must be VISIBLE — dropping them leaves the
      // last visible message as the user's, which the chat page's heuristic
      // reads as "still thinking" → spinner forever with no reply.
      if (content.type === 'event') {
        const evt = content.data || {}
        const msgText = typeof evt.message === 'string' ? evt.message : ''
        if (/Process exited|unexpectedly|fatal/i.test(msgText)) {
          return {
            id: m.id, role: 'agent', timeStr: formatTime(m.createdAt),
            isError: true,
            blocks: [{ type: 'text', text: `⚠️ ${msgText}`, segments: [] }],
          }
        }
        return null
      }

      const text = JSON.stringify(content)
      return {
        id: m.id, role: 'agent', timeStr: formatTime(m.createdAt),
        blocks: [{ type: 'text', text, segments: parseMarkdown(text) }],
      }
    }

    return null
  }

  function captureExpandState(messages) {
    const groupExpanded = {}
    const toolExpanded = {}
    if (!messages) return { groupExpanded, toolExpanded }
    let gi = 0
    for (const msg of messages) {
      if (!msg || !msg.blocks) continue
      for (const block of msg.blocks) {
        if (block.type === 'tool-group') {
          groupExpanded[gi++] = !!block.expanded
          if (block.tools) {
            for (const tool of block.tools) {
              if (tool.toolId) toolExpanded[tool.toolId] = !!tool.expanded
            }
          }
        } else if (block.type === 'tool-call' && block.toolId) {
          toolExpanded[block.toolId] = !!block.expanded
        }
      }
    }
    return { groupExpanded, toolExpanded }
  }

  function mergeToolCallMessages(messages, prevState) {
    if (!messages || messages.length === 0) return messages
    const { groupExpanded = {}, toolExpanded = {} } = prevState || {}
    const result = []
    let accumTools = null
    let accumMsg = null
    let groupIdx = 0

    for (const msg of messages) {
      const isToolOnly = msg.role === 'agent' && msg.blocks &&
        msg.blocks.length > 0 &&
        msg.blocks.every(b => b.type === 'tool-call')

      if (isToolOnly) {
        if (!accumTools) { accumTools = []; accumMsg = msg }
        accumTools.push(...msg.blocks)
      } else {
        if (accumTools) {
          if (accumTools.length === 1) {
            accumMsg.blocks = accumTools
          } else {
            accumMsg.blocks = [{
              type: 'tool-group', tools: accumTools,
              expanded: groupExpanded[groupIdx] !== undefined ? !!groupExpanded[groupIdx] : true,
            }]
            groupIdx++
          }
          result.push(accumMsg)
          accumTools = null; accumMsg = null
        }
        result.push(msg)
      }
    }

    if (accumTools) {
      if (accumTools.length === 1) {
        accumMsg.blocks = accumTools
      } else {
        accumMsg.blocks = [{
          type: 'tool-group', tools: accumTools,
          expanded: groupExpanded[groupIdx] !== undefined ? !!groupExpanded[groupIdx] : true,
        }]
      }
      result.push(accumMsg)
    }

    for (const msg of result) {
      if (!msg.blocks) continue
      for (const block of msg.blocks) {
        if (block.type === 'tool-group' && block.tools) {
          for (const tool of block.tools) {
            tool.expanded = tool.toolId && toolExpanded[tool.toolId] !== undefined
              ? toolExpanded[tool.toolId] : false
          }
        } else if (block.type === 'tool-call' && block.toolId && toolExpanded[block.toolId] !== undefined) {
          block.expanded = toolExpanded[block.toolId]
        }
      }
    }

    return result
  }

  function reset() {
    _toolCallBlocks.clear()
    _submittedQuestions.clear()
  }

  function markQuestionSubmitted(toolId) {
    _submittedQuestions.add(toolId)
  }

  return { parseMessage, mergeToolCallMessages, captureExpandState, reset, markQuestionSubmitted }
}

module.exports = {
  createParser,
  // Standalone stateless utilities for reuse
  formatTime,
  isObject,
  generateId,
  unwrapEnvelope,
  extractUserText,
  stripPersonaPrefix,
  extractToolResultText,
  buildInputDisplay,
  buildDiff,
  buildParamSummary,
  extractPreviewFilePath,
}
