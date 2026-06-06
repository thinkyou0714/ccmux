# ccmux 実装前 TODO 統合ロードマップ

> 2026-05-19 時点。初回監査 + 第4-6回 exa深堀調査（10テーマ×3回×10クエリ = 300件）の統合結果。
> 着手前に **0章 (準備フェーズ)** を必ず終わらせること。

---

## 0. 着手前の準備（実装より先）

| # | やること | 理由 |
|---|---|---|
| 0.1 | `git switch -c chore/audit-cleanup-base` でベースブランチ作成 | P0群を独立 PR にするための土台 |
| 0.2 | `npm install` → `npm run build` → `npm test` → `npm run lint` がクリーンか確認 | 既存壊れの有無を確定 |
| 0.3 | `hyperfine 'node dist/index.js --help'` と `node --cpu-prof dist/index.js list` で startup ベースライン記録 | 性能改善の効果測定用 |
| 0.4 | 既存 `~/.ccmux/config.json` と `sessions.json` を **手動バックアップ** (`cp -r ~/.ccmux ~/.ccmux.bak.2026-05-19`) | 破壊的修正に備える |
| 0.5 | 第4-6回の audit 受け入れ判断（オーナーが） | 全部やる/やらないをここで決め、以降は粛々と実装 |
| 0.6 | 各 P0 を **独立 PR** にすると合意、レビュー速度を確保 | 巨大 PR 化を防ぐ |
| 0.7 | dependabot の 2件 moderate alert を確認・対処方針決定 | 既知脆弱性が滞留中 |

---

## 1. P0 — 即修正（破壊的バグ、セキュリティ）

> 各 1-2 時間以内。並列に PR を分離して提出可能。

### 1.1 [Critical] `prune.ts:47` deleteWorktree の `worktreeBase` 引数欠落
- **出典**: 初回監査 #1
- **症状**: 非デフォルト `worktreeBase` を設定したユーザで `ccmux prune` が失敗
- **修正**: `deleteWorktree(s.name, s.projectPath, { worktreeBase: cfg.worktreeBase })` に変更（close.ts:72 と同形）
- **検証**: `worktreeBase` を `~/custom-wt` に設定して prune を実行
- **想定差分**: 1 行

### 1.2 [Security/Critical] `obsidian.ts:52` `rejectUnauthorized: false` 削除 + CA pinning
- **出典**: 第4回 #1
- **症状**: 全 HTTPS 接続で MITM 受け入れ。Obsidian API key が漏洩リスク
- **修正**:
  1. `rejectUnauthorized: false` を削除
  2. ユーザに `obsidian-local-rest-api.crt` の trust を案内（README 更新）
  3. or `NODE_EXTRA_CA_CERTS` 経由で読む実装
  4. 一時的に `ccmux.obsidian.allowInsecureTLS: true` の opt-in を残す場合は警告ログを出す
- **検証**: Obsidian Local REST API に対する HTTPS 接続が成立すること
- **想定差分**: ~10 行

### 1.3 [i18n/Critical] `cost.ts:60` UTC バグ — 日本ユーザの「今日」が壊れている
- **出典**: 第6回 #6
- **症状**: `new Date().toISOString().slice(0, 10)` が UTC 基準なので Asia/Tokyo の 09:00-23:59 のコストが翌日扱い
- **修正**:
  ```ts
  const tz = process.env.CCMUX_TIMEZONE
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  ```
- **検証**: `TZ=Asia/Tokyo node -e ...` で日付一致、`CCMUX_TIMEZONE=UTC` で従来動作
- **想定差分**: ~10 行

### 1.4 [Config/Critical] `schema.ts:91` shallow merge → deep merge + Zod validation
- **出典**: 第6回 #5
- **症状**: ユーザが `n8n: {enabled: true}` だけ書くと `webhookUrl`/`servePort` が消える
- **修正**:
  1. `zod` 追加（v4）
  2. `ConfigSchema = z.object({...})` を schema.ts で宣言
  3. `loadConfig` で `ConfigSchema.parse(deepMerge(DEFAULTS, parsed))`
  4. パース失敗時は `z.prettifyError()` で actionable な行/列表示
