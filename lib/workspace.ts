/**
 * Workspace management logic
 *
 * Handles workspace lifecycle: creation, state tracking, and cleanup.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  jjIsRepo,
  jjRoot,
  jjWorkspaceList,
  jjWorkspaceAdd,
  jjWorkspaceForget,
  jjSquash,
  jjDiff,
  jjLog,
  sanitizeWorkspaceName,
  type JJWorkspace,
} from "./jj.js";

export interface WorkspaceInfo {
  name: string;
  path: string;
  repoRoot: string;
  task: string;
  createdAt: number;
  status: "active" | "completed" | "failed" | "cleaned";
}

export interface WorkspaceCreateOptions {
  name?: string;
  path?: string;
  task: string;
}

export interface WorkspaceCreateResult {
  success: boolean;
  workspace?: WorkspaceInfo;
  error?: string;
}

export type WorkspaceLifecycleAction = "keep" | "squash-keep" | "squash-delete" | "delete";

/**
 * Validate that we're in a jj repository and jj is available
 */
export async function validateJJEnvironment(
  pi: ExtensionAPI,
  cwd: string
): Promise<{ valid: boolean; error?: string; repoRoot?: string }> {
  // Check if jj is available
  const versionResult = await pi.exec("jj", ["--version"], { timeout: 5000 });
  if (versionResult.code !== 0) {
    return {
      valid: false,
      error: "jj is not installed or not in PATH. Install from https://github.com/martinvonz/jj",
    };
  }

  // Check if we're in a jj repo
  const isRepo = await jjIsRepo(pi, cwd);
  if (!isRepo) {
    return {
      valid: false,
      error: `Not in a jj repository: ${cwd}`,
    };
  }

  const repoRoot = await jjRoot(pi, cwd);
  if (!repoRoot) {
    return {
      valid: false,
      error: "Could not determine repository root",
    };
  }

  return { valid: true, repoRoot };
}

/**
 * Create a new workspace for a task
 */
export async function createWorkspace(
  pi: ExtensionAPI,
  cwd: string,
  options: WorkspaceCreateOptions
): Promise<WorkspaceCreateResult> {
  // Validate environment
  const env = await validateJJEnvironment(pi, cwd);
  if (!env.valid) {
    return { success: false, error: env.error };
  }

  // Generate workspace name if not provided
  const workspaceName = options.name || sanitizeWorkspaceName(options.task);
  if (!workspaceName) {
    return { success: false, error: "Could not generate workspace name from task" };
  }

  // Check if workspace already exists
  const existingWorkspaces = await jjWorkspaceList(pi, cwd);
  if (existingWorkspaces.some((w) => w.name === workspaceName)) {
    return {
      success: false,
      error: `Workspace "${workspaceName}" already exists`,
    };
  }

  // Determine workspace path
  const repoName = path.basename(env.repoRoot!);
  const defaultPath = path.resolve(env.repoRoot!, "..", `${repoName}-${workspaceName}`);
  const workspacePath = options.path || defaultPath;

  // Check if path already exists
  if (fs.existsSync(workspacePath)) {
    return {
      success: false,
      error: `Path already exists: ${workspacePath}`,
    };
  }

  // Create the workspace
  const result = await jjWorkspaceAdd(pi, cwd, workspaceName, workspacePath);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const workspace: WorkspaceInfo = {
    name: workspaceName,
    path: result.path,
    repoRoot: env.repoRoot!,
    task: options.task,
    createdAt: Date.now(),
    status: "active",
  };

  return { success: true, workspace };
}

/**
 * Handle workspace cleanup based on user's chosen action
 */
export async function handleWorkspaceLifecycle(
  pi: ExtensionAPI,
  workspace: WorkspaceInfo,
  action: WorkspaceLifecycleAction
): Promise<{ success: boolean; message: string; error?: string }> {
  const { name, path: wsPath, repoRoot } = workspace;

  switch (action) {
    case "keep": {
      return {
        success: true,
        message: `Workspace "${name}" kept at ${wsPath}`,
      };
    }

    case "squash-keep": {
      const squashResult = await jjSquash(pi, wsPath);
      if (!squashResult.success) {
        return {
          success: false,
          message: `Failed to squash changes in "${name}"`,
          error: squashResult.error,
        };
      }
      return {
        success: true,
        message: `Changes squashed in workspace "${name}" at ${wsPath}`,
      };
    }

    case "squash-delete": {
      // First squash
      const squashResult = await jjSquash(pi, wsPath);
      if (!squashResult.success) {
        return {
          success: false,
          message: `Failed to squash changes in "${name}"`,
          error: squashResult.error,
        };
      }

      // Then forget workspace
      const forgetResult = await jjWorkspaceForget(pi, repoRoot, name);
      if (!forgetResult.success) {
        return {
          success: false,
          message: `Squashed but failed to forget workspace "${name}"`,
          error: forgetResult.error,
        };
      }

      // Delete directory
      try {
        fs.rmSync(wsPath, { recursive: true, force: true });
      } catch (e) {
        return {
          success: true,
          message: `Workspace "${name}" forgotten but directory removal failed: ${wsPath}`,
        };
      }

      return {
        success: true,
        message: `Workspace "${name}" squashed and deleted`,
      };
    }

    case "delete": {
      // Forget workspace without squashing
      const forgetResult = await jjWorkspaceForget(pi, repoRoot, name);
      if (!forgetResult.success) {
        return {
          success: false,
          message: `Failed to forget workspace "${name}"`,
          error: forgetResult.error,
        };
      }

      // Delete directory
      try {
        fs.rmSync(wsPath, { recursive: true, force: true });
      } catch (e) {
        return {
          success: true,
          message: `Workspace "${name}" forgotten but directory removal failed: ${wsPath}`,
        };
      }

      return {
        success: true,
        message: `Workspace "${name}" deleted (changes discarded)`,
      };
    }

    default:
      return { success: false, message: "Unknown action", error: `Invalid action: ${action}` };
  }
}

/**
 * Get summary of changes in a workspace
 */
export async function getWorkspaceSummary(
  pi: ExtensionAPI,
  workspace: WorkspaceInfo
): Promise<{ diff: string; log: string }> {
  let diff = "";
  let log = "";

  try {
    diff = await jjDiff(pi, workspace.path);
  } catch {
    diff = "(could not get diff)";
  }

  try {
    log = await jjLog(pi, workspace.path, 5);
  } catch {
    log = "(could not get log)";
  }

  return { diff, log };
}

/**
 * Prompt user for lifecycle action
 */
export async function promptLifecycleAction(
  ctx: ExtensionContext,
  workspace: WorkspaceInfo,
  taskSucceeded: boolean
): Promise<WorkspaceLifecycleAction | null> {
  if (!ctx.hasUI) {
    // No UI available, default to keep
    return "keep";
  }

  const statusText = taskSucceeded ? "completed successfully" : "failed";
  const options = [
    { value: "keep", label: "Keep workspace for review" },
    { value: "squash-keep", label: "Squash commits, keep workspace" },
    { value: "squash-delete", label: "Squash commits, delete workspace" },
    { value: "delete", label: "Delete workspace (discard changes)" },
  ];

  const choice = await ctx.ui.select(
    `Task ${statusText}. What to do with workspace "${workspace.name}"?`,
    options.map((o) => o.label)
  );

  if (choice === undefined) return null;
  
  // ctx.ui.select returns the selected string, not an index
  const selected = options.find((o) => o.label === choice);
  return selected ? (selected.value as WorkspaceLifecycleAction) : null;
}
