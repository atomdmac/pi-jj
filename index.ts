/**
 * pi-jj: jj VCS Workspace Extension for pi coding agent
 *
 * Provides tools and commands to create jj workspaces and spawn
 * isolated subagent sessions to work on tasks within them.
 *
 * Features:
 * - LLM tool: jj_workspace - Create workspace and delegate task
 * - Command: /jj-workspace - Interactive workspace creation
 * - Session state tracking for workspace metadata
 * - Lifecycle management: keep, squash, delete
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  Text,
  Container,
  Spacer,
  Box,
  Input,
  matchesKey,
  Key,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  jjVersion,
  jjWorkspaceList,
  jjLog,
  jjDiff,
  jjGetStatusInfo,
  sanitizeWorkspaceName,
} from "./lib/jj.js";
import {
  createWorkspace,
  handleWorkspaceLifecycle,
  promptLifecycleAction,
  validateJJEnvironment,
  type WorkspaceInfo,
  type WorkspaceLifecycleAction,
} from "./lib/workspace.js";
import {
  spawnSubagent,
  getFinalOutput,
  getDisplayItems,
  formatUsageStats,
  formatToolCall,
  getPiInvocation,
  type SubagentResult,
  type SubagentUsage,
} from "./lib/subagent.js";
import {
  RpcClient,
  getTextDelta,
  isAgentEnd,
  isAgentStart,
  formatToolEvent,
  type RpcEvent,
  type ExtensionUiRequestEvent,
} from "./lib/rpc-client.js";
import {
  SessionWatcher,
  findWorkspaceSessionFiles,
  formatSessionEntry,
  getSessionSummary,
  type SessionEntry,
} from "./lib/session-watcher.js";
import { spawn } from "node:child_process";

// Custom entry type for session persistence
const WORKSPACE_ENTRY_TYPE = "pi-jj-workspace";

interface WorkspaceEntry {
  workspace: WorkspaceInfo;
  result?: SubagentResult;
  lifecycleAction?: WorkspaceLifecycleAction;
  lifecycleMessage?: string;
}

// Tool result details
interface JJWorkspaceDetails {
  workspace: WorkspaceInfo;
  result?: SubagentResult;
  lifecycleAction?: WorkspaceLifecycleAction;
  lifecycleMessage?: string;
}

/**
 * Interactive RPC Session View Component
 *
 * Displays streaming output from a pi subprocess and allows sending prompts.
 */
class RpcSessionView implements Component, Focusable {
  private outputLines: string[] = [];
  private maxOutputLines = 500;
  private status: "connecting" | "idle" | "running" | "error" | "closed" = "connecting";
  private errorMessage?: string;
  private currentTool?: string;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedRender?: string[];

  private input: Input;
  private _focused = false;

  public rpcClient?: RpcClient;
  public workspaceName: string;
  public workspacePath: string;
  public onClose?: () => void;
  public requestRenderFn?: () => void;

  // Focusable implementation
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(workspaceName: string, workspacePath: string) {
    this.workspaceName = workspaceName;
    this.workspacePath = workspacePath;
    this.input = new Input();
  }

  appendOutput(text: string): void {
    // Split text into lines and add to output
    const lines = text.split("\n");
    for (const line of lines) {
      if (line || this.outputLines.length > 0) {
        this.outputLines.push(line);
      }
    }

    // Trim to max lines
    while (this.outputLines.length > this.maxOutputLines) {
      this.outputLines.shift();
    }

    // Auto-scroll to bottom
    this.scrollOffset = 0;
    this.invalidate();
    this.requestRenderFn?.();
  }

  setStatus(status: typeof this.status, error?: string): void {
    this.status = status;
    this.errorMessage = error;
    this.invalidate();
    this.requestRenderFn?.();
  }

  setCurrentTool(tool?: string): void {
    this.currentTool = tool;
    this.invalidate();
    this.requestRenderFn?.();
  }