- **検証**: 既存 config.json 全パターンが parse 通る、欠落フィールドはデフォルト補完
- **想定差分**: ~80 行（schema 移行）

### 1.5 [Security/Critical] `block-no-verify` PreToolUse hook
- **出典**: 第5回 #9
- **症状**: agent が `git commit --no-verify` で pre-commit 全 bypass 可能
- **修正**: `core/hooks.ts` のブロックリストに `(--no-verify|-n\\s|core.hooksPath=)` を追加、`mcp__github__(push_files|create_or_update_file|merge_pull_request|delete_file|update_pull_request_branch)` も match
- **検証**: hooks-blocklist.test.ts に新規ケース追加し PASS
- **想定差分**: ~30 行（hook + test）

### 1.6 [Observability/P0] `CLAUDE_CODE_ENABLE_TELEMETRY=1` を child env に伝播
- **出典**: 第5回 #3
- **症状**: Claude Code 自身が吐ける OTLP / gen_ai.* spans / cost event を全部捨てている
- **修正**: `core/session.ts` の spawn で `CLAUDE_CODE_ENABLE_TELEMETRY=1` 設定 + `TRACEPARENT` 生成 + (任意) `OTEL_EXPORTER_OTLP_ENDPOINT` も pass-through
- **検証**: OTLP collector に span が届く（local Jaeger 等）
- **想定差分**: ~20 行

---

## 2. P1 — 1日で着手できる中規模改善

### 2.1 [Lock/Reliability] `proper-lockfile` 採用で `lock.ts` 全置換
- **出典**: 第4回 #2
- **修正**: `acquireLock`/`releaseLock` を `proper-lockfile` のラッパに（`stale: 30s, update: 10s, onCompromised`）+ `signal-exit` で自動 cleanup
- **副次**: PID リサイクル耐性、NFS でも動作、CWE-367 symlink 攻撃防御
- **想定差分**: ~100 行（lock.ts 全書き換え + test）

### 2.2 [State/Reliability] `write-file-atomic` で session DB 保護
- **出典**: 第4回 #2
- **修正**: `core/session.ts:writeDB` を `write-file-atomic` に置換（fsync + parent dir fsync）。すべての `readDB → mutate → writeDB` を `proper-lockfile.lock(sessionsFile)` でラップ
- **想定差分**: ~50 行

### 2.3 [Performance/P1] commander の lazy import + better-sqlite3 gate
- **出典**: 第6回 #3
- **修正**:
  1. `src/index.ts` の各 `program.command(...).action(handler)` を `delayedRequire('./commands/foo')` パターンに
  2. better-sqlite3 の import を `core/queue.ts` 内に動的化（queue command 以外で load しない）
  3. Node ≥22.5 では `node:sqlite` を優先 (`hasModernSqlite()` gate)
- **検証**: `hyperfine 'node dist/index.js --help'` で 0.5s → 0.05s 級の改善
- **想定差分**: ~80 行

### 2.4 [Docs/P1] `scripts/sync-docs.ts` で README / completions / help を自動同期
- **出典**: 第6回 #4
- **修正**: commander の `program.commands` を walk して README の `<!-- commands -->` ブロック更新、`completions/_ccmux` と `ccmux.bash` を再生成、`--help` snapshot を tests/help.snapshot.ts に書き出し
- **CI**: `.github/workflows/ci.yml` に `npm run docs:sync && git diff --exit-code` step を追加
- **想定差分**: ~120 行（script + CI 1 step）

### 2.5 [HMAC/Webhook] `X-GitHub-Delivery` dedupe + multi-secret 受け入れ
- **出典**: 第4回 #5
- **修正**:
  1. `n8n.ts` に LRU (24h TTL) で `X-GitHub-Delivery` を dedupe、duplicate は 200 OK 返却で冪等化
  2. `webhookSecret: string` → `CCMUX_WEBHOOK_SECRETS` CSV から `secrets: string[]` で複数同時受け入れ
  3. `X-GitHub-Event` allowlist 検証追加
- **想定差分**: ~80 行 + test

