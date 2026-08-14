// 抢餐主脚本（守望模式）：每周五下午放餐，轮询探测下周菜单，出现即抢
// 用法: node sniper.js menu [YYYYMMDD] | check [YYYYMMDD] | watch
const fs = require("fs");
const path = require("path");
const { init, getSign } = require("./signer.js");

const cfgPath = path.join(__dirname, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const BASE = "https://order.hersweetie.com/feishu-api";
const MEAL_NAME = { "1": "早餐", "2": "午餐", "3": "晚餐" };
const MEAL_KEY = { "1": "breakfast", "2": "lunch", "3": "dinner" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function today() {
  return fmtDate(new Date());
}

// 下周的工作日列表（周一~周五），返回 YYYYMMDD 数组
function nextWeekWorkdays() {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + (8 - day)); // 下周一
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push(fmtDate(d));
  }
  return out;
}

async function api(method, url, params, body) {
  let full = url;
  if (params) {
    full += "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  }
  const time = String(Math.round(Date.now() / 1000));
  const headers = {
    "Content-Type": "application/json;charset=utf-8",
    openId: cfg.openId,
    "x-time": time,
    "x-sign": getSign(time, cfg.openId),
    Cookie: "openId=" + cfg.openId,
    Origin: "https://order.hersweetie.com",
    Referer: "https://order.hersweetie.com/feishu/home",
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  const res = await fetch(BASE + full, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const getMenu = (mealType, mealDate) => api("GET", "/v2/dailymeals/list", { mealType, mealDate });
const getAddressList = (mealType, mealDate) => api("GET", "/v2/address/list", { mealType, mealDate });
// 注意：查订单只传 orderDate，mealType 参数服务端不认
const getMyOrder = (orderDate) => api("GET", "/v2/order/listByUidAndDate", { orderDate });
const createOrder = (payload) => api("POST", "/order/create", null, payload);

// 选餐策略：keywords 非空时先按关键词过滤；最终取剩余份数最少且有货的
function pickPackage(menuData, keywords) {
  if (!Array.isArray(menuData) || !menuData.length) return null;
  const avail = menuData.filter((p) => p.stockRemaining === undefined || p.stockRemaining > 0);
  if (!avail.length) return null;
  let pool = avail;
  if (keywords && keywords.length) {
    const hits = avail.filter((p) => keywords.some((kw) => (p.packageName || "").includes(kw)));
    if (hits.length) pool = hits;
    else return null;
  }
  return pool.reduce((best, p) => (p.stockRemaining < best.stockRemaining ? p : best), pool[0]);
}

function pkgDesc(p) {
  const name = (p.packageName || "").split("\n")[0].trim();
  return `${p.sequenceChar}「${name}」余${p.stockRemaining}份`;
}

async function cmdMenu(date) {
  const d = date || today();
  for (const mt of ["1", "2", "3"]) {
    const r = await getMenu(mt, d);
    if (r.code !== 200) {
      console.log(`[${MEAL_NAME[mt]} ${d}] 接口返回: ${r.code} ${r.msg || ""}`);
      continue;
    }
    if (Array.isArray(r.data) && r.data.length) {
      console.log(`\n[${MEAL_NAME[mt]} ${d}]`);
      r.data.forEach((p) => console.log(pkgDesc(p), "|", (p.packageName || "").replace(/\n/g, " / ")));
    }
  }
}

async function cmdCheck(date) {
  const d = date || today();
  const mt = (cfg.mealTypes && cfg.mealTypes[0]) || cfg.mealType || "2";
  const o = await getMyOrder(d);
  if (o.code === 200 && o.data) {
    console.log(`订单情况(${d}):`);
    for (const [key, name] of [["breakfast", "早餐"], ["lunch", "午餐"], ["dinner", "晚餐"]]) {
      const s = o.data[key];
      // orderStatus: 0=未点 1=已点 3≈已取消，其余视为已占用
      if (Array.isArray(s) && s.length && ![0, 3].includes(s[0].orderStatus)) {
        console.log(`  ${name}: ${s[0].orderStatusName || "已点"} ${(s[0].packageName || "").replace(/\n/g, "，").slice(0, 60)}`);
      } else {
        console.log(`  ${name}: 未点`);
      }
    }
  } else {
    console.log(`订单查询(${d}):`, o.code, o.msg || "");
  }
  const a = await getAddressList(mt, d);
  if (a.code === 200 && Array.isArray(a.data)) {
    console.log("\n可用配送区域:");
    a.data.forEach((x) => console.log(`  id=${x.id} ${x.detailAddress}`));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 限流识别：命中就长退避，避免连续失败把冷却窗口越踩越长
function isRateLimited(r) {
  const msg = (r && r.msg) || "";
  return /频繁|过多|稍后再试/.test(msg);
}

// 守望模式（常驻守护）：早+午餐双目标，菜单一出现立刻抢
// 请求节奏：菜单未放出时每日期每餐仅 1 发；菜单放出后每天补 1 发订单查询；
// 全部完成后进入长休眠，跨周自动滚动到新的下周一~周五；命中限流整轮退避
async function cmdWatch() {
  const mealTypes = cfg.mealTypes && cfg.mealTypes.length ? cfg.mealTypes : [cfg.mealType || "2"];
  // 硬规则：只抢早餐和午餐，晚餐永不开抢
  if (mealTypes.includes("3")) {
    console.log("规则限制：只抢早餐(1)和午餐(2)，不碰晚餐。config.json 的 mealTypes 别含 3，喵。");
    process.exit(1);
  }
  const cooldownMs = (cfg.rateLimitCooldownMin || 10) * 60 * 1000;
  const doneSleepMs = (cfg.doneSleepMin || 30) * 60 * 1000;
  // 变频守望：平时低频安静盯梢，放餐窗口（周五全天）切高频抢首发
  const idleMs = (cfg.idlePollIntervalMs || 600000);      // 平时：10 分钟一轮
  const burstMs = (cfg.burstPollIntervalMs || 60000);     // 周五放餐窗口：1 分钟一轮
  const burstHour = cfg.burstStartHour ?? 0;              // 周五 0 点起进入高频
  const pollMs = () => {
    const now = new Date();
    return now.getDay() === 5 && now.getHours() >= burstHour ? burstMs : idleMs;
  };
  console.log(`守望 ${mealTypes.map((m) => MEAL_NAME[m]).join("+")} | 目标: ${cfg.dates && cfg.dates.length ? cfg.dates.join(", ") : "动态下周一~周五"}`);
  console.log(`轮询: 平时 ${idleMs / 60000} 分钟/轮，周五 ${burstHour} 点起 ${burstMs / 60000} 分钟/轮`);
  console.log(`策略: ${cfg.keywords && cfg.keywords.length ? "关键词[" + cfg.keywords.join(",") + "] + " : ""}份数最少优先 | 地址: ${cfg.addressDetail}(id=${cfg.addressId})`);
  if (cfg.dryRun) console.log("!! dryRun 模式：只探测不真实下单");
  const done = new Set(); // key: `${date}:${mealType}`

  while (true) {
    const targets = cfg.dates && cfg.dates.length ? cfg.dates : nextWeekWorkdays();
    // 跨周滚动：清掉不属于本周目标的完成标记
    for (const k of [...done]) {
      if (!targets.includes(k.split(":")[0])) done.delete(k);
    }
    let rateLimited = false;

    for (const d of targets) {
      try {
        // 第一步：每餐查一次菜单
        const menus = {};
        for (const mt of mealTypes) {
          if (done.has(`${d}:${mt}`)) continue;
          const menu = await getMenu(mt, d);
          if (isRateLimited(menu)) {
            console.log(`[${d}] ${new Date().toLocaleTimeString()} 被限流: ${menu.msg} → 退避 ${cooldownMs / 60000} 分钟`);
            rateLimited = true;
            break;
          }
          if (menu.code !== 200) {
            console.log(`[${d} ${MEAL_NAME[mt]}] 接口: ${menu.code} ${menu.msg || ""}`);
            continue;
          }
          if (Array.isArray(menu.data) && menu.data.length) menus[mt] = menu.data;
        }
        if (rateLimited) break;
        if (!Object.keys(menus).length) continue; // 还没放餐，静默继续

        // 第二步：菜单放出了才查订单（一天一发，返回三餐全量）
        const o = await getMyOrder(d);
        if (isRateLimited(o)) {
          console.log(`[${d}] 被限流: ${o.msg} → 退避 ${cooldownMs / 60000} 分钟`);
          rateLimited = true;
          break;
        }

        for (const mt of Object.keys(menus)) {
          if (done.has(`${d}:${mt}`)) continue;
          console.log(`[${d}] ${MEAL_NAME[mt]} 菜单已放出（${menus[mt].length} 个套餐）`);
          const slot = o.code === 200 && o.data ? o.data[MEAL_KEY[mt]] : null;
          if (Array.isArray(slot) && slot.length && ![0, 3].includes(slot[0].orderStatus)) {
            console.log(`[${d} ${MEAL_NAME[mt]}] 已有订单（${(slot[0].packageName || "").split("\n")[0]}），跳过`);
            done.add(`${d}:${mt}`);
            continue;
          }
          const pkg = pickPackage(menus[mt], cfg.keywords);
          if (!pkg) {
            console.log(`[${d} ${MEAL_NAME[mt]}] 无匹配项/全售罄`);
            done.add(`${d}:${mt}`);
            continue;
          }
          console.log(`[${d} ${MEAL_NAME[mt]}] 命中 ${pkgDesc(pkg)} → 下单`);
          if (cfg.dryRun) {
            console.log(`[${d} ${MEAL_NAME[mt]}] dryRun: 模拟下单成功，不发送请求`);
            done.add(`${d}:${mt}`);
            continue;
          }
          const payload = {
            mealType: mt,
            orderDate: d,
            packageName: pkg.packageName,
            sequenceChar: pkg.sequenceChar,
            addressId: cfg.addressId,
            addressDetail: cfg.addressDetail,
          };
          const r = await createOrder(payload);
          console.log(`[${d} ${MEAL_NAME[mt]}] 下单结果:`, JSON.stringify(r));
          if (r.code === 200) done.add(`${d}:${mt}`);
          else if (isRateLimited(r)) rateLimited = true;
          await sleep(cfg.perDateGapMs || 2000);
        }
      } catch (e) {
        console.error(`[${d}] 请求异常:`, e.message);
      }
      // 日期之间加小间隔，别把请求挤在同一秒
      await sleep(cfg.perDateGapMs || 2000);
    }

    const allDone = targets.every((d) => mealTypes.every((mt) => done.has(`${d}:${mt}`)));
    const wait = rateLimited ? cooldownMs : allDone ? doneSleepMs : pollMs();
    console.log(`${new Date().toLocaleTimeString()} 本轮结束，${wait >= 60000 ? Math.round(wait / 60000) + " 分钟" : wait / 1000 + " 秒"}后再见`);
    await sleep(wait);
  }
}

async function main() {
  if (!cfg.openId || cfg.openId === "在这里粘贴你的openId") {
    console.log("config.json 里还没填 openId！");
    process.exit(1);
  }
  await init(cfg.openId);
  const cmd = process.argv[2] || "watch";
  const arg = process.argv[3];
  if (cmd === "menu") return cmdMenu(arg);
  if (cmd === "check") return cmdCheck(arg);
  if (cmd === "watch") return cmdWatch();
  console.log("用法: node sniper.js menu [YYYYMMDD] | check [YYYYMMDD] | watch");
}

main().catch((e) => {
  console.error("出错:", e);
  process.exit(1);
});
