/**
 * LAUM Vending — Google Apps Script v2
 * ══════════════════════════════════════
 * ชีต1: A=ชื่อสินค้า B=เลขช่อง C=ต้นทุน D=ต้นทุนต่อขวด E=จำนวนขวด(ซื้อมา)
 *        F=ราคาขาย G=กำไรต่อขวด H=ขายหมดได้กำไร I=ชนิด J=ใส่ได้(max)
 *        K=สต็อกปัจจุบัน L=รูปภาพ
 *
 * log:   A=เวลา B=ตู้ C=ช่อง D=สินค้า E=ราคาขาย F=ต้นทุน G=กำไร H=ประเภท
 *
 * Deploy: Extensions → Apps Script → วางโค้ดนี้
 *   Deploy → New Deployment → Web App → Execute as: Me · Access: Anyone
 */

const CONFIG = {
  SHEET_NAME:    "ชีต1",
  LOG_SHEET:     "log",
  LINE_TOKEN:    "YOUR_LINE_CHANNEL_ACCESS_TOKEN",
  LINE_USER_ID:  "YOUR_LINE_USER_ID",
  LINE_MODE:     "critical",   // "every" | "critical" | "summary"
  LOW_STOCK_PCT: 0.25,
};

// คอลัมน์ ชีต1 (0-based)
const COL = {
  name: 0, slot: 1, cost: 3, price: 5,
  type: 8, maxQty: 9, stock: 10, imgUrl: 11,
};

// คอลัมน์ log (0-based)
const LCOL = {
  time: 0, machine: 1, slot: 2, name: 3,
  price: 4, cost: 5, profit: 6, type: 7,
};

// ════════════════════════════════════════════════════
// GET — Web App ดึงข้อมูล
// ════════════════════════════════════════════════════
function doGet(e) {
  const out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    const action = e.parameter.action || "products";
    const sheet  = e.parameter.sheet  || CONFIG.SHEET_NAME;
    const period = e.parameter.period || "today"; // today | week | month | all
    let result;
    if      (action === "products") result = getProducts(sheet);
    else if (action === "summary")  result = getSummary(period);
    else if (action === "ping")     result = { ok: true, time: new Date().toISOString() };
    else                            result = { ok: false, error: "Unknown: " + action };
    out.setContent(JSON.stringify(result));
  } catch (err) {
    out.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }
  return out;
}

// ── ดึงสินค้าจาก ชีต1 ──────────────────────────────
function getProducts(sheetName) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName || CONFIG.SHEET_NAME);
  if (!sheet) throw new Error("ไม่พบ Sheet: " + sheetName);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { ok: true, products: [] };

  const products = data.slice(1)
    .filter(r => r[COL.slot] && r[COL.name])
    .map(r => {
      const maxQty   = parseInt(r[COL.maxQty]) || 20;
      const stockRaw = r[COL.stock];
      const stock    = (stockRaw !== "" && stockRaw !== null && !isNaN(parseInt(stockRaw)))
                         ? parseInt(stockRaw) : maxQty;
      return {
        slot:   parseInt(r[COL.slot])    || 0,
        name:   String(r[COL.name]       || ""),
        cost:   parseFloat(r[COL.cost])  || 0,
        price:  parseFloat(r[COL.price]) || 15,
        type:   String(r[COL.type]       || "ขวด"),
        maxQty, stock,
        imgUrl: String(r[COL.imgUrl]     || ""),
      };
    })
    .sort((a, b) => a.slot - b.slot);

  return { ok: true, products, updatedAt: new Date().toISOString() };
}

