# Working on Streamglass

Start with [the agent guide](docs/AGENT_GUIDE.md), then read [feature contracts](docs/FEATURE_CONTRACTS.md) for the area being changed. [The roadmap](docs/ROADMAP.md) separates implemented features from proposed follow-ups.

- Keep changes focused and preserve unrelated local work.
- Do not run builds, tests, packaging, or device/system setup without explicit user authorization. Documentation changes need source and link review only.
- Keep the inspector read-only. Breakpoint and script editing belongs in separate windows.
- Preserve pass-through behavior when capture/rules are paused. Never treat capture retention limits as permission to truncate forwarded data.
- Reuse engine validation and persistence for desktop and MCP operations; do not create separate rule engines.
- Do not read or publish real captures, CA private keys, credentials, or application-data profiles as fixtures. Use synthetic data.
- Follow inherited Git identity, signing, branch, and publication instructions. This file does not authorize commits or publication.
- Report what changed, what was checked, and any checks not run. Update the relevant docs when behavior changes.
