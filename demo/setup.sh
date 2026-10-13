#!/usr/bin/env bash
# Makes demo media and a curation set for the README demo: four short
# synthesized sounds and three generated images. Needs ffmpeg and the
# canvas CLI (canvas-set) on PATH.
# Usage: demo/setup.sh [dir]   (default: a fresh temp dir; prints the set path)
set -euo pipefail
dir="${1:-$(mktemp -d -t canvas-demo)}"
mkdir -p "$dir/media"
cd "$dir/media"
q() { ffmpeg -loglevel error -y "$@"; }
q -f lavfi -i "sine=frequency=55:duration=0.6" -af "afade=t=out:st=0.05:d=0.55,volume=4" kick-low.wav
q -f lavfi -i "sine=frequency=80:duration=0.4" -af "afade=t=out:st=0.02:d=0.38,volume=4" kick-punch.wav
q -f lavfi -i "anoisesrc=d=0.3:c=pink" -af "highpass=f=6000,afade=t=out:st=0.01:d=0.29" hat-open.wav
q -f lavfi -i "sine=frequency=220:duration=2" -af "vibrato=f=5:d=0.4,afade=t=in:d=0.3,afade=t=out:st=1.4:d=0.6" pad-warm.wav
q -f lavfi -i "gradients=s=640x400:c0=0xe07b39:c1=0x7090b0:duration=1" -frames:v 1 cover-dusk.png
q -f lavfi -i "gradients=s=640x400:c0=0x8cb369:c1=0x609888:duration=1" -frames:v 1 cover-meadow.png
q -f lavfi -i "mandelbrot=s=640x400" -frames:v 1 cover-fractal.png
canvas-set new --title "Demo: pick sounds and a cover" --mode triage -o "$dir/demo.curate.json" "$dir"/media/* >/dev/null
echo "$dir/demo.curate.json"
