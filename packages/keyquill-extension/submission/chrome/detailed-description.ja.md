Keyquill は LLM API の「BYOK (Bring Your Own Key)」ウォレットです。OpenAI / Anthropic / Gemini などの API キーを拡張機能内に登録し、承認した Web アプリが、あなたのキーを使ってチャットを実行できるようにします。Web アプリ側やそのサーバーがキーを見ることは一切ありません。

解決する問題

LLM API を使う Web アプリは通常、以下のいずれかを強いてきます:
• アプリのサーバーにキーを預ける（信頼が必要、漏洩リスクあり）
• ページの localStorage にキーを保存する（XSS に脆弱）
• AI 機能を使わない

Keyquill は第四の選択肢を提供します: キーを拡張機能の独立プロセスに隔離し、Web アプリは狭く、ユーザーが承認したチャネル経由でのみ補完を要求できる。

使い方

1. ツールバーの Keyquill アイコンをクリックし、キー管理ポップアップを開く
2. プロバイダー（OpenAI / Anthropic / Gemini / Groq / Mistral / DeepSeek / Together / Fireworks / xAI / Ollama 等、OpenAI 互換なら何でも）を追加。API キーを入力
3. Keyquill SDK を組み込んだ Web アプリを訪問
4. そのアプリが初めてアクセスを要求すると、オリジン名を示す consent popup が表示される。承認 / 拒否を選ぶ
5. 承認済みアプリは補完を呼び出せる。拡張機能の Service Worker が直接プロバイダーへ HTTPS で接続し、Web ページはストリーミングされる応答テキストだけを受け取る

セキュリティ特性

• キーは chrome.storage.session に保存 — ephemeral（ブラウザ終了で消去）、通常の Web ページ JavaScript からアクセス不可
• オリジン毎の consent（MetaMask 方式）: Keyquill を使おうとするすべてのオリジンは popup での明示承認が必要。承認は chrome.storage.local に保存され、拡張ポップアップからいつでも取り消し可能
• キー登録・削除は拡張機能ポップアップからのみ可能。Web ページからはキーの登録・削除・抜き出しができません
• 拡張機能は分析情報・テレメトリ・ログを一切収集しません。あなたが選んだ LLM プロバイダー以外へのネットワーク通信はゼロ
• Keyquill が管理するサーバーは存在せず、拡張機能はそのようなサーバーと永続接続を張りません

v1.0 新機能 — ポリシーブローカー

すべてのリクエストは、プロバイダーに届く前にユーザー所有のポリシーで仲介されます:

• モデルポリシー: allowlist / denylist / capability-only モード。キーごとに使用可能なモデルを決定
• 予算キャップ: 1 リクエスト / 日 / 月の USD 上限。到達時に block / confirm / warn を選択
• プライバシー: HTTPS 必須、プロバイダー許可リスト、origin 正規表現フィルタ
• Capability-first API: Web アプリは「必要な機能」（tool use / reasoning / long context など）を宣言 — 実モデルはあなたのポリシーが選ぶ。アプリが勝手にプレミアムモデルへ切り替わる事故を防止
• ポリシー違反時の consent popup: 許可外モデルや高コストリクエストの際、モデル・推定コスト・理由が popup で表示。1回だけ / 常に許可 / 拒否 を選択
• 監査 ledger: 全リクエストを timestamp / origin / model / トークン / 推定・実コストで記録。origin で絞り込み、CSV エクスポート可能。90 日保持
• エラーメッセージは日本語 / 英語で自動切り替え（ブラウザの UI 言語を検出）

対応プロバイダー

OpenAI Chat Completions 形式を話せるものなら全てそのまま動作します。Anthropic Messages API はネイティブ変換で対応しています。

動作確認済: OpenAI / Anthropic / Google Gemini / Groq / Mistral / DeepSeek / Together AI / Fireworks AI / xAI (Grok) / Ollama（ローカル）、その他 OpenAI 互換エンドポイント。

開発者向け

公式 SDK（v2 capability-first API）で Web アプリに組み込めます:

    npm install keyquill

    import { Keyquill } from "keyquill";
    const quill = new Keyquill();
    if (await quill.isAvailable()) {
      await quill.connect();
      const { completion } = await quill.chat({
        messages: [{ role: "user", content: "Hello" }],
        requires: ["tool_use"],   // 必要な能力を宣言
        tone: "precise",           // temperature の抽象化
        maxOutput: 1024,
      });
    }

アプリは意図を宣言するだけ — 実際のモデル選定はユーザーのポリシーが行います。v1 SDK ユーザーは keyquill@0.3.x に pin し続けて問題ありません。拡張機能は両方の wire shape を受け付けます。

ドキュメント: https://github.com/R-Okauchi/keyquill

リンク

• ライブデモ: https://r-okauchi.github.io/keyquill/demo/
• ソースコード: https://github.com/R-Okauchi/keyquill
• プライバシーポリシー: https://r-okauchi.github.io/keyquill/privacy-policy
• 問題報告: https://github.com/R-Okauchi/keyquill/issues

ライセンス

MIT。拡張機能全体がオープンソースです。上記 GitHub リポジトリで全コードを監査できます。
