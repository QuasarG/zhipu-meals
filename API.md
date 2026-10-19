# order.hersweetie.com API 逆向参考档案

对智谱订餐站（飞书 H5 内嵌）的完整逆向结论，供学习研究与其余客户端实现复现。
本文不含任何真实凭证；所有 `ou_xxx`、orderId、addressId 均为占位符。

## 1. 站点概况

| 项 | 值 |
|---|---|
| 入口页 | `https://order.hersweetie.com/feishu/home` |
| 前端栈 | Vite + Vue 3 SPA（产物 `assets/index-*.js`，文件名带内容哈希） |
| API 前缀 | `https://order.hersweetie.com/feishu-api` |
| 登录方式 | 飞书 H5 JS-SDK（页面加载 `h5-js-sdk-1.5.44.js`）OAuth，登录后 `openId` 落入 Cookie |
| 签名算法 | wasm-bindgen 编译的 WASM 模块（见 §3） |

## 2. 认证模型

- 身份即 `openId`（`ou_` 开头的飞书用户标识），随登录写入 Cookie。
- 每个请求同时携带两份：`openId` 请求头 + `Cookie: openId=...`（二者都要）。
- 服务端对 openId 的有效期远长于 Cookie 的 30 天客户端过期，实测数月仍有效；
  失效表现见 §8 错误码。
- 无 CSRF token、无 refresh 机制，签名即为全部防伪。

## 3. 请求签名（x-sign）

每个 API 请求需按序构造三个头：

```
x-time: <Unix 秒级时间戳，10 位字符串>
x-sign: <get_sign(x-time, openId)，由前端 WASM 计算>
openId: <你的 openId>
```

签名实现在前端资产 `assets/wasm_encrypt_bg-*.wasm`（wasm-bindgen 产物，
随 bundle 附带于本仓库 `wasm_encrypt.wasm`）。2026-08~10 期间文件未更新：
24201 字节，sha256 `e172b6b09a4c8217da677afeb4497267247999d328923d866f2a6c6f1f678cc7`。

### 3.1 环境指纹检查（关键）

WASM 在计算签名前会探测运行环境，任何一项不过就输出**被污染的假签名**
（服务端返回 401「签名无效或已过期」）：

- `document` / `location` 必须存在
- `process` / `Buffer` / `require` 必须不存在（Node 裸跑必挂）
- `globalThis.constructor.name` 必须是 `Window`
- `navigator.webdriver` 必须为 `false`

因此在 Node 中复现需 vm 沙箱伪装浏览器环境，本仓库 `signer.js` 已实现：
init 时注入 Window/Document/Location/Navigator 伪装类、带 openId 的
document.cookie、`navigator.webdriver=false`，并刻意不暴露 process/Buffer/require。

### 3.2 最小可跑示例

```js
const { init, getSign } = require("./signer.js");

const openId = "ou_xxxxxxxxxxxxxxxx";
await init(openId);

const time = String(Math.floor(Date.now() / 1000));
const sign = getSign(time, openId);
const res = await fetch(
  "https://order.hersweetie.com/feishu-api/v2/dailymeals/list?mealType=2&mealDate=20261023",
  {
    headers: {
      openId,
      "x-time": time,
      "x-sign": sign,
      Cookie: "openId=" + openId,
      "User-Agent": "Mozilla/5.0 ... Chrome/126",
      Referer: "https://order.hersweetie.com/feishu/home",
    },
  }
);
console.log(await res.json());
```

服务端对时钟偏差敏感，宿主机需校准 NTP。

## 4. 接口清单

统一响应包络：`{ code, msg, data }`，`code=200` 为成功；HTTP 状态码另有含义（429=频控）。

### 4.1 菜单查询

```
GET /v2/dailymeals/list?mealType=<1|2|3>&mealDate=<YYYYMMDD>
```

- 日期必须**紧凑格式** `20261023`，带连字符的 `2026-10-23` 返回 422。
- 返回 `data` 为套餐数组，关键字段：

| 字段 | 说明 |
|---|---|
| `packageName` | 套餐名，多行文本以 `\n` 分隔（首行为商家名） |
| `sequenceChar` | 套餐代号字母（A/B/C…），下单凭据之一 |
| `stockRemaining` | 剩余份数，0 为售罄 |

- 菜单未发布时 `data` 为空数组（这就是守望探测的判定依据）。

### 4.2 下单

