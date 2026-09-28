#!/usr/bin/env bash
# Monta a imagem com a instalação local do AI Cockpit, sem baixar o CLI.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -n "${AIC_CLI_DIR:-}" ]]; then
  aic_dir="$(realpath "${AIC_CLI_DIR}")"
else
  aic_bin="$(command -v aic || true)"
  if [[ -z "${aic_bin}" ]]; then
    echo "aic não está no PATH; defina AIC_CLI_DIR para o diretório da instalação" >&2
    exit 1
  fi
  aic_dir="$(dirname "$(realpath "${aic_bin}")")"
fi

if [[ ! -x "${aic_dir}/aic" ]]; then
  echo "aic não encontrado em ${aic_dir}" >&2
  exit 1
fi

image="${SANDBOX_IMAGE:-squad-sandbox:aic}"
if command -v docker >/dev/null 2>&1; then
  docker_cmd=docker
  build_context=sandbox
  aic_context="${aic_dir}"
  dockerfile=sandbox/Dockerfile.aic
elif command -v docker.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
  docker_cmd=docker.exe
  build_context="$(wslpath -w "${PWD}/sandbox")"
  aic_context="$(wslpath -w "${aic_dir}")"
  dockerfile="$(wslpath -w "${PWD}/sandbox/Dockerfile.aic")"
else
  echo "docker não está disponível; instale Docker ou habilite o Docker Desktop" >&2
  exit 1
fi

echo "[build] copiando o CLI de ${aic_dir} para ${image}"
"${docker_cmd}" build -t squad-sandbox:base "${build_context}"
"${docker_cmd}" build \
  --build-context "aic=${aic_context}" \
  --build-arg BASE_SANDBOX_IMAGE=squad-sandbox:base \
  -f "${dockerfile}" \
  -t "${image}" \
  "${build_context}"
