# Docker Sandboxes (`sbx`) on Bazzite

Verified notes for installing [Docker Sandboxes](https://github.com/docker/sbx-releases)
on Bazzite (Fedora Atomic / Universal Blue) without touching the immutable base.
Facts below were verified on 2026-08-25 by downloading and inspecting the actual
release artifacts; use `scripts/install-sbx-bazzite.sh` to install.

## TL;DR

```bash
./scripts/install-sbx-bazzite.sh
export PATH="$HOME/.docker/sbx/bin:$PATH"   # persist in your shell rc
sbx diagnose
sbx login        # Docker OAuth in browser — mandatory
sbx run claude
```

Everything lands under `~/.docker/sbx` (binaries) and `~/.local/state/sandboxes`
(runtime state). No root, no `rpm-ostree` layering, nothing on the immutable base.

## Verified facts (v0.39.0, 2026-08-25)

- **Latest stable release is `v0.39.0`** (tags go v0.34.0 → v0.39.0; check
  [releases](https://github.com/docker/sbx-releases/releases/latest) for drift).
- **Tarball**: `DockerSandboxes-linux-amd64.tar.gz`, 112 MB,
  sha256 `2ec45bc7938c20c2f406fe8cc72294ad5a954bdc047601484b89bf1a108311d4`.
  arm64: sha256 `39c470a5f5e0991b1c2358952e2ab32a7b0309bfa57ac62b6bbc64b466d02c17`.
  No `.sha256`/checksums sidecar asset is published; these were computed from the
  downloaded artifacts.
- **Archive layout** is `docker-sbx/` (not `bin/sbx`):
  `sbx`, `containerd-shim-nerdbox-v1`, `containerd-shim-nerdbox-gpu-v1`,
  `mkfs.erofs`, `libsailor.so`, `nerdbox-kernel-x86_64` (34 MB),
  `nerdbox-rootfs-x86_64.erofs` (13 MB) — the microVM kernel + rootfs are the
  bulk of the size — plus an AppArmor profile and **its own `install.sh`**.
- **The bundled `install.sh` is the official user-space path**: default
  `PREFIX=$HOME/.docker/sbx`, no root required. Its AppArmor step is guarded by
  `[ -d /sys/kernel/security/apparmor ]`, so on Bazzite (SELinux) it is skipped
  cleanly. It hard-requires `mkfs.ext4` (e2fsprogs — in Bazzite's base image).
- **Linking**: `sbx` itself is **statically linked** — no glibc concern at all.
  The dynamic pieces need at most `GLIBC_2.39` (`libsailor.so`) / `GLIBC_2.38`
  (`mkfs.erofs`), plus `liblz4`, `libzstd`, `libxxhash`, `libgcc_s` — fine on
  Bazzite's glibc ≥ 2.40. (The "built for Rocky 8 / glibc 2.28" theory was wrong;
  this is a modern-glibc build. The Rocky 8 RPM is a separate release asset.)
- **Install + run verified end-to-end** in a clean container: `install.sh`
  → `sbx version` → `sbx diagnose` all work. `sbx diagnose` is a real preflight:
  it checks `/dev/kvm`, the `sandboxd` daemon, storage dirs, and auth.

## KVM access

`sbx diagnose` tells you definitively. If `/dev/kvm` exists but isn't accessible:

```bash
sudo usermod -aG kvm $USER   # then log out and back in
```

If `usermod` complains the `kvm` group doesn't exist (Fedora Atomic keeps some
groups in `/usr/lib/group` rather than `/etc/group`):

```bash
grep -E '^kvm:' /usr/lib/group | sudo tee -a /etc/group
sudo usermod -aG kvm $USER
```

Note many Fedora setups ship `/dev/kvm` as mode 0666 via udev, in which case no
group change is needed — check `ls -l /dev/kvm` first.

## Known unknowns

- **First real boot**: `ldd`/`sbx version`/`sbx diagnose` all pass, but the
  microVM boot path (`sbx run …`) could only be tested on a host with
  `/dev/kvm`. If it fails there, read the error — KVM permissions, SELinux
  denials (`sudo ausearch -m avc -ts recent`), or a write path are the likely
  suspects.
- **GPU passthrough** (optional): the GPU shim is installed non-suid; enabling
  it requires a one-time
  `sudo ~/.docker/sbx/libexec/containerd-shim-nerdbox-gpu-v1 install`.
- **Updates**: nothing auto-updates a tarball install. Re-run the script with
  `SBX_VERSION`/`SBX_SHA256` overrides to upgrade.

## Alternative considered

Rootless **podman** (in Bazzite's base) covers container-grade isolation with no
Docker account. `sbx` adds KVM microVM isolation + the agent-focused UX
(YOLO mode, file/network policies, TUI) at the cost of a mandatory Docker OAuth
login. There is also a Rocky 8 RPM asset that could in principle be layered with
`rpm-ostree`, but the user-space tarball is cleaner on an immutable OS and
survives image rebases.