// ── ดึงสรุปรายได้/กำไร/ต้นทุนจาก log ──────────────
function getSummary(period) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  const log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) return { ok: true, revenue: 0, cost: 0, profit: 0, sales: 0, stuck: 0, rows: [] };

  const now   = new Date();
  const today = new Date(now); today.setHours(0,0,0,0);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - today.getDay()); // อาทิตย์
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // กำหนด cutoff ตาม period
  let cutoff;
  if      (period === "today")  cutoff = today;
  else if (period === "week")   cutoff = weekStart;
  else if (period === "month")  cutoff = monthStart;
  else                          cutoff = new Date(0); // all

  const data = log.getDataRange().getValues().slice(1); // skip header
  let revenue = 0, cost = 0, profit = 0, sales = 0, stuck = 0;
  const rows = [];

  data.forEach(r => {
    if (!r[LCOL.time]) return;
    const ts = new Date(r[LCOL.time]);
    if (ts < cutoff) return;

    const type = String(r[LCOL.type] || "").trim();
    if (type === "sale") {
      const rev = parseFloat(r[LCOL.price])  || 0;
      const cst = parseFloat(r[LCOL.cost])   || 0;
      const prf = parseFloat(r[LCOL.profit]) || (rev - cst);
      revenue += rev;
      cost    += cst;
      profit  += prf;
      sales++;
      rows.push({
        time:    r[LCOL.time],
        machine: r[LCOL.machine],
        slot:    r[LCOL.slot],
        name:    r[LCOL.name],
        price:   rev, cost: cst, profit: prf,
        type,
      });
    } else if (type === "stuck") {
      stuck++;
    }
  });

  return {
    ok: true, period,
    revenue: Math.round(revenue * 100) / 100,
    cost:    Math.round(cost    * 100) / 100,
    profit:  Math.round(profit  * 100) / 100,
    sales, stuck,
    profitPct: revenue > 0 ? Math.round(profit / revenue * 100) : 0,
    rows: rows.slice(-50), // ส่ง 50 rows ล่าสุด
  };
}

// ════════════════════════════════════════════════════
// POST — รับ webhook จาก ESP32
// ════════════════════════════════════════════════════
function doPost(e) {
  const out = ContentService.createTextOutput();
  out.setMimeType(ContentService.MimeType.JSON);
  try {
    const data   = JSON.parse(e.postData.contents);
    const action = data.action;
    if      (action === "sale")       handleSale(data);
    else if (action === "stuck")      handleStuck(data);
    else if (action === "refill")     handleRefill(data);
    else if (action === "refill_all") handleRefillAll(data);
    out.setContent(JSON.stringify({ ok: true }));
  } catch (err) {
    out.setContent(JSON.stringify({ ok: false, error: err.toString() }));
  }
  return out;
}

// ── ขายสำเร็จ → ลด K -1, บันทึก log ──────────────
function handleSale(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);

  if (product) {
    const maxQty   = parseInt(product.row[COL.maxQty]) || 20;
    const curStock = parseInt(product.row[COL.stock])  || 0;
    const newStock = Math.max(0, curStock - 1);
    const price    = parseFloat(product.row[COL.price]) || 0;
    const cost     = parseFloat(product.row[COL.cost])  || 0;
    const profit   = Math.round((price - cost) * 100) / 100;

    // ลด K
    sheet.getRange(product.rowNum, COL.stock + 1).setValue(newStock);
    // บันทึก log พร้อมต้นทุน+กำไร
    writeLog(ss, data, product.row[COL.name], price, cost, profit, "sale");

    const pct = newStock / maxQty;
    if (CONFIG.LINE_MODE === "every") {
      sendLineSale(data.slot, product.row[COL.name], price, cost, profit, newStock, maxQty);
    } else if (CONFIG.LINE_MODE === "critical") {
      if (newStock === 0)
        sendLineAlert("empty", data.slot, product.row[COL.name], newStock, maxQty);
      else if (pct <= CONFIG.LOW_STOCK_PCT)
        sendLineAlert("low", data.slot, product.row[COL.name], newStock, maxQty);
    }
  }
}

// ── สินค้าติดตู้ ───────────────────────────────────
function handleStuck(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);
  writeLog(ss, data, product ? product.row[COL.name] : "?", 0, 0, 0, "stuck");
  sendLineAlert("stuck", data.slot, product ? product.row[COL.name] : "ไม่ทราบ", product ? parseInt(product.row[COL.stock])||0 : 0, product ? parseInt(product.row[COL.maxQty])||20 : 20);
}

// ── รีเซ็ทช่องเดียว K = J ─────────────────────────
function handleRefill(data) {
  const ss      = SpreadsheetApp.getActiveSpreadsheet();
  const sheet   = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const product = findProduct(sheet, data.slot);
  if (product) {
    const maxQty = parseInt(product.row[COL.maxQty]) || 20;
    sheet.getRange(product.rowNum, COL.stock + 1).setValue(maxQty);
    writeLog(ss, data, product.row[COL.name], 0, 0, 0, "refill");
  }
}

