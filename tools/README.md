# tools/

開発中に使った診断・限定実行のハーネスです。**本番の実行経路には含まれません。**

対象が外部の管理画面と Google スプレッドシートで、しかも実行のたびに
本物のレポートが配信されてしまう性質上、「通しで動かして確かめる」ができません。
そのため、工程を区切って安全に確かめるための入口を都度作っています。

## diagnose-*

画面の状態を読むだけのもの。クリック・ダウンロード・GAS 実行・通知は行いません。

| ファイル | 用途 |
|---|---|
| `diagnose-admin-controls.js` | 管理画面の可視コントロールを列挙する |
| `diagnose-admin-date-select.js` | 日付セレクタの選択肢と現在値を読む |
| `diagnose-drive.js` | Drive フォルダのタブ状態を読む |
| `diagnose-drive-file-elements.js` | Drive のファイル行の DOM 構造を読む |
| `diagnose-drive-menu.js` | Drive の右クリックメニューの項目を読む |

## limited-*

工程の一部だけを実行するもの。「どこまで進んだ状態から再開できるか」を
検証するために、開始地点を限定してあります。

| ファイル | どこから、どこまで |
|---|---|
| `limited-upload-import-test.js` | アップロードからインポートまで |
| `limited-import-only-retry.js` | インポートのみ再試行 |
| `limited-through-main-menu-test.js` | メインの GAS メニュー操作まで |
| `limited-resume-after-duplicate.js` | 重複検知で止まった状態からの再開 |
| `limited-after-confirmed-uploads.js` | アップロード確認済みの状態からの再開 |

## 注意

これらは安全フラグの一部を前提としており、実データに触れるものもあります。
本番環境で動かす場合は、対象日と対象シートを確認してから実行してください。
