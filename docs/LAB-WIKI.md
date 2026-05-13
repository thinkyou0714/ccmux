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

### 未実装・HIGH優先度 🔴

| 機能 | 理由 |
|---|---|
| **HMAC-SHA256 Webhook署名検証** | 現状セキュリティゼロ。外部からの偽装リクエストを受け入れる |
| **破壊的コマンドblocklist** | `drizzle-kit push --force`, `DROP TABLE`, `rm -rf` をhookでブロック |
| **Stop hookサーキットブレーカー** | Context full + Stop hook のデッドロックバグ対策 |
| **ccusageコスト連携** | セッション終了時に`costUSD`をTASK_STATE.mdに記録 |
| **SQLiteタスクキュー** | 複数セッション間の原子的タスク分配（amuxパターン） |

---

## 2. アーキテクチャ全体図

```
GitHub Issue
    │
    ▼ (Webhook + HMAC-SHA256検証 ← 未実装)
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

## 更新ログ

| 日付 | 内容 |
|---|---|
| 2026-05-13 | 初版作成（3回のexa調査統合） |

---

> このWikiは `ccmux reflect` で蓄積されるルールと合わせて継続的に更新すること。
> 大きな発見があったら `docs/LAB-WIKI.md` に追記し、commitメッセージに `docs:` プレフィックスをつけること。
