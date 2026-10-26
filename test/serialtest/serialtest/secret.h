#pragma once
#include <stdint.h>
#include <stddef.h>
extern const char* WIFI_SSID;
extern const char* WIFI_PASS;
extern const uint8_t TOTP_KEY[];   // TOTPの秘密鍵（サーバーと同じものを使う）
extern const size_t TOTP_KEY_LEN;
