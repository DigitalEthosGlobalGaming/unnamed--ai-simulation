# Getting started: AI-assisted development

How to set up a machine and work on this repo with coding agents (Claude Code and its subagents). It records the setup that is known to work and the rules the agents follow. For running the app day to day see [operations.md](operations.md); for testing model behaviour see [testing-models.md](testing-models.md).

## 1. The reference machine

Everything here was set up and tested on this machine. Other setups may work but are untested.

| Part | Version or setting |
| --- | --- |
| Host | Windows 11 with WSL2 (kernel `6.6.87.2-microsoft-standard-WSL2`) |
| CPU and GPU | Intel Core Ultra 7 255U (14 threads), 31 GB RAM, integrated graphics only: **no GPU for models** |
| WSL distro | **Red Hat Enterprise Linux 10.2 (Coughlan)**, distro name `local-development`, `systemd=true` |
| Node.js | **26.13.1** (npm 11.20), installed under `~/.local/node-v26.13.1-linux-x64`, on `PATH` |
| Containers | **Podman 6.1.1**, rootless, overlay storage, netavark networking |
| Ollama | 0.40.16, in a Podman container named `ollama` (models in volume `ollama`) |
| Other tools | git 2.52, GitHub CLI `gh` 2.104, Vercel CLI 65.16, Python 3.12, Playwright Chromium (headless shell 1148) |

There is no GPU, so local models run on CPU and are slow; the default setup thinks through the Vercel AI Gateway and keeps Ollama as an offline fallback.

## 2. Set up WSL

1. Install a RHEL 10 WSL distro and name it `local-development` (any name works; the commands below use this one). Create your normal user and make it the default.
2. Configure `/etc/wsl.conf` inside the distro:
   ```ini
   [boot]
   systemd = true
   command=mount --make-rshared /

   [user]
   default=<your user>
   ```
   `mount --make-rshared /` stops rootless Podman warning about shared mounts. From PowerShell you can add the line with:
   ```powershell
   wsl -d local-development -u root --exec sed -i '/^\[boot\]/a command=mount --make-rshared /' /etc/wsl.conf
   ```
3. Restart the distro so the settings apply: `wsl --terminate local-development`, then open it again.
4. If `dnf` fails on a third-party repository's GPG key (it did for a Microsoft repo here), add `--disablerepo='<repo id>'` to the install command rather than turning off GPG checks.

## 3. Install the tools

```bash
sudo dnf install -y podman git python3
```

**Rootless Podman storage.** On this distro rootless Podman first tried the system store and failed with `permission denied` on `/var/lib/containers/storage`. Give your user its own store in `~/.config/containers/storage.conf` (use your own uid from `id -u` and your home path):

```toml
[storage]
driver = "overlay"
runroot = "/run/user/<uid>/containers"
graphroot = "/home/<user>/.local/share/containers/storage"
```

Check it with `podman info --format '{{.Host.Security.Rootless}} {{.Store.GraphDriverName}}'`, which should print `true overlay`.

**Rootless networking.** `podman network create` and `--network bridge` fail inside netavark on this WSL setup, so the repo's Podman compose override uses host networking (see [operations.md](operations.md)).

**Node 26.** Download the Linux x64 tarball from nodejs.org, unpack it under `~/.local/`, and put its `bin` on your `PATH`. The repo runs TypeScript directly through Node's type stripping, so there is no build step. pnpm through corepack was broken here, so the repo uses **npm workspaces**.

**GitHub CLI.** Download the release tarball, verify it against the release's checksums file, and copy `gh` into `~/.local/bin`. Then `gh auth login` (interactive, in your own terminal).

**Vercel CLI.** `npm install --global vercel@latest`, then `vercel login` (interactive). Optional: the Vercel plugin for Claude Code (`npx plugins add vercel/vercel-plugin`), which also brings the Vercel MCP connection.

**Playwright Chromium** is only needed for the viewer's screenshot and interaction scripts: `npx playwright install chromium-headless-shell` from `apps/viewer`.

## 4. Get the repo running

```bash
git clone https://github.com/DigitalEthosGlobalGaming/unnamed--ai-simulation.git
cd unnamed--ai-simulation
npm install
cp .env.example .env            # then fill in what you need (below)
npm run check                   # typecheck, tests and the golden-prompt check
npm run dev                     # server :8080 + viewer :5173
```

Open `http://localhost:5173/?key=dev-admin` for an admin view, or `?source=sample` for the offline sample world.

**Local models (optional).** `npm run ollama:up` creates the capped Ollama container (4 CPUs, low priority, so the laptop stays usable), then `npm run ollama:pull` and `npm run smoke:ollama`.

**`.env`** (never committed; never paste its values into chats or logs):

