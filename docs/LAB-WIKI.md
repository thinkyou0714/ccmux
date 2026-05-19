# ccmux LAB Wiki — 自律開発環境ロードマップ

> 3回のexa深掘り調査（2026-05）とccmux実装から得られた知見をまとめた生きたリファレンス。
> 定期的に更新すること。

---

## 目次

1. [現在の実装状況](#1-現在の実装状況)
2. [アーキテクチャ全体図](#2-アーキテクチャ全体図)
3. [立ち上げフェーズ計画](#3-立ち上げフェーズ計画)
4. [優先バックログ（研究由来）](#4-優先バックログ研究由来)
5. [絶対に踏んではいけない地雷](#5-絶対に踏んではいけない地雷)
6. [ローカルLLM運用ガイド](#6-ローカルllm運用ガイド)
7. [コンテキスト管理戦略](#7-コンテキスト管理戦略)
8. [エコシステムマップ](#8-エコシステムマップ)
9. [参考リポジトリ・論文](#9-参考リポジトリ論文)

---

## 1. 現在の実装状況

### 実装済み ✅

| 機能 | ファイル | 説明 |
|---|---|---|
| セッション管理 | `src/commands/new.ts`, `close.ts`, `list.ts` | worktree × Zellij/tmux |
| 自律起動 | `src/commands/auto.ts` | `--prompt`, `--resume`, `--loop`, `--sandbox` |
| Ralph Loop | `src/commands/auto.ts` | 完了シグナルゲート付き反復ループ |
| TASK_STATE.md | `src/core/taskstate.ts` | コンテキスト圧縮耐性の永続状態 |
| Reflexion | `src/commands/reflect.ts` | ログ解析→CLAUDE.mdルール自動生成 |
| Claude Code hooks | `src/core/hooks.ts` | Stop/SessionStart/PreToolUse 自動インストール |
| bubblewrapサンドボックス | `src/commands/auto.ts` | `--sandbox`フラグ、`--unshare-net` |
| Webhook サーバー | `src/integrations/n8n.ts` | Bearer認証 + HTTPS/TLS |
| autoclaw/Ollama接続 | `src/integrations/autoclaw.ts` | `buildClaudeEnv()`, `resolveClaudeModel()` |
| LiteLLM設定テンプレート | `litellm-config.example.yaml` | ローカル+クラウドフォールバック |
| n8n ワークフロー | `n8n-workflows/github-issue-to-ccmux.json` | Issue作成→セッション自動起動 |
| doctor | `src/commands/doctor.ts` | 依存診断（Ollama/bubblewrap/auto-memory含む） |
| merge | `src/commands/merge.ts` | ブランチ→main + gh PR |
| Obsidianハンドオフ | `src/integrations/obsidian.ts` | セッション終了時ノート作成 |
| ハンドオフ（ローカル） | `src/commands/close.ts` | `~/.ccmux/handoffs/` |
| bash/zsh補完 | `completions/` | `ccmux list --json`ベース |
| CI | `.github/workflows/ci.yml` | build + test |

### 実装済み・HIGH優先度 ✅ (2026-05-17 land)

| 機能 | ファイル |
|---|---|
| **BL-1 HMAC-SHA256 Webhook署名検証** | `src/integrations/n8n.ts` `verifyGitHubSignature` + `n8n.webhookSecret` config + `n8n-workflows/github-issue-to-ccmux.json` HMAC node |
| **BL-2 破壊的コマンドblocklist** | `src/core/hooks.ts` `writePreToolUseHook` — DROP TABLE / rm -rf / git push --force / cat .env 等。`CCMUX_BLOCKLIST_OVERRIDE=1` で一時解除 |
| **BL-3 Stop hookサーキットブレーカー** | `src/core/hooks.ts` `writeStopHook` — 60s 窓 5 fires でトリップ / context_length_exceeded 等のパターン検出で即許可。`CCMUX_CIRCUIT_FIRES` / `CCMUX_CIRCUIT_WINDOW_SEC` で調整 |
| **Windows daemon spawn fix** | `src/commands/auto.ts` — Windows では `claude` が `.cmd` shim のため `spawn(..., {shell: true})` で起動。Linux/macOS は従来通り |

### 実装済み・MEDIUM優先度 ✅ (2026-05-17 land)

| 機能 | ファイル |
|---|---|
| **BL-4 ccusage コスト連携** | `src/core/hooks.ts` `writeStopHook` — `ccusage session --id` で取得したコストを TASK_STATE.md の `- **Cost**: $X.XX USD` 行に upsert。`CCMUX_DISABLE_CCUSAGE=1` でオフ。ccusage 未インストール時は silent skip |
| **BL-5 .worktreeinclude 自動コピー** | `src/core/worktree.ts` `applyWorktreeInclude` — projectPath の `.worktreeinclude` をパース、各行のファイル (`.env` / `secrets.json` / IDE 設定など) を新 worktree に複製。コメント (`#`) と空行をスキップ、欠損ファイルは stderr 警告のみ |
| **worktreeBase config 反映** | `src/core/worktree.ts` `resolveWorktreeBase` — `cfg.worktreeBase` (caller 渡し) → `CCMUX_WORKTREE_BASE` env → `${HOME}/worktrees` の解決順位。`auto.ts` / `new.ts` / `close.ts` が `cfg.worktreeBase` を渡す |

### Phase 0 検証ステータス (2026-05-17)

実機検証結果 (Windows 11 / qwen2.5-coder:7b on CPU):

| チェック | 結果 |
|---|---|
| Node.js >= 22 | ✅ v24.11.1 |
| claude CLI | ✅ 2.1.143 |
| Ollama 起動 + qwen2.5-coder:7b pull 済 | ✅ 4.7GB |
| `~/.ccmux/config.json` 構造 valid | ✅ |
| `ccmux auto` で worktree 作成 + TASK_STATE.md 書き出し | ✅ |
| 3 hook (Stop/SessionStart/PreToolUse) install | ✅ |
| `.claude/settings.json` overlay (deny rules 5 件) | ✅ |
| daemon プロセスspawn | ✅ (上記 Windows fix 適用後) |
| 実 LLM 呼び出し (claude → Ollama) | ⚠️ LiteLLM proxy 要セットアップ |

**LLM 呼び出しに関する注意**: Claude CLI は Anthropic protocol (`/v1/messages`) を喋るが、Ollama は OpenAI 互換 (`/v1/chat/completions`) のみ。`ANTHROPIC_BASE_URL=http://localhost:11434` 直結では動かない。`litellm-config.example.yaml` 通り LiteLLM proxy 経由が必要:

```bash
pip install 'litellm[proxy]'
litellm --config litellm-config.example.yaml --port 3101
# その後、~/.ccmux/config.json の autoclaw.url を http://localhost:3101 に変更
```

**既知の小問題**:
- `src/core/worktree.ts` の `WORKTREE_BASE` が `process.env.HOME` の hardcode で、`config.worktreeBase` を無視する。デフォルト `~/worktrees` で動作はするので blocker ではない。`CCMUX_WORKTREE_BASE` env 上書きは効く

### 未実装・MEDIUM優先度 🟡

| 機能 | 理由 |
|---|---|
| **SQLiteタスクキュー** | 複数セッション間の原子的タスク分配（amuxパターン） |

---

## 2. アーキテクチャ全体図

```
GitHub Issue
    │
    ▼ (Webhook + HMAC-SHA256検証 ← BL-1 実装済み 2026-05-17)
  n8n ワークフロー
    │
    ▼ POST /webhook/github
  ccmux serve (port 9090)
    │  Bearer token認証
    │
    ▼ ccmux auto <session>
  ┌─────────────────────────────────────────┐
  │  git worktree (~/worktrees/<session>/)  │
  │                                         │
  │  TASK_STATE.md  ← 永続状態              │
  │  TASK_PROMPT.md ← ループ用プロンプト    │
  │  .claude/hooks/                         │
  │    stop.sh         ← 完了チェック       │
  │    session-start.sh← compaction回復     │
  │    pre-tool-use.sh ← 書き込み境界制御   │
  │  .claude/settings.json ← deny rules    │
  │  .claude/tools/    ← agent自作ツール    │
  │                                         │
  │  claude --dangerously-skip-permissions  │
  │    ▲                                    │
  │    ANTHROPIC_BASE_URL=http://localhost:11434
  │                                         │
  └─────────────────────────────────────────┘
    │               │
    ▼ (任意)        ▼ bubblewrap sandbox
  Zellij tab      bwrap --unshare-net
    │
    ▼ ccmux close
  Obsidian handoff note
  ~/.ccmux/handoffs/<date>-<session>.md
    │
    ▼ ccmux reflect <session> --apply
  CLAUDE.md ← 学習ルール蓄積
```

**ローカルLLMスタック:**
```
Claude Code SDK
    ↓ ANTHROPIC_BASE_URL
Ollama (port 11434)  ← 直接接続 (推奨)
  or
LiteLLM proxy (port 3101)  ← フォールバック付きの場合
    ↓
qwen3-coder (80B MoE, 3B active, 256K ctx)
  or qwen2.5-coder:7b (VRAM 8GB以下)
```

---

## 3. 立ち上げフェーズ計画

### Phase 0 — インフラ確認（1〜2時間）

```bash
# 1. 現状確認
ccmux doctor

# 2. Ollama セットアップ
curl -fsSL https://ollama.com/install.sh | sh
OLLAMA_CONTEXT_LENGTH=131072 ollama serve &
ollama pull qwen3-coder      # VRAM 16GB+推奨
# VRAM 8GB以下: ollama pull qwen2.5-coder:7b

# 3. config.json 更新
# ~/.ccmux/config.json
{
  "autoclaw": {
    "url": "http://localhost:11434",
    "model": "qwen3-coder",
    "authToken": "ollama"
  }
}

# 4. 疎通テスト
ANTHROPIC_BASE_URL=http://localhost:11434 \
ANTHROPIC_AUTH_TOKEN=ollama \
claude --model qwen3-coder -p "hello world"
```

**判断分岐**: 遅すぎる or VRAM不足 → `litellm-config.example.yaml` でハイブリッド構成へ

---

### Phase 1 — 最初の自律セッション（半日）

**目標**: `ccmux auto --loop` を小さなタスクで動作確認。

```bash
# 推奨テストタスク: ドキュメント生成（破壊リスクゼロ）
ccmux auto \
  --loop --max-iter 5 \
  --prompt "src/commands/ 配下の全コマンドの使い方を docs/commands.md に生成せよ。完了したら CCMUX_COMPLETE と出力すること。" \
  test-loop-01

# 監視
tail -f ~/.ccmux/logs/test-loop-01.log

# 確認ポイント
# ✔ TASK_STATE.md が worktree 内に生成されているか
# ✔ .claude/hooks/*.sh が生成されているか
# ✔ CCMUX_COMPLETE でループが止まるか
# ✔ ccmux close test-loop-01 でハンドオフが書かれるか
```

---

### Phase 2 — 自己改善ループ確立（2〜3日）

**目標**: セッションの経験を CLAUDE.md に蓄積し始める。

```bash
# 数回セッションを回した後
ccmux reflect test-loop-01        # ルール案を表示
ccmux reflect test-loop-01 --apply # レビュー後に適用

# サイクル:
# タスク → ログ → reflect → CLAUDE.md更新 → 次タスク
```

**MEMORY.md の整備** (`~/.claude/projects/<slug>/memory/MEMORY.md`):
- 200行以内を厳守（上限で打ち切られる）
- 詳細はトピックファイルへの参照のみ
- プロジェクト固有の知識・アーキテクチャ決定・ハマりパターンを記録

---

### Phase 3 — n8n ワークフロー有効化（半日）

**前提**: Phase 1〜2 が安定していること。Webhook署名検証を先に実装すること（バックログ#1）。

```bash
# ccmux serve をバックグラウンド起動
ccmux serve --port 9090

# n8n: github-issue-to-ccmux.json をインポート → active=true
# GitHub: Settings → Webhooks → Add webhook
#   Payload URL: https://<ngrok-or-server>/webhook/github-issues
#   Content type: application/json
#   Secret: config.json の n8n.authToken と一致させる

# テスト: issue を1件作成
# → ccmux list で自動セッション確認
```

---

### Phase 4 — 長時間タスク運用（継続）

**運用設定チートシート:**

| 設定 | 推奨値 | 理由 |
|---|---|---|
| `--max-iter` | 50 | 暴走防止（研究: デフォルト値） |
| `OLLAMA_CONTEXT_LENGTH` | 131072 | 長時間タスクには128K必須 |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | auto-memoryはOllama使用時もトークン2倍消費 |
| 圧縮トリガー | ~50% utilization | 75%超えると品質劣化（rottencontext.com調査） |
| タスク粒度 | 1ブランチに収まるスコープ | スコープ無限タスクは失敗率高い |

---

## 4. 優先バックログ（研究由来）

### 🔴 HIGH — すぐやる

#### BL-1: HMAC-SHA256 Webhook署名検証

```typescript
// src/integrations/n8n.ts に追加
import crypto from "crypto";

function verifyGitHubSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + crypto
    .createHmac("sha256", secret)
    .update(rawBody)   // ← Buffer必須。JSON.parseより前に取得すること
    .digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}
```

**注意事項**:
- rawBodyはJSON.parse前にBufferで取得すること
- `crypto.timingSafeEqual`は長さが異なるとRangeErrorをthrowするため必ず長さチェックを先に行う
- 設定: `n8n.webhookSecret` フィールドをconfig.jsonに追加

---

#### BL-2: 破壊的コマンドblocklist（PreToolUseフック追加）

実際のインシデント（GitHub issues #27063, #45523, #32616 より）:
- `drizzle-kit push --force` → 本番DBを全消去
- `docker compose up -d` → 本番サービス自動起動
- `.env` / Vault 読み取り → 認証情報を端末に表示

```bash
# src/core/hooks.ts の writePreToolUseHook に追加するパターン例
DESTRUCTIVE_PATTERNS=(
  "drizzle-kit push --force"
  "DROP TABLE"
  "DELETE FROM.*WHERE.*1=1"
  "rm -rf /"
  "git push --force"
  "docker.*up.*-d.*prod"
)
```

**重要**: CLAUDE.mdのルールはモデルが「読んで無視する」ことが実証されている。
PreToolUseフック（プロセス外）だけが確実な防御手段。

---

#### BL-3: Stop hookサーキットブレーカー（デッドロック防止）

**問題**: ralph-loop + Stop hookでcontext満杯になると、Stop hookがcompactionをブロックし続けるデッドロックが発生。（oh-my-claudecode issue #959）

```bash
# src/core/hooks.ts の stop.sh に追加するロジック
# タイムスタンプベースのサーキットブレーカー:
# 60秒以内に5回以上Stop hookが発火した場合は強制的に終了を許可

CIRCUIT_FILE="${worktreePath}/.ccmux-circuit"
NOW=$(date +%s)
# 直近60秒内のfireカウントを確認
FIRES=$(find "$CIRCUIT_FILE" -newer ... 2>/dev/null | wc -l)
if [ "$FIRES" -ge 5 ]; then
  echo "ccmux: circuit breaker tripped — allowing stop" >&2
  exit 0
fi

# コンテキスト関連エラーパターン検出
CONTEXT_PATTERNS="context_limit|context_window|context_exceeded|token_limit|prompt_too_long|context_length_exceeded"
if echo "$INPUT" | grep -qiE "$CONTEXT_PATTERNS"; then
  exit 0
fi
```

---

#### BL-4: ccusage コスト連携

```bash
# Stop hookでセッションコストをTASK_STATE.mdに記録
SESSION_ID=$(echo "$INPUT" | grep -oP '(?<="session_id":")[^"]+')
COST=$(ccusage session --id "$SESSION_ID" --json --jq '.sessions[0].costUSD // 0' 2>/dev/null || echo "0")
sed -i "s/- \*\*Last Updated\*\*.*/- **Cost**: \$${COST}\n- **Last Updated**: $(date -Iseconds)/" "$TASK_STATE_FILE"
```

---

#### BL-5: `.worktreeinclude` 対応

Claude Code v2.1.128+ でネイティブ対応済み。`.env` / `secrets.json` を新worktreeに自動コピー。

```
# プロジェクトルートに .worktreeinclude を作成
.env
.env.local
secrets.json
.vscode/settings.json
```

ccmuxの `createWorktree()` でこのファイルを読み込み、`git worktree add` 後に自動コピーする処理を追加。

---

### 🟡 MEDIUM — 次のステップ

#### BL-6: SQLite タスクキュー（amux パターン）

複数セッションで同じタスクを重複実行しないための原子的タスク分配。

```sql
-- 5行のCAS（Compare-And-Swap）パターン
UPDATE tasks
SET status = 'claimed', session = ?
WHERE id = (
  SELECT id FROM tasks
  WHERE status IN ('todo', 'backlog')
  ORDER BY priority DESC
  LIMIT 1
)
```

外部依存ゼロ（Node.js標準の `better-sqlite3` のみ）。`ccmux queue add/claim/done` コマンドとして実装候補。

---

#### BL-7: Obsidian MCP サーバー統合

`igorilic/obsidian-mcp` の `write_session_report` ツールをStop hookから呼び出す。
現状のObsidian連携（REST API直接叩き）より保守性が高い。

```bash
# claude mcp add obsidian \
#   -e OBSIDIAN_API_KEY=<key> \
#   -- npx -y obsidian-notes-mcp
```

---

#### BL-8: Qwen トークンカウント補正

Qwen3-Coder はtiktokenのカウントより実際のトークン数が1.5〜2倍多い（Letta issue #3288）。
圧縮トリガーの閾値を50%に下げることで実質的に補正する。

---

### 🟢 LOW — 将来

#### BL-9: `ccmux orchestrate` — 階層型マルチセッション

1つのプランナーセッションが複数ワーカーセッションを管理するパターン。
Claude Code Agent Teams（実験的, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`）が安定したら採用を検討。現状はamuxパターン（外部ファイルでの調整）の方が安定。

#### BL-10: E2B クラウドサンドボックス統合

`frankbria/parallel-cc` のパターン: ローカルで計画 → E2Bで実行 → 結果をgit syncして戻す。
完全無人運転（一晩放置）する場合の最終形。

---

## 5. 絶対に踏んではいけない地雷

### 🚨 セキュリティインシデント（実証済み）

| インシデント | 原因 | 対策 |
|---|---|---|
| 本番DB全消去（#27063） | `drizzle-kit push --force` の自動実行 | BL-2のblocklist |
| 本番サービス起動（#45523） | `docker compose up -d` の自動実行 | BL-2のblocklist |
| 認証情報漏洩（#32616） | `.env`/Vaultの自動読み取り→表示 | PreToolUseで機密ファイルの表示をブロック |
| 1008ファイル破壊（#54436） | スコープ拡大の自動実行 | TASK_STATE.mdで明示的スコープ定義 |
| CVE-2025-59536 | 悪意あるリポジトリのhook経由でRCE | 信頼できないリポジトリでは`--sandbox`必須 |

**最重要教訓**: **CLAUDE.mdのルールはモデルが読んで無視する**。
プロセス外のPreToolUseフックと`maxTurns`だけが確実な防御手段。

---

### ⚠️ 技術的地雷

**デッドロックバグ（Context full + Stop hook）**
```
ralph-loop実行中 → contextが満杯 → Stop hookが発火
→ Stop hookがstopをブロック（exit 2）
→ でもcontextが満杯でcompactionもできない
→ 無限ループ → トークンを燃やし続ける
```
→ BL-3のサーキットブレーカーで対処

**Qwen + tiktoken不一致**
```
Qwen3-Coderでは tiktoken のカウントが実際の2倍以上ずれる
→ "まだ余裕あり"と思ってたら実はcontext満杯
→ リクエスト全失敗 → エラーメッセージ蓄積 → さらに悪化
```
→ OLLAMA_CONTEXT_LENGTH=131072 + 圧縮閾値を50%に設定

**Webhook HMAC未検証（現状）**
```
現在の ccmux serve は署名を検証していない
→ 誰でも POST /webhook/github に任意のissueを送れる
→ 攻撃者がccmux autoセッションを任意に起動できる
```
→ BL-1を最優先で実装

**`allowedTools` は bypassPermissions モードで無効**
```
settings.json に allowedTools: ["Read"] と書いても
--dangerously-skip-permissions では全ツールが許可される
```
→ `permissions.deny` (disallowedTools) を使うこと

---

## 6. ローカルLLM運用ガイド

### モデル選定

| VRAM | 推奨モデル | コンテキスト | 特徴 |
|---|---|---|---|
| 24GB+ | `qwen3-coder` (80B MoE, 3B active) | 256K | ベスト選択。Claude Code統合向け設計 |
| 24GB | `qwen2.5-coder:32b` | 128K | 密モデル。HumanEval 92.7%, SWE-bench 50.0% |
| 8GB | `qwen2.5-coder:7b` | 128K | 54tok/s、CodeLlama 70Bより高性能 |
| 服务端 | `qwen3-coder-480b` (35B active) | 256K | マルチGPU。最高品質 |

**避けるべきモデル**: CodeLlama（コンテキスト16K、tool calling非対応）、Codestral（FIM特化、エージェント用途に不向き）

### Ollama設定

```bash
# 必須: 長時間タスクには十分なコンテキストを確保
export OLLAMA_CONTEXT_LENGTH=131072   # 128K (最低限)
# または
export OLLAMA_CONTEXT_LENGTH=262144   # 256K (qwen3-coderフルコンテキスト)

ollama serve
```

### qwen3-coder の既知の失敗パターン

1. **ツールコールスキーマ不一致**: 汎用OpenAIエンドポイントを使うと、ツール呼び出しを自然言語でアナウンスするだけで実際には実行しない。Ollama/SGLang/vLLM の専用パーサーを使うこと。
2. **`<think>` ブロックとツールコールの混在**: 一部のパーサーがアシスタントメッセージの先頭から解析しようとして失敗する。Ollama v0.14.0以降では修正済み。
3. **フロントエンド/UI作業**: qwen3-coderの技術レポートで「フロントエンドは苦手」と明記されている。UI作業にはクラウドモデルにフォールバックすること。

### クラウドフォールバックの判断基準

| 状況 | 推奨 |
|---|---|
| 10ターン超えても正解に辿り着かない | クラウドに切り替え |
| マルチファイル + アーキテクチャ変更 | Sonnet 4.6以上 |
| フロントエンド/UI作業 | クラウド必須 |
| 本番に影響するコマンド実行前 | 人間レビュー必須 |
| コスト計算・財務ロジック | クラウド推奨 |

---

## 7. コンテキスト管理戦略

### 定量的閾値（rottencontext.com 調査）

| 指標 | 推奨値 | 根拠 |
|---|---|---|
| 有効コンテキスト上限 | 256K tokens | 1M+でも75%超で品質劣化 |
| 圧縮トリガー | 50% utilization | 75%超から劣化開始 |
| CLAUDE.md / rules | 300行以内 | コンテキストが貴重 |
| MEMORY.md | 200行以内 | ハードカットオフ |
| 1タスク1セッション | 厳守 | 混在が品質劣化の主因 |

### フェーズ分離原則

```
研究セッション  → 実装セッション  → レビューセッション
  (調査のみ)      (コードのみ)      (確認のみ)
```
絶対に混在させない。

### 構造化 `/compact` インストラクション

コンテキスト圧縮時は以下のフォーマットで実行:
```
/compact [COMPACT #N | NEXT: <1文> | DECISIONS: <主要決定> | DEAD_ENDS: <失敗した試み> | TASK_STATE: TASK_STATE.md参照]
```

**注意**: PreCompactフックはmanual `/compact`では動かない（Issue #13572未修正）。
`SessionStart source="compact"` フックが唯一確実な圧縮後復旧手段。

### STATE.md ドリフト回復パターン

Claudeが迷走しはじめたら:
1. `STATE.md` に「現在の状態」「次のステップ」を書く
2. 新しいセッションを開始
3. `STATE.md` と関連ソースファイルのみをロード
4. 迷走した会話は捨てる（回復しようとしない）

---

## 8. エコシステムマップ

### 類似ツール比較

| ツール | 言語 | 特徴 | ccmuxとの関係 |
|---|---|---|---|
| **amux** (mixpeek/amux) | Python | SQLite CAS、モバイルPWA、艦隊管理 | SQLite CASパターンを借用候補 |
| **ccmux** (TheHumbleTransistor) | Python | TUI、`ccmux.toml` post-create hooks | 同名別プロジェクト。post-create hookアイデアを参考に |
| **parallel-cc** (frankbria) | TypeScript | E2B sandbox、MCP 16ツール | E2B統合パターン参考 |
| **Claude Squad** | - | マルチエージェント管理 | 参考 |
| **Vibe Kanban** | - | カンバンUI | 参考 |

### Obsidian MCP サーバー

| 実装 | ツール数 | 特徴 |
|---|---|---|
| tylernford/obsidian-mcp | 15 | Dataview DQL対応 |
| igorilic/obsidian-mcp | - | `write_session_report`ツール（ccmux向き） |
| krisk248/obsidian-notes-mcp | 18 | Bun使用、`npx`1行セットアップ |

### メモリ永続化

| ツール | 特徴 |
|---|---|
| memory-bank-mcp | クロスセッションメモリのMCP経由アクセス |
| Context Portal | MCP経由の構造化メモリ |
| Auto-Dream (`/dream`) | 自動デduplication + アーカイブ（デフォルト24時間ごと） |

---

## 9. 参考リポジトリ・論文

### 実装パターン

| リソース | URL | 用途 |
|---|---|---|
| amux | github.com/mixpeek/amux | SQLite CAS タスクキュー |
| Live-SWE-agent | github.com/OpenAutoCoder/live-swe-agent | ランタイムツール合成 |
| Agentless | github.com/OpenAutoCoder/Agentless | シンプルタスク向けlocalize→repair |
| Reflexion | github.com/noahshinn/reflexion | Actor/Evaluator/Self-Reflector実装 |
| claude-bubblewrap | github.com/evilsquid888/claude-bubblewrap | bubblewrap/firejailラッパー |
| ralph-loop plugin | anthropics/claude-plugins-official | Stop hookベースの反復ループ |
| claude-meta | github.com/aviadr1/claude-meta | CLAUDE.md自己改善メタルール |

### 論文

| 論文 | 概要 |
|---|---|
| Reflexion (NeurIPS 2023) | 言語による強化学習、Actor/Evaluator/Self-Reflector |
| PARC (arxiv:2512.03549) | マルチエージェント プランナー+ワーカー |
| AgentSpawn (arxiv:2602.07072) | 動的エージェント生成+メモリ転送 |
| InfiAgent (arxiv:2601.03204) | ファイル中心永続状態、事実上無限実行時間 |
| ROMA (arxiv:2602.01848) | 再帰型メタエージェント Atomizer/Planner/Executor/Aggregator |
| Wink (arxiv:2602.17037) | エージェント誤動作の分類、非同期自己介入で90%回復 |
| SWE-Edit (microsoft) | Viewer+Editorサブエージェントパターン、-17.9% inference cost |
| CCA (arxiv:2512.10398) | 階層メモリ+適応圧縮スキャフォールド |

### ベンチマーク

| ベンチマーク | 用途 |
|---|---|
| SWE-bench Verified (500件) | 現在の標準（75-80%で飽和中） |
| SWE-bench Pro (1865件) | マルチファイル、エンタープライズ難度 |
| 内部リポジトリベンチマーク | git履歴からissue→修正ペアを採掘。無料・汚染なし・最も実用的 |

---

## 10. 第4回 exa深堀調査（2026-05-19）— 根本原因 & ベストプラクティス監査

> 監査時点の指摘（README/コード乖離、TLS bypass、TOCTOU lock、HMAC、worktree race など）を起点に、
> 10テーマ×10クエリ = 100件のexa調査をサブエージェント並列で実施。
> 各テーマで **TOP3 根本原因 + TOP5 ベストプラクティスギャップ** を抽出。

### 10.1 TLS / Bearer / シークレット管理 (`integrations/`)

**根本原因**
1. **Bearer over HTTP** (`autoclaw.ts:1,28,112`, `n8n.ts:49` default) — RFC 6750 Bearer は TLS 前提。localhost も DNS rebinding 経路で攻撃可能。OWASP API2:2023。
2. **`rejectUnauthorized: false`** (`obsidian.ts:52`) — "暗号化はされるが認証なし" の MITM 状態。Obsidian Local REST API 公式は自己署名証明書の trust を推奨。
3. **TLS opt-in 設計** — Node 22 / 業界トレンドは "TLS デフォルト ON"。

**ベストプラクティス対応**
- `rejectUnauthorized: false` を削除し、`ca` オプション + SPKI ピンニング (or `NODE_EXTRA_CA_CERTS`)
- `Authorization: Bearer` を `http://` で送る場合は `allowInsecure: true` の明示同意を必須に
- トークン保管を OS keychain (`keytar` / `Bun.secrets` / `libsecret`) へ移行、env-var はフォールバック
- すべての localhost エンドポイントに Host/Origin 検証 + 127.0.0.1 bind 必須
- 静的 Bearer → 短命 token + 80% TTL でリフレッシュ (single-flight mutex)

### 10.2 ファイルロック & TOCTOU (`core/lock.ts`, `core/session.ts`, `core/cost.ts`)

**根本原因**
1. **acquireLock の非アトミック復旧** (`lock.ts:15-41`) — `wx fail → readFile → kill(pid,0) → unlink → wx` の4 syscall race。CWE-367 symlink 攻撃 (`O_NOFOLLOW` なし)。
2. **PID 生存判定が不十分** — `kill(pid,0)` は PID リサイクル後の別プロセスにヒット。py-filelock は startTime + bootId で対策済。
3. **sessions.json に読み書きロックなし、fsync なし** — `temp+rename` だけでは crash で 0-byte ファイル化。`cost.ts` の `_cache` も mutex 無し。

**ベストプラクティス対応**
- `proper-lockfile` 採用（mkdir-based, mtime heartbeat, `onCompromised`, `signal-exit` 自動クリーンアップ）
- `write-file-atomic` で fsync + parent dir fsync + same-dir tmp 保証
- ロックファイルに `{pid, startTimeNs, bootId}` を保存し PID リサイクル耐性
- `readDB → mutate → writeDB` を必ず writer lock 内で実行。長期的には better-sqlite3 + WAL に移行
- `fetchCcusage()` を single-flight Promise でラップ
- daemon 化するなら systemd `Type=notify` + `sd_notify("READY=1")` を採用 (PID file 不要)

### 10.3 SQLite WAL & キュー (`core/queue.ts`)

**根本原因**
1. **`busy_timeout` が接続ごとにリセット** — 新接続で `PRAGMA busy_timeout=N` を再発行しないと SQLITE_BUSY を即発生。Windows の `LockFileEx` 粒度 (15ms) が EBUSY を増幅。
2. **SELECT-then-UPDATE の claim レース** — fencing token (`attempts`) なしの release は stale worker が re-claim 済みジョブを削除可能。
3. **PASSIVE 自動 checkpoint の枯渇** — 長い書き込み txn が writer lock を保持 → WAL が肥大 → Windows EBUSY。

**ベストプラクティス対応**
- 接続生成ヘルパーで `journal_mode=WAL`, `busy_timeout=5000-30000`, `synchronous=NORMAL`, `journal_size_limit` を必ず設定
- claim を `BEGIN IMMEDIATE` + `UPDATE … WHERE id=(SELECT … LIMIT 1) RETURNING …` の単一文に
- visibility timeout + dead-letter キュー（SQS スタイル）に移行、boolean lock 撤廃
- 定期的に `PRAGMA wal_checkpoint(RESTART)` を実行、WAL サイズをメトリクス化
- NFS/SMB パス検出で `CCMUX_QUEUE_DISABLED` を自動 ON

### 10.4 git worktree 並行性 (`core/worktree.ts`)

**根本原因**
1. **`.git/worktrees/` の admin dir 作成 race** — 並列 `worktree add` で commondir 未書き込みのまま読まれる (git 2.53 でも再現)。
2. **`--porcelain` フォーマットドリフト** — `locked`, `prunable` attr 追加で stanza-based parser が壊れる。inverted logic と相まって誤判定。
3. **クラッシュ後の admin dir / branch リーク** — `gc.worktreePruneExpire` 既定3ヶ月。`fatal: 'X' is already checked out at ...` で branch 再利用不可。

**ベストプラクティス対応**
- 全 `worktree add|remove|prune` を `flock(2)` on `<repo>/.git/ccmux-worktree.lock` でシリアライズ
- デフォルトを **detached HEAD worktree** に切り替え (parent HEAD 汚染防止、Codex/Container-Use 流儀)
- worktree ベースを `<repo>/.ccmux/worktrees/<id>` に移動 (`.gitignore` 追加)
- `extensions.worktreeConfig=true` で per-worktree `core.sparseCheckout` / submodule override を分離
- 起動時に冪等な reconciler: `worktree list --porcelain -z` → prunable/missing 除去 → `git branch -D` → `prune --expire=now`

### 10.5 HMAC Webhook (`integrations/n8n.ts`)

**根本原因（既存実装は基本的に堅実）**
1. **リプレイ防止なし** — `X-GitHub-Delivery` UUID を保存していない。捕獲した署名済みリクエストの再送が無制限。
2. **タイムスタンプバインディングなし** — GitHub は body のみ署名。コールドリスタートで replay window が開く。
3. **静的シークレット 1 個、ローテーション経路なし** — Stripe/Loop 流の dual-secret accept-list が無い。

**ベストプラクティス対応**
- `X-GitHub-Delivery` を 24h TTL LRU で dedupe、duplicate は 200 OK 返却で冪等化
- `CCMUX_WEBHOOK_SECRETS`（CSV）で複数シークレット並行受け入れ → ゼロダウン rotation
- `X-GitHub-Event` allowlist + payload schema 検証 (CVE-2026-21894 n8n Stripe verify bypass 教訓)
- `sha256=` 接頭辞を非定数時間で先に検証 → 残り 32 bytes だけ `timingSafeEqual`
- n8n 側は `$rawBody` で署名生成（`JSON.stringify($json)` は RFC 8785 非準拠で mismatch の原因）

### 10.6 サンドボックス（`commands/auto.ts` bubblewrap）

**根本原因**
1. **AF_UNIX 経路が `--unshare-net` で塞がれない** — docker.sock, ssh-agent, gpg-agent, mitmproxy, 他 ccmux pane の tmux socket への lateral movement 可能。Anthropic sandbox-runtime は seccomp で `socket(AF_UNIX,…)` をブロック済み。
2. **クレデンシャル漏洩経路** — `$HOME` を rw bind し `~/.ssh`, `~/.aws`, `~/.config/gh` を deny しなければ、プロンプトインジェクション 1 回で token 盗難 → 合法な `git push` で外部送出。
3. **seccomp + capability + namespace 制御なし** — `unshare/clone3 CLONE_NEW*`, `ptrace`, `bpf`, `mount`, `keyctl`, `userfaultfd`, `io_uring_setup` 等の LPE primitive 未閉鎖。

**ベストプラクティス対応**
- mitmproxy / Squid sidecar で egress allowlist（`api.anthropic.com`, npm, github）。CONNECT bypass 禁止、169.254.169.254 ブロック
- Landlock LSM (ABI v3+, WSL2 kernel 6.6+ 対応) を bwrap と二段構え
- Anthropic 流 `apply-seccomp` を移植して AF_UNIX + namespace syscall を制限
- tmpfs `$HOME` + `~/.claude` のみ rw bind、`~/.ssh ~/.aws ~/.gnupg ~/.config/gh ~/.kube ~/.docker /var/run/docker.sock` を deny
- WSL2 検出 + Ubuntu 24.04 AppArmor プロファイル自動配置、WSL1 では起動拒否

### 10.7 ターミナルマルチプレクサ (`core/zellij.ts`)

**根本原因**
1. **Zellij CLI の per-pane addressability 欠如** — `action write-chars` はフォーカス pane のみ。`new-pane` がフォーカスを奪う。tmux の `send-keys -t %3` 同等が存在しない。
2. **IPC socket が `$XDG_RUNTIME_DIR` 依存** — SSH/iTerm/mobile クライアント間で session が見えなくなる。ログアウトで wipe。
3. **stable pane id なし + env 非継承** — `kill-window` は pty に SIGHUP するだけ、子プロセスの実停止保証なし。

**ベストプラクティス対応**
- pane addressing は `zjctl` / `amux` パターン（WASM プラグイン or per-pane FIFO）を採用
- `zellij action subscribe --format json` (NDJSON) + tmux `pipe-pane -o` でストリーミング観測性を確保
- 長寿命エージェントは `systemd-run --user --scope` (or `setsid`) で multiplexer の cgroup から分離
- `session_serialization true` + `pane_viewport_serialization true` + `--force-run-commands`
- エラーを無音 swallow せず分類（socket-missing → degrade / pane-id-stale → resync / permission-denied → surface）

### 10.8 TASK_STATE / Reflexion / コンテキスト圧縮 (`core/taskstate.ts`, `commands/reflect.ts`)

**根本原因**
1. **TASK_STATE.md が非構造化、`lastSummarizedMessageId` バージョンポインタなし** — compaction で silent drift、完了タスクの replay or 失敗の skip が発生。Sourcegraph Amp は compaction 自体を retired。
2. **`reflect.ts` の CLAUDE.md 自動書き換えに regression gate なし** — HumanLayer 計測の ~150-200 命令 ceiling と Claude Code 既定 ~50 を考えると無制限追記で全 session 劣化。
3. **Bash `echo > TASK_STATE.md`** — Write ツールの hooks/ログを bypass、非アトミック。並列 pane / subagent worktree で破損。

**ベストプラクティス対応**
- Anthropic `compact_20260112` beta + `pause_after_compaction: true` で TASK_STATE を verbatim 再挿入。trigger を context window の 70-75%
- Reflexion 出力先を CLAUDE.md ではなく `.claude/skills/reflections/SKILL.md` に分離（procedure は Skill、fact は CLAUDE.md）
- TASK_PROMPT.md を構造化 handoff artifact として実装（Intent / Phase / Completed / Remaining / Constraints / Failures、`task_id` 派生パス）
- reflect 自動ルールは golden-prompt eval suite で P→F flip 閾値超過なら自動 revert (`ccmux reflect --revert <id>`)
- CLAUDE.md は 60-300 行で cap、超過分は `@import` 化。memory item 30 個上限で剪定

### 10.9 n8n → エージェント オーケストレーション (`n8n-workflows/github-issue-to-ccmux.json`)

**根本原因**
1. **GitHub と code-executing agent 間に認可レイヤなし** — `author_association` / org membership / label gate のチェックなし。public repo で誰でも prompt-injection-as-a-service。
2. **冪等性なし** — `X-GitHub-Delivery` を捨てているので dedupe 不可。再配信 = 重複 session 起動。
3. **同期 fan-out で backpressure なし** — N issue 同時オープン → N 並列 Claude session、課金直撃。

**ベストプラクティス対応**
- `cline/claude-issue-triage` 流の allowlist（OWNER/MEMBER/COLLABORATOR）+ label gate
- HTTP Request ノードに idempotency key、3-state (processing/processed/failed) tracking
- セッション起動時に `--max-turns`, `max_tokens`, USD ceiling を注入（ATXP 流 pre-funded balance）
- `CLAUDE_CODE_ENABLE_TELEMETRY=1` OTLP + Error Trigger ノード → DLQ + Slack 通知
- シークレットを `$env` ではなく n8n Credential 化、`N8N_ENV_FEAT_ENCRYPTION_KEY_ROTATION` 有効化
- 長期的には Inngest / Trigger.dev v3 を実行層、n8n を intake 専用に役割分担

### 10.10 ローカル LLM ルーティング (`integrations/autoclaw.ts`, `litellm-config.example.yaml`)

**根本原因**
1. **`ANTHROPIC_BASE_URL` 直叩き Ollama** — Claude Code は Anthropic Messages API のヘッダ/SSE に敏感。LiteLLM 経由でも 403/unknown errors 既報。
2. **fallback chain が exception-only、未テスト** — 401/403/404 を 10 分リトライ後 cascade。bad response / latency breach では trigger しない。
3. **キャンセル伝播なし** — `AbortSignal` 未接続。ユーザが turn を kill しても Ollama は完走を続け GPU を専有。

**ベストプラクティス対応**
- 既定 backend を **llama.cpp `llama-server`** (single user) または **vLLM** (並列) に変更、Ollama は prototyping 限定
- `BudgetManager` + Redis で `max_budget`/`budget_duration`、provider 別 tokenizer 必須（`cl100k_base` 一律は誤計上）
- `ANTHROPIC_AUTH_TOKEN` を既存 OAuth credential と共存させず、検出して拒否 + 警告
- 名前ベース 1:1 alias を heuristic classifier に置き換え (token-count + tool-call presence → local、低信頼 → cloud escalate)
- `ccmux doctor` で VRAM 要件 (`params*bpw + ctx*kv_per_token + 25%`) を事前検証、`OLLAMA_KEEP_ALIVE=30m`

### 横断テーマ — まとめて見える地雷

| カテゴリ | 共通パターン |
|---|---|
| **暗号化 opt-in** | TLS / HMAC ローテ / Bearer 経路、全部 opt-in。"デフォルトで安全" に統一すべし |
| **冪等性の欠如** | webhook, queue claim, sessions.json mutate、全部 race or replay 経路あり。idempotency key 全層導入 |
| **silent swallow** | lock 失敗 / zellij action / obsidian POST / autoclaw routeTask、エラー隠蔽が連鎖していて根本原因が追えない |
| **非構造化 markdown 永続化** | TASK_STATE.md, CLAUDE.md, handoff note。構造化 (frontmatter + schema + version ID) しないと compaction で崩壊 |
| **クレデンシャル平文** | config.json / env 文字列、OS keychain 未使用 |
| **observability ゼロ** | OTLP / DLQ / cost-per-session の計測ハンドルなし。`reflect` の効果検証も不可能 |

### 推奨 next actions（優先順）

1. **P0**: `obsidian.ts:52` の `rejectUnauthorized: false` 削除 + CA pinning（即修正）
2. **P0**: `prune.ts:47` deleteWorktree の `worktreeBase` 引数欠落（前回監査 Critical #1）
3. **P1**: `proper-lockfile` 採用で `lock.ts` 全置換、`write-file-atomic` で session DB 保護
4. **P1**: `X-GitHub-Delivery` dedupe + multi-secret 受け入れ
5. **P2**: TASK_STATE を構造化 schema + `pause_after_compaction` 連携
6. **P2**: bwrap に seccomp プロファイル追加、`$HOME` deny-list 整備
7. **P3**: SQLite queue を visibility-timeout + DLQ に再設計
8. **P3**: ローカル LLM デフォルトを llama-server / vLLM に切替、`AbortSignal` 配線

詳細出典 URL は本 commit の audit メッセージもしくは `ccmux reflect --history` 参照。

---

## 11. 第5回 exa深堀調査（2026-05-19）— 直交テーマで再深掘り

> 第4回と被らない10テーマ（hooks, subagent orchestration, observability, resilience,
> CLI UX, testing, supply chain, cross-platform, commit safety, disaster recovery）に
> 10クエリずつ exa 調査を並列実施。前回の表面的監査では見えなかった「業界では既に解決済みの
> パターン」「Anthropic 自身の最新ガイダンス」「2026年の攻撃事例」を中心に抽出。

### 11.1 Claude Code hooks 設計 (`core/hooks.ts`)

**根本原因**
1. **`~/.claude/settings.json` 自動書き換えが CVE-2026-21852 / GHSA-ph6w-f82w-28w6 の攻撃面を再現** — npm postinstall, Mini Shai-Hulud, Cozempic 型のドロッパに silent code execution 経路を開く。ユーザに hooks 追加の差分が見えない。
2. **`bash → node` per invocation の性能アンチパターン** — macOS/Linux で 35-75ms、Git Bash で 200-500ms。5 hooks × 全 tool call で 300-500ms オーバーヘッド、Windows では 5 分ハングや "every-other-message" デッドロック既報。
3. **`tool_input.command` regex blocklist はバイパス可能** — `cd dir && rm -rf …`, `|`, `;`, `&` チェーンを `^`-anchored matcher が通す。`permissionDecision:"allow"` 戻り値が native permission prompt を黙って無効化する仕様バグ (#28812)。

**ベストプラクティス対応**
- 設定書き換え前に diff + ユーザ同意、`ccmuxVersion` センチネル書き込みで idempotency 担保
- blocklist は `re.split(r'\s*(?:&&|\|\||[;&|])\s*', cmd)` でサブコマンド分解、allow パスは無返答、deny は `exit 2`（JSON allow ではなく）
- Stop hook ccusage は append-only JSONL + `flock` + `session_id` キー、ccusage 自身の JSONL を真実の源に
- 単一カウンタの circuit breaker から Closed/Open/Half-Open ステートマシン + 進捗無しでの token 累積検出に
- subshell を `bash --norc --noprofile` + `env -i` で起動、`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`、`ConfigChange` hook で settings 改ざん検知

### 11.2 Subagent / マルチエージェント orchestration (worktree-per-pane モデル)

**根本原因**
1. **orchestrator 不在のピア fan-out** — Anthropic research-agent 流の hierarchical (orchestrator-worker) は CallSphere bench で flat swarm の約 40% コスト ($0.31 vs $0.74/task)。ccmux は flat なので kill criteria/retry/dedup を強制する場所がない。
2. **handoff が暗黙 (commits + branch 名のみ)** — Amp Handoff / OpenAI Agents SDK `input_filter` が標準化した 5 要素 (Objective/Constraints/Prior decisions/Current state/Next steps) を運んでいない。次の pane が同じ失敗を繰り返す。
3. **file-ownership contract なし** — 中規模 codebase では 5-10 pane で意味のある conflict 発生。AGENT_OWNERSHIP.md と pre-dispatch overlap scan (`clash` 流) が無いと last-writer-wins。

**ベストプラクティス対応**
- pane ごとに `~/.claude/projects/**/*.jsonl` をパースし `total_cost_usd` + cache-read を pane header に出す（`/cost` は subagent を 10倍 undercount, #43945/#46421/#48040）
- heartbeat mtime + max-iteration counter + same-tool-call-loop detector で watchdog、`stop_reason ≠ end_turn` で alert
- `.claude/settings.json` (local ではなく) を worktree 作成時にテンプレ展開、permission inherit hook をフォールバックに
- JSONL を `parent_tool_use_id` でグルーピングした session timeline ビュー
- `--container` モードで Dagger `cu stdio` MCP 経由のコンテナ隔離をオプション提供

### 11.3 Observability / OpenTelemetry (`core/cost.ts`, `dashboard.ts`, `logs.ts`)

**根本原因**
1. **`CLAUDE_CODE_ENABLE_TELEMETRY=1` 未設定** — Claude Code 自身が gen_ai.* spans / token counter / tool-decision events を OTLP で吐けるのに、ccmux が child env に流していないので全部捨てている。
2. **コスト計算が post-hoc 一発** — streaming token meter / per-tool-call attribution / per-worktree 集約 key / モデル価格レジストリ更新がない。Anthropic 値上げで即ドリフト。
3. **`console.log` がログ基盤** — JSON/levels/request-id/redaction フォーマットなし。prompt 内容のリーク防御もゼロ。

**ベストプラクティス対応**
- worktree → session → tool-call で W3C `TRACEPARENT` を child env に注入（claude-agent-sdk-python PR #821 パターン、Claude CLI ≥ v2.1.110 必要）
- gen_ai semantic conventions (`gen_ai.provider.name=anthropic`, `gen_ai.usage.input_tokens|output_tokens|cache_creation.input_tokens`, `gen_ai.conversation.id`) を保持
- pino `redact` + デフォルトで `gen_ai.input.messages` をキャプチャせず、`OTEL_LOG_TOOL_DETAILS` で明示 opt-in
- multi-window burn-rate アラート（Google SRE 流）: 3× rolling-7d token rate、no heartbeat > N min、error rate 2× baseline
- `~/.ccmux/replay/{sessionId}.jsonl` に hash-only JSONL、`ccmux replay <session>` で regression diff

### 11.4 Resilience patterns (retry / circuit breaker / bulkhead / timeout)

**根本原因**
1. **transient/permanent error 分類なし、リトライ層なし** — ECONNRESET / 503 / 429 一発で Ralph loop 中断。401/403/404/422 を retry しない原則も未実装。
2. **timeout レイヤリング不完全 + Undici の罠** — Undici 既定 10s `connectTimeout` は `AbortSignal.timeout()` で上書き不可 (#4215)、event loop blocking で spurious fire (#3410)。connect/TLS/headers/body/total の分離なし。
3. **child process の signal hygiene 不在** — `spawn` に `'error'`/`'spawn'` listener なし → ENOENT が uncaughtException 化。SIGTERM→drain→SIGKILL escalation なし、`detached:true` + 独自プロセスグループ + `signal-exit` なしでゾンビ蓄積。

**ベストプラクティス対応**
- **cockatiel** 採用 (Polly スタイル: retry+breaker+timeout+bulkhead+fallback が `wrap()` で合成、decorrelated-jitter デフォルト、AbortSignal フル対応)
- 依存ごとに `circuitBreaker(handleAll, { halfOpenAfter: 30s, breaker: new ConsecutiveBreaker(5) })`
- subprocess 起動に **`p-limit`** per dependency (claude=2, git=4, zellij=1) で bulkhead
- POST に UUIDv4 `Idempotency-Key` ヘッダ、リトライで再利用。endpoint 非対応なら `retryable:false` マーク
- CLI entry → integrations → child_process に single `AbortSignal` を `AsyncLocalStorage` で伝播、SIGTERM 時に `bulkhead.drain()` → `SIGKILL` フォールバック

### 11.5 CLI / TUI UX (`commander` + `chalk` + `ora`)

**根本原因**
1. **TTY/CI 検出なしで ANSI が pipe/CI ログにリーク** — `process.stdout.isTTY`/`NO_COLOR`/`CI`/`TERM=dumb` 分岐なし、`FORCE_COLOR=truecolor` の precedence バグ既知。
2. **`--json` がフラグであり契約ではない** — `schema_version` なし、envelope なし、`ccmux schema` introspection なし、stable key 保証なし。clispec.dev 原則 1-3 違反 → 完了補完と AI consumer が minor release で破壊。
3. **interaction-mode 二分法なし** — 破壊的操作 (rm/prune) に確認なし、`--yes/-y` バイパスなし、TTY なしでの prompt フォールバックなし。

**ベストプラクティス対応**
- `supports-color` で `NO_COLOR`/`FORCE_COLOR`/`TERM=dumb` 正しく扱う。`useColor()` ヘルパで単一化、ora に `{isEnabled: process.stdout.isTTY && !process.env.CI}` 渡す
- `--json` を `{schema_version:"1", data, error, warnings, meta}` envelope、JCS/RFC8785 key sort、`ccmux schema` で JSON Schema 返却、stdout/stderr 分離
- spinner を X/Y progress に、redraw を ≤30Hz スロットル、非TTY時は `logger.info("Progress: 50/100")`、SIGINT/SIGTERM でカーソル復元
- `gh`/`cargo` 流: 型付きエラーの cause chain ("could not X / Caused by: Y")、exit code 0/1/2/>2 ドキュメント化、Damerau-Levenshtein で "similar command: foo"
- `--yes`/`-y` で `@clack/prompts` 確認、TTYなしは hard-fail、`DO_NOT_TRACK=1` クロスツール標準サポート

### 11.6 Agentic システムのテスト戦略 (`tests/`)

**根本原因**
1. **real HTTP + real subprocess + real FS で全テスト一段化** — "ice-cream cone" anti-pattern。port collision、tmpdir worker race で Windows skip 連発。
2. **mock-LLM 境界なし** — 共通 mock (llmock/llm-mock-server) や record/replay (vcr-llm/PollyJS) を使わず stub を都度書く → Anthropic wire format ドリフト、SSE 決定論なし。
3. **parallel-safe seed 規律なし** — `VITEST_POOL_ID` 付き tmpdir 不採用、port 0 + read-back 未使用、time freeze なし、PRNG seed 制御なし。

**ベストプラクティス対応**
- PollyJS or 自作 JSONL recorder で `record once、playback in CI` の cassette パターン、API key を CI から除去
- golden-prompt regression: 20-50 タスク (input → expected tool-call sequence / file-tree outcome)、PR ごとに走らせて LLM-as-judge + deterministic assertions
- Lakera PINT / Meta CyberSecEval / PIArena を nightly でプロンプトインジェクション ASR 測定、regression gate
- queue/lock 不変条件に fast-check `fc.scheduler()` で property-based: "concurrent enqueue でジョブ消失なし", "lock が任意 interleaving で mutual exclusion"
- chaos: SIGKILL mid-stream, `truncate` ディスクフル, `tc netem` 遅延、`ink-visual-testing` で TUI PNG snapshot
- Vitest native v8 provider (3.2.0+ で AST-remapped) に coverage 切替

### 11.7 Supply chain security (`package.json`, `package-lock.json`)

**根本原因**
1. **postinstall 無制限実行** — `better-sqlite3` の `prebuild-install` postinstall hook を介して、TanStack (2026-04) / Axios (2026-03) 型攻撃で `.env` 全取り。`ignore-scripts` policy なし。
2. **lockfile integrity gate なし** — `package-lock.json` commit済だが `lockfile-lint` なし、`.npmrc` で registry pinning なし、`npm audit signatures` で Sigstore provenance 検証なし。
3. **`ANTHROPIC_API_KEY` を child Claude プロセスに env 継承** — 単一 transitive dep の postinstall malware で即漏洩。Anthropic は `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` を後追い導入済み。

**ベストプラクティス対応**
- `.npmrc` に `ignore-scripts=true`、better-sqlite3 は `npm rebuild --foreground-scripts` で明示 allowlist
- `lockfile-lint --validate-https --validate-integrity --allowed-hosts npm` を preinstall、`npm sbom --sbom-format=cyclonedx` を Release attach
- Dependabot weekly + 3-day `minimumReleaseAge` cooldown (50% の組織が release から 24h 以内に install するので Axios 級攻撃の 3h window を回避)
- CodeQL default JS/TS + ossf/scorecard-action weekly、npm publish は trusted publishing (OIDC, npm ≥11.5.1)
- 公開 CLI なので `npm-shrinkwrap.json` を ship、devDeps は `--save-exact` ピン

### 11.8 クロスプラットフォーム (WSL2 / Windows / macOS / Linux)

**根本原因**
1. **POSIX 前提が core architecture に焼き付いている** — bubblewrap (Linux), bash hooks, Zellij (Win 未成熟), Unix signals。Win native では `SIGTERM` が SIGKILL 等価 (or Node 23.4 以前で ENOSYS)、graceful shutdown 不可。WSL2 でテストすると問題が隠蔽される。
2. **path/FS 仮定が状態を silently 壊す** — `path.posix` vs `path.win32` 未分岐、`/mnt/c/...` リーク、case-sensitivity 差 (NTFS insensitive / ext4 sensitive / HFS+ NFD)、`fs.symlinkSync` が Admin/Developer Mode 必要。
3. **CI matrix が docs の約束を強制してない** — Windows/macOS-arm64 lane なし、`better-sqlite3` が node-gyp フォールバックで Xcode/VS Build Tools 必要化を発見できない。

**ベストプラクティス対応**
- `sindresorhus/is-wsl` で WSL 検出 (`/proc/version` は Docker 偽陽性)、`wslpath`/`wsl-path` で path 変換
- 取消プリミティブを signal から execa `gracefulCancel` + `AbortSignal` に、Windows は `taskkill /T` で tree-kill
- 単一 path helper で `path.posix` serialize / `fs.realpath` canonical / NFC 正規化 / 240char 超は `\\?\` prefix
- chokidar v4 で inotify/FSEvents/ReadDirectoryChangesW 差吸収、WSL `/mnt/*` は `usePolling:true`
- bubblewrap を sandbox 抽象化 (bwrap on Linux, sandbox-exec on macOS, Job Objects/AppContainer or no-op on Win)、`process.platform` ではなく capability check

### 11.9 git commit safety for autonomous agents (`commands/auto.ts`, `merge.ts`)

**根本原因**
1. **プロセスレベルで git hygiene を強制してない** — CLAUDE.md "`--no-verify` 使うな" は agent がプレッシャー下で無視する (#40117)。`mcp__github__push_files` / `merge_pull_request` は GitHub API 経由で local hooks を完全バイパス。
2. **agent commit に cryptographic identity なし** — GPG/SSH 署名なし、専用 bot account なし、署名鍵ローテ playbook なし。`Require signed commits` branch protection を満たせない、フォレンジック錨なし。
3. **auto-merge 経路 (`gh pr create` → merge) が governance を skip** — 同一 bot identity が作成と merge、required reviewers/required status checks/CODEOWNERS gate/secret scanning push protection なし。GitHub auto-merge race (enable 後 re-review 前に新コミット) と相まって unsafe。

**ベストプラクティス対応**
- `block-no-verify` を `PreToolUse` hook で hard block、`mcp__github__(push_files|create_or_update_file|merge_pull_request|delete_file|update_pull_request_branch)` も合わせて match、`exit 2` で deny
- ed25519 SSH 署名鍵を ccmux インスタンスごとに生成、`gpg.format=ssh`, `commit.gpgsign=true`、専用 `ccmux-bot` GitHub アカウントに登録、repo ruleset で `required_signatures` + 空 `bypass_actors`
- gitleaks + trufflehog を pre-commit & pre-push (lefthook で並列)、GitHub secret scanning push protection をサーバ側で有効化、`trufflehog --results=verified --fail`
- `prepare-commit-msg` hook で trailer 注入: `Agent-Session:<id>`, `Model:claude-opus-4-7`, `Task-Reference:<PR>`, `Cost-USD:<n>`, `Tokens-In/Out:<n>`
- `main` に repo ruleset: PR + 1 human approval, signed commits, linear history, dismiss stale approvals on new commits、`gh pr merge --auto` 禁止

### 11.10 Disaster recovery — crash / OOM / disk full / lost loop (`commands/auto.ts`, `core/queue.ts`)

**根本原因**
1. **durable execution substrate 不在** — Ralph loop の state が `sessions.json` / `queue.sqlite` / worktrees / bash-hook node に散在。append-only event log なし、`thread_id`-keyed checkpoint なし、idempotency key なし。crash 中の in-flight tool call が全消失、replay で重複 side effect (double commit, double 課金) リスク。
2. **liveness ≠ progress、ccmux はどちらも測ってない** — Repeater/Wanderer/Looper の AI 固有失敗モード (Hermes cache-loop #15654, Zylos) を `(progress_metric, recent_actions_deque, last_advance_ts)` で外部 supervisor が判別不能。
3. **state が脆く保護されてない** — `queue.sqlite` WAL モード未文書化、`PRAGMA integrity_check` boot check なし、`.recover` runbook なし。`~/.ccmux/` バックアップなし。ENOSPC で hook と parent loop 両死、SQLite WAL mid-frame 残し。

**ベストプラクティス対応**
- LangGraph 流 super-step checkpointing: 各 Ralph iteration 後に `{intent, tool_results, partial_diff_path, last_commit_sha, iteration_n}` を atomic 書き込み、起動時に git log + status から resume
- gateway 強制 quota: LiteLLM `max_iterations` + `max_budget_per_session`、per-session 200K-500K token cap、per-day $ cap、per-repo write-rate、"10% finalization budget" 予約
- `setInterval` heartbeat で `last_beat_ts` + `progress_hash` (git tree hash)、supervisor が unchanged > N min で kill。`fs.statfs` で `bavail < 1GB` 検出 → loop pause (crash ではなく)。`NODE_OPTIONS=--max-old-space-size=$(75% of cgroup memory.max)`、exit 137 trap
- `restic` (クラウド優先, dedup, AES-256) で `~/.ccmux/` nightly snapshot、SQLite は `.backup` + `-wal`/`-shm` 同時、compaction 直前に hourly
- 単一 `gracefulShutdown(reason)` を SIGTERM/SIGINT/`uncaughtException` にバインド、idempotent flag, `setTimeout(force_exit, 10_000).unref()`, 逆依存順 (新 prompt 停止 → in-flight drain → SQLite close → detached pgid kill)
- `ccmux postmortem <session>` で transcripts から decisions/insights/failures 抽出 (OpenExp/agent-xray パターン)

### 横断テーマ — 第5回で見えた地雷

| カテゴリ | 共通パターン |
|---|---|
| **Anthropic 自身が後追い対策済の脆弱性に未対応** | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, `apply-seccomp`, settings.json 自動書き換え保護、`CLAUDE_CODE_ENABLE_TELEMETRY=1` ーー Anthropic が既に出したガードレールを ccmux が活用してない |
| **プロンプトレベルの強制 vs プロセスレベルの強制** | CLAUDE.md ルール ≠ guardrail。`--no-verify` 禁止、blocklist、cost cap は全部 hook + ruleset で hard enforce すべし |
| **agent failure mode を観測する語彙の欠如** | Repeater / Wanderer / Looper / stuck / progress-without-output — メトリクス化されてないので supervisor が判別不能 |
| **業界が既に解決済の問題を再発明** | cockatiel / proper-lockfile / p-limit / cycloneDX / chokidar v4 / restic etc. NIH ではなく採用判断を |
| **CI matrix が約束未保証** | Windows/macOS arm64 lane 不在、property-based test 不在、chaos test 不在 — README が守られない |
| **handoff / observability / cost を独立データ層として扱ってない** | 全部 markdown or console に紛れ込んでいる。JSONL + JSON schema + trace ID で構造化が prereq |

### 第5回 next actions（優先順、第4回の P0-P3 と独立）

1. **P0 (即修正)**: `block-no-verify` PreToolUse hook、`mcp__github__*` API バイパス match 含む。設定書き換え bypass の即時封じ込め
2. **P0**: `CLAUDE_CODE_ENABLE_TELEMETRY=1` を child env に伝播、JSONL replay capture
3. **P1**: `cockatiel` で全 HTTP integration を retry+breaker+timeout+bulkhead 化、`AbortSignal` 配線
4. **P1**: `.npmrc` `ignore-scripts=true` + `lockfile-lint` preinstall、Dependabot cooldown 3 日
5. **P2**: `restic` snapshot 自動化、SQLite `.backup` + heartbeat watchdog
6. **P2**: `--json` envelope (`schema_version`) と `ccmux schema` 導入、TTY/CI 検出
7. **P3**: ed25519 SSH 署名鍵 + repo ruleset、`prepare-commit-msg` trailer 注入
8. **P3**: Windows/macOS-arm64 CI lane、PollyJS cassette、fast-check property-based

詳細出典 URL は本 commit の audit 記録参照。

---

## 更新ログ

| 日付 | 内容 |
|---|---|
| 2026-05-13 | 初版作成（3回のexa調査統合） |
| 2026-05-19 | 第10章追加：第4回 exa深堀調査（10テーマ×10クエリ、根本原因+ベストプラクティス監査） |
| 2026-05-19 | 第11章追加：第5回 exa深堀調査（直交10テーマ×10クエリ、hooks/orchestration/observability/resilience/UX/test/supply-chain/cross-platform/commit-safety/DR） |

---

> このWikiは `ccmux reflect` で蓄積されるルールと合わせて継続的に更新すること。
> 大きな発見があったら `docs/LAB-WIKI.md` に追記し、commitメッセージに `docs:` プレフィックスをつけること。
