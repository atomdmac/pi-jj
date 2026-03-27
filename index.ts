/**
 * pi-jj: jj VCS Workspace Extension for pi coding agent
 *
 * Provides tools and commands to create jj workspaces and spawn
 * isolated subagent sessions to work on tasks within them.
 *
 * Features:
 * - LLM tool: jj_workspace - Create workspace and delegate task
 * - Command: /jj-add - Create workspace and start interactive pi session
 * - Session state tracking for workspace metadata
 * - Lifecycle management: keep, squash, delete
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  Text,
  Container,
  Spacer,
  type Component,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  jjWorkspaceList,
  jjLog,
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

  // Register the /jj-add command
  pi.registerCommand("jj-add", {
    description: "Create a jj workspace and start a new pi session within it",
    handler: async (args, ctx) => {
      // Validate environment first
      const env = await validateJJEnvironment(pi, ctx.cwd);
      if (!env.valid) {
        ctx.ui.notify(env.error || "Not in a jj repository", "error");
        return;
      }

      // Get workspace name from args or prompt
      let name = args?.trim();
      if (!name) {
        name = await ctx.ui.input("Workspace name:", "");
        if (!name) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
      }

      // Sanitize the name
      name = sanitizeWorkspaceName(name);

      // Create workspace
      ctx.ui.notify(`Creating workspace "${name}"...`, "info");

      const createResult = await createWorkspace(pi, ctx.cwd, { task: name, name });
      if (!createResult.success || !createResult.workspace) {
        ctx.ui.notify(`Failed: ${createResult.error}`, "error");
        return;
      }

      const workspace = createResult.workspace;

      // Track workspace
      const entry: WorkspaceEntry = { workspace };
      activeWorkspaces.set(workspace.name, entry);
      pi.appendEntry(WORKSPACE_ENTRY_TYPE, entry);

      ctx.ui.notify(`Workspace created at ${workspace.path}`, "success");

      // Start a new pi session in the workspace (fullscreen)
      const invocation = getPiInvocation([]);

      const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
        // Stop TUI to release terminal
        tui.stop();

        // Clear screen
        process.stdout.write("\x1b[2J\x1b[H");

        // Spawn pi interactively with full terminal access
        const proc = spawn(invocation.command, invocation.args, {
          cwd: workspace.path,
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

      // Update workspace status based on session result
      workspace.status = exitCode === 0 ? "completed" : "failed";

      if (exitCode !== null) {
        ctx.ui.notify(`Returned from workspace "${workspace.name}" (exit code: ${exitCode})`, "info");
      } else {
        ctx.ui.notify(`Failed to start pi session`, "error");
      }

      // Update status
      const remainingActive = Array.from(activeWorkspaces.values()).filter(
        (w) => w.workspace.status === "active"
      );
      if (remainingActive.length > 0) {
        const names = remainingActive.map((w) => w.workspace.name).join(", ");
        ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("accent", `jj: ${names}`));
      } else {
        await updateJJStatus(pi, ctx);
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

  // Register /jj-switch command to switch to another workspace
  pi.registerCommand("jj-switch", {
    description: "Switch to another jj workspace and start a pi session there",
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

        if (workspaces.length === 1) {
          ctx.ui.notify("Only one workspace exists - nothing to switch to", "info");
          return;
        }

        // Build options with current workspace indicator
        const options = workspaces.map((w) => {
          const current = w.isCurrent ? " (current)" : "";
          return `${w.name}${current}`;
        });

        const choice = await ctx.ui.select("Select workspace to switch to:", options);
        if (!choice) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }

        // Find the selected workspace
        const selectedName = choice.replace(" (current)", "");
        const selected = workspaces.find((w) => w.name === selectedName);

        if (!selected) {
          ctx.ui.notify("Workspace not found", "error");
          return;
        }

        if (selected.isCurrent) {
          ctx.ui.notify("Already in this workspace", "info");
          return;
        }

        ctx.ui.notify(`Switching to workspace "${selected.name}"...`, "info");

        // Start a new pi session in the selected workspace (fullscreen)
        const invocation = getPiInvocation([]);

        const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
          // Stop TUI to release terminal
          tui.stop();

          // Clear screen
          process.stdout.write("\x1b[2J\x1b[H");

          // Spawn pi interactively with full terminal access
          const proc = spawn(invocation.command, invocation.args, {
            cwd: selected.path,
            stdio: "inherit",
            shell: false,
          });

          proc.on("close", (code) => {
            // Restart TUI
            tui.start();
            tui.requestRender(true);
            done(code);
          });

          proc.on("error", (_err) => {
            // Restart TUI even on error
            tui.start();
            tui.requestRender(true);
            done(null);
          });

          // Return empty component (will be disposed when done() is called)
          return { render: () => [], invalidate: () => {} };
        });

        if (exitCode !== null) {
          ctx.ui.notify(
            `Returned from workspace "${selected.name}" (exit code: ${exitCode})`,
            "info"
          );
        } else {
          ctx.ui.notify("Failed to start pi session", "error");
        }

        // Update status after returning
        await updateJJStatus(pi, ctx);
      } catch (err) {
        ctx.ui.notify(`Failed to switch workspace: ${err}`, "error");
      }
    },
  });
}
