// 抢餐主脚本 v3：周五放餐自动抢 + 任意时刻启动补漏
// 用法: node sniper.js menu [YYYYMMDD] | check [YYYYMMDD] | watch
// 多人共部署：设 CONFIG_DIR 环境变量指向各自的配置目录
const fs = require("fs");
const path = require("path");
const { init, getSign } = require("./signer.js");

const cfgDir = process.env.CONFIG_DIR || __dirname;
const cfgPath = path.join(cfgDir, "config.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const statePath = path.join(cfgDir, "state.json");

const BASE = "https://order.hersweetie.com/feishu-api";
const MEAL_NAME = { "1": "早餐", "2": "午餐", "3": "晚餐" };
// 出手顺序：午餐是抢手货，整轮优先；早餐库存充足垫后
const MEAL_ORDER = ["2", "1"];
const sortMealTypes = (mts) => [...mts].sort((a, b) => MEAL_ORDER.indexOf(a) - MEAL_ORDER.indexOf(b));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// 实测节奏参数（2026-08~09 服务器实测，见 README）
const WATCH_GAP = cfg.watchGapMs || 5000; // 守望高频档：5s/发，连跑 8 小时零限流
const GENTLE_GAP = cfg.gentleGapMs || 60000; // 守望低频档：周四晚/周末兜底
const SWEEP_MENU_GAP = cfg.sweepMenuGapMs || 2000; // 扫荡拉菜单：2s/发，31 发才触发限流
const COOLDOWN_MS = (cfg.rateLimitCooldownMin || 15) * 60 * 1000;
const DONE_SLEEP_MS = (cfg.doneSleepMin || 30) * 60 * 1000;
const SCARCE = cfg.scarceThreshold ?? 100;
const MAX_ATTEMPTS = cfg.maxOrderAttempts || 8;
const GENTLE_START_HOUR = cfg.gentleStartHour ?? 18; // 周四此时刻起低频守望
const FAST_START_HOUR = cfg.fastStartHour ?? cfg.activeStartHour ?? 10; // 周五此时刻起高频守望

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function today() {
  return fmtDate(new Date());
}

function ts() {
  return new Date().toLocaleTimeString();
}

// 下周的工作日列表（周一~周五），YYYYMMDD 数组
function nextWeekWorkdays() {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() + (8 - day));
  const out = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    out.push(fmtDate(d));
  }
  return out;
}

// 补漏范围：今天 ~ 下周五之间的全部工作日（含今天与下周五）
function catchupDates() {
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay();
  const out = [];
  const end = new Date(now);
  end.setDate(now.getDate() + (5 - day + 7)); // 本周五或下周五
  for (let d = new Date(now); d <= end; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) out.push(fmtDate(d));
  }
  return [...new Set([...out, ...nextWeekWorkdays()])].sort();
}

// 全局请求步进：菜单接口限流敏感，其余接口宽松
let lastMenuReqAt = 0;
let rateLimitedUntil = 0;
let probeCount = 0; // 心跳计数：每 60 发探测汇报一行，证明自己活着

const FETCH_TIMEOUT_MS = cfg.fetchTimeoutMs || 15000; // 僵尸连接保底：超时即弃，绝不悬挂

async function fetchOnce(method, url, params, body) {
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    j = { code: res.status, msg: text.slice(0, 120) };
  }
  j._http = res.status;
  return j;
}

// 网络层重试：超时/断连自动换新连接重试两次（限流是业务码，不在此列）
async function rawApi(method, url, params, body) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchOnce(method, url, params, body);
    } catch (e) {
      lastErr = e;
      if (i < 2) await sleep(1000 + i * 2000);
    }
  }
  throw lastErr;
}

function isRateLimited(r) {
  if (r && r._http === 429) return true;
  const msg = (r && r.msg) || "";
  return /频繁|过多|稍后再试/.test(msg);
}

// 菜单接口专用：串行 + 指定间隔（实测 2s/发安全，500ms 连发第 5-6 发被拍）
async function getMenu(mealType, mealDate, gapMs) {
  const gap = gapMs ?? SWEEP_MENU_GAP;
  const wait = lastMenuReqAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastMenuReqAt = Date.now();
  return rawApi("GET", "/v2/dailymeals/list", { mealType, mealDate });
}

// 订单/地址接口：实测并发齐发不限流
const getAddressList = (mealType, mealDate) => rawApi("GET", "/v2/address/list", { mealType, mealDate });
// 查订单只传 orderDate，mealType 服务端不认
const getMyOrder = (orderDate) => rawApi("GET", "/v2/order/listByUidAndDate", { orderDate });
const createOrder = (payload) => rawApi("POST", "/order/create", null, payload);