// ── รีเซ็ทสต็อกทั้งหมด K = J ──────────────────────
function handleRefillAll(data) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(data.sheetName || CONFIG.SHEET_NAME);
  const rows  = sheet.getDataRange().getValues();
  let count   = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i][COL.slot] || !rows[i][COL.name]) continue;
    const maxQty = parseInt(rows[i][COL.maxQty]) || 20;
    sheet.getRange(i + 1, COL.stock + 1).setValue(maxQty);
    count++;
  }
  writeLog(ss, data, "ทั้งหมด " + count + " รายการ", 0, 0, 0, "refill_all");
  sendLine(`✅ รีเซ็ทสต็อกทั้งหมด ${count} รายการ`);
}

// ════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════
function findProduct(sheet, slot) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (parseInt(data[i][COL.slot]) === parseInt(slot))
      return { row: data[i], rowNum: i + 1 };
  }
  return null;
}

function writeLog(ss, data, name, price, cost, profit, type) {
  let log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) {
    log = ss.insertSheet(CONFIG.LOG_SHEET);
    log.appendRow(["เวลา","ตู้","ช่อง","สินค้า","ราคาขาย","ต้นทุน","กำไร","ประเภท"]);
  }
  log.appendRow([
    new Date(),
    data.machineId || "M1",
    data.slot || "",
    name,
    price,
    cost,
    profit,
    type,
  ]);
}

// ════════════════════════════════════════════════════
// สรุปประจำวัน (Trigger 3 ครั้ง/วัน)
// ════════════════════════════════════════════════════
function sendDailySummary() {
  const s = getSummary("today");
  const h = new Date().getHours();
  const period = h < 12 ? "🌅 เช้า" : h < 17 ? "☀️ บ่าย" : "🌆 เย็น";
  sendLine([
    `📊 สรุปยอด ${period}`,
    `💰 รายรับ: ฿${s.revenue.toLocaleString()}`,
    `📦 ต้นทุน: ฿${s.cost.toLocaleString()}`,
    `✨ กำไร: ฿${s.profit.toLocaleString()} (${s.profitPct}%)`,
    `🥤 ขาย: ${s.sales} ขวด`,
    `🚨 ติดตู้: ${s.stuck} ครั้ง`,
  ].join("\n"));
}

// ════════════════════════════════════════════════════
// LINE Messaging API — Flex Message
// ════════════════════════════════════════════════════

// ส่ง text ธรรมดา
function sendLine(message) {
  sendLineRaw([{ type: "text", text: message }]);
}

