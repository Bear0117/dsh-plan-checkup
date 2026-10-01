# Changelog

## 0.1.0 (2026-10-01)

First public release.

- When the agent calls `exit_plan_mode`, checks each step of the plan before you approve it and marks the results on the plan review card: can't be undone, affects things outside the workspace, not asked for, too vague. Two more checks cover the whole plan: no verification step, and may miss part of the request.
- Two layers: command rules that need no network, and a judgment engine. The engine is TypeSafe Jev, a server with the same API (for example Laya), or any OpenAI-compatible endpoint that returns logprobs.
- Advisory only: it never blocks, rewrites or approves a plan. The feedback text can be put in the message box or copied.
- The card, panel and feedback text are available in English, Simplified Chinese and Traditional Chinese.
- The details panel links to a GitHub feedback form, which it fills with the plugin version and the engine only.
- Nothing leaves the machine until you enable an engine; non-loopback endpoints need `allowEgress: true`, and plain http hosts must be listed in `allowHttpHosts`.
- Tested on dsh 0.2.0-rc.2 (Windows 11, Node 24.21).
