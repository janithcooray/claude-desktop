# TODO

Open work items for this alpha. Ordered loosely by priority, not deadline.

## Bugs

### Fix file preview
Files panel occasionally renders blank or errors out for assets the backend
clearly has on disk. Suspect:

- relative vs. absolute URL handling in `absolutizeFileUrl()` for assets
  with `#` fragments or queries,
- race between the snapshot response and the iframe's own load cycle,
- MIME sniffing on files written without extensions (e.g. plain-text logs
  getting served as `application/octet-stream`).

Repro: generate a file in a cowork chat, switch chats, switch back. Preview
sometimes shows the spinner indefinitely.

### Fix chat stream jitter
Assistant messages visibly "hop" as tokens arrive — the bubble reflows
instead of appending. Likely caused by:

- re-rendering the entire message list on each SSE frame rather than just
  the trailing message,
- markdown renderer re-parsing the full string every tick,
- tool-call blocks being inserted mid-stream and re-keying the siblings.

Fix direction: virtualize the list, or at minimum memoize all but the tail
message and stream into a dedicated node.

### Model listing fix
The model dropdown in Settings and the Composer don't fully agree:

- Composer shows a stale hard-coded list,
- Settings shows the curated "Let Claude pick / Aliases / Pinned" groups,
- neither actually queries the CLI for the set of models the logged-in
  account has access to.

Wire `claude -p "/models"` (or whatever the stable equivalent is) into the
backend, cache for a few minutes, and feed both pickers from that.

## Testing

### Chroot jail mode testing
The new **Docker shell** mode spawns `claude` inside a container with the
working directory bind-mounted. Still needs:

- soak test that `--add-dir` mounts actually show up inside the container
  with the right permissions,
- verify credential pass-through via `~/.claude` bind-mount works across
  host and container uid mismatches,
- confirm file writes from inside the container land back on the host
  with sane ownership,
- document how to build a minimal custom image (without pulling the
  reference image) for users on corporate networks.

### Compliance testing
End-to-end verify the claims in `COMPLIANCE.md`:

- packet-capture the app on a fresh profile with no user interaction,
  confirm zero outbound traffic from the Electron process,
- confirm the app never reads `~/.claude/credentials` or equivalent —
  only invokes `claude auth status --json`,
- confirm the disclaimer modal blocks the UI on first launch and
  persists acknowledgement across restarts,
- confirm uninstalling the app leaves the CLI's login state intact.

## Nice-to-haves (not scoped yet)

- Keyboard shortcut cheat sheet modal.
- Export a cowork chat (prompts + files) as a zip.
- Pluggable MCP server management from the UI instead of shelling out to
  `claude /config`.