// ส่ง Flex สำหรับการขาย
function sendLineSale(slot, name, price, cost, profit, remaining, maxQty) {
  const pct = maxQty > 0 ? Math.round(remaining / maxQty * 100) : 0;
  const statusColor = remaining === 0 ? "#ef4444" : pct <= 25 ? "#facc15" : "#22c55e";
  const statusText  = remaining === 0 ? "หมดแล้ว!" : pct <= 25 ? "ใกล้หมด" : "ปกติ";

  const flex = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "horizontal", paddingAll: "14px",
      backgroundColor: "#0f172a",
      contents: [
        { type: "box", layout: "vertical", flex: 1, contents: [
          { type: "text", text: "💰 ขายสำเร็จ", size: "sm", color: "#94a3b8", weight: "bold" },
          { type: "text", text: name, size: "lg", color: "#f1f5f9", weight: "bold", wrap: true, margin: "sm" }
        ]},
        { type: "box", layout: "vertical", alignItems: "flex-end", contents: [
          { type: "text", text: "ช่อง " + slot, size: "xs", color: "#64748b" },
          { type: "text", text: "฿" + price, size: "xl", color: "#22c55e", weight: "bold", margin: "sm" }
        ]}
      ]
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "14px",
      backgroundColor: "#1e293b",
      contents: [
        // รายละเอียดการเงิน
        { type: "box", layout: "horizontal", margin: "none", contents: [
          { type: "box", layout: "vertical", flex: 1, backgroundColor: "#0f172a", cornerRadius: "8px", paddingAll: "10px", alignItems: "center",
            contents: [
              { type: "text", text: "ต้นทุน", size: "xxs", color: "#94a3b8" },
              { type: "text", text: "฿" + cost.toFixed(1), size: "md", color: "#f87171", weight: "bold", margin: "sm" }
            ]},
          { type: "separator", margin: "sm" },
          { type: "box", layout: "vertical", flex: 1, backgroundColor: "#0f172a", cornerRadius: "8px", paddingAll: "10px", alignItems: "center",
            contents: [
              { type: "text", text: "กำไร", size: "xxs", color: "#94a3b8" },
              { type: "text", text: "฿" + profit.toFixed(1), size: "md", color: "#4ade80", weight: "bold", margin: "sm" }
            ]}
        ]},
        // สต็อกที่เหลือ
        { type: "box", layout: "vertical", margin: "md", backgroundColor: "#0f172a", cornerRadius: "8px", paddingAll: "10px",
          contents: [
            { type: "box", layout: "horizontal", contents: [
              { type: "text", text: "สต็อกคงเหลือ", size: "xs", color: "#94a3b8", flex: 1 },
              { type: "text", text: remaining + "/" + maxQty + " ขวด", size: "xs", color: statusColor, weight: "bold" },
              { type: "text", text: " · " + statusText, size: "xs", color: statusColor }
            ]},
            { type: "box", layout: "horizontal", margin: "sm", height: "6px", backgroundColor: "#334155", cornerRadius: "3px",
              contents: [
                { type: "box", layout: "horizontal", width: pct + "%", backgroundColor: statusColor, cornerRadius: "3px", contents: [] }
              ]}
          ]}
      ]
    },
    footer: {
      type: "box", layout: "horizontal", paddingAll: "10px",
      backgroundColor: "#020617",
      contents: [
        { type: "text", text: "LAUM Vending · " + new Date().toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"}), size: "xxs", color: "#475569", align: "center" }
      ]
    }
  };
  sendLineRaw([{ type: "flex", altText: "ขายสำเร็จ: " + name + " ฿" + price, contents: flex }]);
}

// ส่ง Flex สำหรับแจ้งเตือน (ติด/หมด/ใกล้หมด)
function sendLineAlert(type, slot, name, remaining, maxQty) {
  const configs = {
    stuck:   { emoji:"🚨", title:"สินค้าติดตู้!", subtitle:"ลูกค้าจ่ายเงินแล้วสินค้าไม่ออก", headerBg:"#450a0a", iconBg:"#ef4444", accent:"#f87171", urgent:true },
    empty:   { emoji:"⛔", title:"สินค้าหมด!", subtitle:"กรุณาเติมสินค้าโดยด่วน", headerBg:"#1c1917", iconBg:"#ef4444", accent:"#fb923c", urgent:false },
    low:     { emoji:"⚠️", title:"สต็อกใกล้หมด", subtitle:"ควรเตรียมเติมสินค้า", headerBg:"#1c1a0a", iconBg:"#ca8a04", accent:"#facc15", urgent:false },
    refill:  { emoji:"✅", title:"เติมสินค้าแล้ว", subtitle:"สต็อกกลับมาเต็มแล้ว", headerBg:"#052e16", iconBg:"#16a34a", accent:"#4ade80", urgent:false },
  };
  const cfg = configs[type] || configs.empty;
  const pct = maxQty > 0 ? Math.round(remaining / maxQty * 100) : 0;

  const flex = {
    type: "bubble",
    size: "kilo",
    header: {
      type: "box", layout: "horizontal", paddingAll: "16px",
      backgroundColor: cfg.headerBg,
      contents: [
        { type: "box", layout: "vertical", width: "48px", height: "48px", backgroundColor: cfg.iconBg,
          cornerRadius: "12px", alignItems: "center", justifyContent: "center",
          contents: [{ type: "text", text: cfg.emoji, size: "xl", align: "center" }]
        },
        { type: "box", layout: "vertical", flex: 1, paddingStart: "12px", contents: [
          { type: "text", text: cfg.title, size: "lg", color: "#f1f5f9", weight: "bold" },
          { type: "text", text: cfg.subtitle, size: "xs", color: "#94a3b8", margin: "xs", wrap: true }
        ]}
      ]
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "14px",
      backgroundColor: "#1e293b",
      contents: [
        { type: "box", layout: "horizontal", backgroundColor: "#0f172a", cornerRadius: "10px", paddingAll: "12px",
          contents: [
            { type: "box", layout: "vertical", flex: 1, contents: [
              { type: "text", text: "ช่อง " + slot, size: "xs", color: "#64748b" },
              { type: "text", text: name, size: "md", color: "#e2e8f0", weight: "bold", wrap: true, margin: "xs" }
            ]},
            { type: "box", layout: "vertical", alignItems: "flex-end", contents: [
              { type: "text", text: remaining + "/" + maxQty, size: "lg", color: cfg.accent, weight: "bold" },
              { type: "text", text: "ขวด", size: "xxs", color: "#64748b", margin: "xs" }
            ]}
          ]},
        { type: "box", layout: "horizontal", margin: "md", height: "6px", backgroundColor: "#334155", cornerRadius: "3px",
          contents: [
            { type: "box", layout: "horizontal", width: Math.max(2, pct) + "%", backgroundColor: cfg.accent, cornerRadius: "3px", contents: [] }
          ]},
        cfg.urgent ? {
          type: "box", layout: "horizontal", margin: "md", backgroundColor: "#450a0a",
          cornerRadius: "8px", paddingAll: "10px",
          contents: [{ type: "text", text: "⚡ กรุณาตรวจสอบด่วน!", size: "sm", color: "#f87171", weight: "bold", align: "center" }]
        } : { type: "separator", margin: "none", color: "transparent" }
      ]
    },
    footer: {
      type: "box", layout: "horizontal", paddingAll: "10px",
      backgroundColor: "#020617",
      contents: [
        { type: "text", text: "LAUM Vending · " + new Date().toLocaleTimeString("th-TH",{hour:"2-digit",minute:"2-digit"}), size: "xxs", color: "#475569", align: "center" }
      ]
    }
  };
  sendLineRaw([{ type: "flex", altText: cfg.title + ": ช่อง " + slot + " " + name, contents: flex }]);
}

