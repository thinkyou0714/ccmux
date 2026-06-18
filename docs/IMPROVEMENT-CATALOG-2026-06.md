# ccmux 改善カタログ 2026-06 — 100 アイデア（根本原因 + ベストプラクティス）

> 生成方法: コードベースを4分割した並列監査（① coreランタイム/並行処理 ② commands/CLI UX ③ 連携/HTTPサーバ/セキュリティ ④ ビルド/CI/テスト/供給網）＋ Web ベストプラクティス調査6領域（SQLiteキュー / webhook HMAC / ファイルロック / CLIエラー処理 / 供給網 / git worktree）。全項目は実コードの `file:line` 根拠付き。
>
> 凡例: 重大度 **P0**(破壊的/即時) / **P1**(近日) / **P2**(計画) / **P3**(将来)。`R?`=ROADMAP既知(Y/N/部分)。`risk`=変更リスク。
>
> 実行ティア: **A**=小さく安全・高確度の修正（即実装推奨） / **B**=堅牢化（設定/CI/供給網/耐障害性） / **C**=構造変更（複数PR・設計判断を伴う）。

---

## Tier A — Quick-win correctness & security（即実装推奨：小・安全・高確度）

### A-1. commander 配線バグ（実機検証済み・数行で確実に直る）
- **I-001** `--no-handoff` が完全無効 | P0 | `close.ts:88` が存在しない `opts.noHandoff` を参照（negate は `opts.handoff`）→ handoffスキップが握り潰される | 修正: `opts.handoff !== false` | risk低 | R?N
- **I-002** `--no-dashboard` が完全無効 | P1 | 同根（`close.ts:122`）| `opts.dashboard !== false` | risk低 | R?N
- **I-003** `merge --no-ff` が git に渡らない | P1 | `merge.ts:55` `opts.noFf` 常に undefined → 常にFF可能 | `opts.ff === false` | risk中 | R?N
- **I-004** `parseInt` radix バグで `--lines`/`--older-than` 死亡 | P1 | `index.ts:116,119` default が radix として渡り `parseInt("8",50)=NaN`→null→既定値 | 共通 `intArg()` パーサ（`InvalidArgumentError`）に置換 | risk中 | R?N
- **I-005** 数値オプションの NaN 未検証（`--port`/`--max-iter`/`--litellm-port`）| P1 | `index.ts:74,89,156` | I-004の共通パーサ＋範囲チェック | risk中 | R?N
- **I-009** `--status` の help/enum/色が三者ドリフト（`starting`/`idle` 欠落）| P3 | `index.ts:41` vs `session.ts:73` vs `list.ts:15` | enumを単一ソース化 | risk低 | R?N

### A-2. 入力検証 / インジェクション
- **I-006** セッション名が無検証でブランチ/パス/ファイル名に流入（CWE-22 `../`脱出）| P1 | `index.ts:26`→`worktree.ts:45,47` | 共通バリデータ `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`、`git check-ref-format`準拠 | risk中 | R?N
- **I-023** `cd "${cwd}"` をエスケープせず補間（コマンド注入）| P2 | `zellij.ts:21,69` | `escapeBashDQ` 相当でクオート | risk中 | R?N
- **I-007** `--prompt-file` 読込失敗が生errno | P2 | `index.ts:79-82` | try/catchで文脈付きメッセージ、`--prompt`併用は警告 | risk低 | R?N

### A-3. ロック/リソースリーク（全終了経路で解放）
- **I-012** `auto.ts` が `acquireLock` 後 `releaseLock` を全経路で呼ばず恒久リーク | P0 | `auto.ts:61`（detach親の即死PIDをロックが指す）→ 同名autoがcloseまで永久ブロック | catchで `releaseLock().catch(()=>{})`＋寿命をchild.pidへ | risk中 | R?部分(2.1)
- **I-014** `close.ts` のエラーパスで lock リーク | P2 | `close.ts:82-84` `process.exit(1)` が `releaseLock`(113)に未到達 | finally化 or throw集約 | risk中 | R?部分
- **I-015** 各コマンドの `process.exit()` 散在で cleanup/flush 中断（19箇所）| P2 | `new/close/merge` 等 | `throw`にして index.ts 集約catchへ委譲、解放は finally | risk中 | R?N
- **I-013** 空/破損ロックで `parseInt→NaN`→`kill(NaN,0)` が TypeError で永久阻害 | P2 | `lock.ts:27-29` | `Number.isInteger` でなければ stale 扱い | risk低 | R?N

