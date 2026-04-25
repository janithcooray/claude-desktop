#!/usr/bin/env node
// Cowork approval MCP shim — a minimal stdio MCP server with one tool: `prompt`.
//
// The Claude CLI is launched (by electron/backend.cjs) with
//   --permission-prompt-tool mcp__cowork-approval__prompt
//   --mcp-config <inline-config-pointing-here>
//
// When the CLI hits a gated tool (Bash, Write, Edit, …) it spawns this script
// as a stdio MCP server and invokes our `prompt` tool. We then POST the
// request to the Cowork backend (loopback — the bwrap sandbox keeps the
// network namespace open so 127.0.0.1 is reachable) and wait for the user's
// answer. The CLI's MCP client returns the result to the engine, which uses
// it to either run the tool or report a denial.
//
// Wire format (per docs.claude.com/en/docs/claude-code/iam):
//   tool input  : { tool_name: string, input: object, tool_use_id?: string }
//   tool result : a single text content block whose text is the JSON-stringified
//                 { behavior: 'allow'|'deny', updatedInput?, message? }
//
// This shim is deliberately dependency-free — it boots inside the sandbox,
// where node_modules from the host aren't visible, so it can only use Node's
// built-ins.

'use strict';

const http = require('node:http');
const readline = require('node:readline');

const BACKEND_PORT = Number(process.env.COWORK_BACKEND_PORT || 0);
const BACKEND_HOST = process.env.COWORK_BACKEND_HOST || '127.0.0.1';
const SESSION_ID = process.env.COWORK_SESSION_ID || null;

if (!BACKEND_PORT) {
  // Make the failure mode loud — without the port there's literally no way to
  // reach the user, so we can't fake an "allow" response either. Stderr lands
  // in the CLI's mcp-server logs and Cowork's plugin/MCP log panel.
  process.stderr.write('[cowork-approval] COWORK_BACKEND_PORT not set; cannot reach backend\n');
}

// ----- JSON-RPC helpers (newline-delimited per MCP stdio transport) -----

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  send({ jsonrpc: '2.0', id, error: err });
}

// ----- Backend POST -----

function postApprovalRequest({ toolName, toolUseId, input }) {
  return new Promise((resolve) => {
    if (!BACKEND_PORT) {
      resolve({ behavior: 'deny', message: 'Cowork backend not reachable (no port).' });
      return;
    }
    const body = JSON.stringify({
      toolName,
      toolUseId: toolUseId || null,
      input: input || {},
      sessionId: SESSION_ID,
    });
    const req = http.request(
      {
        host: BACKEND_HOST,
        port: BACKEND_PORT,
        path: '/approval/request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        // No timeout — the user might step away from the keyboard. The
        // backend imposes its own auto-deny ceiling so this can't hang
        // forever.
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({
              behavior: 'deny',
              message: `Cowork backend returned ${res.statusCode}: ${chunks.slice(0, 200)}`,
            });
            return;
          }
          try {
            const parsed = JSON.parse(chunks);
            const behavior = parsed.behavior === 'allow' ? 'allow' : 'deny';
            const out = { behavior };
            if (behavior === 'allow' && parsed.updatedInput && typeof parsed.updatedInput === 'object') {
              out.updatedInput = parsed.updatedInput;
            }
            if (typeof parsed.message === 'string' && parsed.message.length) {
              out.message = parsed.message;
            }
            resolve(out);
          } catch (err) {
            resolve({
              behavior: 'deny',
              message: `Cowork backend sent unparseable response: ${err.message}`,
            });
          }
        });
      },
    );
    req.on('error', (err) => {
      resolve({
        behavior: 'deny',
        message: `Cowork backend unreachable (${err.code || err.message}).`,
      });
    });
    req.write(body);
    req.end();
  });
}

// ----- MCP handlers -----

const PROTOCOL_VERSION = '2024-11-05';

function handleInitialize(id, params) {
  reply(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: 'cowork-approval',
      version: '0.1.0',
    },
  });
}

function handleToolsList(id) {
  reply(id, {
    tools: [
      {
        name: 'prompt',
        description:
          'Cowork user-approval gate. The Claude CLI calls this tool whenever ' +
          'it needs the user to approve a risky action (Bash, Write, Edit, etc.). ' +
          'Cowork forwards the request to the user via its UI and the host ' +
          'desktop environment, then returns allow/deny.',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object' },
            tool_use_id: { type: 'string' },
          },
          required: ['tool_name', 'input'],
        },
      },
    ],
  });
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  if (name !== 'prompt') {
    replyError(id, -32601, `Unknown tool: ${name}`);
    return;
  }
  const args = (params && params.arguments) || {};
  const decision = await postApprovalRequest({
    toolName: args.tool_name || 'unknown',
    toolUseId: args.tool_use_id || null,
    input: args.input || {},
  });
  reply(id, {
    content: [
      { type: 'text', text: JSON.stringify(decision) },
    ],
  });
}

// ----- Dispatch loop -----

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); }
  catch (err) {
    process.stderr.write(`[cowork-approval] bad JSON: ${err.message}\n`);
    return;
  }

  // Notifications (no id, no response). MCP sends `notifications/initialized`
  // after our initialize response; we just acknowledge by ignoring.
  if (msg.id === undefined || msg.id === null) {
    return;
  }

  const method = msg.method;
  switch (method) {
    case 'initialize':
      handleInitialize(msg.id, msg.params);
      break;
    case 'tools/list':
      handleToolsList(msg.id);
      break;
    case 'tools/call':
      // Async — don't await here; the dispatch loop should keep reading
      // pipelined requests. The handler writes its own response when done.
      handleToolCall(msg.id, msg.params || {}).catch((err) => {
        replyError(msg.id, -32603, `Internal error: ${err.message}`);
      });
      break;
    case 'ping':
      reply(msg.id, {});
      break;
    default:
      replyError(msg.id, -32601, `Method not found: ${method}`);
  }
});

rl.on('close', () => {
  process.exit(0);
});

// Don't let unhandled errors silently kill the shim — log them so the user can
// see why approvals stopped working.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[cowork-approval] uncaught: ${err.stack || err.message}\n`);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[cowork-approval] unhandled rejection: ${err && (err.stack || err.message) || err}\n`);
});
