/**
 * tools/agent.js
 * Agentic loop — intercepts tool calls from the LLM response,
 * executes them on the backend, and returns only the final clean answer.
 *
 * Supports tool call formats:
 *   1. MiniMax XML:  <minimax:toolcall><invoke name="...">...</invoke></minimax:toolcall>
 *   2. Generic XML:  <invoke name="..."><parameter name="...">...</parameter></invoke>
 *   3. OpenAI JSON:  { tool_calls: [{ function: { name, arguments } }] }
 *
 * Available tools:
 *   - run_command      → executes shell command via cli.js
 *   - web_search       → searches via Brave API
 *   - crawl_url        → fetches and reads a webpage
 *   - read_file        → reads a file from the bot directory
 *   - write_file       → writes a file to the bot directory
 *   - remember         → saves a fact to MEMORY.md
 *   - get_memory       → reads MEMORY.md
 */

import { runCommand }                        from "./cli.js";
import { search, crawl, formatSearchResults, formatCrawlResult } from "./search.js";
import { appendMemory, readMemory }          from "./memory.js";
import fs                                    from "fs";
import path                                  from "path";

const MAX_TOOL_ROUNDS = 5; // prevent infinite loops

// ─── Tool definitions (sent to model as system context) ────────────────────

export const TOOL_DEFINITIONS = `
You have access to the following tools. Use them by outputting XML exactly as shown.

<tool name="run_command">
  Run a shell command on the server.
  <parameter name="command">the shell command to run</parameter>
</tool>

<tool name="web_search">
  Search the web for current information.
  <parameter name="query">search query</parameter>
</tool>

<tool name="crawl_url">
  Fetch and read the contents of a webpage.
  <parameter name="url">full URL to fetch</parameter>
</tool>

<tool name="read_file">
  Read a file from the bot directory.
  <parameter name="path">relative file path e.g. MEMORY.md</parameter>
</tool>

<tool name="remember">
  Save a fact to persistent memory.
  <parameter name="fact">the fact to remember</parameter>
  <parameter name="section">Personal|Preferences|Work|Health|Goals|General</parameter>
</tool>

<tool name="get_memory">
  Read all stored memory about the user.
</tool>

To use a tool, output ONLY this XML — nothing else on that turn:
<invoke name="tool_name">
  <parameter name="param_name">value</parameter>
</invoke>

After receiving the tool result, continue your response normally.
Never show raw tool XML to the user — only show the final answer.
`;

// ─── Parsers ───────────────────────────────────────────────────────────────

/**
 * Detect if a response contains a tool call.
 */
export function hasToolCall(text) {
  return (
    /<invoke\s+name=/.test(text) ||
    /minimax:toolcall/i.test(text) ||
    /<tool_call>/i.test(text)
  );
}

/**
 * Parse tool calls from XML response.
 * Returns array of { name, params }
 */
export function parseToolCalls(text) {
  const calls = [];

  // Strip MiniMax wrapper tags if present
  const cleaned = text
    .replace(/<minimax:toolcall>/gi, "")
    .replace(/<\/minimax:toolcall>/gi, "")
    .replace(/<tool_call>/gi, "")
    .replace(/<\/tool_call>/gi, "");

  // Match all <invoke name="...">...</invoke> blocks
  const invokeRegex = /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  let match;

  while ((match = invokeRegex.exec(cleaned)) !== null) {
    const name   = match[1].trim();
    const body   = match[2];
    const params = {};

    // Parse <parameter name="...">value</parameter>
    const paramRegex = /<parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(body)) !== null) {
      params[paramMatch[1].trim()] = paramMatch[2].trim();
    }

    calls.push({ name, params });
  }

  return calls;
}

/**
 * Extract any plain text before the first tool call tag.
 * (Sometimes the model writes text then calls a tool)
 */
export function extractPreText(text) {
  const idx = text.search(/<invoke\s+name=|<minimax:toolcall/i);
  if (idx <= 0) return "";
  return text.slice(0, idx).trim();
}

// ─── Tool executor ─────────────────────────────────────────────────────────

/**
 * Execute a single tool call and return a result string.
 */
