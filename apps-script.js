/**
 * LAUM Vending — Google Apps Script
 * 1. ทำหน้าที่เป็น API (CORS-free) ให้ Web App ดึงข้อมูล
 * 2. รับ webhook จาก ESP32
 * 3. ส่ง LINE Messaging API
 *
 * วิธี Deploy:
 * 1. เปิด Google Sheet → Extensions → Apps Script
 * 2. วางโค้ดนี้ทั้งหมด
 * 3. Deploy → New Deployment → Web App
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy Web App URL → เอาไปใส่ใน index.html (ตัวแปร GAS_URL)
 */

// ═══════════════════════════════════════════════════
// 🔧 CONFIG
// ═══════════════════════════════════════════════════
const CONFIG = {
  SHEET_NAME: "ชีต1",
  LINE_TOKEN: "YOUR_LINE_CHANNEL_ACCESS_TOKEN",
  LINE_USER_ID: "YOUR_LINE_USER_ID",
  LINE_MODE: "critical", // "every" | "critical" | "summary"
};

// ═══════════════════════════════════════════════════
// 🌐 GET — Web App ดึงข้อมูลสินค้า
// ═══════════════════════════════════════════════════
function doGet(e) {
  const action = e.parameter.action || "products";

  // CORS headers
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    let result;
    if (action === "products") {
      result = getProducts();
    } else if (action === "ping") {
      result = { ok: true, time: new Date().toISOString() };
    } else {
      result = { ok: false, error: "Unknown action" };
    }
    output.setContent(JSON.stringify(result));
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }

  return output;
}

// ดึงข้อมูลสินค้าทั้งหมดจาก Sheet
function getProducts() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) throw new Error("ไม่พบ Sheet: " + CONFIG.SHEET_NAME);

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, products: [] };

  const headers = data[0]; // Row 1 = headers

  // Map header index
  // A=0:ชื่อสินค้า, B=1:เลขช่อง, C=2:ต้นทุน, D=3:ต้นทุนต่อขวด
  // E=4:จำนวนขวด, F=5:ราคาขาย, G=6:กำไรต่อขวด, H=7:ขายหมดจะได้กำไร
  // I=8:ชนิด, J=9:ใส่ได้, K=10:ว่าง, L=11:รูปภาพ
  const COL = {
    name:    findCol(headers, "ชื่อสินค้า") ?? 0,
    slot:    findCol(headers, "เลขช่อง") ?? 1,
    cost:    findCol(headers, "ต้นทุนต่อขวด") ?? 3,
    stock:   findCol(headers, "จำนวนขวด") ?? 4,
    price:   findCol(headers, "ราคาขาย") ?? 5,
    type:    findCol(headers, "ชนิด") ?? 8,
    maxQty:  findCol(headers, "ใส่ได้") ?? 9,
    imgUrl:  findCol(headers, "รูปภาพ") ?? 11, // คอลัมน์ L
  };

  const products = data.slice(1)
    .filter(row => row[COL.slot] && row[COL.name])
    .map(row => ({
      slot:   parseInt(row[COL.slot]) || 0,
      name:   String(row[COL.name] || ""),
      cost:   parseFloat(row[COL.cost]) || 0,
      stock:  parseInt(row[COL.stock]) || 0,
      price:  parseFloat(row[COL.price]) || 15,
      type:   String(row[COL.type] || "ขวด"),
      maxQty: parseInt(row[COL.maxQty]) || 20,
      imgUrl: String(row[COL.imgUrl] || ""),
    }))
    .sort((a, b) => a.slot - b.slot);

  return { ok: true, products, updatedAt: new Date().toISOString() };
}

function findCol(headers, name) {
  const idx = headers.findIndex(h => String(h).trim() === name.trim());
  return idx >= 0 ? idx : null;
}

// ═══════════════════════════════════════════════════
// 📨 POST — รับ webhook จาก ESP32
// ═══════════════════════════════════════════════════
function doPost(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    if (action === "sale")   handleSale(data);
    else if (action === "stuck")  handleStuck(data);
    else if (action === "refill") handleRefill(data);

    output.setContent(JSON.stringify({ ok: true }));
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }

  return output;
}

