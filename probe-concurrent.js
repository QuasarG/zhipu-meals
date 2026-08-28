// 并发探针：同时齐发 N 个请求（用订单查询 GET，限流最敏感的接口）
// 用法: node probe-concurrent.js <并发数>
const { init, getSign } = require("./signer.js");
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));

async function one(i) {
  const time = String(Math.round(Date.now() / 1000));
  const res = await fetch("https://order.hersweetie.com/feishu-api/v2/order/listByUidAndDate?orderDate=2026090" + ((i % 4) + 1), {
    headers: {
      openId: cfg.openId,
      "x-time": time,
      "x-sign": getSign(time, cfg.openId),
      Cookie: "openId=" + cfg.openId,
      Origin: "https://order.hersweetie.com",
      Referer: "https://order.hersweetie.com/feishu/home",
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*",
    },
  });
  return res.json();
}

async function main() {
  await init(cfg.openId);
  const n = Number(process.argv[2] || 10);
  console.log(`=== 并发齐发 ${n} 发（订单查询 GET）===`);
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => one(i)));
  const dt = Date.now() - t0;
  let ok = 0, limited = 0, other = 0;
  results.forEach((r, i) => {
    if (r.code === 200) ok++;
    else if (/频繁|过多/.test(r.msg || "")) { limited++; if (limited <= 2) console.log(`  ⛔ 第${i + 1}个: ${r.msg}`); }
    else { other++; if (other <= 2) console.log(`  其他: ${r.code} ${r.msg}`); }
  });
  console.log(`结果: 成功${ok} 限流${limited} 其他${other} | 总耗时${dt}ms`);
}
main();
