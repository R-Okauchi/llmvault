import type { ErrorCode } from "./codes.js";

/**
 * Japanese user-facing messages. Phrased as actionable sentences —
 * 「次に何をすればいいか」がひと目で分かるように。
 */
export const ERRORS_JA: Record<ErrorCode, string> = {
  KEY_NOT_FOUND: "Keyquill キーが見つかりません。ポップアップからキーを追加してからもう一度お試しください。",
  NOT_CONNECTED: "このサイトはまだ Keyquill に接続されていません。アプリ側で Keyquill クライアントの connect() を呼んで接続を要求してください。",
  USER_DENIED: "接続リクエストを拒否しました。もう一度サイトを開いて、ポップアップで許可してください。",
  INVALID_KEY: "キーを保存できませんでした。API キーの値とベース URL を確認してください。",
  INVALID_REQUEST: "このサイトから未知の形式のリクエストを受け取りました。",
  BLOCKED: "この操作は Keyquill ポップアップからのみ実行できます。",
  UNKNOWN_ORIGIN: "リクエストの送信元を特定できませんでした。ページを再読み込みしてから再試行してください。",
  PROVIDER_UNREACHABLE: "プロバイダに接続できませんでした。ネットワーク接続とベース URL を確認してください。",
  PROVIDER_ERROR: "プロバイダからエラーが返されました。詳細はエラーメッセージを参照してください。",
  EMPTY_BODY: "プロバイダから空のレスポンスが返りました。",
  INTERNAL: "拡張機能内部で予期しないエラーが発生しました。",

  POLICY_HTTPS_REQUIRED: "このキーのポリシーは HTTPS を必須にしています。ベース URL が HTTP のままです。",
  POLICY_ORIGIN_BLOCKED: "このキーのポリシーでこの origin は許可されていません。ポップアップの Privacy タブで設定を確認してください。",
  POLICY_PROVIDER_BLOCKED: "このキーのポリシーでこのプロバイダは許可されていません。Privacy タブで許可リストを見直してください。",
  POLICY_NO_MODEL_MATCHES_CAPABILITIES: "このアプリが必要とする機能をすべて満たす許可モデルがありません。Policy タブの Model で対応モデルを追加してください。",
  POLICY_MODEL_DENIED_BY_POLICY: "リクエストされたモデルはこのキーの拒否リストに含まれています。リストから外すか、別のキーを選択してください。",
  POLICY_MODEL_OUTSIDE_ALLOWLIST: "リクエストされたモデルは許可リストにありません。承認ポップアップから許可するか、Policy タブでリストに追加してください。",
  POLICY_CAPABILITY_MISSING_FROM_MODEL: "選択されたモデルではこのリクエストに必要な機能（tool use や structured output など）を満たせません。別のモデルを選んでください。",
  POLICY_UNKNOWN_MODEL: "リクエストされたモデルは Keyquill のカタログに載っていません。拡張機能を更新するか、カタログ収録モデルを選択してください。",
  POLICY_BUDGET_REQUEST_OVER_LIMIT: "このリクエストの推定コストが 1 回あたりの予算上限を超えています。Policy タブで上限を引き上げるか、リクエストを拒否してください。",
  POLICY_CAPABILITY_ONLY_REQUIRES_DEVELOPER_CAPABILITIES: "このキーは capability-only モードですが、アプリが必要とする capability を宣言していません。",
  POLICY_CAPABILITY_ONLY_NO_PREFERRED_MODEL: "このキーは capability-only モードですが、必要な capability に対応する優先モデルが設定されていません。",

  POLICY_MODEL_OUTSIDE_ALLOWLIST_REJECTED: "リクエストを拒否しました：このモデルはキーの許可リスト外です。",
  POLICY_MODEL_IN_DENYLIST_REJECTED: "リクエストを拒否しました：このモデルはキーの拒否リストに含まれています。",
  POLICY_HIGH_COST_REJECTED: "リクエストを拒否しました：推定コストが 1 回あたりの予算を超えていました。",
  POLICY_CAPABILITY_MISSING_REJECTED: "リクエストを拒否しました：モデルが必要な機能を備えていませんでした。",

  POLICY_MODEL_OUTSIDE_ALLOWLIST_CONSENT_REQUIRED: "承認が必要：リクエストされたモデルは許可リストにありません。",
  POLICY_MODEL_IN_DENYLIST_CONSENT_REQUIRED: "承認が必要：リクエストされたモデルは拒否リストに含まれています。",
  POLICY_HIGH_COST_CONSENT_REQUIRED: "承認が必要：推定コストが 1 回あたりの予算を超えました。",
  POLICY_CAPABILITY_MISSING_CONSENT_REQUIRED: "承認が必要：リクエストが要求する capability を選択モデルが備えていません。",
};
