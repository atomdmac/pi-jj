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
import { Text, Container, Spacer } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  jjVersion,
  jjWorkspaceList,
  jjLog,
  jjDiff,
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

    // Update status if we have active workspaces
    const active = Array.from(activeWorkspaces.values()).filter(
      (w) => w.workspace.status === "active"
    );
    if (active.length > 0) {
      const names = active.map((w) => w.workspace.name).join(", ");
      ctx.ui.setStatus("pi-jj", ctx.ui.theme.fg("accent", `jj: ${names}`));
    }
  });

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
        "Start new pi session in workspace",
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
          // Start new pi session in the workspace
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

        case 1: {
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

        case 2: {
          // View log
          try {
            const log = await jjLog(pi, selectedWorkspace.path, 5);
            ctx.ui.notify(`Log for "${selectedWorkspace.name}":\n${log}`, "info");
          } catch (err) {
            ctx.ui.notify(`Failed to get log: ${err}`, "error");
          }
          break;
        }

        case 3: {
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
