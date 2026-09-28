# Imagem da sandbox: kilo serve + git + bubblewrap + a ponte de harness (Claude Code e Codex).
# Um container por tarefa; a variante Dockerfile.aic acrescenta o CLI local para HARNESS=aic.
#
# Para usar o seu fork em vez do pacote oficial, publique o CLI forkado num registry
# (ou copie o tarball de `bun run build`) e troque KILO_NPM_PACKAGE, ex.:
#   docker build --build-arg KILO_NPM_PACKAGE=@sua-org/kilo-cli@0.1.0 -t squad-sandbox:dev sandbox
FROM node:22-bookworm-slim

ARG KILO_NPM_PACKAGE=@kilocode/cli@7.8.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates bubblewrap ripgrep curl openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "${KILO_NPM_PACKAGE}" && kilo --version

# Ponte de harness: Claude Agent SDK e @openai/codex-sdk (cada um traz o binário da plataforma).
# Roda com o strip-types do Node 22 (sem build). Fica antes da squad para aproveitar o cache.
COPY bridge/package.json bridge/package-lock.json /opt/bridge/
RUN cd /opt/bridge && npm ci --omit=dev && npm cache clean --force
COPY bridge/src/ /opt/bridge/src/

# Config da squad fora do repo: kilo.jsonc, aicockpit.jsonc e agents/*.md.
# Kilo e AI Cockpit carregam seus respectivos diretórios de configuração.
# O Kilo carrega KILO_CONFIG_DIR
# como diretório de config confiável; .kilo/agents/*.md do próprio repo continua valendo
# e pode sobrescrever agentes com o mesmo nome.
COPY squad/ /opt/squad/
ENV KILO_CONFIG_DIR=/opt/squad \
    AICOCKPIT_CONFIG_DIR=/opt/squad \
    SQUAD_DIR=/opt/squad \
    KILO_DISABLE_AUTOUPDATE=1 \
    REPO_DIR=/workspace/repo

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 && mkdir -p /workspace && chown node:node /workspace

USER node
WORKDIR /workspace
EXPOSE 4096
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
