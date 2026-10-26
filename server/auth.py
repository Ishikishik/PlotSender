"""ESP32 が作る TOTP トークン（6桁・1分ごと）を照合する。

ESP32 側（serialtest/library.cpp の totp()）と同じ計算をする。
時刻は1分単位に四捨五入した「番号」を使う。
"""

import hashlib
import hmac
import time

PERIOD = 60  # 1分ごとに番号が変わる


def time_step(now: float | None = None) -> int:
    """現在時刻を1分単位に四捨五入した番号を返す（ESP32 の timeStep() と同じ）。"""
    t = int(time.time() if now is None else now)
    return (t + PERIOD // 2) // PERIOD


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
