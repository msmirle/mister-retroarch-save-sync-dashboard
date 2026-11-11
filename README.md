# MiSTer / RetroArch Save Dashboard

A read-only, **save-content comparison** dashboard for **NES, SNES, and Genesis / Mega Drive** saves.
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

The dashboard cannot upload, download, repair, rename, delete, or synchronize
saves. Its only POST endpoint triggers a read-only scan. There are no external
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

## Read-only protection and access

- Both dashboard save mounts use Docker `read_only: true`.
- Its container root filesystem is read-only, runs as UID/GID `1000:1000`, drops
  all capabilities, and uses `no-new-privileges`.
- Set `DASHBOARD_UID` / `DASHBOARD_GID` in your stack's `.env` to an unprivileged
  identity that can read the saves if needed. Grant directory traversal and file
  read permission; do not make saves world-writable or remove the read-only mounts.
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
| `PORT` | `8080` | Container HTTP port; prefer changing the published host port in Compose |
| `HOST` | `0.0.0.0` | Container listen address |
| `MAPPING_FILE` | unset | Optional custom JSON mapping, mounted read-only; invalid files fail startup |
| `SYNC_MODULE_ROOT` | `/app/src` | Upstream module directory; useful for local development |

Unknown systems/cores and incompatible upstream APIs fail startup explicitly.
`GET /api/status` exposes the snapshot, scan state, and scan errors;
`POST /api/refresh` waits for a new scan (concurrent requests share one scan).
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

For a complete Linux test with the real upstream image:

```sh
docker build --pull --target test .
```

Tests create synthetic saves in temporary directories, verify file contents
and timestamps remain unchanged, and cover CRC32, conversion, missing saves,
duplicate names, unreadable files, refresh behavior, and HTTP restrictions.
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
