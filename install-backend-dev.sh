#!/usr/bin/env bash
set -euo pipefail

APP=opencode

MUTED='\033[0;2m'
RED='\033[0;31m'
ORANGE='\033[38;5;214m'
NC='\033[0m'

print_message() {
    local level=$1
    local message=$2
    local color=""

    case $level in
        info) color="${NC}" ;;
        warning) color="${ORANGE}" ;;
        error) color="${RED}" ;;
    esac

    echo -e "${color}${message}${NC}"
}

usage() {
  cat <<EOF
Install modified OpenCode backend (prebuilt binary)

Usage:
  bash install-backend-dev.sh [options]

Options:
  --repo <owner/repo>     GitHub repository (default: anomalyco/opencode)
  --version <version>     Install a specific release version (eg. 1.4.9)
  --install-dir <path>    Install directory (default: ~/.opencode-dev/bin)
  --bin-name <name>       Installed command name (default: opencode-backend-dev)
  --no-modify-path        Don't modify shell rc files
  -h, --help              Show help

Environment variables:
  OPENCODE_BACKEND_REPO        (owner/repo)
  OPENCODE_BACKEND_VERSION
  OPENCODE_BACKEND_INSTALL_DIR
  OPENCODE_BACKEND_BIN_NAME

Examples:
  curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/dev/install-backend-dev.sh | bash
  curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/dev/install-backend-dev.sh | bash -s -- --repo yourname/opencode --version 1.4.9
EOF
}

repo="${OPENCODE_BACKEND_REPO:-anomalyco/opencode}"
requested_version="${OPENCODE_BACKEND_VERSION:-${VERSION:-}}"
install_dir="${OPENCODE_BACKEND_INSTALL_DIR:-$HOME/.opencode-dev/bin}"
bin_name="${OPENCODE_BACKEND_BIN_NAME:-opencode-backend-dev}"
modify_path=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo="${2:-}"
      shift 2
      ;;
    --version)
      requested_version="${2:-}"
      shift 2
      ;;
    --install-dir)
      install_dir="${2:-}"
      shift 2
      ;;
    --bin-name)
      bin_name="${2:-}"
      shift 2
      ;;
    --no-modify-path)
      modify_path=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      print_message warning "Unknown option: $1"
      shift
      ;;
  esac
done

if [[ -z "$repo" || -z "$install_dir" || -z "$bin_name" ]]; then
    print_message error "Invalid empty argument detected"
    usage
    exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
    print_message error "curl is required but was not found in PATH"
    exit 1
fi

if ! command -v unzip >/dev/null 2>&1 && ! command -v tar >/dev/null 2>&1; then
    print_message error "Either unzip or tar is required to extract release artifacts"
    exit 1
fi

raw_os=$(uname -s)
os=$(echo "$raw_os" | tr '[:upper:]' '[:lower:]')
case "$raw_os" in
  Darwin*) os="darwin" ;;
  Linux*) os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) os="windows" ;;
esac

arch=$(uname -m)
if [[ "$arch" == "aarch64" ]]; then
  arch="arm64"
fi
if [[ "$arch" == "x86_64" ]]; then
  arch="x64"
fi

if [[ "$os" == "darwin" && "$arch" == "x64" ]]; then
  rosetta_flag=$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)
  if [[ "$rosetta_flag" == "1" ]]; then
    arch="arm64"
  fi
fi

combo="$os-$arch"
case "$combo" in
  linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64)
    ;;
  *)
    print_message error "Unsupported OS/Arch: $os/$arch"
    exit 1
    ;;
esac

archive_ext=".zip"
if [[ "$os" == "linux" ]]; then
  archive_ext=".tar.gz"
fi

is_musl=false
if [[ "$os" == "linux" ]]; then
  if [[ -f /etc/alpine-release ]]; then
    is_musl=true
  fi

  if command -v ldd >/dev/null 2>&1; then
    if ldd --version 2>&1 | grep -qi musl; then
      is_musl=true
    fi
  fi
fi

