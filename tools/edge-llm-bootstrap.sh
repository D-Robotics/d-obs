#!/usr/bin/env bash
# Build CPU-only llama-server from an operator-selected official commit or tag.
set -euo pipefail
: "${LLAMA_CPP_REF:?Set LLAMA_CPP_REF to an explicit official 40-character commit SHA or release tag (e.g. bNNNN)}"
: "${RDK_EDGE_LLM_PREFIX:?Set RDK_EDGE_LLM_PREFIX to an absolute private installation directory}"
case "$RDK_EDGE_LLM_PREFIX" in /*) ;; *) printf '%s\n' 'RDK_EDGE_LLM_PREFIX must be absolute' >&2; exit 2 ;; esac
if [[ "$LLAMA_CPP_REF" =~ ^[a-fA-F0-9]{40}$ ]]; then
  task_ref="$LLAMA_CPP_REF"
elif [[ "$LLAMA_CPP_REF" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$ ]]; then
  task_ref="refs/tags/$LLAMA_CPP_REF"
else
  printf '%s\n' 'LLAMA_CPP_REF must be a full SHA or a tag name' >&2; exit 2
fi
for task_tool in git cmake c++; do
  command -v "$task_tool" >/dev/null || { printf 'Missing prerequisite: %s (install it explicitly first)\n' "$task_tool" >&2; exit 2; }
done
task_jobs="${LLAMA_CPP_BUILD_JOBS:-4}"
[[ "$task_jobs" =~ ^[1-8]$ ]] || { printf '%s\n' 'LLAMA_CPP_BUILD_JOBS must be 1 through 8' >&2; exit 2; }
umask 077
mkdir -p "$RDK_EDGE_LLM_PREFIX"
task_build_dir="$(mktemp -d "$RDK_EDGE_LLM_PREFIX/.llama-build.XXXXXX")"
trap 'rm -rf -- "$task_build_dir"' EXIT
git init -q "$task_build_dir/source"
git -C "$task_build_dir/source" remote add origin https://github.com/ggml-org/llama.cpp.git
git -C "$task_build_dir/source" fetch --depth 1 origin "$task_ref"
git -C "$task_build_dir/source" checkout --detach FETCH_HEAD
task_commit="$(git -C "$task_build_dir/source" rev-parse HEAD)"
cmake -S "$task_build_dir/source" -B "$task_build_dir/build" \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF -DLLAMA_OPENSSL=OFF \
  -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_BUILD_UI=OFF \
  -DGGML_CUDA=OFF -DGGML_METAL=OFF -DGGML_VULKAN=OFF -DGGML_SYCL=OFF \
  -DGGML_OPENCL=OFF -DGGML_BLAS=OFF -DLLAMA_BUILD_TESTS=OFF
cmake --build "$task_build_dir/build" --target llama-server -j "$task_jobs"
mkdir -p "$RDK_EDGE_LLM_PREFIX/bin"
install -m 700 "$task_build_dir/build/bin/llama-server" "$RDK_EDGE_LLM_PREFIX/bin/.llama-server.new"
mv "$RDK_EDGE_LLM_PREFIX/bin/.llama-server.new" "$RDK_EDGE_LLM_PREFIX/bin/llama-server"
printf '%s\n' "$task_commit" > "$RDK_EDGE_LLM_PREFIX/llama-commit.txt"
"$RDK_EDGE_LLM_PREFIX/bin/llama-server" --version
printf 'Installed CPU-only llama-server from %s\n' "$task_commit"
printf '%s\n' 'Create a private runner config and 0600 token file before starting edge-llm-runner.mjs.'