### A-4. 個人情報/移植性/ロケール
- **I-016** `cost.ts` に開発者個人名 **"Rikuto" ハードコード** fallback ＋脆弱WSL判定 | P1 | `cost.ts:31-37` 他ユーザWSLで誤パス参照 | 個人名削除→undefined、WSLは `/proc/version`/`is-wsl` | risk中 | R?N
- **I-022** git のエラー判定が英語文字列マッチでロケール脆弱 | P3 | `merge.ts:68`,`worktree.ts:65,150` の `CONFLICT/already exists/uncommitted` | execa env に `LC_ALL=C`,`GIT_TERMINAL_PROMPT=0` | risk低 | R?N
- **I-030** `process.env.HOME` の eager 評価が自身のlazy設計に矛盾（`worktreeBase`既定・`DEFAULTS`・`auto.ts CCMUX_DIR`）| P1 | `schema.ts:96,146`,`auto.ts:16` | Zod `.default(()=>…)`化＋`ccmuxDir()`/`home()` を `core/paths.ts` に集約し全6+2箇所統一 | risk中 | R?N
- **I-024** `ZELLIJ_BIN` をimport時に `${HOME}/.local/bin/zellij` で固定（PATH無視/HOME未設定でundefined）| P3 | `zellij.ts:3` | 関数内解決＋PATH優先 | risk低 | R?N

### A-5. データ表示/小バグ
- **I-010** 色付き文字列に `padEnd(8)` で列ズレ（ANSI幅算入）| P3 | `list.ts:100`,`getCost:34,37` | padの後に色付け | risk低 | R?N
- **I-011** `getCost` が無駄に async＋ループ内 await 逐次化 | P3 | `list.ts:33,95` | 同期化 | risk低 | R?N
- **I-008** `reflect --apply` の「重複防止」コメントが虚偽（無条件append）| P2 | `reflect.ts:132-135` | 既存セクション検出でskip/置換、冪等明文化 | risk低 | R?部分(3.4)
- **I-019** `getRecentCost` が ccusage 出力ソート済み前提 | P3 | `cost.ts:86-87` | dateでsort後slice | risk低 | R?N

### A-6. worktree クリーンアップの冪等性
- **I-020** `deleteWorktree` の dirty ガードが wtPath 消失時に誤って失敗 | P2 | `worktree.ts:138-154`（非git→再throw）| status失敗は「掃除すべき」とみなす、dirtyは stdout 由来時のみ | risk低 | R?N
- **I-021** `deleteWorktree`/`prune` が削除失敗を握り潰し成功表示 | P2 | `worktree.ts:160-168`,`prune` `.catch(()=>{})` | 最終失敗はwarn＋status=error保持 | risk低 | R?N
- **I-029** circuit breaker ログを worktree 内に書き agent が改ざん可能 | P3 | `hooks.ts:75,85-91` | `~/.ccmux/circuit/<session>.log` へ移し write-boundary対象に | risk低 | R?N

### A-7. セキュリティ quick-win
- **I-025** Bearer 比較が非constant-time（`===`）| P2 | `n8n.ts:46`（HMACは timingSafeEqual なのに不一致）| `crypto.timingSafeEqual`＋長さガード | risk低 | R?N
- **I-026** webhook body 無制限 → **未認証DoS**（HMAC検証前に全body蓄積）| P1 | `n8n.ts:19-34` | `MAX_BODY`(1MB)超で `req.destroy()`+413、`requestTimeout`/`headersTimeout`設定 | risk中 | R?N
- **I-027** `git commit --no-verify`/`core.hooksPath=` と MCP push 経路で安全フック bypass | P1 | `hooks.ts:336,449-456`（ROADMAP 1.5 既知未実装）| blocklistへ `(--no-verify|-n |core\.hooksPath=)`、deny へ `mcp__github__(push_files|create_or_update_file|merge_pull_request|delete_file|update_pull_request_branch)`＋test | risk中 | R?Y(1.5)
- **I-028** upstream レスポンス body を Error に載せてクライアント応答へ転載（秘密/内部リーク）| P1 | `autoclaw.ts:129` | statusのみ返し body は redact ログ限定 | risk低 | R?部分(3.7)
- **I-031** `routeTask`/`checkHealth` が常に平文 `http` モジュール使用＋scheme検証なし（https設定でも平文送信） | P1 | `autoclaw.ts:28,117` | schemeで http/https 選択、loopback/allowlist制約 | risk中 | R?N
- **I-032** `.worktreeinclude` の `../` 未検証（zip-slip 類型で秘密ファイル露出）| P2 | `worktree.ts:109-115` | `path.resolve`後に projectPath/wtPath prefix検証、`..`拒否 | risk中 | R?N
- **I-033** obsidian `vaultRelPath` 二重エンコード（`/`→`%2F`）＋ handoffPath 無サニタイズ | P2 | `obsidian.ts:46,237,269` | セグメント毎encode＋traversal検証 | risk中 | R?N

