// 持续负载版限流测试：模拟真实侦察场景，固定频率持续打 N 发，找出"可持续频率"的真实边界
// 用法: node ratehold.js <gapMs> <count>
const fs = require("fs");
const path = require("path");
const { init, getSign } = require("./signer.js");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const BASE = "https://order.hersweetie.com/feishu-api";

async function main() {
  await init(cfg.openId);
  const gapMs = Number(process.argv[2] || 1000);
  const count = Number(process.argv[3] || 60);
  console.log(`=== 持续负载: ${gapMs}ms 间隔 x ${count} 发 (≈${(1000 / gapMs).toFixed(1)} 发/秒, 持续≈${((gapMs * count) / 1000).toFixed(0)}秒) ===`);
  let ok = 0, biz = 0, limited = -1, other = 0;
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const time = String(Math.round(Date.now() / 1000));
    try {
      const res = await fetch(`${BASE}/v2/dailymeals/list?mealType=2&mealDate=20260904`, {
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          openId: cfg.openId,
          "x-time": time,
          "x-sign": getSign(time, cfg.openId),
          Cookie: "openId=" + cfg.openId,
          Origin: "https://order.hersweetie.com",
          Referer: "https://order.hersweetie.com/feishu/home",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
        },
      });
      const j = await res.json();
      if (j.code === 200) ok++;
      else if (/频繁|过多|稍后再试/.test(j.msg || "")) { limited = i + 1; console.log(`\n⛔ 第${i + 1}发限流: ${j.msg}`); break; }
      else { biz++; if (other < 3) console.log(`\n  其他响应: ${j.code} ${j.msg}`); }
    } catch (e) {
      other++;
      if (other < 3) console.log(`\n  异常: ${e.message}`);
    }
    if (i % 10 === 9) process.stdout.write(`[${i + 1}] `);
    const wait = t0 + (i + 1) * gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n结果: 成功${ok} 其他${biz + other} 限流于第${limited > 0 ? limited : "-"}发 | 实际${dt}秒 平均${(count / dt).toFixed(2)}发/秒`);
}
main().catch((e) => { console.error(e); process.exit(1); });
