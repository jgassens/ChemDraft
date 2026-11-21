#!/usr/bin/env bash
set -euo pipefail
image=$(realpath "$1")
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
"$image" --appimage-extract > /dev/null
root="$work/squashfs-root"
# linuxdeploy AppRun prepends usr/lib and the multiarch directory.
export LD_LIBRARY_PATH="$root/usr/lib:$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
search_dirs=()
add_search_dir() {
  local dir=$1 existing
  [[ -n "$dir" && -d "$dir" ]] || return 0
  for existing in "${search_dirs[@]}"; do
    [[ "$existing" == "$dir" ]] && return 0
  done
  search_dirs+=("$dir")
}

# Prefer the host's own library metadata, then include the common distro layouts.
if command -v ldconfig >/dev/null 2>&1; then
  while IFS= read -r dir; do add_search_dir "$dir"; done < <(
    ldconfig -p 2>/dev/null | awk '/lib(EGL_mesa|gbm|drm).*\.so|_dri\.so/ { for (i = 1; i <= NF; i++) if ($i == "=>") { print $(i + 1); break } }' | xargs -r -n1 dirname
  )
fi
for package in egl gbm; do
  if command -v pkg-config >/dev/null 2>&1; then
    add_search_dir "$(pkg-config --variable=libdir "$package" 2>/dev/null || true)"
  fi
done
if command -v pkg-config >/dev/null 2>&1; then
  dri_dir=$(pkg-config --variable=dridriverdir dri 2>/dev/null || true)
  add_search_dir "$dri_dir"
  add_search_dir "$dri_dir/gallium"
fi
for dir in /usr/lib64 /lib64 /usr/lib /lib \
  /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu \
  /usr/lib/aarch64-linux-gnu /lib/aarch64-linux-gnu; do
  add_search_dir "$dir"
  add_search_dir "$dir/dri"
  add_search_dir "$dir/dri/gallium"
done

searched_dirs=$(IFS=', '; printf '%s' "${search_dirs[*]}")
mapfile -t libraries < <(find "${search_dirs[@]}" -type f \
  \( -name 'libEGL_mesa.so*' -o -name 'libgbm.so.*' -o -name 'libdrm.so.*' -o -name '*_dri.so' \) 2>/dev/null | sort -u)
for pattern in libEGL_mesa libgbm libdrm _dri.so; do
  printf '%s\n' "${libraries[@]}" | grep -q "$pattern" || { echo "::error::Missing host Mesa component $pattern; searched directories: $searched_dirs"; exit 1; }
done
for library in "${libraries[@]}"; do
  echo "Checking $library"
  dependencies=$(ldd "$library") || { echo "::error::ldd failed for $library"; exit 1; }
  printf '%s\n' "$dependencies"
  if grep -Fq 'not found' <<< "$dependencies" || grep -Fq "$root/" <<< "$dependencies"; then
    echo "::error::Missing or AppImage-shadowed dependency of $library"
    exit 1
  fi
done
