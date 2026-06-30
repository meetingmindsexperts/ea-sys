# loadtest/

k6 load-test scripts for EA-SYS. Full guide — **including the safety rules for a live
production system** — is in [docs/LOAD_TESTING.md](../docs/LOAD_TESTING.md). Read it
before running anything that writes.

| Script | Writes? | Safe target | One-liner |
|---|---|---|---|
| `k6/read-burst.js` | No | Prod (off-hours) OK | `k6 run -e BASE_URL=… -e EVENT_SLUG=… k6/read-burst.js` |
| `k6/register-burst.js` | **Yes** | Staging / disposable DRAFT event + FREE ticket | needs `CONFIRM_WRITE=yes` |
| `k6/checkin-burst.js` | **Yes** | Staging / test event | needs `CONFIRM_WRITE=yes` + session cookie |

Write scripts refuse to run without `CONFIRM_WRITE=yes`, and refuse prod writes without
an additional `I_REALLY_MEAN_PROD=yes`. Use a **free** ticket type for register tests so
no emails (→ no bounces → no SES reputation hit) and no Stripe are involved.

```bash
brew install k6   # then see docs/LOAD_TESTING.md
```