### A-8. データ整合（永続層）
- **I-034** 破損 `sessions.json` を「空」と誤認し全履歴を黙って上書き | P1 | `session.ts:96-103` | パース失敗は throw＋`.corrupt.<ts>`退避、空(初回)と区別 | risk低 | R?N
- **I-035** `createSession` に同名重複チェック無し（台帳に同名複数行）| P2 | `session.ts:112-130` | 既存(status≠closed)なら throw | risk低 | R?N
- **I-036** TZ不正値で `Intl.DateTimeFormat` が throw → `getTodayCost` 全体が落ちる | P2 | `cost.ts:63-66` | try/catchでsystem zoneへfallback＋警告 | risk低 | R?N
- **I-037** `npx ccusage` に timeout 無くハング可能 | P2 | `cost.ts:44-55` | execa timeout＋不在を明示 | risk低 | R?N

---

## Tier B — Hardening（設定/CI/供給網/耐障害性：主に追加・中規模）

### B-1. サプライチェーン
- **I-038** `.npmrc` に `ignore-scripts=true` 不在（`better-sqlite3`/`esbuild` postinstall RCE面）| P1 | `better-sqlite3` のみ allowlist rebuild | R?Y(2.7)
- **I-039** `lockfile-lint` 未導入 | P1 | CI に `--validate-https --validate-integrity --allowed-hosts npm` | R?Y(2.7)
- **I-040** Renovate `minimumReleaseAge`(cooldown) 未確認/未設定 | P2 | 本repoで明示 | R?Y(2.7)
- **I-041** native module(better-sqlite3) の lazy require＋graceful degrade 無し（全コマンドが道連れ）| P2 | `queue.ts:11-13` import を動的化＋doctor で存在確認 | R?部分(3.1)
- **I-042** `npm audit` が production-only（dev依存の脆弱性無視）| P2 | dev含むaudit step追加 | R?N

### B-2. テスト基盤
- **I-043** カバレッジ計測ゼロ | P1 | `@vitest/coverage-v8`＋閾値gating | R?N
- **I-044** lint warn 許容で品質ゲート不在 | P1 | `eslint --max-warnings=0` | R?N
- **I-045** 生成物 drift-guard 無し（completions/README）| P1 | `sync-docs`＋`git diff --exit-code` | R?Y(2.4)
- **I-046** 「統合テスト」が ccmux を駆動せず偽カバレッジ | P1 | `autoCommand` を実spawnしworktree→hook→complete をassert | R?Y(5.2/5.3)
- **I-047** commander配線を通すE2Eスモーク無し（I-001〜005をmasking）| P1 | `program.parseAsync([...])`駆動テスト | R?N
- **I-048** queue 並行claimテスト皆無（dedupの存在意義）| P1 | `Promise.all`でN並行→claimedちょうど1、fast-check | R?Y(5.1)
- **I-049** `lock.ts` のTOCTOU/stale/PID再利用 未検証＋専用テスト無し | P1 | エラーパス単体＋property | R?Y(5.1)
- **I-050** 7コマンド未テスト（merge/prune/doctor等）| P1 | execa/fsモックでsmoke+errorパス | R?Y(5)
- **I-051** `zellij.ts`/`taskstate.ts` 未テスト | P1 | 純粋部分抽出＋round-trip | R?部分
- **I-052** `autoclaw.buildClaudeEnv` 未テスト（秘密注入の要）| P2 | 分岐テスト | R?N
- **I-053** hooks生成 .sh の実行検証無し（grepのみ）| P2 | Linuxジョブで実bash実行、exit/stderr assert | R?部分(3.3)
- **I-054** LLM cassette/golden-prompt 無し | P2 | JSONL recorder/PollyJS、nightly | R?Y(5.2/5.3)
- **I-055** `vitest.config.ts` 不在（include/exclude/timeout/pool 暗黙）| P2 | 設定ファイル化（DB並行のpool明示）| R?N

