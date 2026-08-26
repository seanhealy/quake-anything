#!/usr/bin/env bash
# Install or update Docker Sandboxes (sbx) in user space, and symlink it into
# ~/.local/bin. Safe to re-run: it installs the latest release, or updates to it
# if you're behind, and does nothing if you're already current.
#
#   ./install-sbx.sh            # install latest, or update if a newer one exists
#   ./install-sbx.sh --force    # reinstall even if already current
#   SBX_VERSION=v0.39.0 ./install-sbx.sh   # pin a specific version
#
# Everything lands under ~/.docker/sbx (via the tarball's own installer); the
# base OS is never touched, so this is safe on Bazzite / Fedora Atomic.

set -euo pipefail

REPO="docker/sbx-releases"
PREFIX="${HOME}/.docker/sbx"
LINK_DIR="${HOME}/.local/bin"

case "$(uname -m)" in
  x86_64)  arch=amd64 ;;
  aarch64) arch=arm64 ;;
  *) echo "error: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
ASSET="DockerSandboxes-linux-${arch}.tar.gz"

force=0
[ "${1:-}" = "--force" ] && force=1

# --- Resolve the target version ---------------------------------------------

# Ask GitHub for the latest stable tag (falls back to a redirect trick if the
# API is rate-limited, so no jq/token is required).
latest_version() {
  curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["tag_name"])' 2>/dev/null && return 0
  curl -fsSLI -o /dev/null -w '%{url_effective}\n' \
    "https://github.com/${REPO}/releases/latest" 2>/dev/null \
    | sed -n 's#.*/tag/##p' | grep . && return 0
  return 1
}

version="${SBX_VERSION:-}"
if [ -z "${version}" ]; then
  echo "Checking latest release ..."
  version="$(latest_version)" || { echo "error: could not determine the latest version (set SBX_VERSION to override)" >&2; exit 1; }
fi

# --- Skip if already current -------------------------------------------------

installed=""
if [ -x "${PREFIX}/bin/sbx" ]; then
  # `sbx version` prints e.g. "sbx version: v0.39.0 <sha>"
  installed="$("${PREFIX}/bin/sbx" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -1 || true)"
fi

if [ "${installed}" = "${version}" ] && [ "${force}" -eq 0 ]; then
  echo "sbx ${version} is already installed and current. (Use --force to reinstall.)"
  exit 0
fi
[ -n "${installed}" ] && echo "Updating sbx ${installed} -> ${version}" || echo "Installing sbx ${version}"

# --- Preflight ---------------------------------------------------------------

if ! command -v mkfs.ext4 >/dev/null 2>&1; then
  echo "error: mkfs.ext4 not found — sbx needs e2fsprogs on the host." >&2
  exit 1
fi
if [ ! -e /dev/kvm ]; then
  echo "warning: /dev/kvm is missing — sandboxes won't boot until virtualization is enabled." >&2
elif [ ! -r /dev/kvm ] || [ ! -w /dev/kvm ]; then
  echo "warning: no access to /dev/kvm. Fix with: sudo usermod -aG kvm \$USER  (then re-login)" >&2
fi

# --- Download + verify (best-effort, no hardcoded hashes) --------------------

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
url="https://github.com/${REPO}/releases/download/${version}/${ASSET}"

echo "Downloading ${ASSET} (${version}) ..."
curl -fL --proto '=https' -o "${work}/${ASSET}" "${url}"

got="$(sha256sum "${work}/${ASSET}" | awk '{print $1}')"
want="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${version}" 2>/dev/null \
  | python3 -c "import sys,json
d=json.load(sys.stdin)
print(next((a.get('digest','') for a in d.get('assets',[]) if a['name']=='${ASSET}'),'').replace('sha256:',''))" 2>/dev/null || true)"

if [ -n "${want}" ]; then
  if [ "${want}" != "${got}" ]; then
    echo "error: checksum mismatch! expected ${want}, got ${got}" >&2
    exit 1
  fi
  echo "Verified against GitHub-recorded digest: ${got}"
else
  echo "No published digest available; proceeding on TLS trust. sha256=${got}"
fi

# --- Install (stop the daemon first if we're updating in place) --------------

if [ -x "${PREFIX}/bin/sbx" ]; then
  "${PREFIX}/bin/sbx" daemon stop >/dev/null 2>&1 || true
fi

tar -xzf "${work}/${ASSET}" -C "${work}"
PREFIX="${PREFIX}" "${work}/docker-sbx/install.sh"

# --- Symlink into ~/.local/bin ----------------------------------------------
# sbx resolves /proc/self/exe to its real path, so a symlink here still finds
# the kernel/rootfs/shims in ${PREFIX}/libexec. (Verified behavior.)

mkdir -p "${LINK_DIR}"
ln -sfn "${PREFIX}/bin/sbx" "${LINK_DIR}/sbx"
echo "Linked ${LINK_DIR}/sbx -> ${PREFIX}/bin/sbx"

# --- Sanity checks (derived, not hardcoded) ----------------------------------

# ldd every dynamically-linked ELF that got installed, whatever the release ships.
find "${PREFIX}" -type f 2>/dev/null | while read -r f; do
  case "$(file -b "$f" 2>/dev/null)" in
    *ELF*dynamically*)
      if ldd "$f" 2>/dev/null | grep -q 'not found'; then
        echo "warning: missing libraries for $f:" >&2
        ldd "$f" | grep 'not found' >&2
      fi ;;
  esac
done

"${LINK_DIR}/sbx" version

if ! printf '%s' ":${PATH}:" | grep -q ":${LINK_DIR}:"; then
  echo
  echo "Note: ${LINK_DIR} is not on your PATH. Add it in your shell rc:"
  echo "  export PATH=\"${LINK_DIR}:\$PATH\""
fi

echo
echo "Done. Next: 'sbx diagnose' to preflight, then 'sbx login', then 'sbx run claude'."
