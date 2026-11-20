# Projects

A **project** is a folder with your code and an agent that works on it. The agent reads the code, writes the change, and you see what it changed as a diff. Nothing reaches your folder until you accept it.

Each project has its own tab in the **Projects** section of the sidebar, with three parts: the project's files, the chat with its agent, and the changes waiting for you.

## What you need

- **Git** installed on your computer (version 2.28 or newer), with your name and e-mail set. The [Tools page](./09-tools.md#1-install-git) has the steps. Without Git the Projects view says so.
- An **agent**. Any agent works; in a project it gets the tools for the project's files on top of its own.
- **Write access to the project's folder.** On your own computer you have it. If HydraOps runs as a service on a server, the folder has to be listed in the service's unit first: see [Server mode](./12-server-mode.md#starting-on-boot-linux-systemd).

You do not need to allow the folder in Tools → Git, and you do not need a GitHub token: a project works on your computer only.

## Create a project

Press **New project** and fill in:

- **Name.** How the tab is called.
- **Folder.** The full path of the project's folder: a Git repository, or a folder that holds several (for example `backend` and `frontend`, each one a repository). HydraOps' own data and key folders cannot be a project.
- **Agent.** One agent per project.
- **Also load the agent's personal memory.** Off by default; see [Notes and memory](#notes-and-memory).

If the folder is not a Git repository yet, the tab offers to make it one:

- **With the files that are there**: every file goes into a first commit. What a `.gitignore` names stays out, so write one first if the folder has dependencies or secrets.
- **Empty**: the agent starts from an empty project and your files stay as they are, untracked.

## How the agent works

The agent **never writes in your folder**. For each repository of the project, HydraOps keeps a copy of its own on a branch called `hydraops/<project>`, made from the commit your branch is on. The agent reads and writes there.

This has three consequences worth knowing:

- **The agent sees what is committed.** Work you have not committed is not in its copy, and neither is anything Git ignores: dependencies, builds, `.env` files.
- **Its changes do not run in your folder.** Your development server keeps serving your version until you accept.
- **It cannot run commands.** No builds, no tests, no installs. It tells you what to run to check its change.

Ask in the project's chat as you would in any chat: *"add a `slug` field to the notes and use it in the list"*. The agent does not ask permission for each file, because you decide on the whole change afterwards.

## Review, accept or discard

The **Changes** panel lists every file the agent changed, with the lines added and removed. Click a file to see its diff. The same files are marked in the tree: **A** added, **M** modified, **D** deleted.

- **Accept** saves the changes in your folder as **one commit on your branch**, under your name. The agent proposes the message, one line saying what the change does; edit it or write your own. Nothing is sent to GitHub: pushing stays with the [Git tools](./09-tools.md#git-commits-branches-and-pushes-to-github) and their approval.
- **Discard** drops the changes and puts the agent's copy back on your last commit. You can also discard one file.

Accepting never forces anything. It stops, and leaves the changes waiting, when:

- **Your branch changed the same lines in the meantime.** Discard the changes and ask the agent again; it starts from your latest version.
- **Your folder has unsaved work in the same files.** Commit or set aside your own changes, then accept again.
- **Git has no name and e-mail.** Set them once (see [Tools](./09-tools.md#1-install-git)).

If your branch moved on in *other* files, the agent's commit is simply placed on top of it.

While the agent is working, Accept and Discard wait until it finishes.

The repository's Git hooks (a lint on commit, for example) **do not run** on these commits. A repository can keep its hooks in a folder the agent can write, so running them would run what the agent wrote.

## Read and edit the code

Click a file in the tree and it opens in an editor, in a tab next to **Changes**. Several files can be open at once.

- **What you see is the agent's copy**: your last commit plus whatever is waiting to be accepted. The lines that differ from your commit carry a bar at the left.
- **You can edit.** Fix a detail yourself instead of asking for it. **Save** (or Ctrl+S) writes your edit to the agent's copy, where it joins the changes waiting for you; it reaches your folder when you accept, like the agent's work. Edits you have not saved are not part of what you accept, and the Changes panel reminds you.
- **While the agent is working the file is read-only.** When it finishes, an open file shows the new text by itself.
- **If the agent changed a file you were editing**, saving stops and says so, so that neither side's work is overwritten unseen. You choose: load the agent's version, or keep your text and copy what you need.
- **Closing a tab with unsaved edits asks first.** Going to another section and coming back keeps the open files and what you typed; reloading the page does not.

**Copy path** gives the file's place in your own folder, to open it in your usual editor. Remember that your folder has your version, not the pending changes.

The editor opens text files up to 1 MB. Images, builds and other binary files are not shown, and credentials files (`.env`, keys) are never opened.

## Instructions: HydraOps.md

`HydraOps.md`, at the top of the project's folder, holds the project's instructions: how it is built and run, its conventions, what not to touch. The agent gets it in every message of the project. Open it from the left column to write or edit it.

The agent follows **only the text you accepted**:

- If the file came with the folder (a cloned repository, a colleague's copy) or changed outside HydraOps, the tab shows **to review** and the agent is not given it until you accept.
- If you ask the agent to write or update the instructions, its proposal waits for your approval in the chat, every time, with the full text in the card.

## The two files and your commits

`HydraOps.md` and `ProjectMemory.md` live in your folder but are **not part of your commits**. When the project's folder is a repository, HydraOps names them in the repository's own exclude list (`.git/info/exclude`), which stays on your computer: your `.gitignore` is not touched, and a `git add .` leaves them out.

- **To version them** (to share the instructions with a team, for example), open `.git/info/exclude`, delete the two lines with their names and leave the HydraOps line above them: that line tells HydraOps not to add them back.
- **If one is already in your repository's history**, ignoring it does not stop Git following it. The tab says so and gives the command: `git rm --cached <file>`, then a commit. The file stays in your folder.

## Notes and memory

`ProjectMemory.md`, also at the top of the folder, is where the agent keeps notes about the project: decisions and their reasons, how something is built, what was tried. It adds them on its own, and you can ask: *"note that the API runs on port 4000"*. Every message of the project carries these notes. You can read them from the left column and edit the file with any editor.

The notes reach the agent as notes, not as orders, and count as content from outside the app (see [Security](./13-security.md)): the file can come with a cloned folder.

By default the agent's **personal memory**, what it remembers from its own chat, is not loaded in a project, and "remember this" goes to the project's notes. Turn on **Also load the agent's personal memory** in the project's settings to have both.

## The project's chat is separate

A project's chat is not the agent's own chat. It has its own history, and what you talk about in one is not in the other. That keeps a project's long work out of your everyday conversations with the agent, and the other way round.

The slash commands work here too, including `/plan` (see [Commands](./15-commands.md)): in plan mode the agent only reads the project and proposes.

## Settings and deleting

The gear next to the agent opens the project's settings: its name, its agent and the memory switch.

**Delete the project** removes the agent's copies and their branch. Your folder, its files, the two project files and the chat's history stay. If changes are still waiting, deleting warns you that they will be lost.

## Security, in short

- The agent's tools reach only the project's copies: no other folder, nothing of Git's own data, no credentials file, no link that leads elsewhere.
- Nothing the agent wrote is run by HydraOps.
- Reading code counts as reading outside content: after it, anything the agent wants to send or do outside the project waits for your approval, as on any task (see [Security](./13-security.md)).
- A push always waits for your approval.
