#!/usr/bin/env bash
# Record the real agent sessions behind demo.html on the public sample wiki (see demo-wiki.sh).
#   ./agent-demo.sh [ko|en] [server]   -> out/agent-run-<lang>/{laptop-1,laptop-2,server}.jsonl plus the wiki under .../wiki
#   ("server" re-runs only the server half against the existing run directory)
# The prompts are in the video's language and the agents answer in it.
# laptop: Claude Code (claude -p, stream-json), two turns, with only the sample wiki's MCP server (--strict-mcp-config).
# server: Antigravity CLI (agy -p, stream-json) after a sync, with the sample server registered by
#         `doltap integrations install antigravity` for the duration of the run and removed afterwards.
# Nothing here touches a real wiki; DOLTAP_STATE_HOME points into the run directory.
set -euo pipefail
cd "$(dirname "$0")"
L=${1:-ko}; ONLY=${2:-}; R=$(mkdir -p "out/agent-run-$L" && cd "out/agent-run-$L" && pwd)
W="$R/wiki"; REPO=$(cd ../.. && pwd)
if [ "$L" = en ]; then
  Q1='Our first release just failed in the Publish job: npm publish returned 403 "OIDC permission denied". What is wrong?'
  Q2='Found it: on npmjs.com I ticked "Allow npm publish" on the package'\''s trusted publisher and re-ran the job. It is published now.'
  Q3='Release of acme-cli failed: npm publish in the Publish workflow gets 403 "OIDC permission denied". How do I fix it?'
else
  Q1='첫 릴리스가 Publish 잡에서 실패했어. npm publish가 403 "OIDC permission denied"를 냈는데, 뭐가 문제야?'
  Q2='찾았어. npmjs.com에서 패키지의 trusted publisher 설정에 "Allow npm publish"를 체크하고 잡을 다시 돌리니 배포됐어.'
  Q3='acme-cli 릴리스가 실패해. Publish 워크플로에서 npm publish가 403 "OIDC permission denied"를 내. 어떻게 고쳐?'
fi
MCP=(node "$REPO/packages/mcp/dist/main.js"); CLI=(node "$REPO/packages/cli/dist/main.js")

if [ "$ONLY" != server ]; then
rm -rf "${R:?}"/*
SEED_ONLY=1 ./demo-wiki.sh "$W"
# A small project for each agent to sit in.
for p in laptop server; do
  mkdir -p "$R/$p-proj/.github/workflows"
  printf '{\n  "name": "acme-cli",\n  "version": "1.0.0",\n  "bin": { "acme": "bin/acme.js" }\n}\n' > "$R/$p-proj/package.json"
  printf 'name: Publish\non:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\n  contents: read\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with: { node-version: 24, registry-url: "https://registry.npmjs.org" }\n      - run: npm ci && npm test\n      - run: npm publish --provenance --access public\n' > "$R/$p-proj/.github/workflows/publish.yml"
  git -C "$R/$p-proj" init -q && git -C "$R/$p-proj" add -A && git -C "$R/$p-proj" -c user.name=demo -c user.email=demo@example.com commit -qm init
done

# laptop: Claude Code
jq -n --arg cmd "${MCP[0]}" --arg arg "${MCP[1]}" --arg root "$W/laptop" --arg st "$W/state-laptop" \
  '{mcpServers:{doltap:{command:$cmd,args:[$arg],env:{DOLTAP_ROOT:$root,DOLTAP_AGENT:"claude-code",DOLTAP_STATE_HOME:$st}}}}' > "$R/claude-mcp.json"
C=(claude -p --output-format stream-json --verbose --strict-mcp-config --mcp-config "$R/claude-mcp.json" --allowedTools "mcp__doltap,Read,Glob,Grep" --settings "{\"language\":\"$([ "$L" = en ] && echo english || echo korean)\"}")
(cd "$R/laptop-proj" && printf '%s' "$Q1" | "${C[@]}" > "$R/laptop-1.jsonl")
SID=$(jq -r 'select(.type=="system" and .subtype=="init") | .session_id' "$R/laptop-1.jsonl" | head -1)
(cd "$R/laptop-proj" && printf '%s' "$Q2" | "${C[@]}" --resume "$SID" > "$R/laptop-2.jsonl")
sleep 2

fi

# server: Antigravity CLI, after the scheduled sync would have pulled the laptop's commit
DOLTAP_STATE_HOME="$W/state-server" "${CLI[@]}" --root "$W/server" sync > "$R/server-sync.txt"
CFG="$HOME/.gemini/config/mcp_config.json"; GMD="$HOME/.gemini/GEMINI.md"
cp "$CFG" "$R/mcp_config.before.json" 2>/dev/null || true; HAD_GMD=$([ -e "$GMD" ] && echo 1 || echo 0)
restore() { if [ -e "$R/mcp_config.before.json" ]; then cp "$R/mcp_config.before.json" "$CFG"; else rm -f "$CFG"; fi; [ "$HAD_GMD" = 0 ] && rm -f "$GMD"; true; }
trap restore EXIT
"${CLI[@]}" --root "$W/server" integrations install antigravity > "$R/server-install.txt"
jq --arg st "$W/state-server" '.mcpServers.doltap.env += {DOLTAP_STATE_HOME:$st}' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
(cd "$R/server-proj" && agy -p "$Q3" --output-format stream-json --model gemini-3.8-flash-high --sandbox --dangerously-skip-permissions --print-timeout 600s > "$R/server.jsonl")
echo "recorded in $R"