// ส่ง Flex สำหรับสรุปรายวัน
function sendLineSummary(period, revenue, cost, profit, profitPct, sales, stuck, emptyCount, lowCount) {
  const flex = {
    type: "bubble",
    size: "mega",
    header: {
      type: "box", layout: "vertical", paddingAll: "16px",
      backgroundColor: "#0f172a",
      contents: [
        { type: "box", layout: "horizontal", contents: [
          { type: "text", text: "📊 สรุปยอดขาย", size: "lg", color: "#f1f5f9", weight: "bold", flex: 1 },
          { type: "text", text: period, size: "sm", color: "#64748b", align: "end" }
        ]},
        { type: "text", text: new Date().toLocaleDateString("th-TH",{day:"numeric",month:"long",year:"numeric"}), size: "xs", color: "#475569", margin: "xs" }
      ]
    },
    body: {
      type: "box", layout: "vertical", paddingAll: "14px", spacing: "md",
      backgroundColor: "#1e293b",
      contents: [
        // 3 ก้อนเงิน
        { type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            { type: "box", layout: "vertical", flex: 1, backgroundColor: "#0f2d1a", cornerRadius: "10px", paddingAll: "12px", alignItems: "center",
              contents: [
                { type: "text", text: "รายรับ", size: "xxs", color: "#94a3b8" },
                { type: "text", text: "฿" + revenue.toLocaleString(), size: "md", color: "#4ade80", weight: "bold", margin: "sm" }
              ]},
            { type: "box", layout: "vertical", flex: 1, backgroundColor: "#1a0f0f", cornerRadius: "10px", paddingAll: "12px", alignItems: "center",
              contents: [
                { type: "text", text: "ต้นทุน", size: "xxs", color: "#94a3b8" },
                { type: "text", text: "฿" + cost.toLocaleString(), size: "md", color: "#f87171", weight: "bold", margin: "sm" }
              ]},
            { type: "box", layout: "vertical", flex: 1, backgroundColor: "#0a1628", cornerRadius: "10px", paddingAll: "12px", alignItems: "center",
              contents: [
                { type: "text", text: "กำไร", size: "xxs", color: "#94a3b8" },
                { type: "text", text: "฿" + profit.toLocaleString(), size: "md", color: "#60a5fa", weight: "bold", margin: "sm" }
              ]}
          ]},
        // อัตรากำไร
        { type: "box", layout: "vertical", backgroundColor: "#0f172a", cornerRadius: "8px", paddingAll: "10px",
          contents: [
            { type: "box", layout: "horizontal", contents: [
              { type: "text", text: "อัตรากำไร", size: "xs", color: "#94a3b8", flex: 1 },
              { type: "text", text: profitPct + "%", size: "xs", color: "#60a5fa", weight: "bold" }
            ]},
            { type: "box", layout: "horizontal", margin: "sm", height: "5px", backgroundColor: "#334155", cornerRadius: "3px",
              contents: [
                { type: "box", layout: "horizontal", width: Math.min(100,profitPct) + "%", backgroundColor: "#3b82f6", cornerRadius: "3px", contents: [] }
              ]}
          ]},
        // stats
        { type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            { type: "box", layout: "vertical", flex: 1, backgroundColor: "#0f172a", cornerRadius: "8px", paddingAll: "10px", alignItems: "center",
              contents: [
                { type: "text", text: "🥤", size: "lg" },
                { type: "text", text: str(sales)+" ขวด", size: "xs", color: "#94a3b8", margin: "xs" }
              ]},
            { type: "box", layout: "vertical", flex: 1, backgroundColor: stuck>0?"#1a0505":"#0f172a", cornerRadius: "8px", paddingAll: "10px", alignItems: "center",
              contents: [
                { type: "text", text: "🚨", size: "lg" },
                { type: "text", text: "ติด "+str(stuck)+" ครั้ง", size: "xs", color: stuck>0?"#f87171":"#94a3b8", margin: "xs" }
              ]},
            { type: "box", layout: "vertical", flex: 1, backgroundColor: emptyCount>0?"#1a0505":"#0f172a", cornerRadius: "8px", paddingAll: "10px", alignItems: "center",
              contents: [
                { type: "text", text: "⛔", size: "lg" },
                { type: "text", text: "หมด "+str(emptyCount)+" ช่อง", size: "xs", color: emptyCount>0?"#f87171":"#94a3b8", margin: "xs" }
              ]}
          ]}
      ]
    },
    footer: {
      type: "box", layout: "horizontal", paddingAll: "10px",
      backgroundColor: "#020617",
      contents: [
        { type: "text", text: "LAUM Vending System", size: "xxs", color: "#475569", align: "center" }
      ]
    }
  };
  sendLineRaw([{ type: "flex", altText: "สรุปยอดขาย " + period + " ฿" + revenue.toLocaleString(), contents: flex }]);
}

