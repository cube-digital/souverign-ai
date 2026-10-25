#!/usr/bin/env bash
# Speech fixtures for the live voice and call smokes, written to .run/fixtures/.
#   ask.webm                     Opus 24 k, a question for Ops
#   ana.wav vlad.wav rares.wav   16 kHz mono, 2 s of leading silence, one sentence each
set -euo pipefail
cd "$(dirname "$0")/../.."
for tool in espeak-ng ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "voice-fixtures: $tool is missing (brew install $tool)" >&2
    exit 1
  fi
done
out=.run/fixtures
mkdir -p "$out"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say() { # say <name> <text>: raw speech to $tmp/<name>.wav
  espeak-ng -v en-us -s 150 -w "$tmp/$1.wav" "$2"
}

say ask "Ops, how healthy is the cluster right now?"
ffmpeg -y -loglevel error -i "$tmp/ask.wav" -c:a libopus -b:a 24k "$out/ask.webm"

say ana "We agreed to move the delivery to the twentieth of March."
say vlad "I will send the confirmation email by Friday."
say rares "The secret budget is ninety thousand euros."
for who in ana vlad rares; do
  ffmpeg -y -loglevel error -i "$tmp/$who.wav" -af "adelay=2000:all=1" -ar 16000 -ac 1 \
    -c:a pcm_s16le "$out/$who.wav"
done
ls -l "$out"
