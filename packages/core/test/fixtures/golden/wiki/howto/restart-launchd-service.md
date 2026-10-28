---
title: Restart a launchd service
category: howto
summary: >-
  Reload a launchd agent after a change to its plist or binary, and read its logs when it does not come up.
tags:
  - ops
  - macos
confidence: draft
created: 2026-08-01
updated: 2026-08-01
sources: []
---
## Prerequisites

- The plist lives in `~/Library/LaunchAgents/`.

## Steps

1. `launchctl bootout gui/$(id -u)/<label>`
2. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`
3. `launchctl print gui/$(id -u)/<label>` shows state and pid.

## Verification

The pid in `launchctl print` is new and the service log has a fresh start line.

## Pitfalls

- `launchctl load` is deprecated and silently does nothing for an already loaded label.

## Related

- [[projects/demo/_index]]
