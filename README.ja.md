# gui-report-automation

[![test](https://github.com/lon-coeng/gui-report-automation/actions/workflows/test.yml/badge.svg)](https://github.com/lon-coeng/gui-report-automation/actions/workflows/test.yml)

*[English version](README.md)*

Linux VM 上で、**人間が開いたままにしている既存の Chrome セッションを借りて**日次レポート業務を自動化するパイプラインです。

ブラウザを自前で起動せず、ログイン状態・Cookie・多要素認証済みのセッションをそのまま利用します。認証情報を一切保存しないまま、管理画面からの CSV 取得 → Google Drive へのアップロード → GAS による集計 → チャット通知 → 後片付けまでを、失敗時に安全側へ倒れる形で実行します。

> Scheduled automation that borrows a long-running, human-owned Chrome session on a Linux VM
> to collect, aggregate and report daily metrics — without storing any credentials.

---

## 何が難しいか

**通常の Chrome と Playwright は同じプロファイルを同時に開けません。** 一般的な解法はブラウザを閉じて自動化用に開き直すことですが、それでは運用者が維持しているログイン状態が壊れます。ログイン情報をコピーする方式も、認証情報を保存することになり避けたい。

このリポジトリは「**閉じない・複製しない・保存しない**」を制約として受け入れた上で成立させています。

| 制約 | 採った手段 |
|---|---|
| Chrome を閉じられない | DevTools リモートデバッグを使わず、アドレスバーへの `javascript:` 注入で DOM を読む |
| ログイン情報を複製・保存しない | ウィンドウとタブを URL で特定し、可視コントロールを文字列完全一致で操作 |
| サービスアカウント鍵を置きたくない | GCE インスタンスの ID から対象 SA を短時間だけ代理利用（keyless） |
| 画面が実在しない（ヘッドレス VM） | 仮想ディスプレイのサイズを検証し、安全な最小モードを選択してから起動 |
| GAS メニューが DOM に出ない | スクリーンショット OCR にフォールバックし、日本語ラベルの誤認識バリアントも許容 |

## 設計上の判断

**冪等性を状態ファイルで担保する。** 報告対象日ごとに `state/<日付>.json` を書き、成功・失敗・結果不明のいずれでも記録します。同じ対象日は一度開始したら人間の確認なしに再実行されません。「失敗したから再試行」で二重投稿を起こさないための設計です。

**消す前に隔離する。** 実行開始前から存在したファイルと未完了の `.crdownload` は削除せず `quarantine/<実行ID>/` へ退避します。自動化が消してよいのは「自分が作ったと確認できたもの」だけ、という原則です。

**ダウンロードの完了を推測しない。** Chrome が同名ファイルに付ける `(1)`、` (1)`、`(2)` を同一対象として扱いつつ、サイズが3回連続で安定した1件だけを正規名で実行専用フォルダへ移し、以降はそのファイルだけを使います。

**結果が不明なときは進まない。** GAS の完了ダイアログがタイムアウトしても再実行はせず、読み取り専用の別経路（Sheets API）で結果を検証します。セル値の不足・不一致・数式エラー・API エラーはすべて安全停止です。

**認証は自動化しない。** 対象がログアウトしていた場合、アカウント選択画面で候補が可視状態でちょうど1件のときに限り選択します。パスワード・確認コード・CAPTCHA の自動入力は行わず、2段階認証や本人確認が要求された時点で失敗として記録し停止します。

**多段の安全ロック。** 実処理は `--live` と全安全フラグの明示的な有効化がそろわなければ開始しません。既定の `config/automation.json` は全フラグが `false` です。

## 構成

```
src/        現行方式の本体
  gui-live.js                   常駐Chrome方式のエントリポイント
  gui-runtime.js                アドレスバー注入・OCR・座標クリックの実行基盤
  gui-preflight.js              事前確認（副作用なし）
  gui-observe.js                画面ラベルのOCR確認のみ（クリック・DL・通知なし）
  run-state.js                  報告対象日ごとの実行状態
  drive-verification.js         Drive アップロード結果の検証
  import-sheet-verification.js  Sheets API による結果検証（keyless）
tools/      開発時の診断・限定実行ハーネス。本番経路には含まれない → tools/README.md
legacy/     最初に採り、捨てた Playwright 方式とその理由 → legacy/README.md
config/
  automation.json               既定（全安全フラグ off）
  automation.live.json          本番用
  automation.once.example.json  単発実行の例
systemd/    タイマー起動ユニット
test/       node:test による単体テスト
```

対象が外部の管理画面と本物のスプレッドシートなので、通しで動かして確かめることが
できません。`tools/` にある工程を区切ったハーネスは、そのために作ったものです。

なぜ Playwright でブラウザを制御する素直な方法を捨てたのかは
[legacy/README.md](legacy/README.md) に書いてあります。現行方式の制約は
そこから来ています。

## 使い方

```sh
sudo apt-get install -y xdotool xclip wmctrl

npm run resident-preflight   # 対象タブの存在確認のみ。副作用なし
npm run gui-dry-run          # タブ遷移の確認のみ。実処理なし
npm run resident-live        # 安全フラグを有効化した場合のみ実処理
```

設定は `config/automation.json` を複製して使います。対象管理画面の URL、Chrome プロファイル、スプレッドシート ID / gid、Drive フォルダをすべて設定で与える構造で、コード側に対象固有の値は持ちません。

```sh
npm test     # 単体テスト
npm run check # 構文チェック
```

テストは Node の組み込みモジュールだけで完結し、`xrandr` もモックするため、
依存のインストールも実ディスプレイも要りません。CI (Node 20 / 22) で全件通しています。

> `display guard` の2テストはシェルスクリプトの実行モデルに依存するため、Windows では失敗します。
> Linux / macOS では通ります。

## 技術スタック

Node.js 20+ / Playwright（診断用途のみ）/ systemd timer / Google Sheets API / Google Compute Engine / xdotool・xclip・wmctrl

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照してください。

委託元の承諾を得て、本番稼働中のシステムを匿名化した公開版です。
