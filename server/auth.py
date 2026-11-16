"""ESP32 が作る TOTP トークン（6桁）を照合する。

ESP32 側（firm/src/comm/Totp.h の totp()）と同じ計算をする。
時刻を PERIOD 秒単位に四捨五入した「番号」を使う。

鍵は 2 つある:
- TOTP_KEY    … Web Serial 用。1分ごと。ESP32 から毎分届く（verify_totp）
- TOTP_KEY_QR … パンタグラフの画面の QR 用。30秒ごと。15分間有効で、AI 生成 1 回で使い切り（match_qr_step）
"""

import hashlib
import hmac
import time

PERIOD = 60          # Web Serial の鍵は1分ごとに番号が変わる
QR_PERIOD = 30       # QR の鍵は30秒ごと
QR_VALID_SEC = 15 * 60   # QR のトークンは15分間使える


def time_step(now: float | None = None, period: int = PERIOD) -> int:
    """現在時刻を period 秒単位に四捨五入した番号を返す（ESP32 の timeStep() と同じ）。"""
    t = int(time.time() if now is None else now)
    return (t + period // 2) // period


def totp(key: bytes, step: int) -> str:
    """秘密鍵と番号から6桁のトークンを作る（ESP32 の totp() と同じ）。"""
    h = hmac.new(key, step.to_bytes(8, "big"), hashlib.sha1).digest()
    o = h[19] & 0x0F
    code = int.from_bytes(h[o:o + 4], "big") & 0x7FFFFFFF
    return f"{code % 1_000_000:06d}"


def verify_totp(token: str, key_hex: str) -> bool:
    """トークンが今か1つ前の番号のものなら True。

    ESP32 は毎分0秒にトークンを送り、ブラウザはそれを最大1分ほど持ってから
    サーバーへ送る。その間にサーバー側の番号が1つ進むことがあるので、
    1つ前の番号まで受け付ける。
    """
    if not (isinstance(token, str) and len(token) == 6 and token.isdigit()):
        return False
    key = bytes.fromhex(key_hex)
    now = time_step()
    return any(hmac.compare_digest(token, totp(key, s)) for s in (now, now - 1))


def match_qr_step(token: str, key_hex: str) -> int | None:
    """QR のトークンが、15分以内のどの番号のものかを返す。どれでもなければ None。

    鍵や発行済みのトークンは保存せず、15分ぶんの番号でトークンを作り直して照らし合わせる。
    使い切りにするため、呼び出し側で「この番号は使用済み」を記録する。
    """
    if not (isinstance(token, str) and len(token) == 6 and token.isdigit()):
        return None
    key = bytes.fromhex(key_hex)
    now = time_step(period=QR_PERIOD)
    for s in range(now, now - QR_VALID_SEC // QR_PERIOD - 1, -1):
        if hmac.compare_digest(token, totp(key, s)):
            return s
    return None
