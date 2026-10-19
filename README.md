# zhipu-meals · 智谱订餐自动抢餐脚本

针对 [order.hersweetie.com](https://order.hersweetie.com/feishu/home)（智谱订餐）的自动点餐工具。

原理：复刻前端 WASM 签名算法生成 `x-sign` 请求签名，直接调用后端 API，
以守护进程方式守望每周菜单发布，菜单一放出立即按策略自动下单。

> **硬规则：只抢早餐和午餐，永远不碰晚餐。**（脚本内置拦截，`mealTypes` 含 `"3"` 直接退出）

## 功能特性

- **常驻守望**：systemd 托管按周历作息——平时零请求长眠，周四晚低频兜底，
  周五放餐窗口 5 秒/发高频探测，菜单未发布时静默等待
- **自动抢餐**：菜单一放出立即下单，支持「份数最少优先」或「关键词锁定」策略
- **午餐优先**：扫荡先整轮锁完所有午餐（抢手货），再回头补早餐
- **跨周滚动**：本周全部点完后自动滚向新的下周一~周五，无需人工干预
- **防重复下单**：识别已有订单（含手动点的）自动跳过，随时可手动改菜单
- **限流自保**：识别「请求频繁」响应后自动静默退避，绝不硬刚
- **签名防污染**：vm 沙箱伪装浏览器环境通过 WASM 环境指纹检查（详见下文）

## 快速开始

### 环境要求

- Node.js ≥ 18（建议 22），无需任何 npm 依赖
- 服务器时区为 `Asia/Shanghai`（签名带时间戳）

### 1. 获取 openId

1. 浏览器打开 <https://order.hersweetie.com/feishu/home>，飞书扫码登录
2. F12 打开控制台，输入 `document.cookie` 回车
3. 复制 `openId=` 后面那串值（`ou_` 开头）

> openId 约 30 天过期，失效后重新登录获取一次即可。

### 2. 安装与配置

```bash
git clone https://github.com/QuasarG/zhipu-meals.git
cd zhipu-meals
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "openId": "ou_xxxxxxxxxxxxxxxx",
  "mealTypes": ["1", "2"],
  "dates": [],
  "keywords": [],
  "addressId": null,
  "addressDetail": "",
  "dryRun": true
}
```

其余节奏字段（`gentleStartHour` / `fastStartHour` / 各档间隔）均有默认值，见下文字段说明。

先填 `openId`，`dryRun` 保持 `true`（只探测不下单），跑一次查配送区域拿 `addressId`：

```bash
node sniper.js check 20260818
```

输出末尾会列出所有可用配送区域，把想要的 `id` 和名称填进 `addressId` / `addressDetail`。

### 3. 手动命令

```bash
node sniper.js menu 20260818   # 查看某天三餐菜单（YYYYMMDD 格式）
node sniper.js check 20260818  # 查看某天已点餐情况 + 配送区域
node sniper.js watch           # 守望模式（前台运行，Ctrl+C 退出）
```

### 4. dryRun 验证

```bash
node sniper.js watch
```

观察日志确认：菜单探测 → 订单检查 → 选餐策略 → 「dryRun: 模拟下单成功」。
确认选餐合理后，把 `dryRun` 改为 `false` 进入实战。

## 服务器部署（systemd 常驻）

以 root 为例：

```bash
# 上传项目到服务器
scp -i your.pem -r ./* root@your-server:/opt/zhipu-meals/

# 创建 systemd 服务
cat > /etc/systemd/system/zhipu-meals.service << 'EOF'
[Unit]
Description=Zhipu Meals auto-order daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/zhipu-meals
ExecStart=/usr/bin/node /opt/zhipu-meals/sniper.js watch
Restart=always
RestartSec=30
StandardOutput=append:/var/log/zhipu-meals.log
StandardError=append:/var/log/zhipu-meals.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now zhipu-meals
```

日常运维：

```bash
systemctl status zhipu-meals       # 运行状态
tail -f /var/log/zhipu-meals.log   # 实时日志
systemctl restart zhipu-meals      # 改完 config.json 后重启生效
```

## 多人共部署（一台服务器帮同事一起挂）

脚本身份就是 config 里的 `openId`，一人一份配置即可共用同一份代码。
通过 `CONFIG_DIR` 环境变量指定各自的配置目录，单人使用完全不受影响
（不设该变量时默认读脚本同目录的 `config.json`，开箱即用）。

同事接入三步：

1. 各自浏览器扫码登录，F12 取自己的 `openId`（见上文「获取 openId」）
2. `cp config.example.json` 到自己的目录，填 `openId`，跑一次
   `node sniper.js check <日期>` 选好自己的配送吧台并填入
3. 照下方模板建自己的 systemd 实例，`CONFIG_DIR` 指向自己的目录

目录结构：

```
/opt/zhipu-meals/                 # 共用代码（git clone 或 scp 一份）
├── sniper.js
├── signer.js
├── wasm_encrypt.wasm
├── config.json                   # 你自己的（默认实例）
├── alice/config.json             # 同事 A：她的 openId + 她的楼层吧台
└── bob/config.json               # 同事 B：他的 openId + 他的楼层吧台
```

每位同事一个 systemd 实例（unit 名、日志文件分开）：

```bash
cat > /etc/systemd/system/zhipu-meals-alice.service << 'EOF'
[Unit]
Description=Zhipu Meals daemon (alice)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/zhipu-meals
Environment=CONFIG_DIR=/opt/zhipu-meals/alice
ExecStart=/usr/bin/node /opt/zhipu-meals/sniper.js watch
Restart=always
RestartSec=30
StandardOutput=append:/var/log/zhipu-meals-alice.log
StandardError=append:/var/log/zhipu-meals-alice.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now zhipu-meals-alice
```

注意事项：

- **一人一实例，各用各的 openId**（同事自己登录自己取），共用别人的等于替别人下单
- openId 各自独立过期，谁的 401 了谁重登更新，互不影响
- 建议各实例轮询间隔稍微错开（如同事的 `watchGapMs` 设 6000、
  `gentleGapMs` 设 66000），避免同 IP 同秒并发请求
- 单实例内存约 33MB，一台 2G 服务器挂十来个同事毫无压力

## 手动命令补充（指定他人的配置）

```bash
# 默认读脚本同目录 config.json
node sniper.js menu 20260818

# 多人部署时指定某位同事的配置目录
CONFIG_DIR=/opt/zhipu-meals/alice node sniper.js check 20260818
```

## config.json 完整字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `openId` | string | 登录凭证，必填，约 30 天过期 |
| `mealTypes` | string[] | 守望餐次：`"1"` 早餐 `"2"` 午餐，禁止含 `"3"` 晚餐 |
| `dates` | string[] | 目标日期（`YYYYMMDD`）。留空 `[]` = 动态守望下周一~周五并跨周滚动 |
| `keywords` | string[] | 选餐关键词。留空 `[]` = 份数最少优先；填了则先按关键词过滤再选份数最少 |
| `addressId` | number | 配送吧台 ID，用 `check` 命令查询 |
| `addressDetail` | string | 配送吧台名称，与 ID 对应 |
| `dryRun` | boolean | `true` 只探测不下单（调试），实战设 `false` |
| `strategy` | string | 选餐策略：`scarcest` 份数最少优先（默认）；`safest` 余量最多优先保底 |
| `gentleStartHour` | number | 周四几点起低频守望（60s/发兜底），默认 18 |
| `fastStartHour` | number | 周五几点起高频守望（5s/发），默认 10；兼容旧键 `activeStartHour` |
| `watchGapMs` | number | 高频守望间隔毫秒，默认 5000（连跑 8 小时零限流） |
| `gentleGapMs` | number | 低频守望间隔毫秒，默认 60000（周四晚与周末兜底） |
| `sweepMenuGapMs` | number | 扫荡拉菜单步进毫秒，默认 2000（实测 31 发才触发限流，一场扫荡仅 9 发） |
| `maxOrderAttempts` | number | 下单失败立即换候选的最大尝试数，默认 8（POST 不限流） |
| `scarceThreshold` | number | 稀缺阈值：余量低于此值（默认 100，即两位数）触发极速抢购 |
| `rateLimitCooldownMin` | number | 被限流后静默退避分钟数，默认 15（实测冷却约 13 分钟，勿重试续期） |
| `doneSleepMin` | number | 本周全部完成后复查间隔分钟数，默认 30，到期检查是否跨周 |

## 实测限流画像与三段变速

所有参数经实测标定（ratehold.js / probe-concurrent.js 可复测）：

| 实测项 | 结论 |
|---|---|
| 串行 GET 持续 0.5 发/秒 | 第 31 发触发限流 |
| 串行 GET 持续 1 发/秒 | 第 25 发触发限流 |
| 串行 GET 5 秒/发（0.2 发/秒） | 持续 2 分钟全过——**低于回血速率，永不触发** |
| 并发齐发 5~40 发 | **全部通过**——限流器只看相邻间隔，不拦并发突刺 |
| 下单 POST 连发 16 发 | 全部接受（仅业务码拒绝重复下单） |
| 限流冷却时长 | 约 13 分钟，期间重试会续期 |

推测限流器为令牌桶：容量 ≈24-30，回血 ≈0.25-0.5 发/秒。

据此设计三段变速：

- **守望**（周四 18:00 起 60s/发兜底，周五 `fastStartHour` 起提速）：
  **5 秒/发单点探测**——0.2 发/秒低于回血速率，连跑全天零限流；
  放餐发现延迟 ≤5 秒
- **扫荡**（探测到放餐）：拉菜单步进 **2s/发**（距限流线 3 倍边际），
  侦察响应零请求先出手，**先整轮午餐再整轮早餐**
- **下单**：菜单到手立即 POST（实测不限流），失败瞬间换候选再打
  （每目标最多 8 次）

实测首战（2026-10-16 17:27）：放餐到十顿全部锁定 **18.4 秒，零限流**。

## 活跃窗口 + 守望/扫荡策略

菜单在**每周五下午**发布，其余时间守望毫无意义。脚本按周历安排作息，
频控阈值全部经实测标定（见上节「实测限流画像」）：

- **周一 ~ 周四白天**：完全静默长眠，**零请求**
- **周四 `gentleStartHour`（默认 18:00）**：低频守望兜底（60s/发），
  防运营方提前放餐
- **周五 `fastStartHour`（默认 10:00）**：进入高频守望——**5 秒/发单点
  探测**（低于限流器回血速率，连跑全天零限流），游标轮转覆盖全部
  日期×餐次且**午餐目标排前**，放餐发现延迟 ≤5 秒
- **探测到放餐 → 扫荡**：
  1. 侦察响应自带的菜单零额外请求立即出手
  2. 拉菜单步进 2s/发，**先整轮午餐（抢手货）再整轮早餐**
  3. 每张菜单到手即下单，失败（库存被截）瞬间换候选（每目标 ≤8 次）
- **周六 ~ 周日**：全部完成后 30 分钟节奏复查；手动取消某顿会自动补抢
- 周一 0 点起重新入眠，循环往复

实测首战（2026-10-16）：17:27:14 发现放餐（延迟 ≤5 秒），18.4 秒锁完
10 顿，全程零限流。

## 选餐策略说明

默认策略为**剩余份数最少优先**：菜单内所有有货套餐中，抢 `stockRemaining`
最小的那个（紧俏 = 大概率好吃，博弈论式选餐）。

想锁定口味，往 `keywords` 里加关键词：

```json
"keywords": ["麦当劳", "汉堡王"]
```

则只在命中的套餐里再选份数最少的一个；全部未命中则本轮不下单。

## 守望模式工作流程

```
周一~周四白天：静默长眠（零请求）→ 周四 18:00 低频守望 → 周五 10:00 高频守望
守望模式（5s/发单点探测，游标轮转日期×餐次，午餐目标排前）
 ├─ 未放餐 → 5 秒后再探测（延迟 ≤5 秒）
 └─ 探测到放餐 → 立即扫荡
扫荡模式
 ├─ 侦察响应菜单零请求先出手 → 先整轮午餐、再整轮早餐（拉菜单 2s/发）
 │   ├─ 已有订单（含手动点的）→ 跳过
 │   └─ 未点 → 按策略选餐，到手即下单（POST 不限流）
 ├─ 失败 → 瞬间换候选再打（每目标 ≤8 次）
 ├─ 命中限流 → 整轮静默退避（默认 15 分钟，防续期）
 └─ 全部完成 → 每 30 分钟复查（支持取消后补抢）→ 周一重新入眠
放餐 → 十顿全部锁定实测 18.4 秒
```

每周五下午运营方会发布下周菜单，发布瞬间守护进程即完成全部下单。

## 签名机制（出问题时再看）

前端对每个 API 请求计算 `x-sign = get_sign(时间戳, openId)`，算法在一个
wasm-bindgen 编译的 WASM 模块里（`wasm_encrypt.wasm`，随仓库附带）。

该模块计算签名前会做**环境指纹检查**，任何一项不通过就输出被污染的假签名
（服务端返回 401「签名无效或已过期」）：

- `document` / `location` 必须存在
- `process` / `Buffer` / `require` 必须不存在（Node 裸跑必挂）
- `globalThis.constructor.name` 必须是 `Window`
- `navigator.webdriver` 必须为 `false`

`signer.js` 在 Node `vm` 沙箱里伪装好这一切。若前端发版更换了 wasm 文件
（文件名 hash 变化），从新 JS bundle 里找到 `wasm_encrypt_bg-*.wasm` 下载替换
同名文件即可；只有 glue import 函数名变了才需要改 `signer.js`。

其他常见错误对照：

| 现象 | 原因 |
|---|---|
| `401 用户不存在` | openId 过期或填错，重新登录取一次 |
| `401 签名无效或已过期` | 环境指纹穿帮或本机时钟偏差过大（校准时区/时间） |
| `500 签名验证失败次数过多` | 触发服务端频控，静默等待 10 分钟以上，勿连发 |

## 注意事项

- **请勿调高轮询频率**：高频档 5s/发已贴着限流回血速率标定，再快就会
  触发频控；放餐发现延迟已是最优的 ≤5 秒
- openId 是你的登录凭证，**不要提交到 git、不要发给别人**
  （仓库 `.gitignore` 已默认排除 `config.json`）
- 本脚本仅供个人学习研究，请遵守公司订餐平台使用规范

## License

MIT
