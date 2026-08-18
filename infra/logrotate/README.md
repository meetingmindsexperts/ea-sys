# Application log rotation

Rotates `~/ea-sys/logs/app.log` and `error.log` on the EC2 box.

```bash
bash infra/logrotate/setup.sh
```

## Why this exists

[src/lib/logger.ts](../../src/lib/logger.ts) writes both files with plain
`pino.destination(...)`: append-only, no size cap, no roll. Nothing in the
application rotates them, and until **2026-08-18** nothing on the box did
either — there was no `/etc/logrotate.d/ea-sys`. Both files had therefore been
growing since the box was built.

It surfaced when an error-feedback loop during the contacts import drove them to
**1.2 GB each in about ten minutes**, and `/logs` started failing with
`RangeError: Invalid string length` because the file no longer fit in a single
JS string. Disk was at 67%, so it was never close to an outage, but the leak was
real and had simply been slow enough to go unnoticed.

## What it is NOT

Do not confuse this with the **`log-archive` worker job**. That archives the
`SystemLog` **table** monthly into `logs/archive/*.jsonl.gz`. The database side
was already bounded. The **files** were not. Two different problems, similar
names.

The same log lines exist in three places, so rotating the files loses nothing
unique:

| Where | Retention | Bounded by |
|---|---|---|
| `logs/*.log` on the box | 7 rotations at 100 MB | **this config** |
| `SystemLog` table | 30 days hot, then archived | `system-log-prune` + `log-archive` jobs |
| CloudWatch Logs | 30 days app / 90 days error | `infra/cloudwatch/` |

## Two things in the config that are load-bearing

**`copytruncate`.** The files are held open by the running web and worker
containers, which write by file descriptor. Ordinary rotation renames the file
and the process carries on writing to the same inode — the "rotated" file keeps
growing invisibly and **no space is reclaimed**. `copytruncate` copies the
contents aside and truncates the original in place, which an open descriptor
tolerates. The same reason `truncate -s 0` is the correct manual fix and `rm`
is not.

**`su ssm-user ssm-user`.** The containers run as uid 1001, which surfaces on
the host as `ssm-user`. Rotated files must keep that ownership or the containers
lose the ability to write. This is the same ownership trap as
[INC-004](../../docs/INCIDENTS.md).

## The timer

`size 100M` only means something if logrotate runs often. The stock
Debian/Ubuntu `logrotate.timer` fires **daily**, which would have let the 2.4 GB
above accumulate untouched between runs. Switch it to hourly:

```bash
sudo systemctl edit logrotate.timer
#   [Timer]
#   OnCalendar=
#   OnCalendar=hourly
sudo systemctl restart logrotate.timer
```

The empty `OnCalendar=` is required: it clears the inherited daily schedule
before setting the new one, otherwise both apply.

## Verifying

```bash
sudo logrotate -d /etc/logrotate.d/ea-sys      # parse only, rotates nothing
sudo logrotate -f /etc/logrotate.d/ea-sys      # force one rotation now
ls -lh ~/ea-sys/logs/
```

A valid `-d` run is worth doing after any edit: a broken stanza makes logrotate
abort the **whole** run, including every other config on the box, and it fails
quietly inside the timer.

## Known gap

This is box-level configuration, so a rebuilt instance does not get it
automatically. It is listed in
[docs/FROM_SCRATCH_REBUILD.md](../../docs/FROM_SCRATCH_REBUILD.md). The
belt-and-braces fix would be a size cap inside pino itself (`pino-roll`), which
travels with the image instead of the box — not done, deliberately, because it
changes the logging hot path and this config solves the actual problem.