### 2.6 [Resilience/P1] cockatiel で HTTP integrations を retry + breaker + timeout でラップ
- **出典**: 第5回 #4
- **修正**: `obsidian.ts` / `n8n.ts` / `autoclaw.ts` の HTTP 呼び出しを `cockatiel.wrap(retry, circuitBreaker, timeout)` で囲む、decorrelated jitter、`AbortSignal` フル配線
- **想定差分**: ~100 行

### 2.7 [Supply chain] `.npmrc` `ignore-scripts=true` + `lockfile-lint`
- **出典**: 第5回 #7
- **修正**:
  1. `.npmrc` に `ignore-scripts=true` 追加
  2. better-sqlite3 のみ `npm rebuild --foreground-scripts` で allowlist
  3. `lockfile-lint --validate-https --validate-integrity --allowed-hosts npm` を CI preinstall に
  4. Dependabot の `minimumReleaseAge: 3d` cooldown
- **想定差分**: ~5 行 config + CI 設定

---

## 3. P2 — 1週間規模の構造改善

### 3.1 [Queue/Reliability] SQLite queue を visibility-timeout + DLQ に再設計
- **出典**: 第4回 #3
- **修正**:
  1. Claim を `BEGIN IMMEDIATE` + `UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING …` 単一文に
  2. `visible_at` timestamp + `attempts` fencing token、`max_attempts` 超で DLQ
  3. PRAGMA helper で接続生成時に `busy_timeout=10000` / `journal_mode=WAL` / `synchronous=NORMAL` / `journal_size_limit` を必ず設定
  4. NFS/SMB 検出で `CCMUX_QUEUE_DISABLED` 自動 ON
- **想定差分**: ~200 行 + test 書き直し

### 3.2 [Worktree/Reliability] flock + detached HEAD + 冪等 reconciler
- **出典**: 第4回 #4
- **修正**:
  1. 全 `worktree add|remove|prune` を `<repo>/.git/ccmux-worktree.lock` の flock でシリアライズ
  2. デフォルトを detached HEAD worktree に変更（parent HEAD 汚染防止）
  3. 起動時 reconciler: `worktree list --porcelain -z` パース → prunable/missing 削除
  4. worktree base を `<repo>/.ccmux/worktrees/<id>` に推奨（README 更新）
- **想定差分**: ~150 行

### 3.3 [DR/P2] checkpoint/heartbeat/quota
- **出典**: 第5回 #10
- **修正**:
  1. 各 Ralph iteration 後に `{intent, last_commit_sha, iteration_n}` を atomic write
  2. `setInterval` heartbeat で `last_beat_ts` + `progress_hash` (git tree hash) を `~/.ccmux/heartbeat/<session>.json` に
  3. supervisor: heartbeat 不変 > N 分で `SIGTERM → drain → SIGKILL`
  4. `fs.statfs` で `bavail < 1GB` 検出 → loop pause
  5. per-session token cap / per-day USD cap を `auto.ts` 起動時に注入
- **想定差分**: ~250 行

### 3.4 [TASK_STATE/P2] 構造化 schema + `pause_after_compaction` 連携
- **出典**: 第4回 #8 / 第5回 #8
- **修正**:
  1. TASK_STATE.md を frontmatter + sections (`Intent`/`Files`/`Decisions`/`Active Goals`/`Next Steps`/`Failures`) で構造化
  2. `taskstate.ts` を `Bash echo` ではなく Write tool 経由（hooks/log 通す）
  3. `compact_20260112` beta + `pause_after_compaction: true` で再注入
  4. Reflexion 出力先を `.claude/skills/reflections/SKILL.md` に分離、CLAUDE.md は 180 行 cap
- **想定差分**: ~150 行

### 3.5 [Sandbox/P2] bwrap に seccomp + `$HOME` deny-list
- **出典**: 第4回 #6
- **修正**:
  1. Anthropic 流 `apply-seccomp` 移植して AF_UNIX + namespace syscall ブロック
  2. tmpfs `$HOME` + `~/.claude` のみ rw bind
  3. `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`, `~/.docker`, `/var/run/docker.sock` を deny
  4. WSL2 検出 + Ubuntu 24.04 AppArmor プロファイル自動配置、WSL1 で起動拒否
- **想定差分**: ~100 行 + ドキュメント

