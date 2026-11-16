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

The dashboard cannot upload, download, repair, or synchronize saves. By default,
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

Its UID/GID must have write and traversal permission on the save directories.
Back up saves first. Anyone who can access a deletion-enabled dashboard can delete
saves; protect it with an authenticated reverse proxy and do not expose its port publicly.

Each game has a **Delete saves...** button. It fetches a fresh list of **all**
matching `.srm` and `.sav` files in that game's configured platform/core/alias
folders, including subfolders and any surviving copy if its counterpart is missing.
Other platforms are untouched. Review the exact list, type the game name, and choose
**Delete all listed saves**. This permanently deletes the files; there is no undo.
Canceling the confirmation does not change saves.

All removals are submitted concurrently, without requiring you to stop save-sync.
**This is not an atomic filesystem transaction.** The upstream synchronizer ignores
already-deleted source files, but a sync operation or game already writing a save
can recreate copies. Close the game before deleting. If you need a guaranteed
quiet window, stop save-sync before deletion and start it again afterward.
Only configured copies are removed; copies in unconfigured cores or on another
device can also be synced back later.

Before removing anything, the server rechecks the full file list and file identities.
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
| `PORT` | `8080` | Container HTTP port; prefer changing the published host port in Compose |
| `HOST` | `0.0.0.0` | Container listen address |
| `MAPPING_FILE` | unset | Optional custom JSON mapping, mounted read-only; invalid files fail startup |
| `SYNC_MODULE_ROOT` | `/app/src` | Upstream module directory; useful for local development |

Unknown systems/cores and incompatible upstream APIs fail startup explicitly.
`GET /api/status` exposes the snapshot, scan state, and scan errors;
`POST /api/refresh` waits for a new scan (concurrent requests share one scan).
When deletion is enabled, `POST /api/delete/preview` takes a platform ID and game
name and returns a five-minute, single-use confirmation token and exact file list.
`POST /api/delete` takes that token and the exact game name as `confirm`, revalidates
the list, and removes all copies concurrently. Both endpoints require same-origin
JSON requests; client-supplied filesystem paths are never used as deletion targets.
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
static-only offline caching, and confirmed deletion using temporary synthetic saves.
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
