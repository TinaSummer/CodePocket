const http = require('http')

// Tool definitions — each tool's JSON Schema for MCP tools/list
const TOOLS = [
  {
    name: 'phone_calendar_add',
    description: 'Add an event to the phone system calendar. The user will confirm on their phone before the event is written.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        startTime: { type: 'number', description: 'Start time as Unix timestamp in milliseconds' },
        endTime: { type: 'number', description: 'End time as Unix timestamp in milliseconds (optional)' },
        description: { type: 'string', description: 'Event description (optional)' },
        reminderAlarm: { type: 'number', description: 'Minutes before event to trigger reminder (optional, default 0)' },
      },
      required: ['title', 'startTime'],
    },
  },
  {
    name: 'phone_calendar_query',
    description: 'Query calendar events. Note: the phone cannot read system calendar events; this returns cached data if available.',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'number', description: 'Start of range as Unix timestamp ms' },
        endDate: { type: 'number', description: 'End of range as Unix timestamp ms' },
      },
    },
  },
  {
    name: 'phone_todo_add',
    description: 'Add a todo item. The user will confirm on their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Todo title' },
        dueDate: { type: 'number', description: 'Due date as Unix timestamp ms (optional)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Priority level (optional)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'phone_todo_list',
    description: 'List todo items stored on the phone.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'pending', 'completed'], description: 'Filter todos by status (default: pending)' },
      },
    },
  },
  {
    name: 'phone_todo_complete',
    description: 'Mark a todo item as completed. The user will confirm on their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        todoId: { type: 'string', description: 'The ID of the todo item to complete' },
      },
      required: ['todoId'],
    },
  },
  {
    name: 'phone_notification_send',
    description: 'Send a notification to the phone. The user will confirm on their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body text' },
        at: { type: 'number', description: 'Scheduled time as Unix timestamp ms (optional, send immediately if omitted)' },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'phone_clipboard_write',
    description: 'Write text to the phone clipboard. The user will confirm on their phone.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to write to clipboard' },
      },
      required: ['text'],
    },
  },
]

// phone_calendar_query and phone_todo_list are also sent to the mini-program,
// but the mini-program handles them without showing a confirmation modal.

let pendingPhoneActions = new Map() // actionId -> { resolve, timer, rpcId }
let sendToRelayFn = null
let sseResponse = null // SSE response object for sending events to Claude Code
let messageEndpoint = ''

/**
 * Start the MCP HTTP server.
 * @param {function} relaySender - function(msg) that sends a message to the relay WebSocket
 * @returns {Promise<number>} the port the server is listening on
 */
function startMcpServer(relaySender) {
  sendToRelayFn = relaySender

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // No CORS headers — MCP server is local-only (127.0.0.1), Claude Code doesn't need CORS
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

      if (req.url === '/sse' && req.method === 'GET') {
        handleSSE(req, res)
      } else if (req.url === '/message' && req.method === 'POST') {
        handleMessage(req, res)
      } else {
        res.writeHead(404)
        res.end('Not found')
      }
    })

    // Try ports 3007-3016
    let port = 3007
    function tryListen() {
      server.listen(port, '127.0.0.1', () => {
        console.log(`  [✓] MCP server listening on http://127.0.0.1:${port}`)
        messageEndpoint = `http://127.0.0.1:${port}/message`
        resolve(port)
      })
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < 3017) {
          port++
          server.listen(port, '127.0.0.1')
        } else {
          reject(err)
        }
      })
    }
    tryListen()
  })
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  })

  // Send the endpoint URL as the first event
  res.write(`event: endpoint\ndata: ${messageEndpoint}\n\n`)

  sseResponse = res

  // Heartbeat every 15s to keep SSE connection alive
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat)
      return
    }
    res.write(': heartbeat\n\n')
  }, 15000)

  req.on('close', () => {
    clearInterval(heartbeat)
    if (sseResponse === res) sseResponse = null
  })
}

function handleMessage(req, res) {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    res.writeHead(202)
    res.end('Accepted')

    let rpcMsg
    try { rpcMsg = JSON.parse(body) } catch { return }

    const { id, method, params } = rpcMsg

    if (method === 'initialize') {
      sendSSE({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'codepocket-phone', version: '1.0.0' },
        },
      })
    } else if (method === 'tools/list') {
      sendSSE({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      handleToolCall(id, params)
    } else if (method === 'notifications/initialized') {
      // Client notification, no response needed
    }
  })
}

async function handleToolCall(rpcId, params) {
  const toolName = params?.name
  const toolArgs = params?.arguments || {}

  // All phone tools are sent to the mini-program
  const actionId = 'act_' + Array.from(
    typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint8Array(4))
      : require('crypto').randomBytes(4)
  ).map(b => b.toString(16).padStart(2, '0')).join('')

  if (sendToRelayFn) {
    sendToRelayFn({
      type: 'phone-action',
      actionId,
      tool: toolName,
      params: toolArgs,
      timeout: 60000,
    })
  }

  // Block and wait for phone-action-response (60s timeout)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPhoneActions.delete(actionId)
      resolve({ success: false, error: '操作超时，手机端未响应' })
    }, 60000)

    pendingPhoneActions.set(actionId, { resolve, rpcId, timer })
  })

  sendSSE({ jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
}

/**
 * Called when a phone-action-response is received from the relay.
 */
function handlePhoneActionResponse(msg) {
  const pending = pendingPhoneActions.get(msg.actionId)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingPhoneActions.delete(msg.actionId)
  pending.resolve({
    accepted: msg.accepted,
    result: msg.result,
    error: msg.error,
  })
}

function sendSSE(data) {
  if (sseResponse && !sseResponse.writableEnded) {
    sseResponse.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

module.exports = { startMcpServer, handlePhoneActionResponse }