  handleInput(data: string): void {
    // Handle escape to close
    if (matchesKey(data, Key.escape)) {
      this.onClose?.();
      return;
    }

    // Handle Ctrl+C to abort
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.status === "running" && this.rpcClient) {
        this.rpcClient.abort().catch(() => {});
        this.appendOutput("\n[Aborting...]");
      }
      return;
    }

    // Handle scroll
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.scrollOffset = Math.min(this.scrollOffset + 10, Math.max(0, this.outputLines.length - 5));
      this.invalidate();
      this.requestRenderFn?.();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.invalidate();
      this.requestRenderFn?.();
      return;
    }

    // Handle enter to send prompt
    if (matchesKey(data, Key.enter)) {
      const text = this.input.getValue().trim();
      if (text && this.status === "idle" && this.rpcClient) {
        this.input.setValue("");
        this.appendOutput(`\n> ${text}\n`);
        this.setStatus("running");

        this.rpcClient.prompt(text).then((response) => {
          if (!response.success) {
            this.appendOutput(`\n[Error: ${response.error}]\n`);
            this.setStatus("idle");
          }
        }).catch((err) => {
          this.appendOutput(`\n[Error: ${err.message}]\n`);
          this.setStatus("idle");
        });
      }
      return;
    }

    // Pass other input to the input component
    this.input.handleInput?.(data);
    this.invalidate();
    this.requestRenderFn?.();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRender) {
      return this.cachedRender;
    }

    const lines: string[] = [];

    // Header
    const statusIcon =
      this.status === "connecting" ? "⏳" :
      this.status === "running" ? "▶" :
      this.status === "idle" ? "●" :
      this.status === "error" ? "✗" : "○";

    const statusText =
      this.status === "connecting" ? "Connecting..." :
      this.status === "running" ? (this.currentTool ? `Running (${this.currentTool})` : "Running...") :
      this.status === "idle" ? "Ready" :
      this.status === "error" ? `Error: ${this.errorMessage}` : "Closed";

    const header = `${statusIcon} ${this.workspaceName} - ${statusText}`;
    lines.push(truncateToWidth(`\x1b[1m${header}\x1b[0m`, width));
    lines.push(truncateToWidth(`\x1b[2m${this.workspacePath}\x1b[0m`, width));
    lines.push("─".repeat(Math.min(width, 80)));

    // Calculate available height for output (reserve 4 lines for header + 3 for input/footer)
    const outputHeight = 15; // Fixed height for output area

    // Render output with scroll
    const visibleStart = Math.max(0, this.outputLines.length - outputHeight - this.scrollOffset);
    const visibleEnd = Math.min(this.outputLines.length, visibleStart + outputHeight);
    const visibleLines = this.outputLines.slice(visibleStart, visibleEnd);

    for (const line of visibleLines) {
      // Wrap long lines
      const wrapped = wrapTextWithAnsi(line, width);
      for (const wl of wrapped) {
        lines.push(truncateToWidth(wl, width));
      }
    }

    // Pad to fixed height
    while (lines.length < outputHeight + 3) {
      lines.push("");
    }

    // Scroll indicator
    if (this.outputLines.length > outputHeight) {
      const scrollInfo = this.scrollOffset > 0
        ? `[${this.scrollOffset} lines below, PgUp/PgDn to scroll]`
        : `[${Math.max(0, this.outputLines.length - outputHeight)} lines above]`;
      lines.push(truncateToWidth(`\x1b[2m${scrollInfo}\x1b[0m`, width));
    } else {
      lines.push("");
    }

    // Separator
    lines.push("─".repeat(Math.min(width, 80)));

    // Input area
    const inputLines = this.input.render(width);
    lines.push(...inputLines);

    // Footer with keybindings
    const footer = "\x1b[2mEnter: send | Ctrl+C: abort | Esc: close\x1b[0m";
    lines.push(truncateToWidth(footer, width));

    this.cachedWidth = width;
    this.cachedRender = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRender = undefined;
    this.input.invalidate();
  }
}

/**
 * Session Watcher View Component
 *
 * Displays streaming updates from a session file being watched.
 */
class SessionWatcherView implements Component {
  private outputLines: string[] = [];
  private maxOutputLines = 500;
  private status: "watching" | "stopped" | "error" = "watching";
  private errorMessage?: string;
  private scrollOffset = 0;
  private cachedWidth?: number;
  private cachedRender?: string[];
  private entryCount = 0;

  public sessionFile: string;
  public workspaceName: string;
  public watcher?: SessionWatcher;
  public onClose?: () => void;
  public requestRenderFn?: () => void;

  constructor(workspaceName: string, sessionFile: string) {
    this.workspaceName = workspaceName;
    this.sessionFile = sessionFile;
  }

  appendOutput(text: string): void {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line || this.outputLines.length > 0) {
        this.outputLines.push(line);
      }
    }

    while (this.outputLines.length > this.maxOutputLines) {
      this.outputLines.shift();
    }

    this.scrollOffset = 0;
    this.invalidate();
    this.requestRenderFn?.();
  }

  incrementEntryCount(): void {
    this.entryCount++;
    this.invalidate();
    this.requestRenderFn?.();
  }

  setStatus(status: typeof this.status, error?: string): void {
    this.status = status;
    this.errorMessage = error;
    this.invalidate();
    this.requestRenderFn?.();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.onClose?.();
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) {
      this.scrollOffset = Math.min(this.scrollOffset + 10, Math.max(0, this.outputLines.length - 5));
      this.invalidate();
      this.requestRenderFn?.();
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 10);
      this.invalidate();
      this.requestRenderFn?.();
      return;
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRender) {
      return this.cachedRender;
    }

    const lines: string[] = [];

    const statusIcon =
      this.status === "watching" ? "👁" :
      this.status === "error" ? "✗" : "○";

    const statusText =
      this.status === "watching" ? `Watching (${this.entryCount} entries)` :
      this.status === "error" ? `Error: ${this.errorMessage}` : "Stopped";

    const header = `${statusIcon} ${this.workspaceName} - ${statusText}`;
    lines.push(truncateToWidth(`\x1b[1m${header}\x1b[0m`, width));

    const shortPath = this.sessionFile.replace(/^.*\/sessions\//, "sessions/");
    lines.push(truncateToWidth(`\x1b[2m${shortPath}\x1b[0m`, width));
    lines.push("─".repeat(Math.min(width, 80)));

    const outputHeight = 18;
    const visibleStart = Math.max(0, this.outputLines.length - outputHeight - this.scrollOffset);
    const visibleEnd = Math.min(this.outputLines.length, visibleStart + outputHeight);
    const visibleLines = this.outputLines.slice(visibleStart, visibleEnd);

    for (const line of visibleLines) {
      const wrapped = wrapTextWithAnsi(line, width);
      for (const wl of wrapped) {
        lines.push(truncateToWidth(wl, width));
      }
    }

    while (lines.length < outputHeight + 3) {
      lines.push("");
    }

    if (this.outputLines.length > outputHeight) {
      const scrollInfo = this.scrollOffset > 0
        ? `[${this.scrollOffset} lines below, PgUp/PgDn to scroll]`
        : `[${Math.max(0, this.outputLines.length - outputHeight)} lines above]`;
      lines.push(truncateToWidth(`\x1b[2m${scrollInfo}\x1b[0m`, width));
    } else {
      lines.push("");
    }

    lines.push("─".repeat(Math.min(width, 80)));
    const footer = "\x1b[2mEsc/q: close | PgUp/PgDn: scroll\x1b[0m";
    lines.push(truncateToWidth(footer, width));

    this.cachedWidth = width;
    this.cachedRender = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedRender = undefined;
  }
}

