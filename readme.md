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
- KV(USED_QR_TOKENS)… 使い終わった QR のトークンの記録。wrangler.jsonc の kv_namespaces に id を入れる

QR の URL は `HTTPS://PLOTSENDER.OTTERSTB.COM/T/<6桁>`。サーバーがトークンの鍵から機械を判断して、そのタブ(`/?mode=b&token=<6桁>` など)へ移動させる。機械と鍵の対応は server/main.py の QR_MACHINES(描馬灯は `TOTP_KEY_QR_BYOMATO` を登録すれば使える)