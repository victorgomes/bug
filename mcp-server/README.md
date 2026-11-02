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

Install the package as described in the top-level README, then register the
global `bnz-mcp` executable with Claude Code:

```sh
claude mcp add bnz -- bnz-mcp
```

Or add it to `~/.claude/mcp.json` (or `.mcp.json` in a repo) by hand:

```json
{
  "mcpServers": {
    "bnz": {
      "command": "bnz-mcp"
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
| `bnz_list`  | *(none)*      | `query`, `slo`, `since`, `max_pages`, `full`, `refresh`, `format`, `output_file` | Search hit table / SLO view (markdown) or result object (json) |
| `bnz_issue` | `ids[]`       | `full`, `refresh`, `format`, `output_file`                   | Issues concatenated (markdown) or array of result objects (json) |
| `bnz_cf`    | `inputs[]`    | `full`, `refresh`, `format`, `output_file`                   | Testcases concatenated (markdown) or array of result objects (json) |
| `bnz_comment` | `ids[]`, `comment` | `markdown`, `dry_run`, `format`, `output_file`          | Comment confirmation per issue (markdown) or array of result objects (json) |
| `bnz_close` | `ids[]`       | `status`, `duplicate_of`, `comment`, `markdown`, `assignee`, `dry_run`, `format`, `output_file` | Close confirmation per issue (markdown) or array of result objects (json) |
| `bnz_fields` | `ids[]`      | `full`, `format`, `output_file`                              | Standard + custom fields, current values, and allowed enum choices per issue |
| `bnz_edit`  | `ids[]`       | `assignee`, `status`, `priority`, `severity`, `type`, `title`, `component_id`, `verifier`, `code_changes`, `add_code_changes`, `remove_code_changes`, `cc`, `add_cc`, `remove_cc`, `collaborators`, `add_collaborators`, `remove_collaborators`, `found_in`, `targeted_to`, `verified_in`, `fields`, `add_fields`, `remove_fields`, `clear_fields`, `comment`, `markdown`, `dry_run`, `format`, `output_file` | Field diff confirmation per issue (markdown) or array of result objects (json) |

`bnz_issue`, `bnz_cf`, `bnz_comment`, `bnz_close`, `bnz_fields`, and `bnz_edit`
are batched — pass an array, get one response back.
Prefer one batched call over N single-item calls so the warm browser is
reused across the whole batch. Each array item accepts the same shapes the
CLI does: bare numeric ids, `b/<id>` shortcuts, and full URLs. `bnz_cf` also
accepts an issue id, in which case the testcase link is extracted from the
issue body.

`bnz_edit` updates standard fields (`type` such as downgrading `"vulnerability"`
-> `"bug"` or promoting `"bug"` -> `"vulnerability"`, `priority` `P0`..`P4`,
`severity` `S0`..`S4`, `assignee` including `"me"` or `"none"` to unassign,
`status`, `code_changes` / `add_code_changes` with full `/c/<repo>/+/<cl>`
Gerrit URLs or Critique CLs, `cc`, `collaborators`, etc.) and any component
custom fields via `fields` (set or `null` to clear), `add_fields` (append to
repeated fields like `OS`), `remove_fields`, and `clear_fields`. Use
`bnz_fields` to inspect an issue's available custom field names, types, and
allowed enum values.

`bnz_close` supports `status` values `fixed` (default, or `duplicate` when
`duplicate_of` is set), `verified`, `duplicate`, `wontfix` / `infeasible`,
`intended_behavior` (WAI), `not_reproducible`, `obsolete`, and `inactive`.
Closing an unassigned (`New`) issue as `fixed` or `verified` automatically
assigns it to the authenticated Buganizer user unless `assignee` is specified.
`bnz_comment`, `bnz_close`, and `bnz_edit` all accept `dry_run: true` to
validate access/schemas and preview the mutation without writing to Buganizer,
and invalidate the on-disk issue cache on write.

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
