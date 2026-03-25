/**
 * RPC Client for communicating with a pi subprocess in RPC mode
 *
 * Spawns pi with --mode rpc and provides methods to send commands
 * and receive events.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { getPiInvocation } from "./subagent.js";

export interface RpcCommand {
  id?: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

export interface MessageUpdateEvent extends RpcEvent {
  type: "message_update";
  message: unknown;
  assistantMessageEvent: {
    type: string;
    delta?: string;
    contentIndex?: number;
    [key: string]: unknown;
  };
}

export interface ToolExecutionEvent extends RpcEvent {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  partialResult?: { content: Array<{ type: string; text?: string }> };
  result?: { content: Array<{ type: string; text?: string }> };
  isError?: boolean;
}

export interface AgentEvent extends RpcEvent {
  type: "agent_start" | "agent_end";
  messages?: unknown[];
}

export interface ExtensionUiRequestEvent extends RpcEvent {
  type: "extension_ui_request";
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeout?: number;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  widgetLines?: string[];
}

export type RpcEventHandler = (event: RpcEvent) => void;

export interface RpcClientOptions {
  cwd: string;
  onEvent?: RpcEventHandler;
  onError?: (error: Error) => void;
  onClose?: (code: number | null) => void;
}

export class RpcClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
  >();
  private options: RpcClientOptions;
  private closed = false;

  constructor(options: RpcClientOptions) {
    this.options = options;
  }

  /**
   * Start the RPC subprocess
   */
  async start(): Promise<void> {
    const invocation = getPiInvocation(["--mode", "rpc", "--no-session"]);

    this.proc = spawn(invocation.command, invocation.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    this.proc.stdout?.on("data", (data) => {
      this.handleData(data.toString());
    });

    this.proc.stderr?.on("data", (data) => {
      // Log stderr but don't treat as fatal
      const text = data.toString().trim();
      if (text && this.options.onError) {
        this.options.onError(new Error(`stderr: ${text}`));
      }
    });

    this.proc.on("close", (code) => {
      this.closed = true;
      // Reject any pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Process closed with code ${code}`));
        this.pendingRequests.delete(id);
      }
      this.options.onClose?.(code);
    });

    this.proc.on("error", (err) => {
      this.options.onError?.(err);
    });

    // Wait a moment for the process to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Send a command and wait for response
   */
  async send(command: RpcCommand): Promise<RpcResponse> {
    if (this.closed || !this.proc?.stdin) {
      throw new Error("RPC client is closed");
    }

    const id = `req-${++this.requestId}`;
    const cmdWithId = { ...command, id };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const json = JSON.stringify(cmdWithId) + "\n";
      this.proc!.stdin!.write(json, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });
  }

  /**
   * Send a command without waiting for response (fire-and-forget)
   */
  sendNoWait(command: RpcCommand): void {
    if (this.closed || !this.proc?.stdin) {
      return;
    }

    const json = JSON.stringify(command) + "\n";
    this.proc.stdin.write(json);
  }

  /**
   * Send a prompt to the agent
   */
  async prompt(message: string): Promise<RpcResponse> {
    return this.send({ type: "prompt", message });
  }

  /**
   * Abort the current operation
   */
  async abort(): Promise<RpcResponse> {
    return this.send({ type: "abort" });
  }

  /**
   * Get current state
   */
  async getState(): Promise<RpcResponse> {
    return this.send({ type: "get_state" });
  }

  /**
   * Respond to an extension UI request
   */
  respondToUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): void {
    this.sendNoWait({
      type: "extension_ui_response",
      id,
      ...response,
    });
  }

  /**
   * Close the RPC connection
   */
  close(): void {
    if (this.proc && !this.closed) {
      this.proc.kill("SIGTERM");
      setTimeout(() => {
        if (this.proc && !this.closed) {
          this.proc.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  /**
   * Check if the client is still connected
   */
  isConnected(): boolean {
    return !this.closed && this.proc !== null;
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete lines
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      // Handle CRLF
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line.trim()) continue;

      try {
        const parsed = JSON.parse(line);
        this.handleMessage(parsed);
      } catch {
        // Ignore parse errors
      }
    }
  }

  private handleMessage(msg: RpcEvent | RpcResponse): void {
    // Check if it's a response to a pending request
    if (msg.type === "response" && "id" in msg && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg as RpcResponse);
        return;
      }
    }

    // Otherwise treat as an event
    this.options.onEvent?.(msg as RpcEvent);
  }
}

/**
 * Helper to extract text delta from message_update events
 */
export function getTextDelta(event: RpcEvent): string | null {
  if (event.type !== "message_update") return null;
  const update = event as MessageUpdateEvent;
  if (update.assistantMessageEvent?.type === "text_delta") {
    return update.assistantMessageEvent.delta || null;
  }
  return null;
}

/**
 * Helper to check if event indicates agent is done
 */
export function isAgentEnd(event: RpcEvent): boolean {
  return event.type === "agent_end";
}

/**
 * Helper to check if event indicates agent started
 */
export function isAgentStart(event: RpcEvent): boolean {
  return event.type === "agent_start";
}

/**
 * Helper to format tool execution for display
 */
export function formatToolEvent(event: RpcEvent): string | null {
  if (event.type === "tool_execution_start") {
    const te = event as ToolExecutionEvent;
    return `→ ${te.toolName}`;
  }
  if (event.type === "tool_execution_end") {
    const te = event as ToolExecutionEvent;
    const status = te.isError ? "✗" : "✓";
    return `${status} ${te.toolName}`;
  }
  return null;
}