### 3.6 [UX/P2] `--json` envelope + `ccmux schema`
- **出典**: 第5回 #5
- **修正**: `{schema_version:"1", data, error, warnings, meta}` envelope、JCS key sort、`ccmux schema` で JSON Schema 出力、stdout/stderr 分離
- **想定差分**: ~60 行 + 各 `--json` 利用箇所

### 3.7 [Observability/P2] OTLP + replay JSONL
- **出典**: 第5回 #3
- **修正**:
  1. `pino` ロガー導入、`redact` で prompt content 抑止（既定）
  2. gen_ai semconv に従って span attribute 設定
  3. `~/.ccmux/replay/<sessionId>.jsonl` に hash-only event log（full payload は opt-in flag）
  4. `ccmux replay <session>` で regression diff
- **想定差分**: ~200 行

---

## 4. P3 — アーキテクチャ移行

### 4.1 [Distribution/P3] release-please + Trusted Publishing + Homebrew tap
- **出典**: 第6回 #7
- **作業**:
  1. Conventional Commits 強制（commitlint）
  2. `.github/workflows/release-please.yml`
  3. `.github/workflows/publish.yml` (`v*` tag → npm publish with provenance)
  4. better-sqlite3 を **prebuildify** で `.node` 同梱
  5. Homebrew tap `homebrew-ccmux` を別 repo で
- **想定差分**: 新規ファイル 4-5 個 + package.json 整備

### 4.2 [Commit safety/P3] ed25519 SSH signing + repo ruleset
- **出典**: 第5回 #9
- **作業**:
  1. ccmux インスタンスごとに ed25519 鍵生成
  2. 専用 `ccmux-bot` GitHub アカウント運用
  3. `gpg.format=ssh, commit.gpgsign=true` を session bootstrap で
  4. `main` に repo ruleset (signed commits / linear history / 1 human approval / dismiss stale)
  5. `prepare-commit-msg` hook で trailer 注入 (`Agent-Session`, `Cost-USD`, `Tokens-In/Out`)
- **想定差分**: ~80 行 + docs

### 4.3 [Local LLM/P3] llama-server/vLLM 既定化 + AbortSignal 配線
- **出典**: 第4回 #10
- **作業**:
  1. `litellm-config.example.yaml` を llama-server 既定に書き換え
  2. `autoclaw.ts` に `AbortSignal` フル配線、cancel 時に LiteLLM の iterator を break
  3. `ANTHROPIC_AUTH_TOKEN` 既存 OAuth 検出時の拒否ロジック
  4. `ccmux doctor` に VRAM preflight 追加
- **想定差分**: ~150 行

### 4.4 [Multi-platform/P3] Windows/macOS arm64 CI lane
- **出典**: 第5回 #8
- **作業**:
  1. `.github/workflows/ci.yml` に matrix で `windows-latest`, `macos-14` (arm64) 追加
  2. `is-wsl` 採用、execa `gracefulCancel` で SIGTERM 抽象化
  3. path helper（NFC 正規化、240 文字 cap）
  4. chokidar v4 で `usePolling:true` を `/mnt/*` に
- **想定差分**: CI 設定 + ~100 行 helper

### 4.5 [Plugin/P3] integration を `Backend`/`SessionStore`/`Notifier` interface に inversion
- **出典**: 第6回 #10
- **作業**:
  1. interface 定義 (`src/plugins/api.ts`)
  2. `n8n.ts`/`obsidian.ts`/`autoclaw.ts` を実装に書き換え
  3. `package.json` の `ccmux.contributes` field 設計（plugin loader は次フェーズ）
  4. Tapable 風 hook bus へ移行
- **想定差分**: ~300 行

### 4.6 [MCP/P3] stdio-only MCP server を追加（要否判断後）
- **出典**: 第6回 #2
- **判断**: そもそも MCP として ccmux を出すか否か議論が必要。出すなら：
  1. stdio transport only
  2. session を first worktree に pin
  3. `@anthropic-ai/sandbox-runtime` で再 exec
  4. `send_keys`/`write_file`/`merge` に `require_approval: always`
- **想定差分**: 新規モジュール ~400 行

---

