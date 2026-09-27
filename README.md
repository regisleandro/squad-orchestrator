# squad-orchestrator (POC)

Backend que faz o papel do "mini Kilo Cloud": recebe uma tarefa `(repoUrl, branch, prompt, harness)`, sobe um container por tarefa com `kilo serve` (ou a ponte do Claude Code / Codex), cria a sessão da squad, assina o SSE do harness e republica eventos classificados para a UI web. Ações da UI (follow-up, permissões, reset do board) voltam como POSTs diretos na sandbox.

```
browser ──HTTPS/SSE──> squad-orchestrator ──HTTP+SSE (Basic kilo:<senha por tarefa>)──> kilo serve  (HARNESS=kilo)
                                                                                    └─> ponte     (HARNESS=claude-code | codex)
```

## Harness: Kilo Code, Claude Code ou Codex

A tarefa escolhe o harness na criação (`harness` no `POST /tasks`, seletor na UI). Os três falam o **mesmo protocolo** com o orquestrador: o subconjunto HTTP/SSE do `kilo serve` listado em `src/kilo.ts`. Para Claude Code e Codex, o container sobe `sandbox/bridge` no lugar do `kilo serve`, e a ponte traduz o que o SDK de cada um emite para os eventos do Kilo. Resultado: o orquestrador, o relay e a UI não têm um caminho por harness; só `src/harness.ts` diz o que cada um entrega.

| | Kilo Code | Claude Code | Codex |
|---|---|---|---|
| Motor | `kilo serve` | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `@openai/codex-sdk` (`codex exec --experimental-json`) |
| Squad no grafo | nativa (tool `task`) | a mesma `sandbox/squad/agents/*.md` vira `agents` do SDK; tool `Agent` vira membro, `parent_tool_use_id` põe cada passo no nó certo | **agente único**; o prompt do líder pede os papéis em sequência |
| Board | Swarm nativo | **emulado** pela ponte: servidor MCP in-process com `board_post`/`board_read`, mesmo formato de mensagem (INFO/ASK/RESULT/HOLD/VETO) | **não há**; `GET .../board` volta vazio |
| Permissões | `kilo.jsonc` | `canUseTool` avaliado com o mesmo `permission` do `kilo.jsonc`; o que for `ask` vira `permission.asked` e "Sempre" vale até a sandbox morrer | **não há** aprovação interativa no exec: roda com `approvalPolicy: never`, e o container é o isolamento |
| Retry do modelo | `session.status retry` | `system/api_retry` → `retry` | erro do turno → `error` |
| Diff | `/session/:id/diff` | `git diff` contra o HEAD do início (inclui commits e arquivos novos) | idem |
| Credencial (via `SANDBOX_ENV_PASSTHROUGH`) | a do provedor do Kilo | `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` | `CODEX_API_KEY` ou `OPENAI_API_KEY` |
| Modelo padrão | `DEFAULT_MODEL` (provider/model) | `CLAUDE_CODE_MODEL` (ex.: `sonnet`) | `CODEX_MODEL` |

Agentes oferecidos: no Claude Code, `squad-lead` (a squad) ou `claude` (Claude Code puro, sem squad nem board); no Codex, só `codex`. O `CLAUDE.md` e o `.claude/` do repo continuam valendo (`settingSources: ["project"]`), como o `.kilo/` no Kilo. O sandbox próprio do Codex (landlock/seccomp) costuma falhar dentro do Docker, então o padrão é `CODEX_SANDBOX_MODE=danger-full-access`, na mesma linha da decisão de isolamento só pelo container.

**Roteiros fake (`BRIDGE_FAKE=1`):** a ponte troca os SDKs por roteiros gravados no formato deles, que passam pelos mesmos mapeamentos. Servem para demo e teste sem LLM, como o `scripts/mock-kilo.ts`.

## Rodando

```bash
npm install
cp .env.example .env         # ajuste API_TOKEN e chaves do LLM

# 1) Sem Docker nem LLM: mock do kilo serve + orquestrador apontando para ele
KILO_SERVER_PASSWORD=pw PORT=4096 npm run mock:kilo &
API_TOKEN=tok SANDBOX_DRIVER=external KILO_EXTERNAL_PASSWORD=pw npm run dev &
ORCH_URL=http://127.0.0.1:8080 API_TOKEN=tok npm run smoke

# 2) Kilo real local (sem container): rode `kilo serve` dentro de um repo
cd /algum/repo && KILO_CONFIG_DIR=$PWD/sandbox/squad KILO_SERVER_PASSWORD=pw kilo serve --port 4096
SANDBOX_DRIVER=external KILO_EXTERNAL_PASSWORD=pw KILO_EXTERNAL_DIRECTORY=/algum/repo npm run dev

# 1b) Pontes do Claude Code e do Codex com roteiros fake (sem LLM), cada uma num repo git qualquer
cd sandbox/bridge && npm install
HARNESS=claude-code PORT=4101 KILO_SERVER_PASSWORD=pw REPO_DIR=/tmp/repo-a SQUAD_DIR=../squad BRIDGE_FAKE=1 npm start &
HARNESS=codex       PORT=4102 KILO_SERVER_PASSWORD=pw REPO_DIR=/tmp/repo-b SQUAD_DIR=../squad BRIDGE_FAKE=1 npm start &
cd ../..
API_TOKEN=tok SANDBOX_DRIVER=external KILO_EXTERNAL_PASSWORD=pw \
  EXTERNAL_URL_CLAUDE_CODE=http://127.0.0.1:4101 EXTERNAL_URL_CODEX=http://127.0.0.1:4102 npm run dev &
ORCH_URL=http://127.0.0.1:8080 API_TOKEN=tok HARNESS=claude-code npm run smoke

# 3) Modelo alvo: um container por tarefa
npm run sandbox:build        # imagem squad-sandbox:dev (kilo + git + bwrap + squad)
SANDBOX_DRIVER=docker npm run dev
```

