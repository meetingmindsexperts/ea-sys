# Making the repository private: runbook

**Status: NOT DONE (written Nov 25, 2026; reviewed and corrected the same day, see the end).** The repository
`meetingmindsexperts/ea-sys` is public. This is the order to make it private in, and why each step is there. Every
step that changes the server, GitHub's settings or AWS is the owner's to run; nothing here has been run.

**Do not start on a day with a live event, and never within a few minutes of a scheduled email send.** Step 2 changes
how the production server fetches code; step 7 is the switch itself.

## What was checked on Nov 25, 2026 (and what was not)

| Checked | Found |
|---|---|
| Visibility and owner | Public. 1 star, 1 fork. Owned by a personal account (`meetingmindsexperts` is a user, not an organisation), which decides what a private repository keeps. |
| Deploy keys on the repository | None (`gh api repos/meetingmindsexperts/ea-sys/keys` is empty). |
| How a deploy gets the code onto the server | The deploy job signs in to the server and runs `git fetch origin`, then `git reset --hard <commit>` (`.github/workflows/deploy.yml`, "Checking out deploy commit"). `scripts/deploy.sh` runs no git. Images go to ECR, not GitHub's registry, so they are not affected. |
| The standby server's rebuild | Already signs in: `infra/dr/user-data.sh` (lines 71 to 82) reads `GITHUB_DR_TOKEN` from the restored `.env` and clones with it (a fine-grained token, Contents: read; `infra/dr/README.md` section 2). Not checked: that the token is still in the `.env`, unexpired, and granted this repository by name. Step 5. |
| The fork | `krishnapallapolu/ea-sys`, public, last synced Nov 23, 2026. That account is not a collaborator on the repository. |
| The build machine | GitHub's own table: a job in a public repository gets 4 CPUs and 16 GB of memory, in a private one 2 CPUs and 8 GB. `deploy.yml` is sized for 16 GB (its comments say so; type-check runs with a 6 GB heap beside lint). |
| Build cost | 35 billable minutes per deploy today (the ten jobs of run 45577663994), about 250 runs in the 30 days before Nov 25. GitHub Free includes 12 dollars of build time a month for private repositories, a Linux minute costs 0.6 cents, and "usage is blocked once you consume the included compute usage" when the account has no valid payment method. |
| Docs-only pushes | Already skipped (`paths-ignore` in `deploy.yml`), so there is no saving left there. |
| Protections in use | Secret scanning and push protection are on (free for public repositories). The ruleset "Main" is active but **protects nothing today**: it names no branch (`conditions.ref_name.include` is empty, and `gh api repos/meetingmindsexperts/ea-sys/rules/branches/main` answers `[]`), and the admin role bypasses it always. |
| Vercel | Still connected: it builds every push. It does not serve production and applies no migration (`vercel.json`), so a Vercel build that stops breaks nothing live. |
| Who may push build images | The AWS role the build uses (`ea-sys-gha-ecr-push`) trusts **every repository of the `meetingmindsexperts` account**, not this one alone. It matters for step 4. |

**Not checked:** the server's own git settings (step 1 answers that); the account's payment method and budgets (the
token used cannot read billing); the Vercel plan. GitHub's and Vercel's pages were read on Nov 25, 2026; prices and
plans change, so read them again on the day (links at the end).

## What breaks, stays exposed or starts costing

1. **Deploys, if the server fetches without signing in.** The first deploy after the switch stops at "Commit ... not
   found on the box after fetch. Aborting." The site keeps running the previous version; nothing new can be deployed
   until the server can sign in. Steps 1 to 3 remove this risk before the switch. A rollback by image
   (`docs/ROLLBACK.md`) needs no fetch and keeps working.
2. **The pipeline may not fit the smaller build machine.** Half the CPUs and half the memory. The type-check step
   alone asks for 6 GB beside lint on a machine that will have 8, and most jobs are stopped at 15 minutes. If `checks` or
   `build` runs out of memory or time, nothing deploys until the workflow is changed or the repository is public
   again. Step 4 finds out before the switch.
3. **Build time is paid, and can stop.** About 250 deploys at 35 minutes is 8,750 minutes, about 52 dollars at today's
   price, less the 12 included: about 40 dollars a month, more if the smaller machine runs longer. The included 12
   dollars last about 57 deploys, roughly a week. With no payment method, GitHub then blocks every job, including the
   one that sends the "deploy failed" alert, so nobody is told. Step 6.
4. **The fork stays public.** GitHub detaches a public fork from a repository that goes private and leaves it public,
   with everything it had at its last sync. Step 6.
5. **Secret scanning and push protection end.** For a private repository owned by a personal account GitHub offers
   neither on Free or Pro (they are for organisations on a paid plan), and the account's own push protection covers
   pushes to public repositories only. What remains is ours: `scripts/check-no-secrets.sh`, which gates every deploy.
   The "Main" ruleset is no loss, since it protects nothing today; if a real one is wanted, GitHub lists protected
   branches for private repositories under Pro.
