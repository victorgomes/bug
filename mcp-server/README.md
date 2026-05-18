# bnz-mcp

MCP server exposing `bnz`'s Buganizer + ClusterFuzz fetchers to Claude Code (or
any other MCP client). Wraps the same Playwright session the CLI uses, but
keeps it warm across tool calls so the per-query cost drops from a full
Chromium launch to a single navigation.

## Setup

The server uses the same on-disk auth profile as the CLI
(`~/.config/bnz/profile`). If you have not already, run the CLI's interactive
login once per host:

```sh
bnz login        # issuetracker.google.com
bnz cf login     # clusterfuzz.com
```

Then register the server with Claude Code. The simplest path is the
`claude mcp add` command:

```sh
claude mcp add bnz -- node /home/jakob/src/buganizer_and_clusterfuzz/mcp-server/server.js
```

…or add it to `~/.claude/mcp.json` (or `.mcp.json` in a repo) by hand:

```json
{
  "mcpServers": {
    "bnz": {
      "command": "node",
      "args": ["/home/jakob/src/buganizer_and_clusterfuzz/mcp-server/server.js"]
    }
  }
}
```

The browser launches lazily on the first tool call and tears down after 5
minutes idle (measured from when the last tool call finished, not started, so
a long-running batch can't have the timer fire mid-fetch). Override the
window with `BNZ_MCP_IDLE_MS=<ms>` in the server's environment; set it to `0`
to disable teardown entirely.

## Tools

| Tool        | Required args | Optional args                                                | Returns |
|-------------|---------------|--------------------------------------------------------------|---------|
| `bnz_list`  | `query`       | `since`, `max_pages`, `full`, `refresh`, `format`, `output_file` | Search hit table (markdown) or result object (json) |
| `bnz_issue` | `ids[]`       | `full`, `refresh`, `format`, `output_file`                   | Issues concatenated (markdown) or array of result objects (json) |
| `bnz_cf`    | `inputs[]`    | `full`, `refresh`, `format`, `output_file`                   | Testcases concatenated (markdown) or array of result objects (json) |

`bnz_issue` and `bnz_cf` are batched — pass an array, get one response back.
Prefer one batched call over N single-item calls so the warm browser is
reused across the whole batch. Each array item accepts the same shapes the
CLI does: bare numeric ids, `b/<id>` shortcuts, and full URLs. `bnz_cf` also
accepts an issue id, in which case the testcase link is extracted from the
issue body.

Per-item errors are reported inline (a small error block in markdown, or
`{input, error}` entries in json) so a single bad input doesn't lose the
work done on the rest of the batch. An auth failure short-circuits the
whole call since every subsequent fetch would hit the same wall, and tears
the session down so the next call re-launches and picks up cookies you
refreshed via `bnz login` in the meantime.

`since` accepts duration strings (`7d`, `1w`, `24h`, `1m`) or ISO dates
(`2026-05-01`).

`output_file` (absolute path) writes the rendered output to disk and returns
a short envelope (path, byte count, per-item status) instead of the full
content. Use it when you're batching enough items that you don't want the
full body in the model's context — typically `bnz_list` with hundreds of
hits, or `bnz_issue` over a dozen+ ids.

## Out of scope (vs the CLI)

- Interactive `login` flows (use the CLI for those — they need a headed browser).
- `--download-attachments` / `--download-original` (these write to a path on
  the server host, which doesn't fit the MCP request/response model cleanly).
- Concurrent execution within one session: the underlying Playwright page is
  shared, so tool calls are serialized.
