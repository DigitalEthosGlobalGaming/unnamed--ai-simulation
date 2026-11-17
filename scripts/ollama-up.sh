#!/bin/sh
# Create (or recreate) the local Ollama container with the project's settings.
# Recreates it when its settings differ, or always with --recreate.
# Podman preferred, Docker otherwise. Models live in the named volume `ollama`, so recreating is cheap.
#
# Server settings:
#   OLLAMA_KEEP_ALIVE=-1       keep models loaded (reloading llama3.2 costs ~5 s)
#   OLLAMA_MAX_LOADED_MODELS=3 decision, text and plan models all stay resident (~3 GB RAM, no CPU when idle)
#   OLLAMA_NUM_PARALLEL=1      one request at a time per model; the server's queue orders them
#   OLLAMA_CONTEXT_LENGTH=2048 small default context
# CPU limits, so model calls never take over the machine (both configurable):
#   OLLAMA_CPUS=4              hard cap in CPUs (cgroup cpu.max); 0 = no cap
#   OLLAMA_CPU_SHARES=256      low CPU weight (default is 1024), so foreground work wins under contention
set -e
RT=$(command -v podman || command -v docker || true)
[ -n "$RT" ] || { echo "Neither podman nor docker found." >&2; exit 1; }
CPUS=${OLLAMA_CPUS:-4}
SHARES=${OLLAMA_CPU_SHARES:-256}
WANT="OLLAMA_KEEP_ALIVE=-1 OLLAMA_MAX_LOADED_MODELS=3 OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=2048"
WANT_NANO=$(awk "BEGIN { printf \"%d\", $CPUS * 1000000000 }")

if $RT inspect ollama >/dev/null 2>&1; then
  HAVE=$($RT inspect ollama --format '{{range .Config.Env}}{{println .}}{{end}}')
  HAVE_LIMITS=$($RT inspect ollama --format '{{.HostConfig.NanoCpus}} {{.HostConfig.CpuShares}}')
  OK=1
  for kv in $WANT; do echo "$HAVE" | grep -qx "$kv" || OK=0; done
  [ "$HAVE_LIMITS" = "$WANT_NANO $SHARES" ] || OK=0
  if [ $OK = 1 ] && [ "$1" != "--recreate" ]; then
    $RT start ollama >/dev/null
    echo "ollama container running with project settings ($RT, cpus=$CPUS, cpu-shares=$SHARES)"
    exit 0
  fi
  echo "recreating ollama container with project settings (models are kept in the 'ollama' volume)"
  $RT stop ollama >/dev/null
  $RT container rm ollama >/dev/null
fi
ARGS=""
for kv in $WANT; do ARGS="$ARGS -e $kv"; done
[ "$CPUS" != "0" ] && ARGS="$ARGS --cpus $CPUS"
ARGS="$ARGS --cpu-shares $SHARES"
# shellcheck disable=SC2086
$RT run -d --name ollama -p 11434:11434 -v ollama:/root/.ollama $ARGS --restart unless-stopped docker.io/ollama/ollama:latest
echo "ollama container created ($RT, cpus=$CPUS, cpu-shares=$SHARES)"
