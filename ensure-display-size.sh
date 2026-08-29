#!/usr/bin/env bash
set -euo pipefail

minimum_width="${DISPLAY_MIN_WIDTH:-1024}"
minimum_height="${DISPLAY_MIN_HEIGHT:-700}"

if ! [[ "$minimum_width" =~ ^[0-9]+$ && "$minimum_height" =~ ^[0-9]+$ ]]; then
  echo "Display size safety stop: minimum dimensions must be integers" >&2
  exit 1
fi

read_display_state() {
  xrandr --current
}

connected_output() {
  awk '
    $2 == "connected" && $3 == "primary" { print $1; exit }
    $2 == "connected" && fallback == "" { fallback = $1 }
    END { if (fallback != "") print fallback }
  '
}

output_size() {
  local output="$1"
  awk -v target="$output" '
    $1 == target && $2 == "connected" {
      for (i = 3; i <= NF; i += 1) {
        if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) {
          split($i, geometry, "+")
          split(geometry[1], dimensions, "x")
          print dimensions[1], dimensions[2]
          exit
        }
      }
    }
  '
}

display_state="$(read_display_state)"
output="$(printf '%s\n' "$display_state" | connected_output | head -n 1)"
if [[ -z "$output" ]]; then
  echo "Display size safety stop: no connected output on ${DISPLAY:-unset}" >&2
  exit 1
fi

read -r current_width current_height < <(printf '%s\n' "$display_state" | output_size "$output")
if [[ -z "${current_width:-}" || -z "${current_height:-}" ]]; then
  echo "Display size safety stop: cannot read geometry for $output" >&2
  exit 1
fi

if (( current_width >= minimum_width && current_height >= minimum_height )); then
  echo "DISPLAY_SIZE_OK output=$output size=${current_width}x${current_height}"
  exit 0
fi

best_mode=""
best_area=0
while read -r mode width height; do
  [[ -n "$mode" ]] || continue
  if (( width >= minimum_width && height >= minimum_height )); then
    area=$((width * height))
    if (( best_area == 0 || area < best_area )); then
      best_mode="$mode"
      best_area="$area"
    fi
  fi
done < <(
  printf '%s\n' "$display_state" | awk -v target="$output" '
    $1 == target && $2 == "connected" { active = 1; next }
    active && $0 !~ /^[[:space:]]/ { active = 0 }
    active && $1 ~ /^[0-9]+x[0-9]+/ {
      mode = $1
      dimensions = mode
      sub(/_.*/, "", dimensions)
      split(dimensions, size, "x")
      print mode, size[1], size[2]
    }
  '
)

if [[ -z "$best_mode" ]]; then
  echo "Display size safety stop: $output has no mode at least ${minimum_width}x${minimum_height}" >&2
  exit 1
fi

xrandr --output "$output" --mode "$best_mode"
sleep 1

display_state="$(read_display_state)"
read -r current_width current_height < <(printf '%s\n' "$display_state" | output_size "$output")
if (( current_width < minimum_width || current_height < minimum_height )); then
  echo "Display size safety stop: resize verification failed at ${current_width}x${current_height}" >&2
  exit 1
fi

echo "DISPLAY_SIZE_ADJUSTED output=$output mode=$best_mode size=${current_width}x${current_height}"