| Variable | Needed for |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Hosted models through the Vercel AI Gateway. Create with `vercel ai-gateway api-keys create --scope <team> --name <name> --amount <USD> --refresh-period daily`, and write it straight into `.env` without printing it. |
| `VERCEL_OAUTH_CLIENT_ID`, `VERCEL_OAUTH_CLIENT_SECRET` | Sign in with Vercel. The app is created in the dashboard only (see [operations.md](operations.md#sign-in-with-vercel)). |
| `UAS_ADMIN_VERCEL_USERS` | Vercel usernames or ids that are admins. |
| `UAS_PUBLIC_URL` | `http://localhost:5173` locally (the sign-in callback base). |
| `UAS_SESSION_SECRET` | Generated automatically if missing. |

Everything else has defaults; `.env.example` lists all of them.

## 5. Claude Code setup

- **Skills in the repo** (`.claude/skills/`, project scope):
  - `impeccable`: design work on the viewer. Run its `context` script first; read `craft-floor.md` before UI edits; run the detector and finish reviewer. PRODUCT.md and DESIGN.md are its inputs.
  - `grilling` / `grill-me` (Matt Pocock, MIT): relentless design interviews. New features start with a grilling round; the outcome goes into the spec's decision log before code is written.
- **Agents in the repo** (`.claude/agents/`): the impeccable reviewers and documenter.
- **Plugins:** the Vercel plugin (user scope) for Vercel docs, CLI guidance and MCP.

## 6. How we work with agents

The pattern that has worked: one main session coordinates, a **backend agent** owns `packages/*`, and a **viewer agent** owns `apps/viewer`.

1. **Design first.** Grill the idea, then record decisions in the spec ([decision log](../Unnamed%20AI%20Simulation%20—%20Spec.md#decision-log-and-open-questions)) and plan the work as an [iteration](iterations/README.md) with stages.
2. **Contract before parallel work.** When backend and viewer build one feature together, write the API contract into `docs/architecture/` first (see [visitors.md](architecture/visitors.md)); both agents build against it and message each other about any change.
3. **Small, verifiable briefs.** Each brief says what to build, what's out of scope, what to test, and what to report.
4. **The main session reviews and commits.** Agents don't commit. The main session runs `npm run check`, checks for secrets, commits with a descriptive message and pushes.

### Rules every agent follows

- **Keep the laptop usable.** One heavy process at a time. No Ollama in tests (point `OLLAMA_URL` at an unused port on scratch servers). Headless Chrome uses about 7 cores while it draws the map in software; keep screenshot runs short.
- **Never touch the owner's running world.** The server on `:8080` and `data/uas.db` belong to the owner. Test on scratch servers on other ports (e.g. `:8090`–`:8099`) with a scratch `UAS_DB`, or on a copy made with SQLite's backup API. Pass `UAS_SESSION_SECRET` explicitly to scratch servers so they don't write to `.env`.
- **Secrets stay secret.** Never print, log or echo keys; never put them in files other than `.env`; never send personal details to outside services.
- **Docs are live.** Change behaviour → update the page that owns it in the same change ([docs/README.md](README.md#keeping-these-docs-live)). Deviations from the spec go in [decisions.md](decisions.md).
- **Model behaviour changes need evidence.** Prompt or context changes show up in the golden-prompt check; accept them with `npm run eval -- --update-prompts` and run `npm run eval` (about A$0.001, ~10 minutes because of the gateway's free-tier rate limit) to compare with the last report.
- **Report honestly.** Say what was tested live and what only against mocks.

## 7. Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run dev:fake` | Server + viewer, with real or fake models |
| `npm run check` | Typecheck, tests, golden prompts |
| `npm run eval` | Live model eval against the saved situations; report in `docs/benchmarks/evals/` |
| `npm run eval:capture -- --world garden --character robot` | Save the robot's current moment as a new situation |
| `npm run smoke:gateway` | One call per hosted model, with latency and A$ cost |
| `npm run bakeoff -- --job decide --models …` | Compare models; results in `docs/benchmarks/` |
| `npm run ollama:up` / `ollama:pull` | Start the capped Ollama container and pull models |
| `curl -s localhost:8080/usage -H 'Authorization: Bearer dev-admin'` | Today's model spend |

## 8. Troubleshooting

| Symptom | Fix |
| --- | --- |
| Podman: `permission denied` on `/var/lib/containers/storage` | Add the per-user `storage.conf` above |
| Podman: network create fails | Use the host-network compose override |
| Laptop slow | Check `ps -eo pcpu,cmd --sort=-pcpu | head`: usually headless Chrome or an uncapped Ollama; `npm run ollama:up` recreates Ollama with the cap |
| Server tests time out ("Hook timed out") | The machine is busy; rerun when load drops. They pass on their own |
| "No API key for hosted models" warning | Add `AI_GATEWAY_API_KEY` to `.env`; until then it runs locally |
| Jev returns 403 | The gateway team needs paid credits |
| Gateway 429 | Free tier allows 5 Laya requests a minute, shared by the server and evals |
| Sign-in "invalid scope" | Enable `openid`, `email`, `profile` under the Vercel app's Permissions |
| Viewer says a feature is "not available on this server yet" | Restart `npm run dev` so the server runs the new code |
