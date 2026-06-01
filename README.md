# 🤖 LAUM Vending — คู่มือติดตั้ง

## 📦 มีอะไรในนี้บ้าง

```
laum-vending/
├── index.html          ← Web App (Deploy บน Vercel)
├── apps-script.js      ← โค้ดสำหรับ Google Apps Script
└── README.md           ← คู่มือนี้
```

---

## 🚀 ขั้นตอนที่ 1: Deploy Web App บน Vercel

1. ไปที่ **vercel.com** → Sign up ด้วย Google
2. กด **Add New Project** → **Browse** → upload folder `laum-vending`
3. กด **Deploy** → ได้ URL เช่น `https://laum-vending.vercel.app`
4. เปิดได้ทุกที่ ทุกอุปกรณ์! รหัสผ่าน: `laum320758`

---

## 📱 ขั้นตอนที่ 2: ตั้งค่า LINE Messaging API

### 2.1 สร้าง LINE Bot

1. ไปที่ **developers.line.biz** → Login
2. สร้าง Provider ใหม่ → สร้าง **Messaging API channel**
3. ในหน้า channel ไปที่ tab **Messaging API**
4. Copy **Channel access token** (long-lived)
5. Scan **QR code** เพื่อเพิ่ม bot เป็นเพื่อนใน LINE ของคุณ

### 2.2 หา LINE User ID ของตัวเอง

1. ในหน้า channel → Webhook URL → ตั้งเป็น URL ของ Apps Script
2. หรือใช้วิธีง่ายๆ: ส่ง message อะไรก็ได้ไปหา bot
3. ดู User ID ได้จาก webhook log

**วิธีง่ายกว่า** — ใช้ tool ออนไลน์:
- เปิด **line.me/R/oaMessage/@xxxxx** → ส่งข้อความ
- ใช้ Apps Script ดักด้วย `e.events[0].source.userId`

---

## 📊 ขั้นตอนที่ 3: ตั้งค่า Google Apps Script

1. เปิด **Google Sheet** ของคุณ
2. **Extensions → Apps Script**
3. ลบโค้ดเดิม → วางโค้ดจากไฟล์ `apps-script.js`
4. แก้ CONFIG ด้านบน:
   ```javascript
   LINE_CHANNEL_ACCESS_TOKEN: "ใส่ token ที่ copy มา"
   LINE_USER_ID: "ใส่ User ID ของคุณ"
   ```
5. กด **Save** (💾)
6. รัน `testLine()` เพื่อทดสอบ → ถ้าได้ข้อความใน LINE = สำเร็จ!

---

## 🌐 ขั้นตอนที่ 4: Deploy เป็น Web App

1. ใน Apps Script editor → กด **Deploy** → **New deployment**
2. เลือก type: **Web app**
3. ตั้งค่า:
   - Execute as: **Me**
   - Who has access: **Anyone**
4. กด **Deploy** → Authorize → Allow
5. Copy **Web app URL** ที่ได้
6. URL นี้คือที่ ESP32 จะส่ง webhook มา

---

## 🤖 ขั้นตอนที่ 5: ESP32 ยิง Webhook

ตัวอย่างโค้ด ESP32 (Arduino):

```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* GAS_URL = "https://script.google.com/macros/s/XXX/exec";

void reportSale(int slot) {
  HTTPClient http;
  http.begin(GAS_URL);
  http.addHeader("Content-Type", "application/json");
  
  String payload = "{\"action\":\"sale\",\"machineId\":\"M1\",\"slot\":" + String(slot) + "}";
  int code = http.POST(payload);
  http.end();
}

void reportStuck(int slot) {
  HTTPClient http;
  http.begin(GAS_URL);
  http.addHeader("Content-Type", "application/json");
  
  String payload = "{\"action\":\"stuck\",\"machineId\":\"M1\",\"slot\":" + String(slot) + "}";
  http.POST(payload);
  http.end();
}
```

---

## ⏰ ขั้นตอนที่ 6: ตั้ง Auto-Summary

ใน Apps Script รัน:
```javascript
setupTriggers();
```

จะตั้ง trigger ส่งสรุปอัตโนมัติเวลา **9:00, 14:00, 19:00** ทุกวัน

---

## 💡 LINE Mode (เลือกได้)

ในไฟล์ `apps-script.js` → CONFIG.LINE_MODE:

| โหมด | คำอธิบาย | ข้อความ/เดือน |
|---|---|---|
| `every` | ส่งทุกครั้งที่ขาย | ~900 (เกินฟรี!) |
| `critical` ⭐ | เฉพาะของหมด/ติด + สรุป 3 ครั้ง/วัน | ~50 |
| `summary` | สรุปวันละ 3 ครั้งเท่านั้น | 90 |

**แนะนำ `critical`** — ครอบคลุมเหตุการณ์สำคัญทั้งหมด ไม่เกินโควต้า

---

## 🎨 ความสามารถของ Web App

- ✅ Login ด้วยรหัสผ่าน
- ✅ จัดการหลายตู้ (Fleet Overview สรุปทุกตู้)
- ✅ ใส่รูปสินค้าแต่ละช่อง (คลิกที่ icon ในแท็บสต็อก)
- ✅ เก็บข้อมูลใน browser (localStorage) — ไม่หายเมื่อปิด
- ✅ Responsive ใช้ได้ทั้ง desktop / มือถือ
- ✅ Logo Cute Mascot ออกแบบเอง

---

## 🐛 Troubleshoot

**LINE ไม่ส่ง?**
- เช็ค Channel Access Token ถูกต้องไหม
- เช็ค User ID ถูกต้องไหม
- เช็คว่าเพิ่ม bot เป็นเพื่อนใน LINE แล้ว

**Web App ไม่อัปเดตข้อมูล?**
- เช็ค Published CSV URL ใน Sheet Settings
- ต้อง publish เป็น CSV ก่อน

**ESP32 ส่งไม่ผ่าน?**
- ต้องใช้ HTTPS (Apps Script รองรับเท่านั้น)
- เช็คว่า Web app deploy เป็น **Anyone** ไหม
