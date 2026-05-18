# Long-Running Tasks — Index (000)

> **Status (2026-05-18)**: 410 タスクの仕様作成を 5 バッチで超長期セッション実行した結果のインデックス。9 件は本文 commit 済 (`✅`)、~401 件は worktree prune による本文消失 (`🗃️`)、本 PR 内で実コードに反映された Security 修正群 (`🚧`)。`.claude/worktrees/` を `.gitignore` に入れた組み合わせと session 終了時の prune で worktree が消える設計上の落とし穴については `docs/SESSION-HANDOFF.md` を参照。

## Status legend
- ✅ **spec in PR** — 本文 commit 済 (本 PR 配下の `NNN-*.md`)
- 🚧 **implementation done** — この PR で実コード変更として反映済 (Security findings)
- 🗃️ **spec lost, name only** — 会話履歴に名称のみ残存
- 🗃️ **spec lost, summary** — 会話履歴に主要発見の要約あり、本表に 1-2 行で記録

---

## Security findings (実コードに反映済 — 本 PR 内)

| ID | Severity | Title | File:Line | Status | Fix Commit |
|----|----------|-------|-----------|--------|-----------|
| C-01 | Critical | tmux/zellij send-keys shell interpretation | `src/core/zellij.ts:55-62, 66-70` | 🚧 | `fix(zellij): C-01 use load-buffer/paste-buffer` |
| C-02 | Critical | spawnLoopDaemon bash heredoc shell injection | `src/commands/auto.ts:214-262` | 🚧 | `feat(loop-daemon): C-02 replace bash heredoc with node detached worker` |
| C-03 | Critical | env scrub missing (process.env implicit merge) | `src/integrations/autoclaw.ts:69`, `src/commands/reflect.ts:159`, `src/commands/auto.ts:156` | 🚧 | `feat(env): C-03 add scrubEnv() and apply to 3 spawn sites` |
| H-01 | High | validateSessionName 不在 | new `src/core/session-name.ts` + 3 call sites | 🚧 | `feat(security): H-01 add validateSessionName` |
| H-02 | High | env scrub 残箇所 | (C-03 で同時対応) | 🚧 | (C-03 commit) |
| H-03 | High | n8n authToken undefined で auth bypass | `src/integrations/n8n.ts:42-47, 198` | 🚧 | `fix(n8n): H-03 require authToken` |
| H-04 | High | `--dangerously-skip-permissions` ハードコード | `src/commands/auto.ts:100, 147, 224` | 🚧 | `feat(auto): H-04 make --unsafe-skip-permissions opt-in` |
| H-05 | High | Hardcoded "Rikuto" fallback | `src/core/cost.ts:31` | 🚧 | `fix(cost): H-05 remove Rikuto fallback` |
| H-06 | High | obsidian rejectUnauthorized: false | `src/integrations/obsidian.ts:52` | 🚧 | `fix(obsidian): H-06 default rejectUnauthorized:true` |

---

## カテゴリ別タスク台帳

### A foundation (#001-010) — 🗃️ summary lost
基盤設計: モデル選択、subcommand 体系、worktree base 解決、env init wizard。**名称のみ**。

### B observability (#011-020) — 🗃️ name only
OpenTelemetry、cost.ts、dashboard 出力。10 個中 K116 OTel env と P161-170 が後続バッチで再現。

### C testing (#021-030) — 🗃️ partially derived
- #021 send-keys safety design → C-01 fix へ反映
- #022 ✅ **C-02 bash RCE fix proposal** (in PR)
- #023 validateSessionName design → H-01 fix へ反映
- #024 env scrub design → C-03 fix へ反映
- #025-030 残: PR 反映無し

### D-J (#031-110) — 🗃️ name only, conversational fragments
2nd バッチ前半。foundation 強化、test infrastructure、安全装置、CI integration、metrics 等。

---