export async function executeTool(name, params, userId = "agent") {
  console.log(`🔧 Tool: ${name}`, params);

  switch (name) {

    case "run_command":
    case "runcommand":
    case "cli-mcp-server-runcommand":
    case "execute_command": {
      const cmd = params.command || params.cmd || "";
      if (!cmd) return "Error: no command provided";
      const result = await runCommand(cmd, userId);
      if (result.blocked) return `Blocked: ${result.reason}`;
      const out = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return out || "(command ran with no output)";
    }

    case "web_search":
    case "search": {
      const query = params.query || params.q || "";
      if (!query) return "Error: no query provided";
      if (!process.env.BRAVE_API_KEY) return "Web search not configured (no BRAVE_API_KEY)";
      const results = await search(query);
      return formatSearchResults(results, query);
    }

    case "crawl_url":
    case "fetch_url":
    case "browse": {
      const url = params.url || params.href || "";
      if (!url) return "Error: no URL provided";
      const result = await crawl(url);
      return formatCrawlResult(result);
    }

    case "read_file": {
      const filePath = path.resolve(params.path || "");
      // Safety: only allow reading within bot directory
      const botDir = path.resolve(".");
      if (!filePath.startsWith(botDir)) return "Error: access denied outside bot directory";
      if (!fs.existsSync(filePath)) return `Error: file not found: ${params.path}`;
      const content = fs.readFileSync(filePath, "utf8");
      return content.slice(0, 3000); // truncate for context
    }

    case "write_file": {
      const filePath = path.resolve(params.path || "");
      const botDir   = path.resolve(".");
      if (!filePath.startsWith(botDir)) return "Error: access denied outside bot directory";
      const content  = params.content || "";
      fs.writeFileSync(filePath, content, "utf8");
      return `File written: ${params.path}`;
    }

    case "remember":
    case "save_memory": {
      const fact    = params.fact || params.content || "";
      const section = params.section || "General";
      if (!fact) return "Error: no fact provided";
      const line = appendMemory(fact, section);
      return `Saved to memory: ${line}`;
    }

    case "get_memory":
    case "read_memory": {
      const mem = readMemory();
      return mem || "(memory is empty)";
    }

    default:
      return `Unknown tool: ${name}. Available: run_command, web_search, crawl_url, read_file, write_file, remember, get_memory`;
  }
}

// ─── Agentic loop ──────────────────────────────────────────────────────────

/**
 * Run the full agentic loop.
 * Keeps calling the LLM + executing tools until a clean text response is returned.
 *
 * @param {Function} llmFn  - async (messages) => string
 * @param {Array}    messages - initial message array
 * @param {string}   userId
 * @returns {string} final clean response to show the user
 */
export async function agentLoop(llmFn, messages, userId = "unknown") {
  let rounds = 0;
  let currentMessages = [...messages];

  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;

    const response = await llmFn(currentMessages);

    // ── No tool call — clean response, return it ──
    if (!hasToolCall(response)) {
      return response;
    }

    // ── Has tool calls — execute them ──
    const toolCalls = parseToolCalls(response);
    const preText   = extractPreText(response);

    if (toolCalls.length === 0) {
      // Detected tag patterns but couldn't parse — strip and return
      const cleaned = response
        .replace(/<minimax:toolcall>[\s\S]*?<\/minimax:toolcall>/gi, "")
        .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
        .trim();
      return cleaned || "I encountered an issue generating a response. Please try again.";
    }

    console.log(`🔄 Agent round ${rounds}: executing ${toolCalls.length} tool(s)`);

    // Execute all tool calls and collect results
    const toolResults = [];
    for (const call of toolCalls) {
      const result = await executeTool(call.name, call.params, userId).catch(
        (err) => `Tool error: ${err.message}`
      );
      toolResults.push({ name: call.name, result });
    }

    // Build tool result message to feed back to LLM
    const resultText = toolResults
      .map((r) => `<tool_result name="${r.name}">\n${r.result}\n</tool_result>`)
      .join("\n\n");

    // Add assistant message (with tool call) + tool results to history
    currentMessages = [
      ...currentMessages,
      { role: "assistant", content: response },
      { role: "user",      content: `Tool results:\n\n${resultText}\n\nNow provide your final answer based on these results. Do not output any more tool calls.` },
    ];
  }

  // Exceeded max rounds — ask for plain answer
  currentMessages.push({
    role: "user",
    content: "Please provide your final answer in plain text now. No more tool calls.",
  });

  const finalResponse = await llmFn(currentMessages);

  // Final safety strip
  return finalResponse
    .replace(/<minimax:toolcall>[\s\S]*?<\/minimax:toolcall>/gi, "")
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, "")
    .trim() || "I was unable to complete that request.";
}
