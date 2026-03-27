# pi-jj

A [pi coding agent](https://github.com/badlogic/pi-mono) extension for working with [jj (Jujutsu)](https://github.com/martinvonz/jj) VCS workspaces.

Create isolated workspaces for tasks and spawn subagents to work on them independently—each with its own context window and working copy.

## Features

- **LLM Tool**: `jj_workspace` - Create workspace and delegate tasks programmatically
- **Commands**: `/jj-workspace`, `/jj-attach`, `/jj-switch`, `/jj-list`
- **Isolated Execution**: Each task runs in a separate workspace with fresh context
- **Lifecycle Management**: Keep, squash, or delete workspaces after completion
- **Session Persistence**: Workspace state survives session restarts
- **Status Indicator**: Shows active workspaces in the footer
- **Interactive Attach**: Embedded RPC sessions, session watching, and session resumption
- **Developer APIs**: `RpcClient` and `SessionWatcher` for building integrations

## Installation

### Option 1: Symlink (Development)

```bash
ln -s /path/to/pi-jj ~/.pi/agent/extensions/pi-jj
```

### Option 2: Copy to Extensions

```bash
cp -r /path/to/pi-jj ~/.pi/agent/extensions/
```

### Option 3: Project-Local

```bash
# In your project directory
mkdir -p .pi/extensions
cp -r /path/to/pi-jj .pi/extensions/
```

## Requirements

- [jj](https://github.com/martinvonz/jj) must be installed and in PATH
- Must be run from within a jj repository

## Usage

### LLM Tool: `jj_workspace`

The agent can call this tool to create workspaces and delegate tasks:

```
Create a workspace to refactor the authentication module. 
Focus on extracting the JWT validation logic into a separate file.
```

The agent will:
1. Create a new jj workspace
2. Spawn an isolated subagent in that workspace
3. Execute the task with full tool access
4. Prompt you for what to do with the workspace when done

**Tool Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string | **Required.** Task description for the subagent |
| `name` | string | Workspace name (auto-generated from task if omitted) |
| `path` | string | Custom workspace path (default: sibling directory) |
| `model` | string | Model to use (inherits current if omitted) |
| `tools` | string[] | Restrict available tools |

### Command: `/jj-workspace`

Interactive workspace creation:

```
/jj-workspace Implement user profile page with avatar upload
```

Or without arguments to be prompted:

```
/jj-workspace
```

### Command: `/jj-list`

List all workspaces in the repository:

```
/jj-list
```

### Command: `/jj-attach`

Interactively select and attach to a workspace:

```
/jj-attach
```

This command allows you to:
1. See all jj workspaces with their status (active, completed, failed)
2. Select a workspace
3. Choose an action:
   - **Interactive session (embedded view)** - Opens an embedded RPC session within the current TUI. Send prompts, see streaming output, and interact with the workspace agent without leaving your session. Supports scrolling (PgUp/PgDn), abort (Ctrl+C), and close (Esc).
   - **Start new pi session (fullscreen)** - Launches an interactive pi agent in the workspace directory, temporarily suspending the parent TUI for full terminal access.
   - **Watch workspace session** - Monitor a running or completed session in real-time by watching its session file. Useful for observing subagent progress without interaction.
   - **Resume workspace session** - Select and resume a previous session from the workspace, continuing where it left off.
   - **View workspace diff** - Shows current changes in the workspace
   - **View workspace log** - Shows recent commit history
   - **View tracked agent status** - Shows details of the agent that ran in this workspace (if tracked)

### Command: `/jj-switch`

Switch to another workspace and start a pi session there:

```
/jj-switch
```

This command allows you to:
1. See all jj workspaces with current workspace indicated
2. Select a different workspace
3. Start a fullscreen pi session in that workspace
4. Return to the original session when done

## Lifecycle Actions

When a workspace task completes (or fails), you'll be prompted with these options:

| Action | Description |
|--------|-------------|
| **Keep workspace** | Leave as-is for manual review |
| **Squash & Keep** | Squash commits into one, keep workspace |
| **Squash & Delete** | Squash commits, delete workspace |
| **Delete** | Forget workspace and discard changes |

## How It Works

1. **Workspace Creation**: Uses `jj workspace add` to create a new workspace
2. **Subagent Spawning**: Runs `pi --mode json -p --no-session` in the workspace
3. **Streaming Output**: Tool calls and output stream back in real-time
4. **Lifecycle Management**: Uses `jj squash` and `jj workspace forget` for cleanup

## Example Workflow

```
You: Create a workspace to add input validation to the API endpoints

Agent: I'll create a jj workspace for this task.
       [calls jj_workspace tool]

       ✓ jj_workspace api-input-validation
       Path: /home/user/myproject-api-input-validation
       
       [subagent runs, shows tool calls and progress]
       
       → read src/api/endpoints.ts
       → edit src/api/endpoints.ts
       → write src/api/validators.ts
       → bash npm test
       
       Added input validation using zod schemas...
       
       2 turns ↑5.2k ↓1.8k $0.0234 claude-sonnet-4-20250514

[Prompt: Task completed successfully. What to do with workspace "api-input-validation"?]
> Squash & Delete

✓ Workspace "api-input-validation" squashed and deleted
```

## Developer APIs

The extension exports two modules for building on top of pi-jj:

### RpcClient

Communicate with a pi subprocess running in RPC mode (`--mode rpc`):

```typescript
import { RpcClient, getTextDelta, isAgentEnd, formatToolEvent } from "pi-jj/lib/rpc-client.js";

const client = new RpcClient({
  cwd: "/path/to/workspace",
  onEvent: (event) => {
    // Handle streaming events
    const text = getTextDelta(event);
    if (text) console.log(text);
    
    const toolInfo = formatToolEvent(event);
    if (toolInfo) console.log(toolInfo);
    
    if (isAgentEnd(event)) console.log("Agent finished");
  },
  onError: (err) => console.error(err),
  onClose: (code) => console.log(`Closed with code ${code}`),
});

await client.start();
await client.prompt("Refactor the auth module");
await client.abort();  // Cancel current operation
await client.getState();  // Get agent state
client.close();
```

**Event Types:**
- `message_update` - Streaming text from the assistant
- `tool_execution_start/update/end` - Tool execution lifecycle
- `agent_start/end` - Agent lifecycle
- `extension_ui_request` - UI requests from extensions

### SessionWatcher

Monitor a session JSONL file for real-time updates:

```typescript
import { 
  SessionWatcher, 
  findWorkspaceSessionFiles, 
  formatSessionEntry,
  getSessionSummary 
} from "pi-jj/lib/session-watcher.js";

// Find session files for a workspace
const files = await findWorkspaceSessionFiles("/path/to/workspace");

// Get session summary
const summary = await getSessionSummary(files[0]);
console.log(`${summary.messageCount} messages, last modified: ${summary.lastModified}`);

// Watch for new entries
const watcher = new SessionWatcher(files[0], {
  onEntry: (entry) => {
    const formatted = formatSessionEntry(entry);
    if (formatted) console.log(formatted);
  },
  onError: (err) => console.error(err),
});

await watcher.start();
// ... later
watcher.stop();
```

## Configuration

No configuration required. The extension uses your existing pi and jj settings.

## Troubleshooting

### "jj is not installed"

Install jj from https://github.com/martinvonz/jj

### "Not in a jj repository"

Initialize a jj repo with `jj git init` or `jj init`

### Workspace creation fails

- Check if a workspace with that name already exists: `/jj-list`
- Check if the target path already exists
- Ensure you have write permissions to the parent directory

## License

MIT
