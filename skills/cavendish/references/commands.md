# Cavendish Command Reference

Run `cavendish <command> --help` for full flag details.

## Exit Codes

| Code | Category | Recovery |
|------|----------|----------|
| 0 | Success | — |
| 2 | `cdp_unavailable` | `cavendish init` |
| 3 | `chrome_not_found` | Install Google Chrome |
| 4 | `auth_expired` | Re-login in Chrome |
| 5 | `cloudflare_blocked` | Solve in Chrome tab |
| 6 | `selector_miss` | `cavendish status` |
| 7 | `timeout` | Increase `--timeout` |
| 8 | `chrome_launch_failed` | `cavendish init` |
| 9 | `chrome_close_failed` | Close Chrome manually |

JSON error output (stderr, with `--format json`):
```json
{"error": true, "category": "cdp_unavailable", "message": "...", "exitCode": 2, "action": "Run \"cavendish init\"..."}
```

## Batch Operations

delete, archive, move accept multiple IDs and `--stdin`:
```bash
cavendish delete id1 id2 id3
cavendish list --format json | jq -r '.[].id' | cavendish delete --stdin
```

Per-item errors are logged but do not stop the batch. Summary shown at end.

## Detached Jobs

```bash
cavendish ask --detach "question"
cavendish deep-research --detach "topic"
cavendish jobs list
cavendish jobs status <job-id>
cavendish jobs wait <job-id>
```
