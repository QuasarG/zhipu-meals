// 接口极限频次测试：从慢到快逐级试探，触发限流立即停止
// 用法: node ratetest.js menu   测菜单接口
//       node ratetest.js order  测下单接口（先真实下单，再重复下单看业务错误→限流的边界）
const fs = require("fs");
const path = require("path");
const { init, getSign } = require("./signer.js");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const BASE = "https://order.hersweetie.com/feishu-api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const isRateLimited = (r) => /频繁|过多|稍后再试/.test((r && r.msg) || "");

async function call(method, url, params, body) {
  let full = url;
  if (params) full += "?" + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const time = String(Math.round(Date.now() / 1000));
  const res = await fetch(BASE + full, {
    method,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      openId: cfg.openId,
      "x-time": time,
      "x-sign": getSign(time, cfg.openId),
      Cookie: "openId=" + cfg.openId,
      Origin: "https://order.hersweetie.com",
      Referer: "https://order.hersweetie.com/feishu/home",
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ladder(name, fire, steps) {
  console.log(`\n===== ${name} 频率阶梯测试 =====`);
  for (const { gapMs, count } of steps) {
    process.stdout.write(`[${gapMs}ms 间隔 x${count}] `);
    let limited = false;
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      let r;
      try {
        r = await fire(i);
      } catch (e) {
        console.log(`\n  异常: ${e.message}`);
        break;
      }
      if (isRateLimited(r)) {
        console.log(`\n  ⛔ 第${i + 1}发触发限流: ${r.msg}`);
        limited = true;
        break;
      }
      process.stdout.write(".");
    }
    const dt = Date.now() - t0;
    if (limited) {
      console.log(`  → 结论: ${gapMs}ms 间隔不可行`);
      return { okGap: null, failGap: gapMs };
    }
    console.log(`  全过(${dt}ms) → ${gapMs}ms 可行`);
    await sleep(8000); // 级间冷却，避免累计触发
  }
  return { okGap: steps[steps.length - 1].gapMs, failGap: null };
}

async function main() {
  await init(cfg.openId);
  const mode = process.argv[2];

  if (mode === "menu") {
    // 单点菜单查询：只查 20260904 午餐
    const fire = () => call("GET", "/v2/dailymeals/list", { mealType: "2", mealDate: "20260904" });
    const steps = [
      { gapMs: 2000, count: 5 },
      { gapMs: 1000, count: 5 },
      { gapMs: 500, count: 5 },
      { gapMs: 250, count: 5 },
      { gapMs: 100, count: 5 },
      { gapMs: 50, count: 5 },
      { gapMs: 0, count: 5 },
    ];
    const r = await ladder("菜单接口(单点)", fire, steps);
    console.log("\n总结:", JSON.stringify(r));
    return;
  }

  if (mode === "order") {
    // 先真实下一单（20260904 午餐，用户已取消，此单保留为正餐）
    const menu = await call("GET", "/v2/dailymeals/list", { mealType: "2", mealDate: "20260904" });
    const pkg = (menu.data || []).filter((p) => p.stockRemaining > 0).sort((a, b) => a.stockRemaining - b.stockRemaining)[0];
    if (!pkg) {
      console.log("无有货套餐，中止");
      return;
    }
    console.log(`首选目标: ${pkgDesc(pkg)}`);
    const first = await call("POST", "/order/create", null, {
      mealType: "2",
      orderDate: "20260904",
      packageName: pkg.packageName,
      sequenceChar: pkg.sequenceChar,
      addressId: cfg.addressId,
      addressDetail: cfg.addressDetail,
    });
    console.log("首单结果:", first.code, first.msg, first.data?.orderId || "");
    if (first.code !== 200) {
      console.log("首单失败，中止");
      return;
    }
    await sleep(8000);
    // 之后重复下单同目标：预期业务错误（已点餐），测到限流为止
    const fire = () => call("POST", "/order/create", null, {
      mealType: "2",
      orderDate: "20260904",
      packageName: pkg.packageName,
      sequenceChar: pkg.sequenceChar,
      addressId: cfg.addressId,
      addressDetail: cfg.addressDetail,
    });
    const steps = [
      { gapMs: 2000, count: 4 },
      { gapMs: 1000, count: 4 },
      { gapMs: 500, count: 4 },
      { gapMs: 250, count: 4 },
      { gapMs: 100, count: 4 },
      { gapMs: 0, count: 4 },
    ];
    const r = await ladder("下单接口(重复下单,预期业务错误)", fire, steps);
    console.log("\n总结:", JSON.stringify(r));
    return;
  }
  console.log("用法: node ratetest.js menu | order");
}

function pkgDesc(p) {
  return `${p.sequenceChar}「${(p.packageName || "").split("\n")[0]}」余${p.stockRemaining}份`;
}

main().catch((e) => {
  console.error("出错:", e);
  process.exit(1);
});