/**
 * Run a session watcher for a workspace
 */
async function runSessionWatcher(
  ctx: ExtensionContext,
  workspace: { name: string; path: string }
): Promise<void> {
  // Find session files for this workspace
  const sessionFiles = await findWorkspaceSessionFiles(workspace.path);

  if (sessionFiles.length === 0) {
    ctx.ui.notify("No session files found for this workspace", "warning");
    return;
  }

  // Let user select a session if multiple exist
  let selectedFile = sessionFiles[0];

  if (sessionFiles.length > 1) {
    const options: string[] = [];
    for (const file of sessionFiles.slice(0, 10)) {
      try {
        const summary = await getSessionSummary(file);
        const date = summary.lastModified.toLocaleString();
        const preview = summary.firstMessage?.slice(0, 40) || "(no messages)";
        options.push(`${date}: ${preview}...`);
      } catch {
        options.push(file.split("/").pop() || file);
      }
    }

    const selection = await ctx.ui.select("Select a session to watch:", options);
    if (selection == null) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    const selectedIndex = options.indexOf(selection);
    if (selectedIndex >= 0) {
      selectedFile = sessionFiles[selectedIndex];
    }
  }

  const view = new SessionWatcherView(workspace.name, selectedFile);

  const closeWatcher = () => {
    if (view.watcher) {
      view.watcher.stop();
    }
  };

  view.onClose = closeWatcher;

  const watcher = new SessionWatcher(selectedFile, {
    onEntry: (entry) => {
      const formatted = formatSessionEntry(entry);
      if (formatted) {
        view.appendOutput(formatted);
      }
      view.incrementEntryCount();
    },
    onError: (error) => {
      view.setStatus("error", error.message);
    },
  });

  view.watcher = watcher;

  await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    view.requestRenderFn = () => tui.requestRender();
    view.onClose = () => {
      closeWatcher();
      done();
    };

    watcher.start().catch((err) => {
      view.setStatus("error", err.message);
    });

    return view;
  });
}

/**
 * Run an interactive RPC session in a workspace
 */
async function runInteractiveRpcSession(
  ctx: ExtensionContext,
  workspace: { name: string; path: string }
): Promise<void> {
  const view = new RpcSessionView(workspace.name, workspace.path);

  let handle: { close: () => void; requestRender: () => void } | undefined;

  const closeSession = () => {
    if (view.rpcClient) {
      view.rpcClient.close();
    }
    handle?.close();
  };

  view.onClose = closeSession;

  // Start the RPC client
  const rpcClient = new RpcClient({
    cwd: workspace.path,
    onEvent: (event) => {
      // Handle streaming text
      const textDelta = getTextDelta(event);
      if (textDelta) {
        view.appendOutput(textDelta);
        return;
      }

      // Handle tool events
      const toolText = formatToolEvent(event);
      if (toolText) {
        view.appendOutput(`\n${toolText}\n`);
        if (event.type === "tool_execution_start") {
          view.setCurrentTool((event as any).toolName);
        } else if (event.type === "tool_execution_end") {
          view.setCurrentTool(undefined);
        }
        return;
      }

      // Handle agent lifecycle
      if (isAgentStart(event)) {
        view.setStatus("running");
        return;
      }
      if (isAgentEnd(event)) {
        view.setStatus("idle");
        view.appendOutput("\n");
        return;
      }

      // Handle extension UI requests (auto-respond for now)
      if (event.type === "extension_ui_request") {
        const uiReq = event as ExtensionUiRequestEvent;
        // For now, auto-cancel extension UI requests
        // Future: could show these in the parent UI
        if (uiReq.method === "notify") {
          view.appendOutput(`\n[${uiReq.notifyType || "info"}] ${uiReq.message}\n`);
        } else {
          view.appendOutput(`\n[Extension UI: ${uiReq.method}]\n`);
          rpcClient.respondToUiRequest(uiReq.id, { cancelled: true });
        }
        return;
      }
    },
    onError: (error) => {
      view.appendOutput(`\n[Error: ${error.message}]\n`);
    },
    onClose: (code) => {
      view.setStatus("closed");
      view.appendOutput(`\n[Session closed with code ${code}]\n`);
    },
  });

  view.rpcClient = rpcClient;

  // Show the view
  await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
    view.requestRenderFn = () => tui.requestRender();
    view.onClose = () => {
      closeSession();
      done();
    };

    // Start the RPC client asynchronously
    rpcClient.start().then(() => {
      view.setStatus("idle");
      view.appendOutput("Connected to workspace agent.\n");
      view.appendOutput("Type a prompt below or press Esc to close.\n\n");
    }).catch((err) => {
      view.setStatus("error", err.message);
      view.appendOutput(`Failed to connect: ${err.message}\n`);
    });

    return view;
  });
}

