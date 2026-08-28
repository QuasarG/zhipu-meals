// 探测菜单/订单接口的批量能力：能否一次拿多天/多餐
const { init, getSign } = require("./signer.js");
const fs = require("fs");
const cfg = JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8"));

async function call(path) {
  const time = String(Math.round(Date.now() / 1000));
  const res = await fetch("https://order.hersweetie.com/feishu-api" + path, {
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
  const probes = [
    ["只给日期(无mealType)", "/v2/dailymeals/list?mealDate=20260904"],
    ["全不带参数", "/v2/dailymeals/list"],
    ["日期给区间", "/v2/dailymeals/list?mealDate=20260831:20260904"],
    ["逗号多日期", "/v2/dailymeals/list?mealDate=20260831,20260901"],
    ["mealType=0", "/v2/dailymeals/list?mealType=0&mealDate=20260904"],
    ["订单接口只给日期", "/v2/order/listByUidAndDate?orderDate=20260904"],
  ];
  for (const [name, p] of probes) {
    try {
      const j = await call(p);
      const data = j.data;
      let desc = "";
      if (Array.isArray(data)) desc = `数组[${data.length}]`;
      else if (data && typeof data === "object") desc = `对象{${Object.keys(data).join(",")}}`;
      console.log(`${name}: code=${j.code} ${j.msg || ""} ${desc}`);
      if (j.code === 200 && Array.isArray(data) && data.length) {
        console.log("   首条:", JSON.stringify(data[0]).slice(0, 150));
      }
    } catch (e) {
      console.log(`${name}: 异常 ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
main();
