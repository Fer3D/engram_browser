# Engram Browser

A local web app to browse, organize and edit everything Engram has stored.

Engram gives your AI agents a memory. This gives you a way to see it, tidy it and fix it. It talks to
Engram through Engram's own HTTP API and never opens the database, so indexing, versioning and cloud
sync keep working.

## What you can do

- **Search** everything, across title, content, topic, type, session and project.
- **Organize** by day, type, topic, session, scope or pinned, and filter by type or scope.
- **Switch** between one project, or all of them at once.
- **Read** every field Engram keeps, not just the text.
- **Edit** title, content, type, scope and topic key — only what changed gets sent.
- **Find & replace** inside a memory, done by Engram itself.
- **Pin**, **mark as reviewed**, **create** and **delete**.
- **Browse prompts**, and **inspect, summarize or close sessions**.
- **Judge the relations** Engram finds between memories.
- **See the overview**: totals, breakdowns, Engram's own doctor, JSON export.

## Run it

Engram must be running:

    engram serve

Then start the app and open http://127.0.0.1:7473:

    npm start

No install and no build step. On Windows you can double-click `start.bat` instead.

`/` filters · `Esc` closes · `r` reloads · everything works from the keyboard.

## Worth knowing

- Deleting is a **soft delete** — Engram keeps the row. Purge it with `engram delete <id> --hard`.
- It only listens on `127.0.0.1`, never on your network.
