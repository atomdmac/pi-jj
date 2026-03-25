/**
 * Subagent spawning logic
 *
 * Spawns isolated pi processes to execute tasks in workspaces.
 * Adapted from pi's subagent extension example.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { WorkspaceInfo } from "./workspace.js";

export interface SubagentOptions {
  workspace: WorkspaceInfo;
  task: string;
  model?: string;
  tools?: string[];
  signal?: AbortSignal;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SubagentResult {
  success: boolean;
  exitCode: number;
  output: string;
  messages: Message[];
  usage: SubagentUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export type SubagentUpdateCallback = (update: {
  output: string;
  messages: Message[];
  usage: SubagentUsage;
  model?: string;
}) => void;

/**
 * Get the final text output from messages
 */
export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Extract display items (text and tool calls) from messages
 */
export interface DisplayItem {
  type: "text" | "toolCall";
  text?: string;
  name?: string;
  args?: Record<string, any>;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") {
          items.push({ type: "text", text: part.text });
        } else if (part.type === "toolCall") {
          items.push({ type: "toolCall", name: part.name, args: part.arguments });
        }
      }
    }
  }
  return items;
}

/**
 * Determine how to invoke pi
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * Spawn a subagent in a workspace
 */
export async function spawnSubagent(
  options: SubagentOptions,
  onUpdate?: SubagentUpdateCallback
): Promise<SubagentResult> {
  const { workspace, task, model, tools, signal } = options;

  const args: string[] = ["--mode", "json", "-p", "--no-session"];

  if (model) {
    args.push("--model", model);
  }

  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }

  // Add the task as the prompt
  args.push(task);

  const result: SubagentResult = {
    success: false,
    exitCode: 0,
    output: "",
    messages: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
  };

  let wasAborted = false;

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        output: getFinalOutput(result.messages) || "(running...)",
        messages: result.messages,
        usage: result.usage,
        model: result.model,
      });
    }
  };

  try {
    const exitCode = await new Promise<number>((resolve, reject) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: workspace.path,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";
      let stderr = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          result.messages.push(msg);

          if (msg.role === "assistant") {
            result.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              result.usage.input += usage.input || 0;
              result.usage.output += usage.output || 0;
              result.usage.cacheRead += usage.cacheRead || 0;
              result.usage.cacheWrite += usage.cacheWrite || 0;
              result.usage.cost += usage.cost?.total || 0;
              result.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!result.model && msg.model) {
              result.model = msg.model;
            }
            if (msg.stopReason) {
              result.stopReason = msg.stopReason;
            }
            if (msg.errorMessage) {
              result.errorMessage = msg.errorMessage;
            }
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          result.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          processLine(line);
        }
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        if (stderr.trim() && !result.errorMessage) {
          result.errorMessage = stderr.trim();
        }
        resolve(code ?? 0);
      });

      proc.on("error", (err) => {
        reject(err);
      });

      // Handle abort signal
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };

        if (signal.aborted) {
          killProc();
        } else {
          signal.addEventListener("abort", killProc, { once: true });
        }
      }
    });

    result.exitCode = exitCode;
    result.success = exitCode === 0 && result.stopReason !== "error" && !wasAborted;
    result.output = getFinalOutput(result.messages);

    if (wasAborted) {
      result.success = false;
      result.errorMessage = "Subagent was aborted";
    }

    return result;
  } catch (err) {
    result.success = false;
    result.errorMessage = err instanceof Error ? err.message : String(err);
    return result;
  }
}

/**
 * Format token count for display
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Format usage stats for display
 */
export function formatUsageStats(usage: SubagentUsage, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/**
 * Format a tool call for display
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string
): string {
  const shortenPath = (p: string) => {
    const home = process.env.HOME || "";
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      return themeFg("muted", "read ") + themeFg("accent", filePath);
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      return themeFg("muted", "write ") + themeFg("accent", filePath);
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}
