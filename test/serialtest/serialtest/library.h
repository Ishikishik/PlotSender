#pragma once
#include <Arduino.h>

bool wifiConnect(const char* ssid, const char* pass);
bool syncTime();
uint32_t timeStep(uint32_t stepSec);
String totp(const uint8_t* key, size_t keyLen, uint32_t stepSec);
void sendText(const String& text);
bool receiveText(String& out);
void startTimer(uint32_t ms);
extern volatile bool timerFired;
