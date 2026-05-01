#!/bin/sh
set -eu

REPO="luodaoyi/daoyi-monitor"
MANIFEST_URL=""
INSTALLER_URL="https://raw.githubusercontent.com/luodaoyi/daoyi-monitor/main/install.sh"
ENDPOINT=""
TOKEN=""
CHANNEL="stable"
PROFILE="full"
INTERVAL_SEC="3"
INSTALL_DIR="/usr/local/bin"

usage() {
  cat <<'EOF'
Usage:
  install.sh --endpoint URL --token TOKEN [options]

Options:
  --profile full|small|tiny
  --interval SEC
  --manifest-url URL
  --installer-url URL
  --install-dir DIR
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

download() {
  url="$1"
  output="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$output" "$url"
    return
  fi
  echo "curl or wget is required" >&2
  exit 1
}

verify_sha256() {
  expected="$1"
  file="$2"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s  %s\n' "$expected" "$file" | sha256sum -c -
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256 >/dev/null 2>&1; then
    actual="$(sha256 -q "$file")"
  else
    echo "sha256sum, shasum, or sha256 is required" >&2
    exit 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "sha256 mismatch: $file" >&2
    exit 1
  fi
}

as_root() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "root or sudo is required for: $*" >&2
    exit 1
  fi
}

quote_arg() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\"'\"'/g")"
}

normalize_endpoint() {
  case "$1" in
    wss://*|ws://*) printf '%s\n' "$1" ;;
    https://*) printf 'wss://%s/ws/agent\n' "$(printf '%s' "$1" | sed 's#^https://##; s#/$##')" ;;
    http://*) printf 'ws://%s/ws/agent\n' "$(printf '%s' "$1" | sed 's#^http://##; s#/$##')" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

detect_target() {
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "$os:$arch" in
    linux:x86_64|linux:amd64) echo "x86_64-linux-musl" ;;
    linux:aarch64|linux:arm64) echo "aarch64-linux-musl" ;;
    linux:armv7l|linux:armv7) echo "arm-linux-musleabihf" ;;
    linux:armv6l|linux:armv6) echo "arm-linux-musleabi" ;;
    linux:mips) echo "mips-linux-musl" ;;
    linux:mipsel) echo "mipsel-linux-musl" ;;
    linux:riscv64) echo "riscv64-linux-musl" ;;
    freebsd:x86_64|freebsd:amd64) echo "x86_64-freebsd" ;;
    freebsd:aarch64|freebsd:arm64) echo "aarch64-freebsd" ;;
    darwin:x86_64|darwin:amd64) echo "x86_64-macos" ;;
    darwin:aarch64|darwin:arm64) echo "aarch64-macos" ;;
    *)
      echo "unsupported platform: $os/$arch" >&2
      exit 1
      ;;
  esac
}

manifest_value() {
  key="$1"
  awk -v target="$TARGET" -v profile="$PROFILE" -v key="$key" '
    $0 ~ "\"target\": \"" target "\"" { in_target = 1 }
    in_target && $0 ~ "\"profile\": \"" profile "\"" { in_profile = 1 }
    in_target && in_profile && $0 ~ "\"" key "\":" {
      line = $0
      sub(".*\"" key "\": *\"", "", line)
      sub("\".*", "", line)
      print line
      exit
    }
    in_target && $0 ~ "}" { in_target = 0; in_profile = 0 }
  ' "$MANIFEST_FILE"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-stable}"; shift 2 ;;
    --profile) PROFILE="${2:-full}"; shift 2 ;;
    --interval) INTERVAL_SEC="${2:-3}"; shift 2 ;;
    --manifest-url) MANIFEST_URL="${2:-}"; shift 2 ;;
    --installer-url) INSTALLER_URL="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "$INTERVAL_SEC" in
  ''|*[!0-9]*) echo "--interval must be a positive integer" >&2; exit 1 ;;
esac

if [ -z "$ENDPOINT" ] || [ -z "$TOKEN" ]; then
  usage >&2
  exit 1
fi

need_cmd awk
need_cmd tar

TARGET="$(detect_target)"
ENDPOINT="$(normalize_endpoint "$ENDPOINT")"
MANIFEST_URL="${MANIFEST_URL:-https://github.com/$REPO/releases/latest/download/manifest.json}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

MANIFEST_FILE="$WORK_DIR/manifest.json"
download "$MANIFEST_URL" "$MANIFEST_FILE"

ARTIFACT_URL="$(manifest_value url)"
ARTIFACT_SHA="$(manifest_value sha256)"

if [ -z "$ARTIFACT_URL" ] || [ -z "$ARTIFACT_SHA" ]; then
  echo "no artifact for target=$TARGET profile=$PROFILE in manifest" >&2
  exit 1
fi

ARCHIVE="$WORK_DIR/agent.tar.gz"
download "$ARTIFACT_URL" "$ARCHIVE"
verify_sha256 "$ARTIFACT_SHA" "$ARCHIVE"

mkdir -p "$WORK_DIR/extract"
tar -xzf "$ARCHIVE" -C "$WORK_DIR/extract"
BIN="$(find "$WORK_DIR/extract" -type f -name daoyi-agent | head -n 1)"
if [ -z "$BIN" ]; then
  echo "daoyi-agent binary not found in archive" >&2
  exit 1
fi

as_root mkdir -p "$INSTALL_DIR"
as_root install -m 0755 "$BIN" "$INSTALL_DIR/daoyi-agent"

EXEC_START="$INSTALL_DIR/daoyi-agent --endpoint $(quote_arg "$ENDPOINT") --token $(quote_arg "$TOKEN") --interval $(quote_arg "$INTERVAL_SEC")"

if command -v systemctl >/dev/null 2>&1; then
  as_root sh -c "cat > /etc/systemd/system/daoyi-agent.service" <<EOF
[Unit]
Description=Daoyi Monitor Agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$EXEC_START
Restart=always
RestartSec=5
DynamicUser=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable --now daoyi-agent
  as_root systemctl restart daoyi-agent
  echo "daoyi-agent installed and started"
else
  echo "daoyi-agent installed to $INSTALL_DIR/daoyi-agent"
  echo "systemd not found; start it manually with: $EXEC_START"
fi
