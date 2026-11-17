#!/bin/sh
# Pull the local models into the running `ollama` container and build the project's derived models.
#   laya:421m-typed-decisions-bf16 -> uas-laya   decision model (default), num_thread = OLLAMA_THREADS
#   llama3.2:1b                                  text model: reflection (num_thread is sent per request)
#   qwen3.5:0.8b                                 text model: plans
#   tev1:0.8b -> uas-tev1                        alternative decision model, only with UAS_PULL_TEV=1
# /v1/systemone ignores request options, so thread count (and Tev1's context) must be baked into
# a Modelfile. Keep OLLAMA_THREADS equal to the container's OLLAMA_CPUS cap: more threads than
# CPUs makes llama.cpp threads fight over the quota (measured: about 2x slower).
set -e
RT=$(command -v podman || command -v docker || true)
[ -n "$RT" ] || { echo "Neither podman nor docker found." >&2; exit 1; }
T=${OLLAMA_THREADS:-4}
$RT exec ollama ollama --version
for m in laya:421m-typed-decisions-bf16 llama3.2:1b qwen3.5:0.8b; do $RT exec ollama ollama pull "$m"; done
$RT exec ollama sh -c "printf 'FROM laya:421m-typed-decisions-bf16\nPARAMETER num_thread $T\n' > /tmp/Modelfile.uas-laya && ollama create uas-laya -f /tmp/Modelfile.uas-laya"
if [ "${UAS_PULL_TEV:-0}" = 1 ]; then
  $RT exec ollama ollama pull tev1:0.8b
  $RT exec ollama sh -c "printf 'FROM tev1:0.8b\nPARAMETER num_ctx 2048\nPARAMETER num_thread $T\n' > /tmp/Modelfile.uas-tev1 && ollama create uas-tev1 -f /tmp/Modelfile.uas-tev1"
fi
$RT exec ollama ollama list
