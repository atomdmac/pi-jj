# pi-jj

A [pi coding agent](https://github.com/badlogic/pi-mono) extension for working with [jj (Jujutsu)](https://github.com/martinvonz/jj) VCS workspaces.

Create isolated workspaces for tasks and spawn subagents to work on them independently—each with its own context window and working copy.

## Features

- **LLM Tool**: `jj_workspace` - Create workspace and delegate tasks programmatically
- **Commands**: `/jj-workspace`, `/jj-attach`, `/jj-list`, `/jj-status`
- **Isolated Execution**: Each task runs in a separate workspace with fresh context
- **Lifecycle Management**: Keep, squash, or delete workspaces after completion
- **Session Persistence**: Workspace state survives session restarts
- **Status Indicator**: Shows active workspaces in the footer

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
   - **Start new pi session** - Launches an interactive pi agent in the workspace directory
   - **View workspace diff** - Shows current changes in the workspace
   - **View workspace log** - Shows recent commit history
   - **View tracked agent status** - Shows details of the agent that ran in this workspace (if tracked)

### Command: `/jj-status`

Show recent jj changes:

```
/jj-status
```

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