// 选餐策略：keywords 非空时只从命中项里选；strategy 决定稀缺优先还是保底优先
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
  const wantMin = (cfg.strategy || "scarcest") !== "safest";
  return pool.reduce((best, p) => {
    const a = p.stockRemaining ?? Infinity, b = best.stockRemaining ?? Infinity;
    return wantMin ? (a < b ? p : best) : (a > b ? p : best);
  }, pool[0]);
}

function pkgDesc(p) {
  const name = (p.packageName || "").split("\n")[0].trim();
  return `${p.sequenceChar}「${name}」余${p.stockRemaining}份`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 完成状态落盘：重启后不必重打下单接口探测
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const t = today();
    return new Set(s.done.filter((k) => k.split(":")[0] >= t));
  } catch (e) {
    return new Set();
  }
}

function saveState(done) {
  const s = { updated: new Date().toISOString(), done: [...done] };
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
}

async function cmdMenu(date) {
  const d = date || today();
  for (const mt of ["1", "2", "3"]) {
    const r = await getMenu(mt, d, 500);
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

// 下单：POST 不限流，失败立即换候选，直到尝试上限或候选耗尽
async function orderNow(d, mt, menuData, dead, done) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pkg = pickPackage(menuData, cfg.keywords, dead, d);
    if (!pkg) {
      console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 无匹配项/全售罄`);
      done.add(`${d}:${mt}`);
      return false;
    }
    console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 命中 ${pkgDesc(pkg)} → 下单`);
    if (cfg.dryRun) {
      console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] dryRun: 模拟下单成功`);
      done.add(`${d}:${mt}`);
      return true;
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
        console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] ✓下单成功 orderId=${r.data?.orderId}`);
        done.add(`${d}:${mt}`);
        return true;
      }
      if (isRateLimited(r)) {
        console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 下单被限流: ${r.msg}`);
        rateLimitedUntil = Date.now() + COOLDOWN_MS;
        return false;
      }
      if (/已存在订单|已点/.test(r.msg || "")) {
        console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 已有订单（手动点的），标记完成`);
        done.add(`${d}:${mt}`);
        return true;
      }
      console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 失败(${r.code}): ${r.msg} → 立即换候选`);
      dead.add(`${d}|${pkg.packageName}`);
    } catch (e) {
      console.error(`${ts()} [${d} ${MEAL_NAME[mt]}] 下单异常:`, e.message);
      return false;
    }
  }
  if (!pickPackage(menuData, cfg.keywords, dead, d)) done.add(`${d}:${mt}`);
  return false;
}

// 启动补漏：并发核对今天~下周五的订单，漏点的当场补上
// 已点的只花订单查询（不限流），未放的留给守望，不动菜单接口预算
async function catchUp(done) {
  const mealTypes = cfg.mealTypes && cfg.mealTypes.length ? cfg.mealTypes : [cfg.mealType || "2"];
  const dates = catchupDates();
  console.log(`${ts()} 启动补漏：核对 ${dates[0]}~${dates[dates.length - 1]}`);
  const orders = await Promise.all(dates.map((d) => getMyOrder(d).catch(() => null)));
  const missing = [];
  dates.forEach((d, i) => {
    const o = orders[i];
    if (!o || o.code !== 200 || !o.data) return;
    const taken = { "1": "breakfast", "2": "lunch", "3": "dinner" };
    for (const mt of mealTypes) {
      const s = o.data[taken[mt]];
      if (Array.isArray(s) && s.length && ![0, 3].includes(s[0].orderStatus)) {
        done.add(`${d}:${mt}`);
      } else if (!done.has(`${d}:${mt}`)) {
        missing.push({ d, mt });
      }
    }
  });
  missing.sort((a, b) => MEAL_ORDER.indexOf(a.mt) - MEAL_ORDER.indexOf(b.mt));
  if (!missing.length) {
    console.log(`${ts()} 补漏完成：范围内都已点过`);
    return;
  }
  console.log(`${ts()} 待补: ${missing.map((m) => `${m.d}${MEAL_NAME[m.mt]}`).join(", ")}`);
  const dead = new Set();
  const nextWeek = new Set(nextWeekWorkdays());
  const thisWeekMissing = missing.filter((m) => !nextWeek.has(m.d));
  const nextWeekMissing = missing.filter((m) => nextWeek.has(m.d));
  // 下周菜单未放时不空耗请求：先探一个哨兵，未放则全部留给守望
  if (nextWeekMissing.length) {
    try {
      const sentinel = await getMenu(nextWeekMissing[0].mt, nextWeekMissing[0].d);
      if (isRateLimited(sentinel)) {
        console.log(`${ts()} 补漏哨兵被限流: ${sentinel.msg}`);
        rateLimitedUntil = Date.now() + COOLDOWN_MS;
        nextWeekMissing.length = 0;
      } else if (!(sentinel.code === 200 && Array.isArray(sentinel.data) && sentinel.data.length)) {
        console.log(`${ts()} 下周菜单未放，跳过下周补漏（留给守望）`);
        nextWeekMissing.length = 0;
      }
    } catch (e) {
      console.error(`${ts()} 补漏哨兵异常:`, e.message);
      nextWeekMissing.length = 0;
    }
  }
  for (const { d, mt } of [...thisWeekMissing, ...nextWeekMissing]) {
    if (Date.now() < rateLimitedUntil) break;
    try {
      const menu = await getMenu(mt, d);
      if (isRateLimited(menu)) {
        console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 补漏拉菜单被限流: ${menu.msg}`);
        rateLimitedUntil = Date.now() + COOLDOWN_MS;
        break;
      }
      if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) {
        await orderNow(d, mt, menu.data, dead, done);
      } else {
        console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 菜单未放，留给守望`);
      }
    } catch (e) {
      console.error(`${ts()} [${d} ${MEAL_NAME[mt]}] 补漏异常:`, e.message);
    }
  }
}

// 守望阶段判定：周四晚起低频兜底，周五大清起高频，周末低频等漏放
function watchGapFor(now = new Date()) {
  const day = now.getDay();
  if (day === 5 && now.getHours() >= FAST_START_HOUR) return WATCH_GAP;
  if (day === 4 && now.getHours() >= GENTLE_START_HOUR) return GENTLE_GAP;
  if (day === 6 || day === 0) return GENTLE_GAP;
  return 0; // 其余时段休眠
}

function msUntilActive(now = new Date()) {
  // 最近一个进入守望的时刻：周四 GENTLE_START_HOUR 或周五 FAST_START_HOUR
  const t = new Date(now);
  const day = now.getDay();
  if (day === 4 && now.getHours() < GENTLE_START_HOUR) {
    t.setHours(GENTLE_START_HOUR, 0, 0, 0);
  } else if (day === 5 && now.getHours() < FAST_START_HOUR) {
    t.setHours(FAST_START_HOUR, 0, 0, 0);
  } else if (day === 6 || day === 0 || day >= 1) {
    const add = (4 - day + 7) % 7 || 7;
    t.setDate(now.getDate() + add);
    t.setHours(GENTLE_START_HOUR, 0, 0, 0);
  }
  return t - now;
}

// 扫荡：侦察目标先出手，整轮午餐再整轮早餐，2s/发拉菜单到手即下单
async function sweep(targets, mealTypes, probe, probeMenu, done) {
  const t0 = Date.now();
  const dead = new Set();
  let limited = false;
  // 侦察响应自带菜单，零额外请求立即出手
  if (!done.has(`${probe.d}:${probe.mt}`) && probeMenu) {
    await orderNow(probe.d, probe.mt, probeMenu, dead, done);
    if (Date.now() < rateLimitedUntil) limited = true;
  }
  // 外层餐次内层日期：先锁完所有午餐抢手货，再回头收拾早餐
  for (const mt of mealTypes) {
    if (limited || Date.now() < rateLimitedUntil) break;
    for (const d of targets) {
      if (done.has(`${d}:${mt}`)) continue;
      if (d === probe.d && mt === probe.mt) continue;
      if (Date.now() < rateLimitedUntil) break;
      try {
        const menu = await getMenu(mt, d);
        if (isRateLimited(menu)) {
          console.log(`${ts()} [${d} ${MEAL_NAME[mt]}] 扫荡拉菜单被限流: ${menu.msg} → 退避 ${COOLDOWN_MS / 60000} 分钟`);
          rateLimitedUntil = Date.now() + COOLDOWN_MS;
          limited = true;
          break;
        }
        if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) {
          await orderNow(d, mt, menu.data, dead, done);
        }
      } catch (e) {
        console.error(`${ts()} [${d} ${MEAL_NAME[mt]}] 扫荡异常:`, e.message);
      }
    }
  }
  console.log(`${ts()} 扫荡完毕，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  saveState(done);
  return !limited;
}