Defina `DEFAULT_MODEL=provider/model` (formato `provider/model`, como aparece em `kilo models`) e repasse a chave do provedor via `SANDBOX_ENV_PASSTHROUGH`; sem isso o Kilo escolhe um provedor padrão que pode não estar autenticado.

## UI web (`web/`)

Vite + React + TypeScript, no tema "Arena" (base: design system Raycast do Refero, escuro, Inter + Geist Mono), em variáveis CSS (`web/src/styles.css`). Cada agente tem uma cor de identidade (`agentColor` em `web/src/squad.ts`); âmbar marca o que espera você e coral marca VETO e erro. Telas: lista e criação de tarefas e a tela da tarefa, com dois modos (a escolha fica salva no navegador):

- **Palco** (padrão): o grafo da squad ocupa a tela, com um nó por agente (delegar de novo ao mesmo agente reaproveita o nó e mostra ×N), espaçamento que cresce com a quantidade de nós e quebra de linha acima de 6 por nível (1 por linha no celular e no modo Detalhes, em zigue-zague). Balões mostram a tarefa recebida e as mensagens do board por alguns segundos; um letreiro lista os 5 últimos acontecimentos. No topo, um único alerta por vez: permissão pendente (com Permitir uma vez / Sempre / Recusar), depois ASK/HOLD/VETO sem resposta, depois erro. Clicar num agente abre o painel lateral com o que ele recebeu, o que está fazendo, o board dele e a conversa. No rodapé, a última fala do líder e o campo para falar com a squad.
- **Escritório**: a mesma squad em pixel art (canvas, sprites desenhados em código em `web/src/office/`). Cada agente tem uma baia na sua cor; delegar vira o líder caminhando até a baia com a tarefa num balão, mensagens do board viram visitas (ou uma ida ao quadro, para ALL) e post-its no quadro, VETO em coral. Quem espera você mostra "!" âmbar e quem está em "tentando de novo" vai para a máquina de café. Cada personagem tem uma fila: em rajadas de eventos ele para de caminhar e só fala, para não ficar atrás do que acontece. Alerta do topo, letreiro, painel do agente e barra do líder são os mesmos do Palco.
- **Detalhes**: as três colunas (conversa, squad, board do Swarm), com o card flutuante de permissão.

A gaveta de diff funciona nos dois modos.

- **Replay** (Palco e Escritório): botão no topo reproduz o log de eventos da tarefa (`GET /tasks/:id/replay`) no mesmo reducer do modo ao vivo, com play/pause, linha do tempo com marcos, velocidade 1×–30× e "Pular esperas". Só leitura.
- **Escritório:** clique num post-it do quadro abre o post (markdown), respostas, navegação entre posts e o que o autor fez desde o post anterior dele (mensagens, thinking, ferramentas). Na parede: relógio (hora original no replay), placar da squad, rack que pisca quando alguém trabalha, janelas que seguem a hora do dia; lâmpada de status em cada baia.

```bash
cd web && npm install
ORCH_URL=http://127.0.0.1:8080 npm run dev     # http://localhost:5173, /api é proxiado para o orquestrador
```

A UI pede o `API_TOKEN` na primeira abertura (fica no localStorage). Para uma demo sem Docker nem LLM, suba o mock com `MOCK_SPEED=1 npm run mock:kilo` e o orquestrador com `SANDBOX_DRIVER=external`.

## API

| Método | Rota | O que faz |
|---|---|---|
| GET | `/harnesses` | harnesses habilitados (`HARNESSES`), o padrão e as capacidades de cada um |
| POST | `/tasks` | `{ repoUrl, branch?, prompt, harness?, agent?, model? }` → 202 e provisiona em background |
| GET | `/tasks`, `/tasks/:id` | lista / detalhe (status, membros da squad, permissões pendentes) |
| GET | `/tasks/:id/events` | SSE de eventos da UI; reconexão com `Last-Event-ID` ou `?after=` faz replay |
| GET | `/tasks/:id/replay` | `{ task, events }` com o log completo (do arquivo, se `DATA_DIR`), para o replay da UI |
| POST | `/tasks/:id/prompt` | `{ text, agent? }` follow-up na mesma sessão (inclui `/goal pause`) |
| POST | `/tasks/:id/permissions/:permissionID` | `{ reply: once\|always\|reject, message? }` |
| GET | `/tasks/:id/board` | snapshot do board do Swarm (`?before=&limit=`) |
| POST | `/tasks/:id/board/reset` | `{ revision }` |
| GET | `/tasks/:id/diff` | diff da sessão |
| POST | `/tasks/:id/abort` | interrompe o turno |
| DELETE | `/tasks/:id` | destrói a sandbox |