### K 実装重視仕様 (#111-120) — 🗃️ summary in conversation
| # | Title | Key Finding |
|---|-------|-------------|
| 111 | validateSessionName impl | C-01 H-01 と統合、本 PR 内 |
| 112 | send-keys -l 設計 | tmux 3-stage `load-buffer → paste-buffer -d -p → send-keys -l`、Zellij は sanitize + `--` 区切り。argv 経由ではなく stdin 経由が安全 |
| 113 | env scrub | `execa({ extendEnv: false })` を忘れると process.env が暗黙再 merge される。本 PR 反映 |
| 114 | n8n harden | shallow spread の loadConfig は新規 default を deep-merge しないと破壊する |
| 115 | loopguard MVP | SHA-256 / 16 hex / 256 ring、窓 {3,5,8} で 3 回繰返し検知。`bash -c` 不使用 |
| 116 | OTel env injection | distrubuted trace 用 env propagation 設計 |
| 117 | cost MCP | stdout に絶対書かない (JSON-RPC framing 破壊)、Schema.shape を直渡し |
| 118 | sessions MCP | spec 74 daemon/sqlite から意図的逸脱、既存 session.ts pure functions を直接使用 (in-process) |
| 119 | vitest setup | 本 PR の baseline = 10 file existed in master + 8 new in this PR |
| 120 | tests.yml impl | `.github/workflows/ci.yml` 拡張 |

### L ユーザ向けドキュメント (#121-130) — 🗃️ name only
Quickstart / Cookbook / tmux migration / Troubleshooting / Production deploy / Multi-account auth / Hooks advanced / Cost optimization / Security best practices / Performance tuning。

### M エディタ/OS 統合 (#131-140) — 🗃️ name only
Neovim / VSCode / JetBrains / Emacs / macOS menu / Linux systray / WSL2 / SSH remote pane / Web dashboard / Mobile companion。M137 で `src/core/cost.ts` の "Rikuto" hardcode を発見、本 PR で H-05 として修正。

### N 高度テストシナリオ (#141-150) — 🗃️ summary in conversation
| # | Title | Key Finding |
|---|-------|-------------|
| 141 | Crash recovery | `~/.ccmux/sessions/<id>/journal.ndjson` append-only、at-least-once replay + idempotent side effects |
| 142 | Network partition | `cost.ts` に execa timeout 無し (gap として明記)、`obsidian.ts:64` には 5s timeout あり |
| 143 | Disk full | ENOSPC handling |
| 144 | 100-pane stress | watcher/inotify limits |
| 145 | Concurrent users | lock contention |
| 146 | Stale worktree cleanup | PID リサイクル対策に `/proc/<pid>/stat` の start_time も比較 |
| 147 | tmux restart | session restore |
| 148 | Claude update mid-session | binary swap survivability |
| 149 | FS corruption | journal verify |
| 150 | Memory pressure | RSS budget |

### O AI 協調パターン (#151-160) — 🗃️ name only
Planner-Coder-Reviewer / A/B model test / Cross-pane handoff / 3-agent voting / Master-worker / Hierarchical task tree / Race to first success / MoE routing / Proposer-critic / Polyglot。

### P 分析ツール (#161-170) — 🗃️ name only
analytics / Cost forecaster / Productivity dashboard / Anomaly detector / Token breakdown / Tool call frequency / Lifetime analytics / Cross-agent comparison / Trend analysis / BI export。

### Q ワークフロー研究 (#171-180) — 9 件中 2 件 ✅
| # | Title | Status |
|---|-------|--------|
| 171 | Aider workflow | 🗃️ summary: turn = commit / architect-editor 2-call / coding-tool 哲学差 |
| 172 | Cursor team workflows | ✅ spec in PR (`172-cursor-team-workflows.md`) |
| 173 | Devin patterns | 🗃️ |
| 174 | CC subagents in prod | 🗃️ |
| 175 | Goose extensions | 🗃️ summary: MCP first-class、`ServerHandler` 統一、recipe YAML 1-file |
| 176 | Copilot Workspace | 🗃️ |
| 177 | OpenCode selection | 🗃️ |
| 178 | Lovable patterns | 🗃️ |
| 179 | Replit Agent 3 | 🗃️ |
| 180 | Industry survey | ✅ spec in PR (`180-industry-survey-...md`) |

### R エンタープライズ/コンプラ (#181-190) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 181 | SOC2 readiness | n8n.ts:27-66 の auth-less HTTP が **top blocker**、`bash -c` template (auto.ts:93) + 未検証 session name で shell injection chain |
| 182 | GDPR compliance | data subject rights |
| 183 | Audit log | BLAKE3 hash chain + ed25519 sig、fsync + flock crash-safe |
| 184 | Multi-user isolation | per-user namespaces |
| 185 | RBAC | role design |
| 186 | Secrets at scale | rotation strategy |
| 187 | On-premise deploy | air-gap-friendly |
| 188 | Air-gapped deploy | offline operation |
| 189 | Compliance dashboards | SOC2/HIPAA reports |
| 190 | Data residency | EU/JP boundaries |