6. **Vercel may stop building.** Vercel's rule for a Hobby team: "the commit author must be the owner of the Hobby
   team", and it "does not support collaboration for private repositories". Every commit here also carries a
   Co-Authored-By line; the page does not say whether that counts. Nothing live depends on Vercel (see the table), so
   this is a red mark on commits, not an outage.
7. **The past.** Going private hides the code from now on. It does not take back what was already cloned, forked or
   indexed. Any secret that was ever committed is to be treated as known. One is known: the organisation API key of
   INC-005 (`docs/INCIDENTS.md`), whose rotation is still open. A search of the history for the shapes of AWS, GitHub,
   Stripe, Anthropic, Brevo and `mmg_` keys and private keys found only that one. Step 0.

## The steps

### 0. Rotate the exposed key (does not wait for anything)

The key of INC-005: Settings, API Keys. The new key goes into the n8n workflow first, or its sync stops. This does not
depend on the switch and should not wait for it.

### 1. See how the server fetches today (read only)

On the production server, as the deploy user (through Session Manager you land as `ssm-user`: run `sudo -iu ubuntu`
first, or step 2's key lands in the wrong home):

```bash
cd /home/ubuntu/ea-sys
git remote get-url origin | sed -E 's#//[^@/]+@#//<token hidden>@#'
git config --show-origin --get-all credential.helper || echo "no credential helper"
git config --show-origin --get-regexp '^(url\..*\.insteadof|http\..*extraheader)$' || echo "no rewrites or extra headers"
ls -la ~/.netrc 2>/dev/null || echo "no .netrc"
```

The `sed` is there because an address can hold a token (the standby's clone leaves one in `.git/config`): never
paste the plain `git remote -v` anywhere.

- `https://github.com/...` with nothing else found: the fetch is anonymous. Steps 2 and 3 are required.
- `https://<token hidden>@github.com/...`, a credential helper or a `.netrc`: a saved token is in use. It keeps
  working after the switch only if it is unexpired and granted this repository. Do steps 2 and 3 anyway: a read-only
  key for one repository is the better thing to leave on a production server.
- `git@github.com:...`: a key is in use, and since the repository has no deploy key it is a key of a GitHub
  **account**, which can write to everything that account owns. Run `ssh -T git@github.com` to see whose. Do steps 2
  and 3 anyway, then remove that key from the account (its Settings, SSH and GPG keys) once step 3's deploy passed.

### 2. Give the server its own read-only key

On the production server, as `ubuntu`:

```bash
ssh-keygen -t ed25519 -C "ea-sys production server (read-only deploy key)" -f ~/.ssh/ea_sys_deploy -N ""
cat ~/.ssh/ea_sys_deploy.pub
```

Add the printed line in GitHub: the repository's Settings, Deploy keys, Add deploy key. Title "production server
(ap-south-1)". Leave "Allow write access" unticked.

Back on the server:

```bash
cat >> ~/.ssh/config <<'CONF'
Host github-ea-sys
  HostName github.com
  User git
  IdentityFile ~/.ssh/ea_sys_deploy
  IdentitiesOnly yes
CONF
chmod 600 ~/.ssh/config
ssh -T git@github-ea-sys
```

The last command should answer "Hi meetingmindsexperts/ea-sys! You've successfully authenticated". If it hangs, the
server cannot reach GitHub on port 22: add `Port 443` and change `HostName` to `ssh.github.com` in the block above.

A deploy key belongs to one repository and one machine. Do not copy it to the standby, which signs in with its own
token (step 5).

### 3. Point the server at the key, and prove a deploy still works

```bash
cd /home/ubuntu/ea-sys
git remote set-url origin git@github-ea-sys:meetingmindsexperts/ea-sys.git
git fetch origin && git status -sb
```

Then run one ordinary deploy while the repository is still public (push a small code change, or run the workflow by
hand from the Actions tab) and watch it finish. This is the step that matters: it proves the deploy path works over the
key before anything depends on it. Going back is one command: `git remote set-url origin` with the address step 1
showed.

### 4. Try the pipeline on a private repository's build machine

The only way to get the smaller machine is a private repository. Use a throwaway private copy **under the
`krishnapallapolu` account, not `meetingmindsexperts`**: the AWS role that pushes build images trusts every repository
of `meetingmindsexperts`, so a copy there would push its images over production's. A copy under another account is
refused by AWS and holds no secrets, so it can test and build but cannot push or deploy.

Signed in to `gh` as `krishnapallapolu` (`gh auth status` says who; `gh auth setup-git` makes the push below sign in
as the same account), from a clean checkout of `main`:

```bash
gh repo create krishnapallapolu/ea-sys-ci-rehearsal --private
git push https://github.com/krishnapallapolu/ea-sys-ci-rehearsal.git main:main
gh run watch --repo krishnapallapolu/ea-sys-ci-rehearsal
```

Expected: "Lint · types · guards", "Unit tests", "Build (gating)", "DB integration", "Migration replay" and "Online
venue" pass. The two "Build & push ... image" jobs fail at "Configure AWS credentials" (that is the refusal, and it
is the end of the rehearsal), "Sentry source maps" and "Alert on failure" fail for lack of secrets, and the deploy
never starts. Note each passing job's minutes: their sum, plus about 12 for the two image builds and the deploy that
could not run, is the real figure for item 3 above. Then delete the copy:
`gh repo delete krishnapallapolu/ea-sys-ci-rehearsal --yes` (it asks `gh auth refresh -s delete_repo` first if the
sign-in lacks that right).

If `checks` or `build` runs out of memory or time, stop here: the workflow has to change first (type-check and lint
one after the other instead of side by side is the first thing to try), on the public repository, proven by a normal
deploy, before the switch.

Worth doing whatever is decided: narrow that AWS role's trust to this repository's `main` branch
(`repo:meetingmindsexperts/ea-sys:ref:refs/heads/main`).

### 5. The standby's token

On the production server: `grep -c '^GITHUB_DR_TOKEN=' /home/ubuntu/ea-sys/.env` should print 1. In GitHub, signed in
as the account that made it: Settings, Developer settings, Fine-grained tokens. It must be unexpired, with
"Repository access" naming `ea-sys` (a token for "Public repositories" stops working at the switch) and Contents:
Read-only. Make a new one if not (`infra/dr/README.md` section 2 has the steps). After the switch, rehearse one standby
rebuild: it is the only proof.

### 6. Paying for builds, and the fork

- In the account's Settings, Billing and licensing: a valid payment method, and under Budgets and alerts a budget for
  Actions that is neither zero nor too low for the figure from step 4 (GitHub: "spending may be limited by one or more
  budgets"). GitHub emails at 90% and 100% of the included amount. If the cost is too much: push less often (a push is
  a deploy, and several commits can ride one push), or use `.github/deploy-fast.yml` when the owner says so. Never move
  the builds onto the production server (INC-001).
- The fork was synced two days before this was written, so something or someone uses it: find out what before
  removing it. Then, signed in as `krishnapallapolu`: delete it (its Settings, Danger Zone), or keep it and make it
  private right after step 7 (a fork of a public repository cannot be made private while it is still attached). If
  that account still needs to read the code, add it as a collaborator: it has no access today and loses the public
  view at the switch. Check for other forks just before the switch:
  `gh api repos/meetingmindsexperts/ea-sys/forks --jq '.[].owner.login'`.
- Vercel: see which plan the project is on. Decide whether it should stay connected at all (an open question since
  September 2026): disconnecting it removes item 6 above.

### 7. The switch

Read GitHub's pages again first (links below). Then, in the repository's Settings, General, Danger Zone, "Change
repository visibility", choose Private. From a terminal it is:

```bash
gh repo edit meetingmindsexperts/ea-sys --visibility private --accept-visibility-change-consequences
```

Stars and watchers are removed and public forks are detached. Neither comes back if the repository is made public
again.

### 8. Right after

1. `gh repo view meetingmindsexperts/ea-sys --json visibility` says PRIVATE, and the repository's address opens a
   "not found" page in a private browser window.
2. Run a deploy and watch it finish, then check `https://events.meetingmindsgroup.com/api/health` shows the new commit.
3. Anything else that reads the repository: Vercel (do its builds still start?), the Claude cloud routines (the Claude
   GitHub app), Sentry. None was tested with a private repository.
4. Rehearse one standby rebuild (step 5).
5. Watch the first week's Actions usage (Settings, Billing and licensing) against the figure from step 4.

## Going back

`gh repo edit meetingmindsexperts/ea-sys --visibility public --accept-visibility-change-consequences`. The server's key
keeps working either way, so step 3 never needs undoing. Stars, watchers and the fork's link do not return.

## Where the facts came from (read Nov 25, 2026)

- Build machines: docs.github.com, "GitHub-hosted runners" (the public and private tables).
- Build cost and blocking: docs.github.com, "GitHub Actions billing" (12 dollars included on Free, 18 on Pro; Linux
  2-core 0.006 dollars a minute). Whether a new budget starts at zero was not read: check the Budgets page.
- What a private repository loses: docs.github.com, "Setting repository visibility", "About secret scanning", "About
  push protection", "GitHub's plans".
- Vercel: vercel.com/docs, "Troubleshoot project collaboration".

Review of 263a38baa (0 BLOCKER, 3 HIGH, 2 MED, 6 LOW), corrected here: the standby already signs in with a token (the
first version said its clone was anonymous and had it rewritten); the smaller build machine and the rehearsal of step
4; build time that stops without a payment method; the "Main" ruleset that protects nothing; step 1's two missed
outcomes (an account's key on the server, a token inside the address); secret scanning stated as lost, not "may need a
paid plan"; the rotation moved first; Vercel, the fork's user and the deploy user's shell.
