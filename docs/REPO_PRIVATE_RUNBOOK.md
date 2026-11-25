# Making the repository private: runbook

**Status: NOT DONE (written Nov 25, 2026).** The repository `meetingmindsexperts/ea-sys` is public. This is the
order to make it private in, and why each step is there. Every step that changes the server or GitHub's settings is
the owner's to run; nothing here has been run.

**Do not start on a day with a live event, and never within a few minutes of a scheduled email send.** Step 2 changes
how the production server fetches code; step 5 is the switch itself.

## What was checked on Nov 25, 2026 (and what was not)

| Checked | Found |
|---|---|
| Visibility | Public. 1 star, 1 fork. |
| Deploy keys on the repository | None (`gh api repos/meetingmindsexperts/ea-sys/keys` is empty). |
| How a deploy gets the code onto the server | The deploy job signs in to the server and runs `git fetch origin`, then `git reset --hard <commit>` (`.github/workflows/deploy.yml`, "Checking out deploy commit"). |
| The standby server's rebuild | `infra/dr/user-data.sh` line 81 runs `git clone` over HTTPS with no sign-in. |
| The fork | `krishnapallapolu/ea-sys`, public, last pushed Nov 23, 2026. |
| Build minutes | 35 billable minutes per deploy (the ten jobs of run 45577663994 added up); 253 runs in the 30 days before Nov 25. |
| Docs-only pushes | Already skipped (`paths-ignore` in `deploy.yml`); none of the last 119 pushes was docs-only, so there is no saving left there. |
| Protections in use | Secret scanning and push protection are on. One ruleset, "Main", is active: it blocks deleting `main` and force-pushing to it. |

**Not checked:** the server's own git settings. With no deploy key, the fetch most likely works only because the
repository is public, but a saved token on the server would also explain it. Step 1 answers that. Also not checked:
GitHub's current prices and which protections a free private repository keeps. Read GitHub's own pages for both
before step 5.

## What breaks, stays exposed or starts costing

1. **Deploys.** If the server fetches without signing in, the first deploy after the switch stops at
   "Commit ... not found on the box after fetch. Aborting." The site keeps running the previous version; nothing new
   can be deployed until the server can sign in. Steps 1 to 3 remove this risk before the switch.
2. **The fork stays public.** GitHub detaches a public fork from a repository that goes private and leaves it
   public, with everything it had at its last sync. Step 4.
3. **The standby rebuild.** A rebuild of the Singapore standby, or of production from nothing
   (`docs/FROM_SCRATCH_REBUILD.md`), clones the repository. Private, that clone needs a key or a token. Step 6.
4. **Build minutes.** Public repositories build free. Private ones on a personal account have a monthly allowance
   (about 2,000 minutes on the free plan when this was written, from memory); at 35 minutes a deploy and about 250
   deploys a month, that is roughly 8,800 minutes, most of it paid.
5. **Protections.** Secret scanning, push protection and the "Main" ruleset may need a paid plan on a private
   repository. If the ruleset stops, nothing blocks a force-push to `main`.
6. **The past.** Going private hides the code from now on. It does not take back what was already cloned, forked or
   indexed. Any secret that was ever committed is to be treated as known: rotate it (the MCP key named in the September
   2026 compliance report is one).

## The steps

### 1. See how the server fetches today (read only)

On the production server, as the deploy user:

```bash
cd /home/ubuntu/ea-sys
git remote -v
git config --show-origin --get-all credential.helper || echo "no credential helper"
```

`https://github.com/meetingmindsexperts/ea-sys.git` with no credential helper means the fetch is anonymous: steps 2
and 3 are required. A `git@github.com:` address means a key is already in use: find which one (`ssh -T git@github.com`)
and skip to step 4.

### 2. Give the server its own read-only key

On the production server, as the deploy user:

```bash
ssh-keygen -t ed25519 -C "ea-sys production server (read-only deploy key)" -f ~/.ssh/ea_sys_deploy -N ""
cat ~/.ssh/ea_sys_deploy.pub
```

Add the printed line in GitHub: the repository's Settings, Deploy keys, Add deploy key. Title "production server
(ap-south-1)". Leave "Allow write access" unticked.

Back on the server:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-ea-sys
  HostName github.com
  User git
  IdentityFile ~/.ssh/ea_sys_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
ssh -T git@github-ea-sys
```

The last command should answer "Hi meetingmindsexperts/ea-sys! You've successfully authenticated". If it hangs, the
server cannot reach GitHub on port 22: add `Port 443` and change `HostName` to `ssh.github.com` in the block above.

A deploy key belongs to one repository and one machine. Do not copy this key to the standby: it gets its own (step 6).

### 3. Point the server at the key, and prove a deploy still works

```bash
cd /home/ubuntu/ea-sys
git remote set-url origin git@github-ea-sys:meetingmindsexperts/ea-sys.git
git fetch origin && git status -sb
```

Then run one ordinary deploy while the repository is still public (push a small code change, or run the workflow by
hand from the Actions tab) and watch it finish. This is the step that matters: it proves the deploy path works over the
key before anything depends on it. Going back is one command:
`git remote set-url origin https://github.com/meetingmindsexperts/ea-sys.git`.

### 4. The fork

Signed in as `krishnapallapolu`: delete the fork (its Settings, Danger Zone, Delete this repository), or keep it and
make it private right after step 5 (a fork of a public repository cannot be made private while it is still attached).
Check for others just before the switch: `gh api repos/meetingmindsexperts/ea-sys/forks --jq '.[].owner.login'`.

### 5. The switch

Read GitHub's page on changing visibility and its Actions pricing page first. Then, in the repository's Settings,
General, Danger Zone, "Change repository visibility", choose Private. From a terminal it is:

```bash
gh repo edit meetingmindsexperts/ea-sys --visibility private --accept-visibility-change-consequences
```

Stars and watchers are removed and public forks are detached. Neither comes back if the repository is made public
again.

### 6. Right after

1. `gh repo view meetingmindsexperts/ea-sys --json visibility` says PRIVATE, and the repository's address opens a
   "not found" page in a private browser window.
2. Run a deploy and watch it finish, then check `https://events.meetingmindsgroup.com/api/health` shows the new commit.
3. Settings, Code security: is secret scanning still on? Settings, Rules: is "Main" still enforced? If either stopped,
   decide between a paid plan and going without, knowingly.
4. Anything else that reads the repository must be given access: Vercel (its GitHub app, and check that its builds
   still start), the Claude cloud routines (the Claude GitHub app), Sentry. Each was fine with a public repository by
   default; none was tested with a private one.
5. The standby: change `infra/dr/user-data.sh` (line 81) and the clone step in `docs/FROM_SCRATCH_REBUILD.md` to sign
   in, with a second deploy key or a token held in the parameter store, and rehearse one standby rebuild. Until this is
   done, a rebuild from nothing fails at the clone.
6. Watch the first month's Actions usage (Settings, Billing and plans). If it is too much: push less often (a push is
   a deploy, and several commits can ride one push), or use `.github/deploy-fast.yml` when the owner says so. Never move
   the builds onto the production server (INC-001).
7. Rotate every secret that was ever committed. Going private does not make an exposed key safe.

## Going back

`gh repo edit meetingmindsexperts/ea-sys --visibility public --accept-visibility-change-consequences`. The server's key
keeps working either way, so step 3 never needs undoing.