```
POST /order/create
Content-Type: application/json

{
  "mealType": "2",
  "orderDate": "20261023",
  "packageName": "套餐全名（须与菜单返回完全一致，含换行）",
  "sequenceChar": "C",
  "addressId": 123,
  "addressDetail": "X层XX吧台"
}
```

- **没有 packageId**——后端按 `orderDate + mealType + sequenceChar` 定位套餐。
- 成功返回 `data.orderId`；重复下单返回业务码，msg 含「已存在订单」或「已点」。
- POST 实测不受频控（连发 16 发全部受理）。

### 4.3 订单查询

```
GET /v2/order/listByUidAndDate?orderDate=<YYYYMMDD>
```

- 身份取自 openId，只传 `orderDate`（传 mealType 服务端不认）。
- 返回 `data.breakfast / lunch / dinner` 三个数组，元素含
  `orderStatus`（0=未点，1=已点，3≈已取消）、`orderStatusName`、`packageName`。
- 该接口实测并发 40 发齐拉不限流，适合做对账/补漏。

### 4.4 配送地址

```
GET /v2/address/list?mealType=<1|2|3>&mealDate=<YYYYMMDD>
```

- 返回 `data: [{ id, detailAddress }]`，`id` 即下单用的 `addressId`。

### 4.5 敏感提示

站点还存在 `/htt-platform/list` 类平台配置接口，响应中曾观察到**明文
appSecret**。该类密钥切勿使用、记录或传播，建议向平台管理员报告；
本档案不记录其细节。

## 5. 频控画像（实测 2026-08~09）

| 实测项 | 结论 |
|---|---|
| 串行 GET 持续 0.5 发/秒 | 第 31 发触发限流 |
| 串行 GET 持续 1 发/秒 | 第 25 发触发限流 |
| 串行 GET 5 秒/发 | 持续全天零限流（低于回血速率） |
| 并发齐发 5~40 发 | 全部通过（限流器只看相邻间隔，不拦并发突刺） |
| 下单 POST 连发 16 发 | 全部接受 |
| 冷却时长 | 约 13 分钟，期间重试会**续期**惩罚窗口 |

限流响应特征：HTTP 429 或业务 msg 命中 `/频繁|过多|稍后再试/`。
推测为令牌桶：容量 ≈24-30，回血 ≈0.25-0.5 发/秒。
本仓库 `ratehold.js` / `probe-concurrent.js` / `probe-batch.js` 可复测。

## 6. 业务节奏

- 下周菜单（周一~周五的早餐+午餐）于**每周五下午**发布，
  实测四个样本：16:03、17:26、15:34、17:27。
- 发布近似原子：任一目标菜单出现时，全部 10 个目标同时可查。
- `mealType=3`（晚餐）当前不在员工可选范围。

## 7. 逆向复现步骤（方法论）

1. 取入口页 HTML，从 `<script type="module">` 拿到带哈希的 bundle 文件名；
2. 下载主 bundle，定位 axios 实例 `baseURL`（`/feishu-api`）与请求拦截器，
   拦截器里可见 `x-time` / `x-sign` / `openId` 三头的组装；
3. 顺藤摸瓜找到 `wasm_encrypt_bg-*.wasm` 与其 JS glue（`__wbg_*` 导入表），
   下载 wasm，记录其字节数与 sha256 作为版本指纹；
4. 在 Node `vm` 沙箱里伪装浏览器环境（§3.1 清单）并跑 glue +
   `WebAssembly.instantiate`；注意 wasm-bindgen 的 imports 对象就是 glue
   文件导出的那个完整对象，不要二次包裹；
5. 用 §4.1 菜单接口做冒烟测试（返回 200 + 空数组即签名链路全通）；
6. 前端若发版：bundle 哈希变化 → 重新下载 wasm；只有 glue 的
   `__wbg_*` 导入函数名变了才需要改 `signer.js`。

## 8. 错误码对照

| 现象 | 原因 |
|---|---|
| `401 用户不存在` | openId 过期或填错，重新登录取一次 |
| `401 签名无效或已过期` | 环境指纹穿帮，或本机时钟偏差过大 |
| `422` | 参数格式错误（日期未用紧凑 YYYYMMDD 等） |
| `429` / msg 含「频繁」 | 触发频控，静默等 13 分钟以上，勿重试续期 |
| 业务码 + msg「已存在订单/已点」 | 该餐已点过，视为成功 |

## 9. 合规

本文与配套脚本仅供个人学习研究，请遵守公司订餐平台使用规范，
勿高频压测、勿替他人下单、勿传播任何凭证。