### S 開発者体験 (#191-200) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 191 | init wizard | `~/.ccmux/` → XDG `~/.config/ccmux/` 移行提案 (legacy fallback 維持) |
| 192 | doctor command | OK/FAIL に加え 3s timeout を yellow 扱い (red にしない) |
| 193 | profile command | |
| 194 | auto-update | self-update mechanism |
| 195 | Shell completion | bash/zsh/fish |
| 196 | Interactive tutorial | |
| 197 | Better errors | actionable error messages |
| 198 | Performance HUD | live dashboard |
| 199 | Color themes | a11y |
| 200 | Accessibility | screen reader |

### T 実験/将来 (#201-210) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 201 | WASM plugin runtime | plugin.toml + plugin.wasm、capability model、WIT host API、OCI dist |
| 202 | Quantum-safe signing | ML-DSA-65 (FIPS 204) + Ed25519 hybrid |
| 203 | ML loop prediction | logistic regression on hidden state proxies、sub-ms inference |
| 204 | Federated learning | 3 model families × 4-layer privacy (DP/SecAgg/OHTTP) |
| 205 | Voice control | PEG コマンド文法、Whisper/Piper local、wake word、声紋 + verbal 二段 confirm |
| 206 | AR/VR visualization | gaze-driven focus 220/450ms dwell、pinch approval |
| 207 | Distributed mesh | mDNS + central registry、QUIC + mTLS + gRPC、Lamport clock |
| 208 | P2P collaboration | xterm.js + CLI guest、drive/watch + co-drive、JWT + invite |
| 209 | Self-healing agent | detect → corrective context injection → restart (素朴 retry との違い) |
| 210 | Long-term knowledge | SQLite + sqlite-vec、Graphiti bi-temporal、3 ingestion paths |

### U 追加実装 (#211-220) — 🗃️ name only
Obsidian writer / n8n HTTP / serve daemon / swap command / worktree prune / init wizard / doctor / sessions MCP / bash completion / zsh completion / fish completion。

### V LLM provider adapter (#221-230) — 9 lost + 1 ✅
| # | Title | Status |
|---|-------|--------|
| 221 | OpenAI Codex adapter | 🗃️ |
| 222 | Gemini CLI adapter | 🗃️ |
| 223 | Mistral adapter | 🗃️ |
| 224 | Cohere adapter | 🗃️ |
| 225 | DeepSeek adapter | 🗃️ |
| 226 | Qwen Coder adapter | 🗃️ |
| 227 | xAI Grok adapter | 🗃️ |
| 228 | Ollama adapter | 🗃️ |
| 229 | vLLM adapter | 🗃️ |
| 230 | Aider compat shim | ✅ spec in PR (`230-aider-compat-shim.md`) |

### W 言語別クライアント (#231-240) — 🗃️ name only
Python / Go / Rust / Ruby / Java/Kotlin / C# / PHP / Lua / Shell / JSON-RPC spec。

### X プロジェクトテンプレ (#241-250) — 9 lost + 1 ✅
| # | Title | Status |
|---|-------|--------|
| 241 | TS monorepo | 🗃️ |
| 242 | Python DS | 🗃️ |
| 243 | Next.js | 🗃️ |
| 244 | Rust crate | ✅ spec in PR (`244-rust-crate-template.md`) |
| 245 | Go module | 🗃️ |
| 246 | Terraform | 🗃️ summary: operator-gate を first-class pause step、-target で blast-radius 制御 |
| 247 | Kubernetes | 🗃️ |
| 248 | DB migration | 🗃️ summary: Prisma/Drizzle/Knex 別の `CREATE INDEX CONCURRENTLY`、NOT NULL は NOT VALID → VALIDATE CONSTRAINT 2 段 |
| 249 | API gen | 🗃️ |
| 250 | Mobile RN | 🗃️ |

### Y 開発ツール統合 (#251-260) — 🗃️ summary
pre-commit / semantic-release / conventional commits / changesets / nx / turbo / pnpm / bazel / GitHub Issues / Linear。Y253 で `commitlint.config.cjs` を `"type":"module"` と共存させる選択。

