#!/usr/bin/env bash
# Install or update Docker Sandboxes (sbx) under ~/.docker/sbx and symlink it
# into ~/.local/bin. Safe to re-run — it updates when a newer release exists.
#
# Bazzite / Fedora Atomic notes:
#   - User-space only: binaries go to ~/.docker/sbx, runtime state to
#     ~/.local/state/sandboxes. Nothing touches the immutable base (no root, no
#     rpm-ostree layering), so it survives image rebases.
#   - Runs the tarball's own docker-sbx/install.sh, which needs mkfs.ext4
#     (e2fsprogs, in Bazzite's base) and auto-skips its AppArmor step on SELinux.
#   - `sbx` is statically linked; the shims / mkfs.erofs / libsailor.so are
#     dynamic but need only modern glibc (fine on Bazzite).
#
# After installing:
#   sbx diagnose    # preflight: checks /dev/kvm, the daemon, storage, auth
#   sbx login       # Docker OAuth in browser — required before any run
#   sbx run claude  # mounts the current directory as the workspace
#
# KVM access (sbx diagnose is definitive):
#   - Check `ls -l /dev/kvm` first; many setups ship it mode 0666 (no change).
#   - Otherwise: sudo usermod -aG kvm $USER   (then log out/in)
#   - If the kvm group is missing (Atomic keeps some in /usr/lib/group):
#       grep -E '^kvm:' /usr/lib/group | sudo tee -a /etc/group
#
# Cleanup (nothing auto-stops): `sbx run` leaves a background daemon plus a
# persistent microVM (defaults to ~50% RAM / all CPUs). When done:
#   sbx ls ; sbx stop <name>  (or sbx rm / sbx prune) ; sbx daemon stop
#   (a reboot also clears everything — nothing auto-restarts.)
#
# Optional GPU passthrough (one-time):
#   sudo ~/.docker/sbx/libexec/containerd-shim-nerdbox-gpu-v1 install
# Debugging a failed run: sudo ausearch -m avc -ts recent  (SELinux denials)
#
# Uninstall (remove sbx entirely) — run these while the sbx binary still exists,
# in order, since they use it to tear down running state first:
#   sbx reset          # stop + remove all sandboxes and their state
#   sbx daemon stop    # stop the background daemon
#   sbx logout         # optional: drop the stored Docker credentials
#   rm ~/.local/bin/sbx                 # the symlink this script created
#   rm -rf ~/.docker/sbx               # the binaries + bundle
#   rm -rf ~/.local/state/sandboxes    # runtime state/logs (optional; deletes data)
# If you ran the optional GPU step above, undo it with (needs root):
#   sudo ~/.docker/sbx/libexec/containerd-shim-nerdbox-gpu-v1 uninstall
# (do that BEFORE removing ~/.docker/sbx, or run the shim from a saved copy).
set -euo pipefail

REPO="docker/sbx-releases"
PREFIX="$HOME/.docker/sbx"
ASSET="DockerSandboxes-linux-amd64.tar.gz"

latest="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oP '"tag_name":\s*"\K[^"]+')"

current=""
[ -x "$PREFIX/bin/sbx" ] && current="$("$PREFIX/bin/sbx" version 2>/dev/null | grep -oP 'v\d+\.\d+\.\d+' | head -1)"

if [ "$current" = "$latest" ]; then
  echo "sbx $latest is already up to date."
  exit 0
elif [ -n "$current" ]; then
  echo "Updating sbx $current -> $latest ..."
  "$PREFIX/bin/sbx" daemon stop >/dev/null 2>&1 || true
else
  echo "Installing sbx $latest ..."
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fL "https://github.com/$REPO/releases/download/$latest/$ASSET" -o "$tmp/sbx.tar.gz"
tar -xzf "$tmp/sbx.tar.gz" -C "$tmp"
PREFIX="$PREFIX" "$tmp/docker-sbx/install.sh"

mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/bin/sbx" "$HOME/.local/bin/sbx"
"$HOME/.local/bin/sbx" version
