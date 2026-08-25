#!/usr/bin/env bash
# Install Docker Sandboxes (sbx) on Bazzite / Fedora Atomic — user-space only.
#
# Downloads the official static Linux tarball from docker/sbx-releases,
# verifies its sha256, and runs the tarball's own bundled install.sh,
# which installs everything under ~/.docker/sbx (no root, nothing written
# to the immutable base image).
#
# Usage:
#   ./install-sbx-bazzite.sh
#
# To install a different release, override both pins:
#   SBX_VERSION=v0.40.0 SBX_SHA256=<sha256-of-that-tarball> ./install-sbx-bazzite.sh
#
# After installing:
#   export PATH="$HOME/.docker/sbx/bin:$PATH"   # add to your shell rc
#   sbx diagnose                                # built-in preflight checks
#   sbx login                                   # Docker OAuth (required)
#   sbx run claude                              # or codex, gemini, ...

set -euo pipefail

SBX_VERSION="${SBX_VERSION:-v0.39.0}"

case "$(uname -m)" in
  x86_64)  arch=amd64  default_sha256=2ec45bc7938c20c2f406fe8cc72294ad5a954bdc047601484b89bf1a108311d4 ;;
  aarch64) arch=arm64  default_sha256=39c470a5f5e0991b1c2358952e2ab32a7b0309bfa57ac62b6bbc64b466d02c17 ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ "${SBX_VERSION}" != "v0.39.0" ] && [ -z "${SBX_SHA256:-}" ]; then
  echo "error: SBX_VERSION overridden without SBX_SHA256 — the pinned checksums only match v0.39.0." >&2
  echo "       Compute the new tarball's sha256 and pass it via SBX_SHA256." >&2
  exit 1
fi
SBX_SHA256="${SBX_SHA256:-${default_sha256}}"

tarball="DockerSandboxes-linux-${arch}.tar.gz"
url="https://github.com/docker/sbx-releases/releases/download/${SBX_VERSION}/${tarball}"

# --- Preflight ---------------------------------------------------------------

# The bundled installer requires mkfs.ext4 (e2fsprogs); Bazzite ships it in the
# base image, so a miss here means something unusual about this system.
if ! command -v mkfs.ext4 >/dev/null 2>&1; then
  echo "error: mkfs.ext4 not found — sbx needs e2fsprogs on the host." >&2
  exit 1
fi

if [ ! -e /dev/kvm ]; then
  echo "warning: /dev/kvm does not exist — sandboxes will not be able to boot." >&2
  echo "         Enable virtualization (VT-x/AMD-V) in firmware, or check that the kvm modules are loaded." >&2
elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "warning: no read/write access to /dev/kvm. Fix with:" >&2
  echo "           sudo usermod -aG kvm \$USER   # then log out and back in" >&2
  echo "         If usermod says the kvm group does not exist (Fedora Atomic keeps it in" >&2
  echo "         /usr/lib/group), copy it into /etc/group first:" >&2
  echo "           grep -E '^kvm:' /usr/lib/group | sudo tee -a /etc/group" >&2
fi

# --- Download + verify -------------------------------------------------------

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

echo "Downloading ${url} ..."
curl -fL --proto '=https' -o "${workdir}/${tarball}" "${url}"

echo "${SBX_SHA256}  ${workdir}/${tarball}" | sha256sum -c -

tar -xzf "${workdir}/${tarball}" -C "${workdir}"

# --- Install (user-space, via the tarball's own installer) -------------------

# Defaults to PREFIX=$HOME/.docker/sbx. On Bazzite (SELinux, no AppArmor) the
# installer's AppArmor step is skipped automatically, so nothing needs root.
"${workdir}/docker-sbx/install.sh"

# --- Post-install checks -----------------------------------------------------

prefix="${HOME}/.docker/sbx"

# sbx itself is statically linked; the shim, mkfs.erofs, and libsailor.so are
# dynamic. Surface any library the host is missing rather than failing later.
missing=0
for f in "${prefix}/libexec/containerd-shim-nerdbox-v1" \
         "${prefix}/libexec/mkfs.erofs" \
         "${prefix}/libexec/lib/libsailor.so"; do
  if ldd "$f" 2>/dev/null | grep -q 'not found'; then
    echo "warning: missing shared libraries for ${f}:" >&2
    ldd "$f" | grep 'not found' >&2
    missing=1
  fi
done
[ "${missing}" -eq 0 ] && echo "All dynamic libraries resolved."

"${prefix}/bin/sbx" version

cat <<EOF

Done. Next steps:
  1. Add to PATH (persist it in your shell rc):
       export PATH="\$HOME/.docker/sbx/bin:\$PATH"
  2. Run the built-in preflight:
       sbx diagnose
  3. Sign in (Docker OAuth in browser — required):
       sbx login
  4. Run an agent:
       sbx run claude
EOF
