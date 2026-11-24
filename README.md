# Workshop Manager

Steam クライアントと連携してワークショップのアイテムを管理する、Windows 用のデスクトップアプリです。

## 起動

`dist\WorkshopManager.exe` をダブルクリックします。専用のウィンドウが開きます（ブラウザは使いません）。

- 終了するときはウィンドウを閉じます。
- 二重に起動しようとすると、既に起動している旨のメッセージを表示します。
- 設定は exe と同じフォルダの `data\` に保存されます。

## Steam クライアント連携

起動中の Steam クライアントに Steamworks API（ISteamUGC）で接続します。

- ログイン中のユーザーと、ゲームごとの購読状態（購読中 / 未購読 / インストール済み / 更新待ち / ダウンロード中）を表示します。
- 購読、購読解除、今すぐ更新（ダウンロード）ができ、進捗バーも表示します。「更新を全てDL」でまとめて更新できます。
- ID や URL を入力して購読できます。コレクション照合からは未購読のものをまとめて購読できます。
- 「Steam」タブで同期をオンにすると、有効/無効とロード順を Steam に反映します（Steam のローカル無効化に対応したゲームのみ）。
- Steam API の DLL（`steam_api64.dll`）は、インストール済みのゲームから Valve の署名が有効な新しいものを自動で選んで使います。exe と同じフォルダに置いた DLL があればそちらを優先します。

注意点:

- SteamAPI の仕組み上、接続中は Steam 上でそのゲームが「実行中/プレイ中」になります。そのため普段は接続しません。
  購読状態（`WorkshopItemDetails` の `subscribedby`）と更新の有無（`latest_timeupdated` > `timeupdated`）は `appworkshop_<appid>.acf` から読みます。
  接続するのは購読・購読解除・更新・検索・Steam 同期のときだけで、操作が終わってから 15 秒（`SteamManager.IDLE`）で切断します。
  「Steam」タブの「ゲームを選んだら自動で接続する」で、前と同じ常時接続にもできます。
- 所有していないゲームや、Steam が起動していないときは接続できません。その場合も、フォルダを読み取って管理する機能はそのまま使えます。

## v1.5 で追加した機能

| 機能 | 仕組み |
|---|---|
| 前提MODのチェック | アダプタの `deps()`（STS2 はマニフェストの `dependencies`）から依存グラフを作り、無効や不足を `⚠ 前提OFF/不足` で表示。有効にすると前提も有効にし、無効にするときは依存しているものを一緒に無効にするか確認 |
| 依存順に整列 | 前提が先に来るトポロジカルソート（ほかは今の順番を保つ）。`orderCustom` になるのでゲームにもロード順を書く |
| バックアップと巻き戻し | `features.Backups`。`data/backups/<appid>/<id>/<timeupdated>/files`。更新前と更新を見つけたとき（自動）に保存し、1 件につき最新 3 版を保持。戻すときは今の版も保存してから入れ替える |
| 起動時のプロファイル | `launch.profile` を `r_launch` で適用してから起動（ゲーム設定にも書き、Steam 同期中なら Steam にも反映） |
| ワークショップ検索 | Steam ワーカーの `CreateQueryAllUGCRequestPage`（ID だけ受け取り、詳細は Web API）。API キーは不要 |
| お掃除 | 未購読で残ったフォルダを `SHFileOperationW`（FOF_ALLOWUNDO）でごみ箱へ。削除できるのは `workshop/content/<appid>/<数字>` だけで、購読中なら拒否。消したものは `cleaned` に記録して表示しない |
| スイッチの説明 | ゲーム設定連動・Steam 同期・デプロイ・ツール内のみ、のどれに反映されるかをツールチップに表示 |
| 複数選択 | Ctrl/Shift+クリック、Ctrl+A。選択バーからまとめて操作 |
| プロファイルの差分 | 共有されたプロファイルを適用する前と「比較」ボタンで、有効になる/無効になる/未導入/順番を表示 |
| 更新予約の保存 | `localStorage`（`wsm-queue`）に保存し、起動時に復元 |
| 元に戻す | 有効/無効・順番・プロファイル適用などの前の状態を 30 件まで保持（Ctrl+Z） |
| 更新履歴 | ワークショップの変更履歴ページ（`changelog/<id>`）から `<p id="時刻">` を読み取って表示 |
| ツールの更新 | `server.UPDATE_URL`（既定: GitHub `flowercircle0304/SteamWorkshop` の `releases/latest`）。⚙ 設定で別の確認先も指定できます |
| 更新の通知 | 30 分ごとに Web API で最新情報を取り、新しく更新されたものを PowerShell の NotifyIcon で通知 |

### ツール本体の自動更新

起動から 4 秒後と ⚙ 設定を開いたときに GitHub の最新リリースを確認します。新しいバージョンがあれば画面上部の「今すぐ更新」で、次の順に自動で更新します。

1. リリースに添付された `WorkshopManager_v<版>.zip` をダウンロードする
2. `WorkshopManager_v<版>.sha256.txt` があれば SHA256 を照合する（一致しなければ中止）
3. ZIP の中の `WorkshopManager.exe` を取り出し、実行中の exe を `WorkshopManager.old.exe` に名前変更して入れ替える
4. ツールを終了し、終了を待ってから新しい exe を起動する（古い exe は次回起動時に削除）

更新の記録は `%TEMP%\WorkshopManager-update.log` に残ります。設定やプロファイル（`%APPDATA%\WorkshopManager`）はそのままです。

#### 新しいバージョンを公開する

1. `server.py` の `VERSION` と `version_info.txt` を上げる
2. `release.ps1` を実行する（`package.ps1` でビルドし、`gh release create v<版>` で ZIP と SHA256 を添付して公開）

タグ名は `v1.6.0` の形式にしてください。ZIP のファイル名は `WorkshopManager` で始まっている必要があります。

## MOD の更新

- 「更新あり」は、Steam の `NeedsUpdate` フラグか、Web API の最終更新日時がローカルより新しいことで判定します。
- 一覧の「更新あり ⬇」バッジ、詳細の「⬇ 更新する」、ツールバーの「⬇ 更新を全てDL (n)」で、Steam の `DownloadItem`（高優先度）を呼んで更新します。Steam に接続していなければ自動で接続します。
- ゲームの実行中は Steam が MOD を更新できないため、更新を予約して「⏳ 終了後に更新」と表示します。ゲームの終了を検知したら接続し、まとめて更新を始めます（予約はアプリを閉じると消えます）。

## ゲームの起動

- ゲームの見出しにある「▶ プレイ」で、Steam 経由（`steam://rungameid/<AppID>`）でゲームを起動します。
- 「▾」で起動オプション（引数）と「起動前に有効な MOD をデプロイする」を設定できます。引数を付けると `steam://run/<AppID>//<引数>/` で起動するため、Steam が確認ダイアログを表示します。
- 起動の直前に、そのゲームとの Steam 連携を切断します（つないだままだと Steam が「実行中」と判断して起動できないため）。
- 実行中のゲームは Steam のレジストリ値（`HKCU\Software\Valve\Steam\Apps\<AppID>\Running`）で検出します。実行中はゲーム一覧に緑の点を付け、そのゲームとの連携を一時停止し、終了したら自動で再開します。

