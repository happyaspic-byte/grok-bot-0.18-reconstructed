# Architecture

The repository keeps two editable source roots:

- `source/` contains the Electron main, host, coordinator, local-exec, shared,
  and protocol reconstruction.
- `frontend/` contains the React renderer reconstruction.

The upstream 0.18.0 application is an external, checksum-pinned build input.
`manifests/runtime/platforms.json` records the exact carrier, archive size/hash,
application ASAR hash, and runtime layout for `darwin-arm64` and `win32-x64`.
`npm run bootstrap` extracts its `dist` tree to ignored `src/app/dist`. Build
scripts stage that baseline, compile reviewed source runtimes, overlay eligible
clean outputs, apply the reconstructed updater guard, and pack a new ASAR.

On Windows, bootstrap never starts the NSIS carrier. It uses the exact
`7zip-bin@5.2.0` executable allowed by the platform hash policy, rejects links
and special files in the extracted tree, verifies `Grok Bot.exe` and all native
payloads as PE x86-64, and caches an origin/hash/layout descriptor. Portable
packaging copies that verified carrier, removes updater artifacts, assigns the
distinct reconstructed identity, and installs a clean-source renderer ASAR.
Verification re-hashes clean-build outputs and checks renderer provenance.

The Windows service boundary uses a separate user-data/data root, disables
upstream update, telemetry, and protocol registration before Electron main
starts, and exposes no reconstructed development controls in production.
9Router is reached through the normal Settings → Router surface at the default
OpenAI-compatible endpoint `http://127.0.0.1:20128/v1`. Secret persistence
uses `source/shared/node/windows-private-path.ts` to replace inherited ACLs with
an exact current-user/SYSTEM/Administrators allow-list.

Small manifests remain checked in only where the build consumes them directly.
Large recovery reports, source capsules, rejected candidate evidence, and
screenshots live only in the private forensic history and are not part of this
branch's product tree.
