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

// 全局请求步进：任意两个请求之间至少间隔 requestGapMs，避免短时突发触发频控
let lastReqAt = 0;

async function api(method, url, params, body) {
  // 实测：GET 接口 50ms 间隔可行（0ms 连发触发限流，冷却约13分钟）；POST 下单不设限
  // 取 500ms 留足余量：扫荡全流程 25 发约 12 秒完成
  const gap = cfg.requestGapMs ?? 500;
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
  const cooldownMs = (cfg.rateLimitCooldownMin || 10) * 60 * 1000;
  const doneSleepMs = (cfg.doneSleepMin || 30) * 60 * 1000;
  // 活跃窗口制：周一~周四完全静默长眠；周五 activeStartHour 起每分钟一轮
  // 周五之后（周末）窗口保持开启，用于「取消后自动补抢」；全部完成后每轮零请求
  const activeHour = cfg.activeStartHour ?? 13;
  const activeMs = cfg.pollIntervalMs || 10000; // 实测单点侦察可承受更高频，10 秒一轮
  const useWindow = !(cfg.dates && cfg.dates.length); // 显式指定 dates 时不限窗口，便于测试
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
  console.log(`轮询: ${useWindow ? `周五 ${activeHour}:00 起每轮 1 发侦察（${activeMs / 1000} 秒/轮），放出即扫荡，周一~周四静默` : "指定 dates，不限窗口"}`);
  console.log(`策略: ${cfg.keywords && cfg.keywords.length ? "关键词[" + cfg.keywords.join(",") + "] + " : ""}份数最少优先 | 地址: ${cfg.addressDetail}(id=${cfg.addressId})`);
  if (cfg.dryRun) console.log("!! dryRun 模式：只探测不真实下单");
  const done = new Set(); // key: `${date}:${mealType}`
  let cursor = 0; // 侦察轮转游标

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

    // 侦察模式：未放餐阶段每轮只发 1 发菜单探测，轮转覆盖所有目标
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
        console.log(`[${probe.d} ${MEAL_NAME[probe.mt]}] ${new Date().toLocaleTimeString()} 被限流: ${menu.msg} → 退避 ${cooldownMs / 60000} 分钟`);
        rateLimited = true;
      } else if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) {
        released = true;
      } else if (menu.code !== 200) {
        console.log(`[${probe.d} ${MEAL_NAME[probe.mt]}] 接口: ${menu.code} ${menu.msg || ""}`);
      }
    } catch (e) {
      console.error(`[${probe.d}] 侦察异常:`, e.message);
    }

    // 扫荡模式：侦察发现菜单已放，立刻全量处理所有日期
    // 稀缺款（放出时两位数库存）竞争窗口极短，两阶段策略：
    //   阶段一：逐日期拉菜单，撞见稀缺候选立即下单（跳过订单预查，最快 8 秒锁定）
    //   阶段二：剩余目标按稀缺度排序，走完整流程（订单预查+下单+死名单重试）
    if (released && !rateLimited) {
      const dead = new Set(); // 下单失败（库存不足等）的 "日期|套餐名"
      const scarce = cfg.scarceThreshold ?? 100; // 两位数 = 稀缺
      const plan = [];

      // 阶段一：边拉菜单边抢稀缺
      for (const d of targets) {
        if (rateLimited) break;
        try {
          const menus = {};
          for (const mt of mealTypes) {
            if (done.has(`${d}:${mt}`)) continue;
            const menu = await getMenu(mt, d);
            if (isRateLimited(menu)) {
              console.log(`[${d}] 被限流: ${menu.msg} → 退避 ${cooldownMs / 60000} 分钟`);
              rateLimited = true;
              break;
            }
            if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) menus[mt] = menu.data;
          }
          if (rateLimited) break;
          if (!Object.keys(menus).length) continue; // 该日期还没放餐

          for (const mt of Object.keys(menus)) {
            if (done.has(`${d}:${mt}`)) continue;
            const pkg = pickPackage(menus[mt], cfg.keywords, dead, d);
            if (!pkg) {
              done.add(`${d}:${mt}`);
              continue;
            }
            if ((pkg.stockRemaining ?? Infinity) < scarce) {
              console.log(`[${d} ${MEAL_NAME[mt]}] ⚡稀缺 ${pkgDesc(pkg)} → 跳过预查直接下单`);
              if (cfg.dryRun) {
                console.log(`[${d} ${MEAL_NAME[mt]}] dryRun: 模拟下单成功`);
                done.add(`${d}:${mt}`);
                continue;
              }
              try {
                const r = await createOrder({
                  mealType: mt,
                  orderDate: d,
                  packageName: pkg.packageName,
                  sequenceChar: pkg.sequenceChar,
                  addressId: cfg.addressId,
                  addressDetail: cfg.addressDetail,
                });
                if (r.code === 200) {
                  console.log(`[${d} ${MEAL_NAME[mt]}] ⚡下单成功 orderId=${r.data?.orderId}`);
                  done.add(`${d}:${mt}`);
                  continue;
                }
                if (isRateLimited(r)) {
                  console.log(`[${d} ${MEAL_NAME[mt]}] 被限流: ${r.msg} → 退避`);
                  rateLimited = true;
                  break;
                }
                // 失败（库存被截/已点等）：标记死亡，留给阶段二完整流程复核
                console.log(`[${d} ${MEAL_NAME[mt]}] ⚡失败(${r.code}): ${r.msg} → 交给阶段二复核`);
                dead.add(`${d}|${pkg.packageName}`);
              } catch (e) {
                console.error(`[${d} ${MEAL_NAME[mt]}] ⚡下单异常:`, e.message);
              }
            }
            if (!done.has(`${d}:${mt}`)) plan.push({ d, mt, menus: menus[mt] });
          }
        } catch (e) {
          console.error(`[${d}] 扫荡查询异常:`, e.message);
        }
      }

      // 阶段二：剩余目标按稀缺度排序，查订单后下单，两轮死名单重试
      if (!rateLimited && plan.length) {
        const orderCache = {};
        for (let round = 0; round < 2; round++) {
          const queue = [];
          for (const { d, mt, menus } of plan) {
            if (done.has(`${d}:${mt}`)) continue;
            let o = orderCache[d];
            if (!o) {
              try {
                o = await getMyOrder(d);
              } catch (e) {
                console.error(`[${d}] 订单查询异常:`, e.message);
                continue;
              }
              if (isRateLimited(o)) {
                console.log(`[${d}] 被限流: ${o.msg} → 退避 ${cooldownMs / 60000} 分钟`);
                rateLimited = true;
                break;
              }
              orderCache[d] = o;
            }
            const slot = o.code === 200 && o.data ? o.data[MEAL_KEY[mt]] : null;
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
            queue.push({ d, mt, pkg });
          }
          if (rateLimited || !queue.length) break;
          queue.sort((a, b) => (a.pkg.stockRemaining ?? Infinity) - (b.pkg.stockRemaining ?? Infinity));
          for (const { d, mt, pkg } of queue) {
            try {
              console.log(`[${d} ${MEAL_NAME[mt]}] 命中 ${pkgDesc(pkg)} → 下单`);
              if (cfg.dryRun) {
                console.log(`[${d} ${MEAL_NAME[mt]}] dryRun: 模拟下单成功`);
                done.add(`${d}:${mt}`);
                continue;
              }
              const r = await createOrder({
                mealType: mt,
                orderDate: d,
                packageName: pkg.packageName,
                sequenceChar: pkg.sequenceChar,
                addressId: cfg.addressId,
                addressDetail: cfg.addressDetail,
              });
              if (r.code === 200) {
                console.log(`[${d} ${MEAL_NAME[mt]}] 下单成功 orderId=${r.data?.orderId}`);
                done.add(`${d}:${mt}`);
              } else if (isRateLimited(r)) {
                console.log(`[${d} ${MEAL_NAME[mt]}] 被限流: ${r.msg} → 退避`);
                rateLimited = true;
                break;
              } else {
                console.log(`[${d} ${MEAL_NAME[mt]}] 下单失败(${r.code}): ${r.msg} → 换候选`);
                dead.add(`${d}|${pkg.packageName}`);
              }
            } catch (e) {
              console.error(`[${d} ${MEAL_NAME[mt]}] 下单异常:`, e.message);
            }
          }
          if (rateLimited || round === 1) break;
          if (!plan.some(({ d, mt }) => !done.has(`${d}:${mt}`))) break;
          console.log(`--- 第二轮：对失败目标换候选重试 ---`);
        }
      }
    }

    const allDone = targets.every((d) => mealTypes.every((mt) => done.has(`${d}:${mt}`)));
    const wait = rateLimited ? cooldownMs : allDone ? doneSleepMs : activeMs;
    console.log(`${new Date().toLocaleTimeString()} 本轮结束（侦察 ${probe.d} ${MEAL_NAME[probe.mt]}${released ? " → 已放餐，扫荡完毕" : " 未放"}），${wait >= 60000 ? Math.round(wait / 60000) + " 分钟" : wait / 1000 + " 秒"}后再见`);
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