## ゲーム内の MOD 設定との連動

ワークショップの購読とは別に、ゲーム自身が MOD の ON/OFF を管理している場合は、`game_adapters.py` のアダプタで同期します。

- 対応しているゲーム: Slay the Spire 2（`%APPDATA%\SlayTheSpire2\steam\<SteamID>\settings.save` の `mod_settings.mod_list`）。
  ワークショップのアイテムに入っている MOD マニフェスト（`id` と `has_dll`/`has_pck` を持つ JSON）の `id` で対応付けます。
- ゲームを選んだときと、ゲームが終了したときにゲームの設定を読み込み、ツールの有効/無効に取り込みます。
- ON/OFF、プロファイルの適用、並べ替えをするとゲームの設定に書き込みます。ロード順を書き込むのは、ドラッグで並べ替えたことがある場合（`orderCustom`）だけです。
- ゲームの実行中は書き込みを保留し（`gamePending`）、終了を検知したら書き込みます。書き込む前に `settings.save.wsm-backup` を作ります。
- プロファイルの適用は、Steam 同期がオンなら Steam の「ローカル無効化」にも反映します。
- 新しいゲームに対応するには、`read(items)` と `write(items, disabled, order)` を実装したクラスを `ADAPTERS` に追加します。

## プロファイルの共有

- 「プロファイル」タブの各プロファイルで、「📋 コード」（共有コードをコピー）、「⬇」（`.wsmprofile` ファイルに保存）、「✎」（名前を変更）が使えます。「全てファイルに保存」でそのゲームの全プロファイルをまとめて書き出せます。
- 共有コードは `WSM1.` + base64url(deflate-raw(JSON)) です。中身は AppID、ゲーム名、プロファイル名、MOD の ID（無効な MOD は先頭に `-`）です。11 件で約 180 文字です。
- ファイル形式（`format: "wsm-profiles"`）は MOD のタイトルも含む JSON です。「エクスポート」タブで書き出した旧形式の JSON も読み込めます。
- 読み込んだプロファイルは「共有」と表示され、同じ名前があれば「(2)」を付けます。別のゲームのプロファイルなら、そのゲームに読み込むか確認します。
- 適用すると、プロファイルに含まれない MOD は無効になります（共有された構成をそのまま再現するため）。インストールされていない MOD は一覧を表示し、まとめて購読できます。

## その他の機能

- 全ライブラリのワークショップのフォルダを読み取り、Web API でタイトル・サムネイル・説明・タグを取得します。
- 有効/無効の切り替え、ドラッグ&ドロップでのロード順変更、検索、フィルタ、並べ替え、リスト/グリッド表示ができます。
- プロファイルの保存と切り替え、MOD フォルダへのデプロイ（ジャンクションまたはコピー）、JSON でのエクスポートとインポートができます。

## 開発

```
pip install pywebview pyinstaller
python server.py              # デスクトップウィンドウで起動
python server.py --browser    # ブラウザで起動（開発用、ポート 8765）
build.bat                     # dist\WorkshopManager.exe を作り直す
package.bat                   # 配布用 ZIP を release\ に作る
```

## 配布

`package.bat` を実行すると、`release\WorkshopManager_v<バージョン>.zip`（exe とフレンド向けの説明書）と、SHA256 を書いたファイルができます。

- バージョンを上げるときは、`server.py` の `VERSION` と `version_info.txt` の両方を書き換えます。
- 説明書の元は `dist_files\はじめにお読みください.txt` です。
- 配布版の設定は `%APPDATA%\WorkshopManager` に保存されます。exe の隣に `data` フォルダがある場合はそちらを使います（ポータブル利用）。

構成: `server.py`（スキャン、API、ウィンドウ）、`steam_bridge.py`（Steamworks 連携）、`static\`（画面）