async function cmdWatch() {
  const mealTypes = sortMealTypes((cfg.mealTypes && cfg.mealTypes.length ? cfg.mealTypes : [cfg.mealType || "2"]));
  // 硬规则：只抢早餐和午餐，晚餐永不开抢
  if (mealTypes.includes("3")) {
    console.log("规则限制：只抢早餐(1)和午餐(2)，不碰晚餐。config.json 的 mealTypes 别含 3。");
    process.exit(1);
  }
  const useWindow = !(cfg.dates && cfg.dates.length);
  const done = loadState();
  console.log(`守望 ${mealTypes.map((m) => MEAL_NAME[m]).join("+")} | 目标: ${cfg.dates && cfg.dates.length ? cfg.dates.join(", ") : "动态下周一~周五"}`);
  console.log(`节奏: 高频 ${WATCH_GAP / 1000}s/发（周五${FAST_START_HOUR}点起）| 低频 ${GENTLE_GAP / 1000}s/发（周四${GENTLE_START_HOUR}点起/周末）| 扫荡拉菜单 ${SWEEP_MENU_GAP / 1000}s/发`);
  console.log(`策略: ${cfg.keywords && cfg.keywords.length ? "关键词[" + cfg.keywords.join(",") + "] + " : ""}${cfg.strategy || "scarcest"} | 顺序: ${mealTypes.map((m) => MEAL_NAME[m]).join("→")} | 地址: ${cfg.addressDetail}(id=${cfg.addressId})`);
  if (cfg.dryRun) console.log("!! dryRun 模式：只探测不真实下单");

  await init(cfg.openId);
  await catchUp(done);
  saveState(done);

  let cursor = 0;
  while (true) {
    if (useWindow) {
      const gap = watchGapFor();
      if (!gap) {
        const wait = msUntilActive();
        console.log(`${ts()} 非守望时段，休眠 ${(wait / 3600000).toFixed(1)} 小时至周四 ${GENTLE_START_HOUR}:00 / 周五 ${FAST_START_HOUR}:00`);
        await sleep(wait);
        continue;
      }
    }
    if (Date.now() < rateLimitedUntil) {
      await sleep(Math.min(rateLimitedUntil - Date.now(), 60000));
      continue;
    }
    const targets = cfg.dates && cfg.dates.length ? cfg.dates : nextWeekWorkdays();
    // 跨周滚动 + 过期目标清理
    for (const k of [...done]) {
      if (!targets.includes(k.split(":")[0]) && k.split(":")[0] >= today()) {
        if (k.split(":")[0] > targets[targets.length - 1]) done.delete(k);
      }
      if (k.split(":")[0] < today()) done.delete(k);
    }
    // 午餐排前：轮转探测优先盯抢手货，放餐瞬间首单大概率是午餐
    const pending = [];
    for (const mt of mealTypes) {
      for (const d of targets) {
        if (d < today()) continue;
        if (!done.has(`${d}:${mt}`)) pending.push({ d, mt });
      }
    }
    if (!pending.length) {
      console.log(`${ts()} 全部完成，${DONE_SLEEP_MS / 60000} 分钟后复查`);
      await sleep(DONE_SLEEP_MS);
      continue;
    }
    // 守望轮转探测：一发只查一个目标，探测命中即扫荡
    const probe = pending[cursor++ % pending.length];
    try {
      const menu = await getMenu(probe.mt, probe.d, useWindow ? watchGapFor() : WATCH_GAP);
      if (isRateLimited(menu)) {
        console.log(`${ts()} [${probe.d} ${MEAL_NAME[probe.mt]}] 被限流: ${menu.msg} → 静默退避 ${COOLDOWN_MS / 60000} 分钟`);
        rateLimitedUntil = Date.now() + COOLDOWN_MS;
        continue;
      }
      if (menu.code === 200 && Array.isArray(menu.data) && menu.data.length) {
        console.log(`${ts()} [${probe.d} ${MEAL_NAME[probe.mt]}] ⚡放餐！${menu.data.length} 个套餐`);
        await sweep(targets, mealTypes, probe, menu.data, done);
        continue;
      }
      if (menu.code !== 200) {
        console.log(`${ts()} [${probe.d} ${MEAL_NAME[probe.mt]}] 接口: ${menu.code} ${menu.msg || ""}`);
      }
      // 心跳：正常"未放"不刷屏，每 60 轮汇报一次存活（高频≈5 分钟/条，低频≈1 小时/条）
      probeCount++;
      if (probeCount % 60 === 0) {
        console.log(`${ts()} 心跳：已守望 ${probeCount} 轮（当前 ${probe.d} ${MEAL_NAME[probe.mt]}），菜单未放`);
      }
    } catch (e) {
      console.error(`${ts()} [${probe.d} ${MEAL_NAME[probe.mt]}] 守望异常:`, e.message);
    }
    // 节奏由 getMenu 内部按 lastMenuReqAt 严格控制（起点对起点），此处不再叠加等待
  }
}

async function main() {
  if (!cfg.openId || cfg.openId === "在这里粘贴你的openId") {
    console.log("config.json 里还没填 openId！");
    process.exit(1);
  }
  const cmd = process.argv[2] || "watch";
  const arg = process.argv[3];
  if (cmd === "menu") {
    await init(cfg.openId);
    return cmdMenu(arg);
  }
  if (cmd === "check") {
    await init(cfg.openId);
    return cmdCheck(arg);
  }
  if (cmd === "watch") return cmdWatch();
  console.log("用法: node sniper.js menu [YYYYMMDD] | check [YYYYMMDD] | watch");
}

main().catch((e) => {
  console.error("出错:", e);
  process.exit(1);
});