### Z UI/UX 詳細 (#261-270) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 261 | Color blindness | |
| 262 | Keyboard-only nav | Ctrl+C/V/X 絶対禁止、CC interrupt は Esc 採用 |
| 263 | Vim modal | |
| 264 | Emacs | |
| 265 | Fuzzy finder | |
| 266 | Command palette | subsequence fuzzy 自前実装、recency 0.7 / freq 0.3 ブレンド |
| 267 | Statusbar API | |
| 268 | Help system | |
| 269 | Onboarding tour | |
| 270 | Empty state | |

### AA コミュニティ/教育 (#271-280) — 1 ✅ + 9 🗃️
| # | Title | Status |
|---|-------|--------|
| 271 | Docs site IA | 🗃️ Diataxis 5 セクション、LRT specs を canonical、site pages は derived |
| 272 | Blog post series | 🗃️ |
| 273 | Conference talk outline | ✅ spec in PR (`273-conference-talk-outline.md`) |
| 274 | Workshop curriculum | 🗃️ |
| 275 | YouTube scripts | 🗃️ |
| 276 | Twitter threads | 🗃️ |
| 277 | HN/Reddit launch | 🗃️ |
| 278 | Discord guide | 🗃️ |
| 279 | Contributor onboarding | 🗃️ |
| 280 | Growth plan | 🗃️ |

### BB アンチパターン集 (#281-290) — 🗃️ summary
| # | Don't ... | |
|---|-----------|---|
| 281 | share state across panes | |
| 282 | use pane count for sizing | |
| 283 | trust self-reports | |
| 284 | skip git verify (`--no-verify` 安易使用) | AI が SHA を捏造する心理 = context pressure 下の narrative completion、`git cat-file -e` + `merge-base --is-ancestor` で検出 |
| 285 | disable loopguard | Task 285 = $4.2K / $47K 事例 |
| 286 | expose serve | n8n.ts は POST `/session/new` で full host RCE primitive を露出。`ssh -L` local forward + PermitOpen 制限が正解 |
| 287 | shell=true | |
| 288 | secrets in CLAUDE.md | |
| 289 | loop on 429 | |
| 290 | trust "all tasks done" without handoff verify | hallucinated progress failure class、spec 10 verify_handoff algorithm 必須 |

### CC 他ツールからの移行 (#291-300) — 2 ✅ + 8 🗃️
| # | From | Status |
|---|------|--------|
| 291 | Aider | ✅ spec in PR (`291-from-aider.md`) |
| 292 | Cursor | ✅ spec in PR (`292-from-cursor.md`) |
| 293 | Devin | 🗃️ |
| 294 | Goose | 🗃️ |
| 295 | bare tmux | 🗃️ summary: tmux first-class なのでゼロ変更、`.tmux.conf` + tpm が carry over |
| 296 | shell scripts | 🗃️ |
| 297 | CrewAI | 🗃️ |
| 298 | LangGraph | 🗃️ |
| 299 | AutoGen | 🗃️ |
| 300 | make/npm scripts | 🗃️ |

### DD パフォーマンス深堀 (#301-310) — 🗃️ summary in conversation
| # | Title | Key Finding |
|---|-------|-------------|
| 301 | Cold start analysis | ccmux share 700-1500ms、`zellij.ts:68` ハードコード 300ms setTimeout、`src/index.ts` eager ESM ロード、esbuild bundle で 200-500ms へ圧縮可能 |
| 302 | Hot path | `ccmux list` が sessions.json を 3 回パース (N+1)、`getCost` の無意味 await |
| 303 | Memory footprint | --max-old-space-size=96 --max-semi-space-size=4、lazy `await import()`、readBody 64KB cap |
| 304 | Disk I/O | SessionsWriter coalescing (50ms debounce / 250ms ceiling)、3 段 durability tier、ENOSPC リカバリ |
| 305 | Network batching | ccusage 120/min → 1/min (single-flight + 60s TTL)、n8n webhook 10 → 1 (250ms debounce)、MCP handshake 60/min → 0 |
| 306 | tmux protocol opt | |
| 307 | File watcher tuning | per-pane inotify ~250 pane 安全、`max_user_watches=524288`、ENOSPC で polling mode |
| 308 | SQLite tuning | WAL + synchronous=NORMAL + busy_timeout=5000、auto_vacuum=INCREMENTAL |
| 309 | Cache eviction | |
| 310 | IO scheduler | git=4 / execa=8 / fetch=10 per-resource p-limit、eslint カスタムルールで直接呼び禁止 |