needs_baseline=false
if [[ "$arch" == "x64" ]]; then
  if [[ "$os" == "linux" ]]; then
    if ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
      needs_baseline=true
    fi
  fi

  if [[ "$os" == "darwin" ]]; then
    avx2=$(sysctl -n hw.optional.avx2_0 2>/dev/null || echo 0)
    if [[ "$avx2" != "1" ]]; then
      needs_baseline=true
    fi
  fi
fi

target="$os-$arch"
if [[ "$needs_baseline" == "true" ]]; then
  target="$target-baseline"
fi
if [[ "$is_musl" == "true" ]]; then
  target="$target-musl"
fi

filename="$APP-$target$archive_ext"

if [[ -z "$requested_version" ]]; then
    url="https://github.com/$repo/releases/latest/download/$filename"
    specific_version=$(curl -s "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p')

    if [[ $? -ne 0 || -z "$specific_version" ]]; then
        print_message error "Failed to fetch version information"
        exit 1
    fi
else
    requested_version="${requested_version#v}"
    specific_version="$requested_version"
    url="https://github.com/$repo/releases/download/v${requested_version}/$filename"

    http_status=$(curl -sI -o /dev/null -w "%{http_code}" "https://github.com/$repo/releases/tag/v${requested_version}")
    if [[ "$http_status" == "404" ]]; then
        print_message error "Release v${requested_version} not found in $repo"
        exit 1
    fi
fi

mkdir -p "$install_dir"

tmp_dir="${TMPDIR:-/tmp}/opencode_backend_install_$$"
mkdir -p "$tmp_dir"

print_message info "\n${MUTED}Installing ${NC}${bin_name}${MUTED} version:${NC} $specific_version"
curl -# -fL -o "$tmp_dir/$filename" "$url"

if [[ "$os" == "linux" ]]; then
    if ! command -v tar >/dev/null 2>&1; then
        print_message error "tar is required to extract Linux release archives"
        exit 1
    fi
    tar -xzf "$tmp_dir/$filename" -C "$tmp_dir"
else
    if ! command -v unzip >/dev/null 2>&1; then
        print_message error "unzip is required to extract non-Linux release archives"
        exit 1
    fi
    unzip -q "$tmp_dir/$filename" -d "$tmp_dir"
fi

if [[ ! -f "$tmp_dir/opencode" ]]; then
    print_message error "Downloaded archive did not contain expected binary: opencode"
    exit 1
fi

mv "$tmp_dir/opencode" "$install_dir/$bin_name"
chmod 755 "$install_dir/$bin_name"
rm -rf "$tmp_dir"

add_to_path() {
  local config_file=$1
  local command=$2

  if [[ ! -f "$config_file" ]]; then
    return
  fi

  if grep -Fqx "$command" "$config_file"; then
    return
  fi

  if [[ ! -w "$config_file" ]]; then
    print_message warning "Cannot modify $config_file; add this manually:"
    print_message info "  $command"
    return
  fi

  echo -e "\n# opencode modified backend" >> "$config_file"
  echo "$command" >> "$config_file"
  print_message info "${MUTED}Added launcher path to${NC} $config_file"
}

if [[ "$modify_path" == "true" ]]; then
  current_shell="$(basename "${SHELL:-bash}")"
  path_cmd="export PATH=$install_dir:\$PATH"

  if [[ "$current_shell" == "zsh" ]]; then
    add_to_path "${ZDOTDIR:-$HOME}/.zshrc" "$path_cmd"
    add_to_path "${ZDOTDIR:-$HOME}/.zshenv" "$path_cmd"
  elif [[ "$current_shell" == "bash" ]]; then
    add_to_path "$HOME/.bashrc" "$path_cmd"
    add_to_path "$HOME/.bash_profile" "$path_cmd"
    add_to_path "$HOME/.profile" "$path_cmd"
  elif [[ "$current_shell" == "fish" ]]; then
    add_to_path "$HOME/.config/fish/config.fish" "fish_add_path $install_dir"
  fi
fi

print_message info ""
print_message info "${MUTED}Installed modified backend binary:${NC} $install_dir/$bin_name"
print_message info "${MUTED}Run it with:${NC} $bin_name serve --port 4096"
print_message info ""