### B-3. CI / 再現性
- **I-056** Node matrix が22単一（engines≥22と不整合）| P2 | `[22,24]` | R?N
- **I-057** `.nvmrc`/engines/CI の version 3重管理 | P3 | `node-version-file:.nvmrc` | R?N
- **I-058** secrets-scan(gitleaks v2) が org化で失敗しうる | P2 | trufflehog 切替 or license配線 | R?N
- **I-059** test reporter が verbose 固定（PR注釈出ない）| P3 | `--reporter=github-actions`＋junit artifact | R?N
- **I-060** OS matrix の各セルが何を保証するか不明（bash hookがwin未実行=偽の網羅）| P2 | include/excludeで明示 | R?Y(4.4)

### B-4. 型安全 / 静的解析
- **I-061** eslint に floating-promise系ルール無し（fire-and-forget多数）| P1 | `no-floating-promises`/`no-misused-promises` error | R?N
- **I-062** `tsconfig` strictのみで `noUncheckedIndexedAccess` 等欠如 | P2 | 段階導入 | R?N
- **I-063** 外部JSON(sessions/ccusage/TASK_STATE)を `as` で握り潰し未検証 | P2 | Zod `safeParse`（config同様）| R?部分(2.2)
- **I-064** 未使用export検出機構無し | P3 | `knip` 導入 | R?N
- **I-065** `schema.version` が読まれず死にフィールド | P2 | loadConfigで読み未知versionは警告/migration | R?Y(8-1)

### B-5. リリース / 配布
- **I-066** publish/release ワークフロー皆無 | P1 | release-please＋Trusted Publishing(OIDC,provenance) | R?Y(4.1)
- **I-067** `package.json` publishメタ欠落（`files`/`prepublishOnly`/`repository`/`license`）→壊れたtarball publish リスク | P1 | allowlist＋`prepublishOnly:build` | R?部分(4.1)
- **I-068** version 3重ハードコード（`index.ts:23` vs package.json）| P1 | ビルド時注入 or 整合テスト | R?部分
- **I-069** CHANGELOG 無し | P3 | release-please自動生成 | R?Y(4.1)

### B-6. HTTP/サーバ耐障害性
- **I-070** HTTP連携にretry/circuit breaker/AbortSignal 皆無＋autoclaw固定10sでLLM長時間タスク誤失敗 | P1 | `cockatiel.wrap` + signal配線 + timeout config化 | R?Y(2.6/4.3)
- **I-071** webhook replay防御なし（`X-GitHub-Delivery` dedupe未実装）| P1 | LRU(24h)で冪等化 | R?Y(2.5)
- **I-072** 署名検証より前にevent分岐＋未署名で200（fail-open）| P1 | raw読取→署名検証を最優先に | R?部分(2.5)
- **I-073** event allowlist が `issues` ハードコードのみ | P2 | 明示allowlist集合 | R?Y(2.5)
- **I-074** `serve` 常駐が `new Promise(()=>{})` でerror後も無限待ち | P2 | `server.on("error")`常設＋graceful exit | R?N
- **I-075** graceful shutdown が in-flight 待たず即exit | P3 | drain→timeout→force | R?部分(3.3)
- **I-076** body無制限とは別に server timeout(`requestTimeout`/`headersTimeout`)未設定 | P2 | 設定 | R?N
- **I-077** 二重 `send`(`ERR_HTTP_HEADERS_SENT`)余地 | P3 | `res.headersSent`ガード | R?N
- **I-078** 不正JSONが500（webhookで400返せない）| P3 | 専用エラー型→400 | R?N
- **I-079** EADDRINUSE 等 listen エラーの案内不足 | P3 | コード判別＋actionable | R?N
- **I-080** Content-Type/405/Allow 検証なし | P3 | ルータ化＋検証 | R?N
- **I-081** autoclaw レスポンス無制限蓄積＋`chunk.toString()`境界割れ | P2 | 上限＋`Buffer.concat`一括decode | R?N

