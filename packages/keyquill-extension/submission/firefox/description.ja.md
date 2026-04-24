**Keyquill** は LLM API の「BYOK (Bring Your Own Key)」ウォレットです。OpenAI / Anthropic / Gemini などの API キーを拡張機能内に登録し、承認した Web アプリが、あなたのキーを使ってチャットを実行できるようにします。Web アプリ側やそのサーバーはキー本体を一切目にしません。

### 解決する問題

LLM API を使う Web アプリは通常、以下のいずれかを強いてきます:
- アプリのサーバーにキーを預ける（信頼が必要、漏洩リスク）
- `localStorage` にキーを保存する（XSS リスク）
- AI 機能を諦める

Keyquill は第四の選択肢: キーを拡張機能の独立プロセスに隔離し、Web アプリは狭く、ユーザー承認済みチャネルだけから補完を要求する。

### 使い方

1. ツールバーの Keyquill アイコンをクリック。プロバイダー（OpenAI / Anthropic / Gemini / Groq / Mistral / DeepSeek / Together / Fireworks / xAI / Ollama 等、OpenAI 互換なら何でも）を登録。API キーを入力
2. Keyquill SDK を組み込んだ Web アプリを訪問
3. そのアプリが初めてアクセスを要求すると、オリジン名を示す consent popup。承認 / 拒否を選ぶ
4. 承認済みアプリは補完呼び出しが可能。拡張機能の Service Worker が直接プロバイダーへ HTTPS で接続、ページはストリーミング応答だけを受け取る

### セキュリティ特性

- **キーは `browser.storage.session` に保存** — ephemeral（ブラウザ終了で消去）、通常の Web ページ JavaScript からアクセス不可
- **オリジン毎の consent**（MetaMask 方式）。あらゆるオリジンは popup で明示承認が必要。承認は `browser.storage.local` に保存、拡張ポップアップからいつでも取り消し可能
- **キー登録・削除は popup のみ**。Web ページからはキーの登録・削除・抜き出し不可
- **ゼロテレメトリ**。Keyquill が管理するサーバーへの接続はゼロ（そもそもサーバーが存在しない）。ネットワーク送信先はユーザーが選んだ LLM プロバイダーのみ

### v1.0 新機能 — ポリシーブローカー

すべてのリクエストはプロバイダーに届く前にユーザー所有のポリシーで仲介されます:

- **モデルポリシー**: allowlist / denylist / capability-only モード（キーごと）
- **予算キャップ**: 1 リクエスト / 日 / 月の USD 上限、block / confirm / warn を選択
- **プライバシー**: HTTPS 必須、プロバイダー許可リスト、origin 正規表現フィルタ
- **Capability-first API**: アプリは「必要な機能」を宣言、実モデルはあなたのポリシーが選ぶ
- **ポリシー違反時の consent popup**: 許可外モデルや高コスト時にモデル・推定コスト・理由を表示、1回 / 常に / 拒否 を選択
- **監査 ledger**: 全リクエストを origin / model / トークン / 推定・実コストで記録。origin フィルタ、CSV エクスポート、90 日保持
- **エラー多言語対応**（日本語 / 英語自動切り替え）

### 対応プロバイダー

OpenAI Chat Completions 形式を話せるものなら全てそのまま動作。Anthropic Messages API はネイティブ変換で対応。

動作確認済: OpenAI / Anthropic / Google Gemini / Groq / Mistral / DeepSeek / Together AI / Fireworks AI / xAI (Grok) / Ollama（ローカル）、その他 OpenAI 互換エンドポイント。

### 開発者向け

公式 SDK（v2 capability-first API）で Web アプリに組み込み:

```
npm install keyquill
```

```js
import { Keyquill } from "keyquill";
const quill = new Keyquill();
if (await quill.isAvailable()) {
  await quill.connect();
  const { completion } = await quill.chat({
    messages: [{ role: "user", content: "Hello" }],
    requires: ["tool_use"],
    tone: "precise",
    maxOutput: 1024,
  });
}
```

v1 SDK ユーザーは `keyquill@0.3.x` に pin し続けて問題ありません。拡張機能は両方の wire shape を受け付けます。

ドキュメント: https://github.com/R-Okauchi/keyquill

### リンク

- ライブデモ: https://r-okauchi.github.io/keyquill/demo/
- ソースコード (MIT): https://github.com/R-Okauchi/keyquill
- プライバシーポリシー: https://r-okauchi.github.io/keyquill/privacy-policy
- 問題報告: https://github.com/R-Okauchi/keyquill/issues