function str(n){ return String(n); }

function sendLineRaw(messages) {
  if (!CONFIG.LINE_TOKEN || CONFIG.LINE_TOKEN.startsWith("YOUR_")) {
    console.log("[LINE]", JSON.stringify(messages)); return;
  }
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post", contentType: "application/json",
      headers: { Authorization: "Bearer " + CONFIG.LINE_TOKEN },
      payload: JSON.stringify({ to: CONFIG.LINE_USER_ID, messages }),
      muteHttpExceptions: true,
    });
  } catch (err) { console.error("LINE:", err); }
}

// ════════════════════════════════════════════════════
// Setup Triggers
// ════════════════════════════════════════════════════
function setupTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === "sendDailySummary")
    .forEach(t => ScriptApp.deleteTrigger(t));
  [9, 14, 19].forEach(h =>
    ScriptApp.newTrigger("sendDailySummary").timeBased().atHour(h).everyDays(1).create()
  );
  Logger.log("Triggers: 09:00, 14:00, 19:00 ✅");
}

// ════════════════════════════════════════════════════
// ทดสอบ
// ════════════════════════════════════════════════════
function testGetProducts()  { Logger.log(JSON.stringify(getProducts(), null, 2)); }
function testGetSummary()   { Logger.log(JSON.stringify(getSummary("today"), null, 2)); }
function testGetAll()       { Logger.log(JSON.stringify(getSummary("all"), null, 2)); }
function testLine()         { sendLine("🤖 LAUM Vending ทดสอบ ✅"); }
function testSale()         { handleSale({ action:"sale", machineId:"M1", slot:19 }); }
function testRefill()       { handleRefill({ action:"refill", machineId:"M1", slot:19 }); }
function testRefillAll()    { handleRefillAll({ action:"refill_all", machineId:"M1" }); }
