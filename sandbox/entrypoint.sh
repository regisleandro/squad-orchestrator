#!/usr/bin/env bash
# Clona o repo da tarefa e sobe o harness: `kilo serve`, ou a ponte (sandbox/bridge) para
# Claude Code e Codex, que responde o mesmo protocolo. O health (/global/health) só responde
# depois do clone, então o orquestrador usa o health como "sandbox pronta".
set -euo pipefail

: "${REPO_URL:?REPO_URL obrigatório}"
: "${KILO_SERVER_PASSWORD:?KILO_SERVER_PASSWORD obrigatório}"
REPO_BRANCH="${REPO_BRANCH:-}"
REPO_DIR="${REPO_DIR:-/workspace/repo}"

git config --global user.name "${GIT_AUTHOR_NAME:-squad-bot}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-squad-bot@localhost}"
git config --global init.defaultBranch main

# Token do GitHub via credential helper (não fica na URL nem no .git/config do repo).
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  git config --global credential.helper '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f'
fi

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  echo "[sandbox] clonando ${REPO_URL} (${REPO_BRANCH:-branch padrão})"
  if [[ -n "${REPO_BRANCH}" ]]; then
    git clone --depth 50 --branch "${REPO_BRANCH}" "${REPO_URL}" "${REPO_DIR}"
  else
    git clone --depth 50 "${REPO_URL}" "${REPO_DIR}"
  fi
fi
cd "${REPO_DIR}"
# Referência estável para revisar também os commits feitos pelo agente.
git config squad.baseBranch "$(git symbolic-ref --short HEAD)"
git update-ref refs/squad/base HEAD
git checkout -B "${TASK_BRANCH:-squad/${HOSTNAME}}" >/dev/null

case "${HARNESS:-kilo}" in
  kilo)
    echo "[sandbox] subindo kilo serve"
    exec kilo serve --port 4096 --hostname 0.0.0.0
    ;;
  claude-code | codex)
    echo "[sandbox] subindo a ponte (${HARNESS})"
    exec env REPO_DIR="${REPO_DIR}" PORT=4096 node /opt/bridge/src/server.ts
    ;;
  *)
    echo "[sandbox] HARNESS desconhecido: ${HARNESS}" >&2
    exit 1
    ;;
esac
