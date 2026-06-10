# fail2ban — nginx rate-limit jail (EA-SYS)

Bans IPs that **repeatedly** trip the nginx `limit_req`/`limit_conn` rate limit
(the 429s from `deploy/nginx.conf`). The nginx layer *throttles*; this jail
*drops* a persistent flooder at the firewall so it stops reaching the box at all.

This complements the existing **`sshd`** jail (SSH brute-force) — it's an
additional jail, not a replacement.

| File | Goes to (on the box) | Purpose |
|---|---|---|
| `filter.d/nginx-limit-req.conf` | `/etc/fail2ban/filter.d/` | Regex matching nginx's "limiting requests/connections … client: <IP>" error lines |
| `jail.d/nginx-rate-limit.conf` | `/etc/fail2ban/jail.d/` | The jail: thresholds, log path, ban time |
| `setup.sh` | run on the box | Idempotent installer (copy → dry-run → reload → status) |

## Install

```bash
# On the Mumbai box (SSM lands as root):
aws ssm start-session --target i-0b51ab1213d084640 --region ap-south-1
# Pull the latest repo if needed, then:
bash /home/ubuntu/ea-sys/infra/fail2ban/setup.sh
```

Or by hand:
```bash
sudo cp filter.d/nginx-limit-req.conf /etc/fail2ban/filter.d/
sudo cp jail.d/nginx-rate-limit.conf  /etc/fail2ban/jail.d/
sudo fail2ban-regex /var/log/nginx/error.log /etc/fail2ban/filter.d/nginx-limit-req.conf  # dry-run
sudo systemctl reload fail2ban
sudo fail2ban-client status nginx-rate-limit
```

## Verify it's armed

```bash
sudo fail2ban-client status nginx-rate-limit   # shows file monitored + currently-banned list
# Generate some 429s from a test IP (a quick curl flood — see AWS_OPERATIONS.md §4.1),
# then re-check the banned list. To watch live:
sudo tail -f /var/log/fail2ban.log | grep nginx-rate-limit
```

## Operate

```bash
# Unban an IP (e.g. you false-positived your own office):
sudo fail2ban-client set nginx-rate-limit unbanip 203.0.113.9

# Permanently whitelist an IP — add it to `ignoreip` in jail.d/nginx-rate-limit.conf,
# then re-run setup.sh (or `sudo systemctl reload fail2ban`).

# See everything fail2ban is doing:
sudo fail2ban-client status
```

## Tuning (the shared-NAT tradeoff)

A ban blocks the **whole IP**, and EA-SYS attendees often share one venue-WiFi
IP — so a false-positive bans a crowd. The defaults are deliberately
conservative:

| Setting | Default | Meaning |
|---|---|---|
| `maxretry` | 100 | # of rejected (429) requests within the window before a ban |
| `findtime` | 120s | the window |
| `bantime`  | 1800s (30 min) | how long the ban lasts |

So an IP must generate **100+ rate-limited requests within 2 minutes** to be
banned. A real flooder hits that in seconds; a legit registration rush from a
shared NAT is bursty and subsides, so it won't. If you still see legit bans
during big on-site events, raise `maxretry` / shorten `bantime`, or add the
venue's egress IP to `ignoreip`. If you want to catch flooders faster, lower
`maxretry`.

**Always keep `127.0.0.1/8 ::1` in `ignoreip`**, and consider adding your office
egress IP and any uptime-monitor IPs so you can never lock yourself out.

> Note: the GitHub Actions deploy uses **SSH (port 22)**, which is guarded by the
> separate `sshd` jail — this nginx jail only touches http/https, so it can't
> interfere with deploys.
