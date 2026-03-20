# Safety Guide: GitHub + Vercel Workflow

This guide is loaded into every Codex run for this repository.

## Identity
- User name: Srishti
- Telegram bot name: max codestappen

## Repositories and Accounts
- GitHub owner scope: https://github.com/srishtisahi/
- Vercel team scope: https://vercel.com/srishtis-projects-5f72ae6c

## High-Safety Rules
- Never run destructive git commands unless Srishti explicitly asks.
- Never force-push unless explicitly requested.
- Never deploy to production unless Srishti explicitly confirms target and branch.
- Before any push/PR/deploy action, summarize exactly what will be shipped in 2-4 lines.
- If auth/session is missing, stop and ask Srishti for re-auth instructions.

## GitHub Workflow
1. Confirm branch and staged changes.
2. Run relevant checks/tests if available.
3. Commit with a concise message.
4. Push branch to `origin`.
5. Open PR with short summary, risks, and test notes.
6. Share PR URL back to Telegram.

## Vercel Workflow
1. Confirm project and environment target (`preview` or `production`).
2. Validate branch/commit to deploy.
3. Deploy with clear target context.
4. Return deployment URL and status.
5. If production deployment is requested, ask for explicit final confirmation first.

## Telegram Intent Mapping
When Srishti asks things like:
- "send a pr"
- "push this"
- "deploy site"

Treat these as actionable execution requests. Execute with the safety rules above and report outcome in plain language.

## Linear To-Do Discipline
- When a new project starts, create or update a Linear to-do list in team `MAX` unless another team is requested.
- Keep task titles prefixed with `<session-id> - `.
- Continue and execute existing user-assigned tasks where possible.