Auth: `Authorization: Bearer $API_TOKEN` (ou `?token=` para `EventSource`). O browser nunca vê a URL nem a senha do `kilo serve`.

### Eventos para a UI (`kind`)

| kind | Origem no Kilo | Uso na UI |
|---|---|---|
| `task.status` | orquestrador | queued → provisioning → starting → running ⇄ waiting_permission → idle / error / stopped |
| `message`, `message.delta` | `message.updated`, `message.part.updated` (texto), `message.part.delta` | chat da tarefa |
| `squad.member` | tool `task` (`state.metadata.sessionId` = sessão filha) | grafo da squad (nasce/termina membro) |
| `board.activity`, `board.snapshot` | tools `board_post`/`board_read` + `GET .../board` | board do Swarm |
| `permission.asked`, `permission.replied` | `permission.*` | modal de aprovação |
| `tool` | demais tool calls | timeline |
| `session.status`, `session.diff`, `error` | `session.*` | indicadores, painel de diff |
| `raw` | todo o resto | debug |

## O que foi validado

- Rotas e formatos conferidos no código do `Kilo-Org/kilocode` (commit `c267794`, 26/09/2026).
- Contra `@kilocode/cli` 7.8.1 real: `/global/health` (401 sem auth), `GET /event` com `server.connected`, `POST /session` com `agent`, board retornando `200` vazio antes do primeiro post, `/permission`, `/session/:id/diff`, e os 5 agentes da squad carregados via `KILO_CONFIG_DIR`. O fluxo completo do orquestrador rodou até a chamada ao LLM (parou por falta de credencial de provedor, como esperado).
- Fluxo com o mock: squad.member, board.activity, permissão aprovada pela API e retomada, idle.
- **Não validado ainda:** o build da imagem Docker (o ambiente onde isto foi escrito bloqueia os mirrors do Debian) e um turno real com LLM.
- **Harnesses (27/09):** tipos da ponte conferidos contra `@anthropic-ai/claude-agent-sdk` 0.3.283 e `@openai/codex-sdk` 0.157.1. Smoke pelo orquestrador com as pontes em `BRIDGE_FAKE=1`: Claude Code com squad (4 delegações, developer ×2), board com autoria certa por subagente, VETO, permissão de `npm install` aprovada pela API, diff do git e idle; Codex com passos, diff, follow-up e abort. **Não validado:** turno real com LLM em cada ponte e a imagem com a ponte instalada.

## Decisões e gaps do POC

- **Board em tempo real:** híbrido. Cada `board_post`/`board_read` concluído no stream dispara refresh do snapshot (throttle 400ms), mais polling de 15s enquanto a tarefa está `running`.
- **Permissões:** usa `POST /permission/:id/reply` com `interactive: true` (a rota antiga `/session/:id/permissions/:id` também existe). O `kilo.jsonc` da squad deixa só `bash` genérico, `webfetch` e `git push` em `ask`.
- **Isolamento (decidido em 26/09):** só o container, com o perfil padrão do Docker (`SANDBOX_NATIVE_ISOLATION=false`, que desliga o bubblewrap do Kilo via `KILO_CONFIG_CONTENT`). O bwrap dentro do Docker exige `seccomp`, `apparmor` e `systempaths=unconfined` (falha com "Can't mount proc on /newroot/proc"); `SANDBOX_NATIVE_ISOLATION=true` volta a esse modo. Consequência: o agente tem rede dentro do container; restrinja com `SANDBOX_NETWORK`. Para produção, avaliar gVisor ou microVM.
- **Senha por tarefa** vai como env do container (visível em `docker inspect`); em produção use secret do orquestrador de containers.
- **Store em memória com persistência em arquivo** (`DATA_DIR`, padrão `.data`): `tasks/<id>/task.json` (sem o handle da sandbox) e `tasks/<id>/events.jsonl` com todos os eventos. No boot as tarefas voltam como `stopped` e o replay lê o log completo do arquivo. Trocar por Postgres mantendo a interface do `TaskStore`.
- **Squad fora do repo:** `sandbox/squad/{kilo.jsonc,agents/*.md}` via `KILO_CONFIG_DIR`; `.kilo/agents/*.md` do próprio repo continua valendo. O Kilo também já traz um agente primário `orchestrator` embutido, alternativa ao `squad-lead`.
- **Fora do escopo por enquanto:** abrir PR ao final, multiusuário real.