### B-7. core 永続層 堅牢化
- **I-082** `session.writeDB` に fsync 無し（電源断で台帳消失）| P1 | `write-file-atomic`(tmp fsync→rename→dir fsync) | R?Y(2.2)
- **I-083** queue に `synchronous`/`journal_size_limit`/checkpoint 未設定（claimロスト/WAL肥大）| P1 | PRAGMA設定 | R?Y(3.1)
- **I-084** queue接続が close されずserve常駐でWAL残骸 | P2 | exit/SIGTERMでclose | R?N
- **I-085** `taskstate.writeTaskState` 非原子（agentの単一真実源が破損）| P1 | tmp+rename/atomic | R?部分(3.4)
- **I-086** `parseTaskState` が破損入力で「それらしい誤データ」を返す | P2 | 必須欠落でundefined、frontmatter+zod化 | R?Y(3.4)
- **I-087** worktree既定baseが repo を含まず別repo同名で衝突 | P1 | `path.join(base, projectKey, name)` | R?Y(3.2)
- **I-088** worktree porcelain パースが `-z` 不使用で空白/改行に脆弱 | P2 | `list --porcelain -z` | R?Y(3.2)
- **I-089** `buildClaudeEnv` が `process.env` 全継承（クラウド資格情報過剰伝播）| P2 | allowlist継承、autoclaw時はクラウド系削除 | R?部分(4.3)
- **I-090** zellij/tmux 連携が固定sleep(3000ms)でプロンプト取りこぼし | P2 | 状態polling検出 | R?N

---

## Tier C — Structural（複数PR・設計判断を伴う：ROADMAP §8 オーナー判断含む）

- **I-091** `lock.ts` を `proper-lockfile` 全置換（mkdir方式・NFS安全・stale/onCompromised・signal-exit cleanup）| P1 | L-01/L-03/L-05 を根治 | R?Y(2.1)
- **I-092** SQLite queue を visibility-timeout + DLQ + `BEGIN IMMEDIATE`/`RETURNING` 単一文に再設計 | P2 | R?Y(3.1)
- **I-093** worktree 操作を `.git/ccmux-worktree.lock` flock でシリアライズ＋起動時冪等reconciler＋detached HEAD | P1 | W-02/W-03 根治 | R?Y(3.2)
- **I-094** bwrap サンドボックス（seccomp＋`$HOME` deny-list）を主防御化（blocklistは補助）| P1 | H-18/H-21 の根本対策 | R?Y(3.5)
- **I-095** webhook→`--dangerously-skip-permissions` agent の信頼境界設計（issue本文をデータ分離＋author allowlist＝repo collaborator限定）| P1 | プロンプトインジェクション緩和 | R?部分(5.4)
- **I-096** Obsidian TLS を CA pinning/`NODE_EXTRA_CA_CERTS` のみへ（`allowInsecureTLS` 廃止 or localhost限定）| P1 | H-11 | R?Y(1.2)
- **I-097** 秘密情報の集中管理＋出力時 redact ヘルパ（pino redact）＋TLS鍵のmode検証 | P2 | H-15/H-16 | R?部分(3.7)
- **I-098** OTLP/`pino` 構造化ログ＋replay JSONL（`CLAUDE_CODE_ENABLE_TELEMETRY` 伝播）| P2 | R?Y(1.6/3.7)
- **I-099** `--json` envelope `{schema_version,data,error,warnings,meta}` 全コマンド横展開＋stdout/stderr分離 | P2 | F09/F10 | R?Y(3.6)
- **I-100** plugin inversion（`Backend`/`SessionStore`/`Notifier` interface）＋ DR/heartbeat/quota supervisor | P3 | R?Y(3.3/4.5)

---

## 既に実装済み（確認済み・対象外）
ROADMAP §1 の P0: cost.ts UTC(1.3) / Obsidian TLS opt-in自体(1.2) / HMAC timingSafeEqual(BL-1) / config deep-merge+Zod(1.4, 本セッションで実装) は対処済み。なお 1.5(`--no-verify` block) と 1.2 の CA pinning 化は未完（I-027/I-096）。

## 推奨実行戦略
1. **Tier A を本セッションで実装**（約37項目／大半が数行・低〜中リスク・高確度の correctness/security 修正）。配線テスト(I-047)とコマンドテスト(I-050)を同時に入れて回帰を固定。論理単位で複数コミットに分割し PR #52 ブランチへ。
2. **Tier B を次バッチ**（供給網・CI・テスト基盤・耐障害性）。多くは追加でリスク低だが、CI/lint gating は既存警告整理を伴う。
3. **Tier C はオーナー判断（ROADMAP §8）を要する構造変更**。lock置換 / queue再設計 / sandbox / TLS pinning / plugin化 は各々独立PRで段階導入。
