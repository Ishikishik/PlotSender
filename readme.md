# Todo
## できたところ
- 画像のアップロード
## これからやること
- AIへのアップと認証
- 諸々の画像処理
- ベジェデータの送信
- connectwifiシステム

esp側のサンプルコードは[こちら](test/serialtest/serialtest)

cloudflareで設定する鍵とか
- espと共通にする秘密鍵(TOTP_KEY)… Web Serial 用。1分ごと
- QR 用の秘密鍵(TOTP_KEY_QR)… パンタグラフ(cutting_machine)の画面に出る QR 用。30秒ごと。15分間有効で、AI 生成 1 回で使い切り
- AIのapiキー(REPLICATE_API_TOKEN)
- KV(binding 名 KV)… 使い終わった QR のトークンの記録と、パンタグラフの最新の補正データ。wrangler.jsonc の kv_namespaces に id を入れる

QR の URL は `HTTPS://PLOTSENDER.OTTERSTB.COM/T/<6桁>`。サーバーがトークンの鍵から機械を判断して、そのタブ(`/?mode=b&token=<6桁>` など)へ移動させる。機械と鍵の対応は server/main.py の QR_MACHINES(描馬灯は `TOTP_KEY_QR_BYOMATO` を登録すれば使える)

パンタグラフの補正(キャリブレーション)
- パンタグラフのタブの一番下から、補正シートに描いた格子の写真を送る。計算はブラウザ(public/js/calibrate.js、OpenCV.js)で行い、
  できた表を /api/correction に POST する(QR のトークンを 1 回使う)。サーバーは日時を付けて KV に保存する
- cutting_machine は GET /api/correction で最新を受け取る(起動時と 5 分ごと)。KV にまだ無いときは 404
- calibrate.js は cutting_machine/calibration/make_correction.py を移したもの。紙の範囲などは firm の PlotterConfig.h と合わせてある
- public/correction_default.json は、ファームに入っている表(CorrectionTable.h)を JSON にしたもの。サーバーにまだ表が無いときの「更新」の元に使う
