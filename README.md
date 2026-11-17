# MiSTer / RetroArch Save Dashboard

A **save-content comparison** dashboard for **NES, SNES, and Genesis / Mega Drive** saves.
Read-only by default, with optional confirmed deletion of a game's copies on both sides.
It supplements [mister-retroarch-save-sync](https://github.com/juaniwck/mister-retroarch-save-sync);
it does not replace or modify the upstream synchronizer.

## What it checks

- Groups games separately by platform, matching filenames without their extension,
  case-insensitively. Subfolders are scanned recursively.
- Compares actual save-data bytes, **not CRC values**. Shows every `.srm` / `.sav`
  copy, its size and modification time, with full-file **CRC32 (IEEE)** under
  optional file diagnostics. Multiple configured cores and Genesis/MegaDrive
  copies are all compared, not just the first file.
- Distinguishes **contents match**, **contents match (format differs)**, **different contents**,
  **missing counterpart**, **read/format error**, and **ambiguous names**.
- Uses the **actual upstream conversion modules** from the base image. NES
  padding and Genesis byte expansion need not produce matching raw CRCs.
  NES and Genesis equivalence also accepts a uniform trailing run of `00` or `FF`,
  following upstream padding conventions. **SNES data must match exactly**:
  no bytes are discarded as presumed padding. CRC collisions never count as
  matches: the actual buffers determine the result.
- Scans every **60 seconds**, with a **Refresh now** button, search, platform
  filtering, and status filtering. Browsers poll the latest snapshot every five
  seconds without initiating additional scans.

The dashboard cannot upload, download, or repair saves and does not implement its own
synchronizer. Optional sync controls manage the existing upstream container. By default,
its only enabled POST endpoint triggers a read-only scan. Save deletion requires
explicit server configuration and writable save mounts (see below). There are no external
scripts, fonts, analytics, or services receiving save contents.

## Deploy on your Linux Docker server

Use the public prebuilt image:

```text
ghcr.io/msmirle/mister-retroarch-save-sync-dashboard:latest
```

Images support **AMD64 and ARM64**. No GitHub login, source checkout, or local
build is needed on the server.

### Add to the existing stack (recommended)

Leave your existing `save-sync` service and deployment in place. Copy **only the
`dashboard` service** from [docker-compose.yml](docker-compose.yml) into the
remotely deployed Compose file.

If upgrading from the previous build-based deployment, remove its entire
`build:` section and replace the dashboard's `image:` line with:

```yaml
    image: ghcr.io/msmirle/mister-retroarch-save-sync-dashboard:latest
```

Keep the dashboard mount paths from the example if they match your server:

| Host path | Dashboard path | Access |
|---|---|---|
| `/mnt/external-8tb/retroarch/saves` | `/retroarch/saves` | read-only |
| `/mnt/external-8tb/mister/saves` | `/mister/saves` | read-only |

Both source directories must already exist. The dashboard will not create them.
In your existing stack directory, run:

```sh
docker compose pull dashboard
docker compose up -d --no-deps dashboard
docker compose logs dashboard
```

If your deployment uses `docker compose -f ...` or a project name, keep using
those same options. Do **not** start a second copy of `save-sync`: the included
full Compose example retains your original container name and would conflict
with the existing stack.

Open **http://YOUR_SERVER_LAN_IP:8080**. The dashboard container is named
`mister-retroarch-save-sync-dashboard`.

### Alternatively: download the full stack example

The included [docker-compose.yml](docker-compose.yml) contains the original sync
service with the same image, cores, and read/write save mounts, plus the dashboard.
Use it only after deliberately migrating your existing stack management to this
file/project, or for a new deployment. Back up saves before changing the
synchronizer deployment.

Download it into a new deployment directory without cloning the repository:

```sh
curl -fL https://raw.githubusercontent.com/msmirle/mister-retroarch-save-sync-dashboard/main/docker-compose.yml -o docker-compose.yml
docker compose pull
docker compose up -d
```

Do not overwrite an existing customized Compose file with this download.

## Install on your phone

The dashboard is a Progressive Web App (PWA). After deploying this version, open
your HTTPS dashboard address in your phone's browser, for example
`https://mistersavesync.serverbessie.localdomain/`:

- **Android (Chrome / Edge):** use the browser menu's **Install app** or
  **Add to Home screen** option.
- **iPhone / iPad (Safari):** tap **Share**, then **Add to Home Screen**. Leave
  **Open as Web App** enabled if that option is shown, then tap **Add**.

The installed app opens in its own window with a home-screen icon. No additional
server configuration is needed behind an HTTPS reverse proxy serving the
dashboard at `/`. The phone must resolve the hostname and trust the HTTPS
certificate; a certificate warning bypass is not sufficient for service workers.
For a private CA, install and trust its root certificate on the phone.
Plain HTTP on a LAN IP still works as a dashboard, but does not support the PWA
service worker.

After one successful online visit, the app shell can open offline. **Save scans
are never cached**: the server must be reachable for current results. A connection
error explicitly identifies unavailable results or a last scan already visible
in the open app that may now be stale. Installation does not grant offline access
to your server or save files.

Online visits always request the latest dashboard files. After an update, close
all dashboard tabs/app windows and reopen to activate the new offline shell.

## Optional: sync status, on/off controls, and automatic pause

The upstream sync image stays unchanged. An optional private helper in this
repository controls **only the configured sync container**. The page shows its
current **On / Off / Unavailable** state, refreshed with the dashboard's five-second
poll, and a switch to turn it on or off. **On means the container is running**,
not that every save is matching or that a transfer is currently in progress.

The helper stops the sync container before deleting saves, waits until Docker
confirms it is off, and then removes the files. It restarts sync only after
successful verification and only if it was previously on. A manually switched-off
service stays off. Partial deletion, failed verification, or an uncertain outcome
leaves sync off for review. A failed preflight that removed nothing restores the
previous on state. Restart errors are explicitly reported.

This uses **stop/start**, not Docker freeze/unfreeze: resuming a frozen process
could finish an old write and recreate a deleted save. Other devices can still
write saves independently; close the game before deleting.

### One-time setup (edit your own `compose.yaml` and `.env`)

This is done **once**. Afterward, updates are just `docker compose pull` and
`docker compose up -d` (see [Ongoing updates](#ongoing-updates)).

1. Back up your files:

   ```sh
   cp -p compose.yaml compose.yaml.backup
   cp -p .env .env.backup
   ```

2. Generate a private token and add it to your existing `.env`, keeping
   everything already there:

   ```sh
   openssl rand -hex 32
   ```

   ```dotenv
   SYNC_CONTROL_TOKEN=PASTE_THE_TOKEN_HERE
   ```

   Deletion also needs `ALLOW_SAVE_DELETE=true` and `DASHBOARD_SAVES_READ_ONLY=false`
   (see the next section).

3. In `compose.yaml`, add these two lines to the `dashboard` service's
   `environment:` list, add `sync-control` to its `networks:`, and add a
   `depends_on:`. Leave your Traefik labels, save mounts, and `proxy` network as they are:

   ```yaml
       environment:
         - SYNC_CONTROL_URL=http://sync-control:8090
         - SYNC_CONTROL_TOKEN=${SYNC_CONTROL_TOKEN}
       networks:
         - default
         - proxy
         - sync-control
       depends_on:
         - sync-control
   ```

4. Add the helper as a new service beside `dashboard`, and a private network at
   the bottom of the file:

   ```yaml
     sync-control:
       image: ghcr.io/msmirle/mister-retroarch-save-sync-dashboard:latest
       container_name: mister-retroarch-save-sync-control
       command: ["node", "src/sync-control.js"]
       user: "0:0"
       environment:
         - HOST=0.0.0.0
         - PORT=8090
         - SYNC_CONTAINER_NAME=mister-retroarch-save-sync
         - SYNC_CONTROL_TOKEN=${SYNC_CONTROL_TOKEN}
       read_only: true
       cap_drop:
         - ALL
       security_opt:
         - no-new-privileges:true
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock:ro
       networks:
         - sync-control
       labels:
         - "traefik.enable=false"
       healthcheck:
         test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(e=>{console.error(e.message);process.exit(1)})"]
         interval: 30s
         timeout: 5s
         start_period: 10s
         retries: 3
       restart: unless-stopped

   networks:
     proxy:
       external: true
     sync-control:
       internal: true
   ```

   The `healthcheck` is required: the image's built-in check probes the dashboard
   port (8080), so without this override the helper would always show **unhealthy**.
   Set `SYNC_CONTAINER_NAME` only if you renamed the sync container.

5. Optional but recommended: add a shutdown handler to the existing
   `save-sync` service so stopping it exits cleanly (code 0). See
   [Avoiding exit code 137 alerts](#avoiding-exit-code-137-alerts).

6. Validate and start:

   ```sh
   docker compose config --quiet
   docker compose pull
   docker compose up -d
   ```

   `config --quiet` prints nothing when the file is valid. The page should now
   show **Sync service: On** with a switch.

Prefer not to edit your Compose file? [compose.sync-control.yaml](compose.sync-control.yaml)
is an equivalent overlay: download it beside your file and add
`COMPOSE_FILE=compose.yaml:compose.sync-control.yaml` (Linux separator) to `.env`.

### Ongoing updates

After the one-time setup, update everything with:

```sh
docker compose pull
docker compose up -d
```

### Avoiding exit code 137 alerts

The upstream sync daemon has no shutdown handler, so Docker waits 10 seconds and
then force-kills it. Tools such as Arcane then report
`mister-retroarch-save-sync exited with code 137` every time the dashboard pauses
sync. This is harmless: upstream writes each save to a temporary file and then
renames it, so a stop should not leave a partly written save.

To stop it cleanly without forking upstream, add one `command:` to the existing
`save-sync` service (same upstream image); it handles `SIGTERM`/`SIGINT` and then
loads the unchanged daemon:

```yaml
  save-sync:
    image: ghcr.io/juaniwck/mister-retroarch-save-sync:latest
    container_name: mister-retroarch-save-sync
    command: ["node", "-e", "process.on('SIGTERM',()=>process.exit(0));process.on('SIGINT',()=>process.exit(0));require('./src/daemon.js')"]
```

Run `docker compose up -d` once to recreate `save-sync`. Pausing sync then
stops it immediately with exit code 0. If upstream later changes how
`src/daemon.js` starts, remove the line to return to the default behavior.

**Permissions:** only the helper receives `/var/run/docker.sock`. It has no
published port and only joins a private internal network shared with the
dashboard. Requests require the token, which is not sent to the browser. The
dashboard stays unprivileged and does not receive Docker socket access.
However, **Docker socket access is effectively host-administrator access**;
a read-only socket mount does not make Docker API actions read-only. Enable the
helper only on a trusted host and protect the dashboard with authentication.
Do not expose the helper through Traefik or publish its port.

If a configured helper is unavailable, the page shows that error and deletion
is blocked rather than proceeding without a pause. Without the optional helper,
existing deployments retain the original concurrent-delete behavior.
If the dashboard crashes during an automatic pause, sync may remain off; check
the indicator and explicitly turn it back on after reviewing the saves.

## Optional: delete a game's saves from both sides

Deletion is **disabled by default**. To enable it with the included Compose
configuration, add these values to your existing stack's `.env`:

```dotenv
ALLOW_SAVE_DELETE=true
DASHBOARD_SAVES_READ_ONLY=false
```

If you copied an older dashboard service into your own Compose file, also add
`ALLOW_SAVE_DELETE: "${ALLOW_SAVE_DELETE:-false}"` to its `environment` and change
**both save-volume** `read_only` settings to
`${DASHBOARD_SAVES_READ_ONLY:-true}`, as shown in [docker-compose.yml](docker-compose.yml).
Keep the container-level `read_only: true`: only the two save mounts need write access.

Recreate only the dashboard:

```sh
docker compose pull dashboard
docker compose up -d --no-deps dashboard
```

Its UID/GID must have read permission on the save files and write and traversal
permission on the save directories.
Back up saves first. Anyone who can access a deletion-enabled dashboard can delete
saves; protect it with an authenticated reverse proxy and do not expose its port publicly.

Each game has a **Delete saves...** button. It fetches a fresh list of **all**
matching `.srm` and `.sav` files in that game's configured platform/core/alias
folders, including subfolders and any surviving copy if its counterpart is missing.
Other platforms are untouched. Review the exact list, tick the confirmation checkbox, and choose
**Delete all listed saves**. This permanently deletes the files; there is no undo.
Canceling the confirmation does not change saves.

All removals are submitted concurrently. With the optional sync-control helper,
the dashboard stops and restores the sync service as described above.
Without that helper, deletion does not stop save-sync.
**This is not an atomic filesystem transaction.** The upstream synchronizer ignores
already-deleted source files, but a sync operation or game already writing a save
can recreate copies. Close the game before deleting. If you need a guaranteed
quiet window, stop save-sync before deletion and start it again afterward.
Only configured copies are removed; copies in unconfigured cores or on another
device can also be synced back later.

Before removing anything, the server rechecks the full file list, file identities,
and SHA-256 content fingerprints.
A changed list, modified file, inaccessible directory, or symlink blocks the operation.
Missing optional alias directories are allowed. A follow-up scan refreshes the dashboard.
If a removal fails or files are seen again, the dashboard reports the problem rather
than claiming success. Separate filesystems cannot guarantee all-or-nothing deletion,
so a runtime I/O failure can leave some files deleted and others intact; per-file
failures are shown. There are no automatic retries or rollback writes.

To disable deletion, set `ALLOW_SAVE_DELETE=false` and
`DASHBOARD_SAVES_READ_ONLY=true`, then recreate the dashboard again.

## Read-only defaults and access

- Both dashboard save mounts use Docker `read_only: true` by default.
- Its container root filesystem is read-only, runs as UID/GID `1000:1000`, drops
  all capabilities, and uses `no-new-privileges`.
- Set `DASHBOARD_UID` / `DASHBOARD_GID` in your stack's `.env` to an unprivileged
  identity that can read the saves if needed. Grant directory traversal and file
  read permission; do not make saves world-writable. Keep mounts read-only unless
  deliberately enabling the deletion option above.
- File and directory symlinks are skipped and reported. Files that change while
  being read are reported as unverified. A new scan retries them.
- Save files over 16 MiB and empty files are reported as errors.
- Inaccessible/missing directories are shown as warnings, not a clean bill of
  health. A missing Genesis alias directory is a warning; the dashboard does not
  require a copy in every possible core/alias folder for a game to be paired.

**No authentication is included. This is LAN-only software.** The default port
mapping, `8080:8080`, listens on all host interfaces. Restrict it with your firewall
and/or add the server's LAN address to the port mapping. Docker-published ports can
bypass some host firewall rules, so verify your Docker firewall policy. Do not
forward port 8080 from the internet. Use `127.0.0.1:8080:8080` with an authenticated
reverse proxy if external access is needed. Change the published port by editing
the left-hand port in Compose (for example, `8089:8080`).

## Updates without forking upstream

Your sync service continues using the official upstream `:latest` image.
The dashboard image derives from that same image but overrides its command;
the **sync daemon never starts in the dashboard container**.

From your existing stack directory, run:

```sh
docker compose pull
docker compose up -d
```

GitHub Actions tests against upstream `:latest`, then publishes a fresh dashboard
image on successful main-branch pushes, daily builds, and manual workflow runs.
Publishing uses the same upstream image digest that passed the tests. Failed
tests leave the previously published dashboard image in place. The workflow
does **not** automatically update containers on your server.

No source checkout, `git pull`, or `docker compose build` is needed to update.
For dashboard-only updates, use `docker compose pull dashboard` followed by
`docker compose up -d --no-deps dashboard`.

Each published build also has a unique `build-<run-id>-<attempt>` tag. Pin that
tag, or an image digest, instead of `:latest` for controlled updates/rollback.

### One-time container package setup (maintainer)

GitHub creates container packages as **private**, even for public repositories.
After the first successful image publication, open the
[container package](https://github.com/users/msmirle/packages/container/package/mister-retroarch-save-sync-dashboard),
choose **Package settings**, then **Change visibility** to **Public**.
This only needs to be done once; subsequent images retain the package visibility.

The workflow's anonymous-pull check intentionally fails until the package is
public. After changing visibility, rerun the failed job. Both architectures must
be downloadable without credentials.

## Pairing details

Defaults mirror your configured cores: `Mesen`, `Snes9x`, `Genesis Plus GX`.
Platform folders and their aliases come from upstream's mapping, resolved
case-insensitively. Only `.srm` files on RetroArch and `.sav` files on MiSTer are
examined. Upstream ignored filenames and `_bak` exclusions are respected.

For example, `Mesen/Zelda.srm` pairs with `NES/Zelda.sav`, even if one is in a
subfolder or uses different capitalization. If two `Zelda.sav` files exist under
the **same** MiSTer platform folder, the game is ambiguous instead of guessing.
Copies in different configured cores or in `Genesis` and `MegaDrive` are expected:
every cross-side pair must agree for a match. Missing counterparts are reported;
no files are ever created.

Genesis Plus GX can also store Master System and Game Gear saves. The dashboard
uses upstream's Genesis discriminator and flags non-Genesis `.srm` files as
unverified rather than treating them as Genesis matches. Other platforms and
save extensions are outside this dashboard's scope.

Format-aware equivalence follows upstream's conversion and NES/Genesis padding conventions;
it is not proof of game-specific compatibility or protection against corruption
already present in both copies. Keep independent backups. Scans are sequential,
not atomic snapshots of both machines; refresh after a game or sync finishes if
you see a transient mismatch.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `RETROARCH_ROOT` | `/retroarch` | Parent of RetroArch's `saves/` directory |
| `MISTER_SAVES` | `/mister/saves` | MiSTer platform folder root |
| `RETROARCH_CORES` | `Mesen,Snes9x,Genesis Plus GX` | Core directories to inspect |
| `SYSTEMS` | `nes,snes,genesis` | Subset of the three supported platforms |
| `REFRESH_SECONDS` | `60` | Scan interval (5-86400 seconds) |
| `ALLOW_SAVE_DELETE` | `false` | Enable confirmed deletion of all configured copies of a game; requires writable save mounts |
| `DASHBOARD_SAVES_READ_ONLY` | `true` | Compose-only flag controlling both save mounts; set `false` only when enabling deletion |
| `SYNC_CONTROL_URL` | unset | Optional private helper origin; wired automatically by `compose.sync-control.yaml` |
| `SYNC_CONTROL_TOKEN` | unset | Shared 64-hex-character secret for the dashboard and helper; keep in `.env` |
| `SYNC_CONTAINER_NAME` | `mister-retroarch-save-sync` | Helper-only name of the existing sync container to control |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | Helper-only Docker socket path |
| `PORT` | `8080` | Container HTTP port; prefer changing the published host port in Compose |
| `HOST` | `0.0.0.0` | Container listen address |
| `MAPPING_FILE` | unset | Optional custom JSON mapping, mounted read-only; invalid files fail startup |
| `SYNC_MODULE_ROOT` | `/app/src` | Upstream module directory; useful for local development |

Unknown systems/cores and incompatible upstream APIs fail startup explicitly.
`GET /api/status` exposes the snapshot, scan state, and scan errors;
`POST /api/refresh` waits for a new scan (concurrent requests share one scan).
When deletion is enabled, `POST /api/delete/preview` takes a platform ID and game
name and returns a five-minute, single-use confirmation token and exact file list.
`POST /api/delete` takes that token and `acknowledged: true`, revalidates
the list, and removes all copies concurrently. Both endpoints require same-origin
JSON requests; client-supplied filesystem paths are never used as deletion targets.
`GET /api/status` also reports sync service state, control errors, and busy state.
With a configured helper, same-origin `POST /api/sync` accepts a boolean `enabled`
to stop/start the existing service. Controls and deletions cannot overlap.
`GET /healthz` checks service readiness, not whether all games match; inspect
per-platform issues and game errors in the dashboard for save health.

## Development and validation

Source checkout is only needed for development:

```sh
git clone https://github.com/msmirle/mister-retroarch-save-sync-dashboard.git
cd mister-retroarch-save-sync-dashboard
```

No runtime npm packages are needed. Node.js 20+ and a built upstream checkout
are sufficient for local development. Set `SYNC_MODULE_ROOT` to that checkout's
`src` directory, then run:

```sh
npm run check
npm test
npm start
```

When changing app-shell files, bump the cache version in [public/sw.js](public/sw.js)
so installed apps replace their offline shell. Only explicitly listed static
assets belong in that cache; API responses and health checks must remain network-only.
Service workers can also be tested on `http://localhost:8080` during development.

For a complete Linux test with the real upstream image:

```sh
docker build --pull --target test .
```

Tests create synthetic saves in temporary directories, verify scans leave file contents
and timestamps unchanged, and cover CRC32, conversion, missing saves,
duplicate names, unreadable files, refresh behavior, HTTP restrictions, PWA assets,
static-only offline caching, confirmed deletion using temporary synthetic saves,
and sync coordination. Helper tests use an isolated fake Docker API socket and
never stop or start a real container.
CI also verifies the hardened container can read saves but cannot write them.
Image publication only runs for this repository's public main branch, never for
pull requests.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). Conversion code remains in the
upstream image, including its original license files at `/app/LICENSE` and
`/app/LICENSE.save-file-converter`.

Corresponding source for a published image is available from this repository
at the commit in its `org.opencontainers.image.revision` label, and from the
exact upstream source URL in its `org.opencontainers.image.base.source` label.
That upstream source includes the vendored save-file-converter code. Inspect
these labels with:

```sh
docker image inspect ghcr.io/msmirle/mister-retroarch-save-sync-dashboard:latest --format '{{json .Config.Labels}}'
```
