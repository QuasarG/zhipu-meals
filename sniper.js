// 抢餐主脚本（守望模式）：每周五下午放餐，轮询探测下周菜单，出现即抢
// 用法: node sniper.js menu [YYYYMMDD] | check [YYYYMMDD] | watch
// 多人共部署：设 CONFIG_DIR 环境变量指向各自的配置目录
const fs = require("fs");
const path = require("path");
const { init, getSign } = require("./signer.js");

const cfgDir = process.env.CONFIG_DIR || __dirname;
const cfgPath = path.join(cfgDir, "config.json");
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

// 全局请求步进：可动态调整（守望期防限流；扫荡期降到 sweepGapMs）
let lastReqAt = 0;
let currentGapMs = null; // null = 用 cfg.requestGapMs

async function api(method, url, params, body) {
  // 实测：串行 GET 快速连打会触发令牌桶限流（容量≈24-30，回血≈0.25-0.5发/秒）；
  // 并发齐发与 POST 下单不受限。守望 5s/发稳态，扫荡 0.5s/发短脉冲，下单并发齐发
  const gap = currentGapMs ?? cfg.requestGapMs ?? 500;
  const wait = lastReqAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastReqAt = Date.now();
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
// dead: 本轮扫荡中下单失败（如库存不足）的 "日期|套餐名" 集合，排除后重选
function pickPackage(menuData, keywords, dead, date) {
  if (!Array.isArray(menuData) || !menuData.length) return null;
  const avail = menuData.filter((p) => {
    if (p.stockRemaining !== undefined && p.stockRemaining <= 0) return false;
    if (dead && dead.has(`${date}|${p.packageName}`)) return false;
    return true;
  });
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
// 侦察：未放餐时每轮仅 1 发菜单探测（轮转目标），探测到放出后进入扫荡
// 扫荡：全量处理所有日期；全部完成后长休眠，跨周自动滚动；限流整轮退避
// 全局请求步进 requestGapMs 兜底，杜绝短时突发
async function cmdWatch() {
  const mealTypes = cfg.mealTypes && cfg.mealTypes.length ? cfg.mealTypes : [cfg.mealType || "2"];
  // 硬规则：只抢早餐和午餐，晚餐永不开抢
  if (mealTypes.includes("3")) {
    console.log("规则限制：只抢早餐(1)和午餐(2)，不碰晚餐。config.json 的 mealTypes 别含 3，喵。");
    process.exit(1);
  }
  const cooldownMs = (cfg.rateLimitCooldownMin || 15) * 60 * 1000;
  const doneSleepMs = (cfg.doneSleepMin || 30) * 60 * 1000;
  // 活跃窗口制：周一~周四完全静默长眠；周五 activeStartHour 起进入高频守望
  const activeHour = cfg.activeStartHour ?? 13;
  const useWindow = !(cfg.dates && cfg.dates.length); // 显式指定 dates 时不限窗口，便于测试
  // 三段变速（实测令牌桶容量≈24-30、回血≈0.25-0.5发/秒；并发齐发不受限）：
  //   守望 5s/发（0.2发/秒 < 回血速率，永不触发）；发现放餐后 0.5s/发连拉 10 餐即停
  const watchGapMs = cfg.watchGapMs || 5000;
  const sweepGapMs = cfg.sweepGapMs || 500;
  const inWindow = (now = new Date()) => {
    const day = now.getDay(); // 0=周日 5=周五 6=周六
    if (day === 5) return now.getHours() >= activeHour;
    return day === 6 || day === 0;
  };
  const msUntilWindow = (now = new Date()) => {
    const t = new Date(now);
    t.setDate(now.getDate() + ((5 - now.getDay() + 7) % 7));
    t.setHours(activeHour, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 7);
    return t - now;
  };
  console.log(`守望 ${mealTypes.map((m) => MEAL_NAME[m]).join("+")} | 目标: ${cfg.dates && cfg.dates.length ? cfg.dates.join(", ") : "动态下周一~周五"}`);
  console.log(`节奏: ${useWindow ? `周五 ${activeHour}:00 起守望 ${watchGapMs / 1000}s/发不停歇，放餐后 ${sweepGapMs}ms/发连拉菜单，齐发并发下单；周一~周四静默` : "指定 dates，不限窗口"}`);
  console.log(`策略: ${cfg.keywords && cfg.keywords.length ? "关键词[" + cfg.keywords.join(",") + "] + " : ""}份数最少优先 | 地址: ${cfg.addressDetail}(id=${cfg.addressId})`);
  if (cfg.dryRun) console.log("!! dryRun 模式：只探测不真实下单");
  const done = new Set(); // key: `${date}:${mealType}`
  let cursor = 0; // 守望轮转游标

  // 并发下单（POST 实测不限流）：同批订单 Promise.all 齐发
  async function fireOrders(batch) {
    const results = await Promise.all(batch.map(async ({ d, mt, pkg }) => {
      try {
        const r = await createOrder({
          mealType: mt,
          orderDate: d,
          packageName: pkg.packageName,
          sequenceChar: pkg.sequenceChar,
          addressId: cfg.addressId,
          addressDetail: cfg.addressDetail,
        });
        return { d, mt, pkg, r };
      } catch (e) {
        return { d, mt, pkg, r: { code: -1, msg: e.message } };
      }
    }));
    return results;
  }

  while (true) {
    // 非活跃窗口：整轮跳过，零请求，一觉睡到周五 activeStartHour
    if (useWindow && !inWindow()) {
      const wait = msUntilWindow();
      const hrs = Math.round(wait / 3600000);
      console.log(`${new Date().toLocaleTimeString()} 非活跃窗口（周一~周四/周五${activeHour}点前），休眠 ${hrs} 小时至周五 ${activeHour}:00 开抢`);
      await sleep(wait);
      continue;
    }
    const targets = cfg.dates && cfg.dates.length ? cfg.dates : nextWeekWorkdays();
    // 跨周滚动：清掉不属于本周目标的完成标记
    for (const k of [...done]) {
      if (!targets.includes(k.split(":")[0])) done.delete(k);
    }

    // 等待守望：5s 一发单点探测，永不停歇（低于回血速率，理论上永不触发限流）
    const pending = [];
    for (const d of targets) {
      for (const mt of mealTypes) {
        if (!done.has(`${d}:${mt}`)) pending.push({ d, mt });
      }
    }
    let rateLimited = false;
    let released = false;

    if (!pending.length) {
      const wait = doneSleepMs;
      console.log(`${new Date().toLocaleTimeString()} 全部完成，${wait / 60000} 分钟后复查`);
      await sleep(wait);
      continue;
    }

    const probe = pending[cursor++ % pending.length];
    try {
      const menu = await getMenu(probe.mt, probe.d);
      if (isRateLimited(menu)) {
        console.log(`[${probe.d} ${MEAL_NAME[probe.mt]}] ${new Date().toLocaleTimeString()} 被限流: ${menu.msg} → 退避 ${cooldownMs / 60000} 分钟（期间完全静默）`);
        rateLimited = true;
      } else if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) {
        released = true;
      } else if (menu.code !== 200) {
        console.log(`[${probe.d} ${MEAL_NAME[probe.mt]}] 接口: ${menu.code} ${menu.msg || ""}`);
      }
    } catch (e) {
      console.error(`[${probe.d}] 守望异常:`, e.message);
    }

    // 扫荡：探测到放餐，0.5s/发连拉全部菜单（共约10发短脉冲），拉完立即并发下单
    if (released && !rateLimited) {
      const t0 = Date.now();
      currentGapMs = sweepGapMs; // 扫荡期提速
      const dead = new Set();
      const plan = []; // {d, mt, menus}

      for (const d of targets) {
        const menus = {};
        for (const mt of mealTypes) {
          if (done.has(`${d}:${mt}`)) continue;
          try {
            const menu = await getMenu(mt, d);
            if (isRateLimited(menu)) {
              console.log(`[${d}] 拉菜单被限流: ${menu.msg}`);
              rateLimited = true;
              break;
            }
            if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) menus[mt] = menu.data;
          } catch (e) {
            console.error(`[${d}] 拉菜单异常:`, e.message);
          }
        }
        if (rateLimited) break;
        for (const mt of Object.keys(menus)) plan.push({ d, mt, menus: menus[mt] });
      }

      if (!rateLimited && plan.length) {
        // 逐天查订单防重复（GET，带步进）
        const orderCache = {};
        const batch = [];
        for (const { d, mt, menus } of plan) {
          let o = orderCache[d];
          if (!o) {
            try {
              o = await getMyOrder(d);
            } catch (e) {
              console.error(`[${d}] 订单查询异常:`, e.message);
              continue;
            }
            if (isRateLimited(o)) { rateLimited = true; break; }
            orderCache[d] = o;
          }
          const slot = o?.code === 200 && o.data ? o.data[MEAL_KEY[mt]] : null;
          if (Array.isArray(slot) && slot.length && ![0, 3].includes(slot[0].orderStatus)) {
            console.log(`[${d} ${MEAL_NAME[mt]}] 已有订单（${(slot[0].packageName || "").split("\n")[0]}），跳过`);
            done.add(`${d}:${mt}`);
            continue;
          }
          const pkg = pickPackage(menus, cfg.keywords, dead, d);
          if (!pkg) {
            console.log(`[${d} ${MEAL_NAME[mt]}] 无匹配项/全售罄`);
            done.add(`${d}:${mt}`);
            continue;
          }
          batch.push({ d, mt, pkg });
        }

        // 并发齐发下单（POST 实测不限流）；失败目标进死名单，换候选再打一批（最多两轮）
        for (let round = 0; round < 2 && !rateLimited; round++) {
          if (!batch.length) break;
          if (round > 0) {
            // 重选候选：排除死名单后重新挑
            batch.length = 0;
            for (const { d, mt, menus } of plan) {
              if (done.has(`${d}:${mt}`)) continue;
              const pkg = pickPackage(menus, cfg.keywords, dead, d);
              if (pkg) batch.push({ d, mt, pkg });
              else { done.add(`${d}:${mt}`); }
            }
            if (!batch.length) break;
            console.log(`--- 第二轮：换候选重试 ${batch.length} 个目标 ---`);
          }
          batch.sort((a, b) => (a.pkg.stockRemaining ?? Infinity) - (b.pkg.stockRemaining ?? Infinity));
          if (cfg.dryRun) {
            for (const { d, mt, pkg } of batch) {
              console.log(`[${d} ${MEAL_NAME[mt]}] dryRun 命中 ${pkgDesc(pkg)}`);
              done.add(`${d}:${mt}`);
            }
            break;
          }
          const results = await fireOrders(batch);
          for (const { d, mt, pkg, r } of results) {
            if (r.code === 200) {
              console.log(`[${d} ${MEAL_NAME[mt]}] ✓下单成功 ${pkgDesc(pkg)} orderId=${r.data?.orderId}`);
              done.add(`${d}:${mt}`);
            } else if (isRateLimited(r)) {
              console.log(`[${d} ${MEAL_NAME[mt]}] 被限流: ${r.msg}`);
              rateLimited = true;
            } else {
              console.log(`[${d} ${MEAL_NAME[mt]}] 失败(${r.code}): ${r.msg} → 换候选`);
              dead.add(`${d}|${pkg.packageName}`);
            }
          }
          if (!plan.some(({ d, mt }) => !done.has(`${d}:${mt}`))) break;
        }
      }
      console.log(`${new Date().toLocaleTimeString()} 扫荡完毕，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      currentGapMs = null; // 恢复守望步进
    }

    const allDone = targets.every((d) => mealTypes.every((mt) => done.has(`${d}:${mt}`)));
    const wait = rateLimited ? cooldownMs : allDone ? doneSleepMs : watchGapMs;
    console.log(`${new Date().toLocaleTimeString()} 本轮（守望 ${probe.d} ${MEAL_NAME[probe.mt]}${released ? " → 放餐！扫荡完毕" : " 未放"}），${wait >= 60000 ? Math.round(wait / 60000) + " 分钟" : wait / 1000 + " 秒"}后再见`);
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