### EE AI 安全性 (#311-320) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 311 | Prompt injection | A1-A12 系列 |
| 312 | Multi-pane containment | 6 つの暗黙 shared channels (files/env/clipboard/status/MCP/sockets)、PaneCapabilitySet 署名管理 |
| 313 | Constitutional AI | |
| 314 | Bias auditing | |
| 315 | PII redaction | |
| 316 | Safety evals | |
| 317 | Mode collapse | |
| 318 | Adversarial robustness | MCP description hijack も A8 として、DirectBooker prompt injection 事例自体を A8/A9 regression case |
| 319 | Sandbox escape detect | |
| 320 | Output validation | |

### FF 国際化 (#321-330) — 🗃️ name only
Japanese / Chinese / Korean / Spanish / French / German / RTL / Time zone / Currency / Date/number format。

### GG 高度な Git (#331-340) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 331 | Submodules | |
| 332 | Sparse checkout | |
| 333 | Partial clone | |
| 334 | LFS handling | |
| 335 | Conflict resolution | |
| 336 | Bisect-driven AI debug | `ccmux bisect` 新コマンド、bisect → root cause analyze 2 段 |
| 337 | Cherry-pick across | |
| 338 | Rebase orchestration | `GIT_SEQUENCE_EDITOR` shim、protected branch / backup ref |
| 339 | Fork/upstream sync | |
| 340 | Monorepo split | `git filter-repo` は worktree 共有 object DB で隣接 mission 破壊、`git clone --no-local` で別 object DB に強制隔離 |

### HH 業種特化 (#341-350) — 1 ✅ + 9 🗃️
| # | Title | Status |
|---|-------|--------|
| 341 | Healthcare HIPAA | 🗃️ |
| 342 | Finance/quant | ✅ spec in PR (`342-vertical-finance.md`) — `data/ticks/**` への sandbox 拒否を enforceable に |
| 343 | Gaming dev | 🗃️ |
| 344 | Embedded systems | 🗃️ |
| 345 | Scientific/HPC | SplitMix64 seed + container digest + dataset SHA256 で 3 軸再現性 |
| 346 | ML/AI engineering | 🗃️ |
| 347 | Mobile app dev | 🗃️ |
| 348 | IoT firmware | 🗃️ |
| 349 | Blockchain/smart contracts | 6 つの security check (reentrancy/storage layout/access/oracle/Anchor/Move) を broadcast 解放前ゲート |
| 350 | AR/VR dev | 🗃️ |

### II ペルソナ別 (#351-360) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 351 | Senior engineer | エージェントを疑う 5 トリガ、Fork-and-A/B モデル選定 5 規律、loopguard tune-but-not-disable、カスタム skill 5 ポイント |
| 352 | Junior engineer | |
| 353 | Tech lead | |
| 354 | EM path | per-engineer ランキング禁止 (観測性を監視に転化させない) |
| 355 | DevOps | |
| 356 | SRE | |
| 357 | Security engineer | |
| 358 | Data scientist | |
| 359 | ML engineer | |
| 360 | Designer-engineer | |

### JJ ユースケース (#361-370) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 361 | Hackathon mode | |
| 362 | Interview prep | `/hint clarify\|nudge\|shape\|code` 4 段 throttling、UserPromptSubmit hook |
| 363 | OSS maintenance | |
| 364 | Bug bounty | T-30/T-14/T-7/T-72h/T-0 責任ある開示タイマー |
| 365 | CTF challenges | |
| 366 | Live demo mode | |
| 367 | Pair programming | |
| 368 | Tutorial creation | |
| 369 | Code review marathon | |
| 370 | Sprint planning | |

### KK DB 統合 (#371-380) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 371 | Postgres | |
| 372 | MySQL | |
| 373 | MongoDB | |
| 374 | Redis | |
| 375 | DynamoDB | |
| 376 | Elasticsearch | |
| 377 | ClickHouse | |
| 378 | DuckDB | 90 日 SQLite → DuckDB アーカイブ 2 段、parquet ロールアップ |
| 379 | Snowflake | |
| 380 | BigQuery | mandatory dry-run cost preview、bytes → USD、cached-result も考慮 |

