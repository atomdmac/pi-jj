/**
 * Session Watcher - Watch a session file for changes
 *
 * Monitors a session JSONL file and emits events for new entries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SessionWatcherOptions {
  onEntry: (entry: SessionEntry) => void;
  onError?: (error: Error) => void;
}

export class SessionWatcher {
  private filePath: string;
  private options: SessionWatcherOptions;
  private watcher?: fs.FSWatcher;
  private fileHandle?: fs.promises.FileHandle;
  private position = 0;
  private stopped = false;
  private checkInterval?: NodeJS.Timeout;

  constructor(filePath: string, options: SessionWatcherOptions) {
    this.filePath = filePath;
    this.options = options;
  }

  /**
   * Start watching the session file
   */
  async start(): Promise<void> {
    this.stopped = false;

    // Read existing content first
    await this.readNewContent();

    // Watch for changes using polling (more reliable than fs.watch for appending files)
    this.checkInterval = setInterval(() => {
      if (!this.stopped) {
        this.readNewContent().catch((err) => {
          this.options.onError?.(err);
        });
      }
    }, 500); // Check every 500ms
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.stopped = true;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = undefined;
    }
    if (this.fileHandle) {
      this.fileHandle.close().catch(() => {});
      this.fileHandle = undefined;
    }
  }

  /**
   * Read new content from the file since last position
   */
  private async readNewContent(): Promise<void> {
    if (this.stopped) return;

    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size <= this.position) {
        return; // No new content
      }

      // Open file if needed
      if (!this.fileHandle) {
        this.fileHandle = await fs.promises.open(this.filePath, "r");
      }

      // Read new content
      const buffer = Buffer.alloc(stat.size - this.position);
      const { bytesRead } = await this.fileHandle.read(buffer, 0, buffer.length, this.position);

      if (bytesRead > 0) {
        this.position += bytesRead;
        const content = buffer.toString("utf8", 0, bytesRead);

        // Parse JSONL
        const lines = content.split("\n");
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as SessionEntry;
            this.options.onEntry(entry);
          } catch {
            // Incomplete line, wait for more data
          }
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.onError?.(err as Error);
      }
    }
  }
}

/**
 * Find session files in a workspace directory
 */
export async function findWorkspaceSessionFiles(workspacePath: string): Promise<string[]> {
  const homeDir = os.homedir();
  const sessionsBase = path.join(homeDir, ".pi", "agent", "sessions");

  // Session directories are named based on cwd path
  const pathEncoded = workspacePath.replace(/\//g, "-");

  // Find matching session directory
  const possibleDirs = [
    path.join(sessionsBase, `-${pathEncoded}`),
    path.join(sessionsBase, `--${pathEncoded}`),
  ];

  const sessionFiles: string[] = [];

  for (const dir of possibleDirs) {
    try {
      const files = await fs.promises.readdir(dir);
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          sessionFiles.push(path.join(dir, file));
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }

  // Sort by modification time, most recent first
  const withStats = await Promise.all(
    sessionFiles.map(async (file) => {
      try {
        const stat = await fs.promises.stat(file);
        return { file, mtime: stat.mtime };
      } catch {
        return { file, mtime: new Date(0) };
      }
    })
  );

  withStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return withStats.map((w) => w.file);
}

/**
 * Format a session entry for display
 */
export function formatSessionEntry(entry: SessionEntry): string | null {
  if (entry.type === "session") {
    return `[Session started at ${entry.timestamp || "unknown"}]`;
  }

  if (entry.type === "message" && entry.message) {
    const msg = entry.message;
    const role = msg.role;
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");
    }

    // Truncate long content
    const maxLen = 500;
    if (content.length > maxLen) {
      content = content.slice(0, maxLen) + "...";
    }

    switch (role) {
      case "user":
        return `\n> ${content}`;
      case "assistant":
        return content;
      case "toolResult":
        const toolName = (msg as any).toolName || "tool";
        const isError = (msg as any).isError;
        const preview = content.slice(0, 200) + (content.length > 200 ? "..." : "");
        return `  [${toolName}${isError ? " (error)" : ""}]: ${preview}`;
      default:
        return null;
    }
  }

  if (entry.type === "model_change") {
    return `[Model changed to ${(entry as any).provider}/${(entry as any).modelId}]`;
  }

  if (entry.type === "compaction") {
    return `[Context compacted]`;
  }

  return null;
}

/**
 * Get a short summary of a session file
 */
export async function getSessionSummary(filePath: string): Promise<{
  id: string;
  cwd: string;
  firstMessage?: string;
  messageCount: number;
  lastModified: Date;
}> {
  const stat = await fs.promises.stat(filePath);
  const content = await fs.promises.readFile(filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());

  let id = "";
  let cwd = "";
  let firstMessage: string | undefined;
  let messageCount = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionEntry;

      if (entry.type === "session") {
        id = (entry as any).id || "";
        cwd = (entry as any).cwd || "";
      }

      if (entry.type === "message" && entry.message?.role === "user") {
        messageCount++;
        if (!firstMessage) {
          const content = entry.message.content;
          if (typeof content === "string") {
            firstMessage = content.slice(0, 100);
          } else if (Array.isArray(content)) {
            const text = content.find((c) => c.type === "text");
            if (text?.text) {
              firstMessage = text.text.slice(0, 100);
            }
          }
        }
      }
    } catch {
      // Skip invalid lines
    }
  }

  return {
    id,
    cwd,
    firstMessage,
    messageCount,
    lastModified: stat.mtime,
  };
}