export default function (pi: ExtensionAPI) {
  // Track active workspaces in session
  let activeWorkspaces: Map<string, WorkspaceEntry> = new Map();

  // Restore state on session start
  pi.on("session_start", async (_event, ctx) => {
    activeWorkspaces = new Map();

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === WORKSPACE_ENTRY_TYPE) {
        const data = entry.data as WorkspaceEntry;
        if (data.workspace) {
          activeWorkspaces.set(data.workspace.name, data);
        }
      }
    }

    // Check if we're in a JJ repo and show status info
    await updateJJStatus(pi, ctx);

    // Also show active workspaces if any
    const active = Array.from(activeWorkspaces.values()).filter(
      (w) => w.workspace.status === "active"
    );
    if (active.length > 0) {
      // Active workspaces take precedence in status display
      const names = active.map((w) => w.workspace.name).join(", ");
      ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("accent", `jj: ${names} (active)`));
    }
  });

  // Update status when cwd changes
  pi.on("cwd_change", async (_event, ctx) => {
    await updateJJStatus(pi, ctx);
  });

  /**
   * Helper to update JJ status in the status line
   */
  async function updateJJStatus(pi: ExtensionAPI, ctx: ExtensionContext) {
    try {
      const statusInfo = await jjGetStatusInfo(pi, ctx.cwd);

      if (!statusInfo.isRepo) {
        ctx.ui.setStatus("pi-jj", undefined);
        return;
      }

      // Build status string: bookmark@workspace or just workspace or just bookmark
      const parts: string[] = [];

      if (statusInfo.bookmarks.length > 0) {
        // Show first bookmark (most relevant), with indicator if there are more
        const bookmarkDisplay = statusInfo.bookmarks.length > 1
          ? `${statusInfo.bookmarks[0]}+${statusInfo.bookmarks.length - 1}`
          : statusInfo.bookmarks[0];
        parts.push(ctx.ui.theme.fg("accent", bookmarkDisplay));
      }

      if (statusInfo.workspaceName && statusInfo.workspaceName !== "default") {
        // Only show workspace if not the default one
        parts.push(ctx.ui.theme.fg("muted", `@${statusInfo.workspaceName}`));
      }

      if (parts.length > 0) {
        ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("dim", "jj: ") + parts.join(""));
      } else {
        // In a jj repo but no bookmark or special workspace - just show "jj"
        ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("dim", "jj"));
      }
    } catch {
      // Silently ignore errors - might not be in a jj repo
      ctx.ui.setStatus("pi-jj", undefined);
    }
  }

  // Warn about active workspaces on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    const active = Array.from(activeWorkspaces.values()).filter(
      (w) => w.workspace.status === "active"
    );
    if (active.length > 0) {
      const names = active.map((w) => w.workspace.name).join(", ");
      ctx.ui.notify(`Note: ${active.length} jj workspace(s) still active: ${names}`, "warning");
    }
  });

  // Register the jj_workspace tool
  pi.registerTool({
    name: "jj_workspace",
    label: "JJ Workspace",
    description: [
      "Create a new jj (Jujutsu) workspace and delegate a task to an isolated agent.",
      "The agent runs in the new workspace with its own context window.",
      "After completion, you can choose to keep, squash, or delete the workspace.",
    ].join(" "),
    promptSnippet: "Create jj workspace and run task in isolated agent",
    promptGuidelines: [
      "Use jj_workspace for isolated tasks that benefit from a clean working copy",
      "Each workspace gets a separate context window - good for large or risky changes",
      "The workspace agent can make changes without affecting the main working copy",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Task description to delegate to the agent" }),
      name: Type.Optional(
        Type.String({ description: "Workspace name (auto-generated from task if omitted)" })
      ),
      path: Type.Optional(
        Type.String({ description: "Custom workspace path (default: sibling directory)" })
      ),
      model: Type.Optional(
        Type.String({ description: "Model to use (inherits current if omitted)" })
      ),
      tools: Type.Optional(
        Type.Array(Type.String(), { description: "Restrict available tools (default: all)" })
      ),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { task, name, path, model, tools } = params;

      // Validate environment
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        return {
          content: [{ type: "text", text: `Error: ${env.error}` }],
          details: {} as JJWorkspaceDetails,
          isError: true,
        };
      }

      // Create workspace
      const createResult = await createWorkspace(pi, ctx.cwd, {
        task,
        name,
        path,
      });

      if (!createResult.success || !createResult.workspace) {
        return {
          content: [{ type: "text", text: `Failed to create workspace: ${createResult.error}` }],
          details: {} as JJWorkspaceDetails,
          isError: true,
        };
      }

      const workspace = createResult.workspace;

      // Track workspace
      const entry: WorkspaceEntry = { workspace };
      activeWorkspaces.set(workspace.name, entry);
      pi.appendEntry(WORKSPACE_ENTRY_TYPE, entry);

      // Update status
      ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("warning", `jj: ${workspace.name} (running)`));

      // Emit initial update
      onUpdate?.({
        content: [{ type: "text", text: `Creating workspace "${workspace.name}"...` }],
        details: { workspace } as JJWorkspaceDetails,
      });

      // Spawn subagent
      const subagentResult = await spawnSubagent(
        {
          workspace,
          task,
          model,
          tools,
          signal,
        },
        (update) => {
          onUpdate?.({
            content: [{ type: "text", text: update.output || "(running...)" }],
            details: {
              workspace,
              result: {
                success: false,
                exitCode: -1,
                output: update.output,
                messages: update.messages,
                usage: update.usage,
                model: update.model,
              },
            } as JJWorkspaceDetails,
          });
        }
      );

      // Update workspace status
      workspace.status = subagentResult.success ? "completed" : "failed";
      entry.result = subagentResult;

      // Prompt for lifecycle action
      const action = await promptLifecycleAction(ctx, workspace, subagentResult.success);

      if (action) {
        entry.lifecycleAction = action;
        const lifecycleResult = await handleWorkspaceLifecycle(pi, workspace, action);
        entry.lifecycleMessage = lifecycleResult.message;

        if (action === "squash-delete" || action === "delete") {
          workspace.status = "cleaned";
          activeWorkspaces.delete(workspace.name);
        }
      }

      // Update status
      const remainingActive = Array.from(activeWorkspaces.values()).filter(
        (w) => w.workspace.status === "active"
      );
      if (remainingActive.length > 0) {
        const names = remainingActive.map((w) => w.workspace.name).join(", ");
        ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("accent", `jj: ${names}`));
      } else {
        ctx.ui.setStatus("pi-jj", undefined);
      }

      // Persist final state
      pi.appendEntry(WORKSPACE_ENTRY_TYPE, entry);

      const details: JJWorkspaceDetails = {
        workspace,
        result: subagentResult,
        lifecycleAction: entry.lifecycleAction,
        lifecycleMessage: entry.lifecycleMessage,
      };

      const statusText = subagentResult.success ? "completed" : "failed";
      const output = subagentResult.output || "(no output)";

      return {
        content: [
          {
            type: "text",
            text: `Workspace "${workspace.name}" ${statusText}.\n\n${output}`,
          },
        ],
        details,
        isError: !subagentResult.success,
      };
    },

    renderCall(args, theme, _context) {
      const workspaceName = args.name || sanitizeWorkspaceName(args.task || "") || "...";
      const taskPreview = args.task
        ? args.task.length > 60
          ? `${args.task.slice(0, 60)}...`
          : args.task
        : "...";

      let text = theme.fg("toolTitle", theme.bold("jj_workspace "));
      text += theme.fg("accent", workspaceName);
      text += `\n  ${theme.fg("dim", taskPreview)}`;

      if (args.model) {
        text += `\n  ${theme.fg("muted", `model: ${args.model}`)}`;
      }
      if (args.tools && args.tools.length > 0) {
        text += `\n  ${theme.fg("muted", `tools: ${args.tools.join(", ")}`)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as JJWorkspaceDetails | undefined;

      if (!details || !details.workspace) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const { workspace, result: subResult, lifecycleAction, lifecycleMessage } = details;
      const isRunning = !subResult || subResult.exitCode === -1;
      const isError = subResult && !subResult.success;

      const icon = isRunning
        ? theme.fg("warning", "⏳")
        : isError
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");

      const statusText = isRunning
        ? "running"
        : isError
        ? subResult.stopReason || "failed"
        : "completed";

      if (expanded && subResult) {
        const container = new Container();

        // Header
        let header = `${icon} ${theme.fg("toolTitle", theme.bold("jj_workspace "))}`;
        header += theme.fg("accent", workspace.name);
        header += theme.fg("muted", ` (${statusText})`);
        container.addChild(new Text(header, 0, 0));

        // Path
        container.addChild(new Text(theme.fg("dim", `Path: ${workspace.path}`), 0, 0));

        // Error message if any
        if (subResult.errorMessage) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("error", `Error: ${subResult.errorMessage}`), 0, 0));
        }

        // Task
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
        container.addChild(new Text(theme.fg("dim", workspace.task), 0, 0));

        // Tool calls
        const displayItems = getDisplayItems(subResult.messages);
        const toolCalls = displayItems.filter((d) => d.type === "toolCall");
        if (toolCalls.length > 0) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Tool Calls ───"), 0, 0));
          for (const item of toolCalls) {
            if (item.name && item.args) {
              container.addChild(
                new Text(
                  theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
                  0,
                  0
                )
              );
            }
          }
        }

        // Output
        const output = getFinalOutput(subResult.messages);
        if (output) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          container.addChild(new Text(output.trim(), 0, 0));
        }

        // Lifecycle action
        if (lifecycleAction) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Lifecycle ───"), 0, 0));
          container.addChild(
            new Text(theme.fg("dim", `Action: ${lifecycleAction}`), 0, 0)
          );
          if (lifecycleMessage) {
            container.addChild(new Text(theme.fg("dim", lifecycleMessage), 0, 0));
          }
        }

        // Usage
        const usageStr = formatUsageStats(subResult.usage, subResult.model);
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }

        return container;
      }

      // Collapsed view
      let text = `${icon} ${theme.fg("toolTitle", theme.bold("jj_workspace "))}`;
      text += theme.fg("accent", workspace.name);
      text += theme.fg("muted", ` (${statusText})`);
      text += `\n${theme.fg("dim", workspace.path)}`;

      if (subResult) {
        if (subResult.errorMessage) {
          text += `\n${theme.fg("error", `Error: ${subResult.errorMessage}`)}`;
        } else {
          const output = getFinalOutput(subResult.messages);
          if (output) {
            const preview = output.split("\n").slice(0, 3).join("\n");
            text += `\n${theme.fg("toolOutput", preview)}`;
            if (output.split("\n").length > 3) {
              text += `\n${theme.fg("muted", "...")}`;
            }
          }
        }

        const usageStr = formatUsageStats(subResult.usage, subResult.model);
        if (usageStr) {
          text += `\n${theme.fg("dim", usageStr)}`;
        }
      }

      if (lifecycleAction) {
        text += `\n${theme.fg("muted", `[${lifecycleAction}]`)}`;
      }

      return new Text(text, 0, 0);
    },
  });

  // Register the /jj-workspace command
  pi.registerCommand("jj-workspace", {
    description: "Create a jj workspace and run a task in an isolated agent",
    handler: async (args, ctx) => {
      // Validate environment first
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        ctx.ui.notify(env.error || "Not in a jj repository", "error");
        return;
      }

      // Get task from args or prompt
      let task = args?.trim();
      if (!task) {
        task = await ctx.ui.input("Task for the workspace agent:", "");
        if (!task) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      // Generate workspace name suggestion
      const suggestedName = sanitizeWorkspaceName(task);

      // Prompt for workspace name
      const name = await ctx.ui.input("Workspace name:", suggestedName);
      if (!name) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Show confirmation
      const confirmed = await ctx.ui.confirm(
        "Create workspace?",
        `Name: ${name}\nTask: ${task.slice(0, 100)}${task.length > 100 ? "..." : ""}`
      );

      if (!confirmed) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Create workspace
      ctx.ui.notify(`Creating workspace "${name}"...`, "info");

      const createResult = await createWorkspace(pi, ctx.cwd, { task, name });
      if (!createResult.success || !createResult.workspace) {
        ctx.ui.notify(`Failed: ${createResult.error}`, "error");
        return;
      }

      const workspace = createResult.workspace;

      // Track workspace
      const entry: WorkspaceEntry = { workspace };
      activeWorkspaces.set(workspace.name, entry);
      pi.appendEntry(WORKSPACE_ENTRY_TYPE, entry);

      // Update status
      ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("warning", `jj: ${workspace.name} (running)`));
      ctx.ui.notify(`Workspace created at ${workspace.path}`, "success");

      // Spawn subagent
      ctx.ui.notify("Starting agent...", "info");

      const subagentResult = await spawnSubagent({
        workspace,
        task,
        signal: undefined, // Commands don't have abort signal
      });

      workspace.status = subagentResult.success ? "completed" : "failed";
      entry.result = subagentResult;

      // Show result
      const statusText = subagentResult.success ? "completed" : "failed";
      ctx.ui.notify(`Agent ${statusText}`, subagentResult.success ? "success" : "error");

      // Show output preview
      const output = getFinalOutput(subagentResult.messages);
      if (output) {
        const preview = output.slice(0, 200) + (output.length > 200 ? "..." : "");
        ctx.ui.notify(preview, "info");
      }

      // Prompt for lifecycle action
      const action = await promptLifecycleAction(ctx, workspace, subagentResult.success);

      if (action) {
        entry.lifecycleAction = action;
        const lifecycleResult = await handleWorkspaceLifecycle(pi, workspace, action);
        ctx.ui.notify(lifecycleResult.message, lifecycleResult.success ? "success" : "error");

        if (action === "squash-delete" || action === "delete") {
          workspace.status = "cleaned";
          activeWorkspaces.delete(workspace.name);
        }
      }

      // Update status
      const remainingActive = Array.from(activeWorkspaces.values()).filter(
        (w) => w.workspace.status === "active"
      );
      if (remainingActive.length > 0) {
        const names = remainingActive.map((w) => w.workspace.name).join(", ");
        ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("accent", `jj: ${names}`));
      } else {
        ctx.ui.setStatus("pi-jj", undefined);
      }

      // Persist final state
      pi.appendEntry(WORKSPACE_ENTRY_TYPE, entry);
    },
  });

  // Register /jj-list command to show workspaces
  pi.registerCommand("jj-list", {
    description: "List jj workspaces in the current repository",
    handler: async (_args, ctx) => {
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        ctx.ui.notify(env.error || "Not in a jj repository", "error");
        return;
      }

      try {
        const workspaces = await jjWorkspaceList(pi, ctx.cwd);
        if (workspaces.length === 0) {
          ctx.ui.notify("No workspaces found", "info");
          return;
        }

        const lines = workspaces.map((w) => {
          const current = w.isCurrent ? " (current)" : "";
          return `${w.name}${current}: ${w.path}`;
        });

        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Failed to list workspaces: ${err}`, "error");
      }
    },
  });

  // Register /jj-status command
  pi.registerCommand("jj-status", {
    description: "Show jj status and recent changes",
    handler: async (_args, ctx) => {
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        ctx.ui.notify(env.error || "Not in a jj repository", "error");
        return;
      }

      try {
        const log = await jjLog(pi, ctx.cwd, 5);
        ctx.ui.notify(log.trim(), "info");
      } catch (err) {
        ctx.ui.notify(`Failed to get status: ${err}`, "error");
      }
    },
  });

  // Register /jj-attach command
  pi.registerCommand("jj-attach", {
    description: "Attach to a pi agent running in a jj workspace",
    handler: async (_args, ctx) => {
      // Debug: Verify command handler is being reached
      ctx.ui.notify("Loading workspaces...", "info");
      
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        ctx.ui.notify(env.error || "Not in a jj repository", "error");
        return;
      }

      // Get all jj workspaces
      let workspaces: Awaited<ReturnType<typeof jjWorkspaceList>>;
      try {
        workspaces = await jjWorkspaceList(pi, ctx.cwd);
      } catch (err) {
        ctx.ui.notify(`Failed to list workspaces: ${err}`, "error");
        return;
      }

      if (workspaces.length === 0) {
        ctx.ui.notify("No workspaces found", "info");
        return;
      }

      // Build workspace options with status info
      const options = workspaces.map((ws) => {
        const tracked = activeWorkspaces.get(ws.name);
        let status = "";
        if (ws.isCurrent) {
          status = " (current)";
        } else if (tracked) {
          const wsStatus = tracked.workspace.status;
          const icon = wsStatus === "active" ? "⏳" : wsStatus === "completed" ? "✓" : wsStatus === "failed" ? "✗" : "○";
          status = ` ${icon} ${wsStatus}`;
        }
        return `${ws.name}${status} - ${ws.path}`;
      });

      // Let user select a workspace
      const selection = await ctx.ui.select("Select a workspace to attach to:", options);
      if (selection == null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // ctx.ui.select returns the selected label, not the index
      const selectedIndex = options.indexOf(selection);
      if (selectedIndex === -1) {
        ctx.ui.notify("Error: could not find selected workspace", "error");
        return;
      }

      const selectedWorkspace = workspaces[selectedIndex];

      // Check if we're already in this workspace
      if (selectedWorkspace.isCurrent) {
        ctx.ui.notify("Already in this workspace", "info");
        return;
      }

      // Offer actions for the selected workspace
      const tracked = activeWorkspaces.get(selectedWorkspace.name);
      const actionOptions = [
        "Interactive session (embedded view)",
        "Start new pi session (fullscreen)",
        "Watch workspace session",
        "Resume workspace session",
        "View workspace diff",
        "View workspace log",
      ];

      if (tracked) {
        actionOptions.push("View tracked agent status");
      }

      const actionSelection = await ctx.ui.select(
        `Workspace "${selectedWorkspace.name}" - Choose action:`,
        actionOptions
      );

      if (actionSelection == null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // ctx.ui.select returns the selected label, not the index
      const actionIndex = actionOptions.indexOf(actionSelection);

      switch (actionIndex) {
        case 0: {
          // Interactive session using RPC mode (embedded view)
          await runInteractiveRpcSession(ctx, selectedWorkspace);
          break;
        }

        case 1: {
          // Start new pi session (fullscreen)
          // Use ctx.ui.custom() to properly suspend/resume the TUI
          const invocation = getPiInvocation([]);
          
          const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
            // Stop TUI to release terminal
            tui.stop();

            // Clear screen
            process.stdout.write("\x1b[2J\x1b[H");

            // Spawn pi interactively with full terminal access
            const proc = spawn(invocation.command, invocation.args, {
              cwd: selectedWorkspace.path,
              stdio: "inherit",
              shell: false,
            });

            proc.on("close", (code) => {
              // Restart TUI
              tui.start();
              tui.requestRender(true);
              done(code);
            });

            proc.on("error", (err) => {
              // Restart TUI even on error
              tui.start();
              tui.requestRender(true);
              done(null);
            });

            // Return empty component (will be disposed when done() is called)
            return { render: () => [], invalidate: () => {} };
          });

          if (exitCode !== null) {
            ctx.ui.notify(`Returned from workspace "${selectedWorkspace.name}" (exit code: ${exitCode})`, "info");
          } else {
            ctx.ui.notify(`Failed to start pi session`, "error");
          }
          break;
        }

        case 2: {
          // Watch workspace session
          await runSessionWatcher(ctx, selectedWorkspace);
          break;
        }

        case 3: {
          // Resume workspace session
          // Find and let user pick a session, then open pi with --session flag
          const sessionFiles = await findWorkspaceSessionFiles(selectedWorkspace.path);

          if (sessionFiles.length === 0) {
            ctx.ui.notify("No session files found for this workspace", "warning");
            break;
          }

          let selectedSession = sessionFiles[0];

          if (sessionFiles.length > 1) {
            const options: string[] = [];
            for (const file of sessionFiles.slice(0, 10)) {
              try {
                const summary = await getSessionSummary(file);
                const date = summary.lastModified.toLocaleString();
                const preview = summary.firstMessage?.slice(0, 40) || "(no messages)";
                options.push(`${date}: ${preview}...`);
              } catch {
                options.push(file.split("/").pop() || file);
              }
            }

            const selection = await ctx.ui.select("Select a session to resume:", options);
            if (selection == null) {
              ctx.ui.notify("Cancelled", "info");
              break;
            }

            const selectedIndex = options.indexOf(selection);
            if (selectedIndex >= 0) {
              selectedSession = sessionFiles[selectedIndex];
            }
          }

          // Open pi with the selected session in fullscreen mode
          const invocation = getPiInvocation(["--session", selectedSession]);

          const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
            tui.stop();
            process.stdout.write("\x1b[2J\x1b[H");

            const proc = spawn(invocation.command, invocation.args, {
              cwd: selectedWorkspace.path,
              stdio: "inherit",
              shell: false,
            });

            proc.on("close", (code) => {
              tui.start();
              tui.requestRender(true);
              done(code);
            });

            proc.on("error", () => {
              tui.start();
              tui.requestRender(true);
              done(null);
            });

            return { render: () => [], invalidate: () => {} };
          });

          if (exitCode !== null) {
            ctx.ui.notify(`Returned from session (exit code: ${exitCode})`, "info");
          } else {
            ctx.ui.notify(`Failed to start pi session`, "error");
          }
          break;
        }

        case 4: {
          // View diff
          try {
            const diff = await jjDiff(pi, selectedWorkspace.path);
            if (diff.trim()) {
              ctx.ui.notify(`Diff in "${selectedWorkspace.name}":\n${diff}`, "info");
            } else {
              ctx.ui.notify(`No changes in workspace "${selectedWorkspace.name}"`, "info");
            }
          } catch (err) {
            ctx.ui.notify(`Failed to get diff: ${err}`, "error");
          }
          break;
        }

        case 5: {
          // View log
          try {
            const log = await jjLog(pi, selectedWorkspace.path, 5);
            ctx.ui.notify(`Log for "${selectedWorkspace.name}":\n${log}`, "info");
          } catch (err) {
            ctx.ui.notify(`Failed to get log: ${err}`, "error");
          }
          break;
        }

        case 6: {
          // View tracked agent status (only shown if tracked)
          if (tracked) {
            const ws = tracked.workspace;
            const result = tracked.result;

            let statusText = `Workspace: ${ws.name}\n`;
            statusText += `Path: ${ws.path}\n`;
            statusText += `Status: ${ws.status}\n`;
            statusText += `Task: ${ws.task}\n`;
            statusText += `Created: ${new Date(ws.createdAt).toLocaleString()}\n`;

            if (result) {
              statusText += `\nAgent Result:\n`;
              statusText += `  Success: ${result.success}\n`;
              statusText += `  Exit Code: ${result.exitCode}\n`;
              if (result.model) {
                statusText += `  Model: ${result.model}\n`;
              }
              if (result.usage) {
                statusText += `  Usage: ${formatUsageStats(result.usage, result.model)}\n`;
              }
              if (result.errorMessage) {
                statusText += `  Error: ${result.errorMessage}\n`;
              }

              const output = getFinalOutput(result.messages);
              if (output) {
                const preview = output.length > 500 ? output.slice(0, 500) + "..." : output;
                statusText += `\nOutput:\n${preview}\n`;
              }
            }

            if (tracked.lifecycleAction) {
              statusText += `\nLifecycle Action: ${tracked.lifecycleAction}`;
              if (tracked.lifecycleMessage) {
                statusText += `\n${tracked.lifecycleMessage}`;
              }
            }

            ctx.ui.notify(statusText, "info");
          }
          break;
        }
      }
    },
  });
}