### LL クラウド (#381-390) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 381 | AWS | aws-vault + per-pane AssumeRole sidecar tracking |
| 382 | GCP | per-pane `CLOUDSDK_ACTIVE_CONFIG_NAME` + `CLOUDSDK_CONFIG` |
| 383 | Azure | process-wide `az login` 問題に `AZURE_CONFIG_DIR` 隔離、federated credentials |
| 384 | Cloudflare | |
| 385 | Fly.io | |
| 386 | Vercel | |
| 387 | Netlify | |
| 388 | DigitalOcean | |
| 389 | Hetzner | ARM cax21 月 $4 級、IPv6-only でさらに半額 |
| 390 | Bare metal | |

### MM コンテナオーケ (#391-400) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 391 | Docker Compose | `COMPOSE_PROJECT_NAME=ccmux_${CCMUX_SESSION}` でペイン間衝突回避 |
| 392 | Kubernetes | per-session port range allocator |
| 393 | Helm chart | |
| 394 | ArgoCD GitOps | sync wave で mission ID annotation |
| 395 | Flux GitOps | Notification Provider → ccmuxd `/handoff` endpoint |
| 396 | Cloud Run | |
| 397 | Lambda | |
| 398 | Fargate | |
| 399 | Nomad | |
| 400 | Bottlerocket vs Talos | 両方 immutable RO root、A/B atomic upgrades。Bottlerocket = dm-verity/SELinux/Brupop、Talos = API-only/machine config |

### NN AI/ML パイプライン (#401-410) — 🗃️ summary
| # | Title | Key Finding |
|---|-------|-------------|
| 401 | Hugging Face | |
| 402 | W&B | per-pane wandb init wrapper、mission-as-sweep、artifact、idempotent Report |
| 403 | MLflow | per-mission experiment 1:1 マッピング、CI-gated model promotion |
| 404 | Modal | `modal {deploy\|run\|sandbox}`、pane-aware、GPU sizing decision table |
| 405 | Replicate | `cog push` as long-running、3 surfaces (HTTP/Python/JS)、Svix webhook 検証、既存 n8n webhook server に `/replicate` route |
| 406 | Together | OpenAI 互換、4 段優先度 (env → per-pane key file → per-pane config → global) |
| 407 | OpenRouter | single-key、fallback chain、3-knob tradeoff (tier override / budget / latency)、ledger telemetry |
| 408 | Helicone | baseURL swap table、必須ヘッダ、Helicone Export API、2 層 rate limit、cache (seed/TTL/streaming) |
| 409 | LiteLLM | self-hosted、Vault/AWS-SM/GCP-SM 鍵管理、latency-based routing + cooldowns、Prometheus + OTEL + Langfuse + Alertmanager |
| 410 | LangFlow | nodes/edges JSON → ccmux mission import、`src/integrations/langflow.ts`、DAG walk runtime、{{name.output}} テンプレ置換、片方向 ingest only |

---

## 主要発見 cross-cutting

会話履歴で検出された普遍的な教訓:

1. **Hallucinated progress** (BB290 / spec 10): handoff verification なしで終了条件を信じると、agent が "全 task done" を捏造する failure class が起きる
2. **`bash -c` template literal は本質的に危険** (C-02 / shell-quote module advisory): argv-array spawn が唯一の安全策、`shell-escape` ライブラリも argument injection 経路あり
3. **暗黙の env merge は secret 漏洩経路** (C-03 / H-02): `extendEnv: false` + allowlist 明示が業界 standard
4. **3 agent sweet spot** (Q180 industry survey): ccmux は 3-5 agent local orchestrator として positioning、Anthropic managed-settings / Jules / Antigravity cloud fleet とは別レーン
5. **コールド share 圧縮** (DD301): ccmux 起動 700-1500ms → 200-500ms へ 3 つの knob (zellij.ts:68 setTimeout 削除 / lazy import / esbuild bundle)
6. **Provider-Consumer pattern** (Phase 7G/9/10/53/56G memory より): 並行 session が helper drop → 後続が wire-in する cooperate pattern が 4 instance で reusable に
7. **`.gitignore` への `.claude/worktrees/` 追加は worktree prune と組み合わさると本文消失リスク** (本セッション本体の教訓、SESSION-HANDOFF.md 参照)

---

## このインデックスの使い方

- 完成 spec を見たい → 表の `✅` 列をたどり、`docs/long-running-tasks/NNN-*.md` を開く
- セキュリティ修正の根拠 → 上の "Security findings" 表 → 各 commit 経由
- カテゴリ全体のテーマ → 該当カテゴリ section の見出しを参照
- 失われた spec の発見だけ知りたい → 各カテゴリ表の "Key Finding" 列