// ═══════════════════════════════════════════════════
// 💰 ขายสำเร็จ
// ═══════════════════════════════════════════════════
function handleSale(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);

  // บันทึก log (เพิ่ม Sheet "log" ถ้ามี)
  logTransaction(ss, data, product, "sale");

  // ลด stock ในคอลัมน์ E
  if (product) {
    const newStock = Math.max(0, (parseInt(product.row[4]) || 0) - 1);
    sheet.getRange(product.rowNum, 5).setValue(newStock); // Col E

    const maxQty = parseInt(product.row[9]) || 20;
    const pct = newStock / maxQty;

    if (CONFIG.LINE_MODE === "every") {
      sendLine(`💰 ขายสำเร็จ\nช่อง ${data.slot} · ${product.row[0]}\nราคา ฿${product.row[5]}\nเหลือ ${newStock}/${maxQty} ขวด`);
    } else if (CONFIG.LINE_MODE === "critical") {
      if (newStock === 0) {
        sendLine(`⛔ สินค้าหมด!\nช่อง ${data.slot} · ${product.row[0]}\nกรุณาเติมสินค้า`);
      } else if (pct <= 0.25 && pct > 0) {
        sendLine(`⚠️ สต็อกใกล้หมด\nช่อง ${data.slot} · ${product.row[0]}\nเหลือ ${newStock}/${maxQty} ขวด`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════
// 🚨 สินค้าติดตู้
// ═══════════════════════════════════════════════════
function handleStuck(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);

  logTransaction(ss, data, product, "stuck");
  sendLine(`🚨 สินค้าติดตู้!\nช่อง ${data.slot}${product ? ' · ' + product.row[0] : ''}\nลูกค้าจ่ายเงินแล้วแต่สินค้าไม่ออก\n⚡ กรุณาตรวจสอบด่วน!`);
}

// ═══════════════════════════════════════════════════
// 🔄 เติมสินค้า
// ═══════════════════════════════════════════════════
function handleRefill(data) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);

  if (product) {
    const maxQty = parseInt(product.row[9]) || 20;
    sheet.getRange(product.rowNum, 5).setValue(maxQty); // รีเซ็ต stock → max
  }
  sendLine(`✅ เติมสินค้าแล้ว\nช่อง ${data.slot}${product ? ' · ' + product.row[0] : ''}`);
}

// ═══════════════════════════════════════════════════
// 🛠️ Helpers
// ═══════════════════════════════════════════════════
function findProduct(sheet, slot) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (parseInt(data[i][1]) === parseInt(slot)) {
      return { row: data[i], rowNum: i + 1 };
    }
  }
  return null;
}

function logTransaction(ss, data, product, type) {
  let logSheet = ss.getSheetByName("log");
  if (!logSheet) {
    logSheet = ss.insertSheet("log");
    logSheet.appendRow(["เวลา", "ตู้", "ช่อง", "สินค้า", "ราคา", "ประเภท"]);
  }
  logSheet.appendRow([
    new Date(),
    data.machineId || "M1",
    data.slot,
    product ? product.row[0] : "ไม่ทราบ",
    product ? product.row[5] : 0,
    type,
  ]);
}

// ═══════════════════════════════════════════════════
// 📱 LINE Messaging API
// ═══════════════════════════════════════════════════
function sendLine(message) {
  if (!CONFIG.LINE_TOKEN || CONFIG.LINE_TOKEN.startsWith("YOUR_")) {
    console.log("LINE not configured:", message);
    return;
  }
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.LINE_TOKEN },
      payload: JSON.stringify({
        to: CONFIG.LINE_USER_ID,
        messages: [{ type: "text", text: message }],
      }),
      muteHttpExceptions: true,
    });
  } catch (err) {
    console.error("LINE error:", err);
  }
}

// ═══════════════════════════════════════════════════
// ⏰ ส่งสรุปประจำวัน (ตั้ง Trigger วันละ 3 ครั้ง)
// ═══════════════════════════════════════════════════
function sendDailySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName("log");
  if (!logSheet) return;

  const today = new Date(); today.setHours(0,0,0,0);
  const rows = logSheet.getDataRange().getValues().slice(1);
  let revenue = 0, sales = 0, stuck = 0;

  rows.forEach(r => {
    const ts = new Date(r[0]);
    if (ts >= today) {
      if (r[5] === "sale") { revenue += parseFloat(r[4])||0; sales++; }
      else if (r[5] === "stuck") stuck++;
    }
  });

  const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  const products = sheet.getDataRange().getValues().slice(1)
    .filter(r => r[1] && r[0]);
  const emptySlots = products.filter(r => (parseInt(r[4])||0) === 0).length;
  const lowSlots = products.filter(r => {
    const cur = parseInt(r[4])||0, max = parseInt(r[9])||20;
    return cur > 0 && cur/max < 0.25;
  }).length;

  const h = new Date().getHours();
  const period = h < 12 ? "🌅 เช้า" : h < 17 ? "☀️ บ่าย" : "🌆 เย็น";

  sendLine([
    `📊 สรุปยอด ${period}`,
    `💰 รายได้: ฿${revenue.toLocaleString()}`,
    `🥤 ขาย: ${sales} ขวด`,
    `🚨 ติดตู้: ${stuck} ครั้ง`,
    `⚠️ ใกล้หมด: ${lowSlots} ช่อง`,
    `⛔ หมด: ${emptySlots} ช่อง`,
  ].join("\n"));
}

// รัน setupTriggers() ครั้งเดียวเพื่อตั้ง auto-summary
function setupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendDailySummary")
    .forEach(t => ScriptApp.deleteTrigger(t));

  [9, 14, 19].forEach(h => {
    ScriptApp.newTrigger("sendDailySummary")
      .timeBased().atHour(h).everyDays(1).create();
  });
  Logger.log("Triggers set: 9:00, 14:00, 19:00");
}

// ═══════════════════════════════════════════════════
// 🧪 ทดสอบ (รันจาก editor)
// ═══════════════════════════════════════════════════
function testGetProducts() {
  const result = getProducts();
  Logger.log(JSON.stringify(result, null, 2));
}

function testLine() {
  sendLine("🤖 LAUM Vending ทดสอบ ✅");
}