## 5. テスト / 検証強化（実装と並行）

| # | やること | 優先度 |
|---|---|---|
| 5.1 | `fast-check` で queue / lock の property-based test | P2 |
| 5.2 | PollyJS or 自作 JSONL recorder で LLM cassette pattern | P2 |
| 5.3 | golden-prompt regression (20-50 タスク) を nightly に | P2 |
| 5.4 | Lakera PINT / Meta CyberSecEval でプロンプト injection ASR 測定 | P3 |
| 5.5 | memlab で leak 検出 CI (`heap-trend` diff) | P3 |
| 5.6 | Windows/macOS arm64 CI matrix（P3 4.4 と統合） | P3 |
| 5.7 | chaos: SIGKILL mid-stream / disk full / slow net | P3 |

---

## 6. ドキュメント反映タスク

| # | やること |
|---|---|
| 6.1 | README に `dashboard`/`doctor`/`logs`/`merge`/`prune`/`reflect`/`serve` を追加（前回監査） |
| 6.2 | README config 例に `version`/`worktreeBase`/`n8n`/`autoclaw`/`cost`/`logs` 必須フィールド追加 |
| 6.3 | LAB-WIKI の `TASK_PROMPT.md` 記述を実装と整合（P2 3.4 と同時） |
| 6.4 | completions/_ccmux と ccmux.bash に `reflect` / `dashboard` 追加（P1 2.4 で自動化） |
| 6.5 | docs/SECURITY.md 新設（threat model + 各 P0/P1 対応の説明） |

---

## 7. 推奨実装順（依存関係）

```
0章 (準備) [必須]
  ↓
P0 群 [独立 PR 6 本、並列レビュー可]
  1.1 prune.ts fix
  1.2 obsidian TLS
  1.3 cost.ts UTC
  1.4 schema.ts Zod ← これだけ少し大きい、最初に出すと他 PR の base
  1.5 block-no-verify
  1.6 telemetry env
  ↓
P1 群
  2.7 supply chain (CIだけなのでまず入れる)
  2.4 sync-docs (今後の drift 防止に直結)
  2.3 lazy import (測定→改善 ループ確立)
  2.1 + 2.2 lock + atomic write (state stability)
  2.5 webhook dedupe
  2.6 cockatiel (resilience 基盤、P2 で使う)
  ↓
P2 群
  3.7 OTLP/replay (P0 1.6 と統合して観測性確立 ← 以降の改善検証用)
  3.1 queue 再設計
  3.2 worktree 強化
  3.3 DR/heartbeat
  3.4 TASK_STATE / Skill
  3.6 --json envelope
  3.5 sandbox 強化
  ↓
P3 群（オーナー方針判断後）
  4.1 release pipeline
  4.4 CI matrix
  4.5 plugin inversion
  4.2 commit signing
  4.3 local LLM
  4.6 MCP server (要否判断)
```

---

## 8. 着手前の意思決定事項

オーナーに決めてもらう前提：

1. **互換性方針**: `~/.ccmux/config.json` フォーマット変更（P0 1.4）を migration ありで実施？ なし？
2. **distribution**: npm publish に踏み切るタイミング（P3 4.1）
3. **MCP**: ccmux 自身が MCP server になるか否か（P3 4.6）
4. **commit signing**: 専用 `ccmux-bot` GitHub アカウント取るか（P3 4.2）
5. **plugin architecture**: 内部 inversion だけで止めるか、公開 API まで出すか（P3 4.5）
6. **デフォルト sandbox**: bwrap を強推奨に切替えるか opt-in 据え置きか（P2 3.5）
7. **local LLM デフォルト**: Ollama 既定維持か llama-server に切替か（P3 4.3）

---

## 9. 注意

- **P0 はオーナー判断不要、即着手可**
- **P1 はだいたい 1 日で 1 つ、PR 6 本くらいで 1-2 週間**
- **P2 は構造変更を含むので 1-2 ヶ月かかる**
- **P3 は方針判断 + 別 repo 含む大プロジェクト**
- 第4-6回の各セクション (LAB-WIKI §10/§11/§12) に詳細な出典 URL あり、迷ったら参照

---

最終更新: 2026-05-19
