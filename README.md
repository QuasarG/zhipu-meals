# zhipu-meals · 智谱订餐自动抢餐脚本

针对 [order.hersweetie.com](https://order.hersweetie.com/feishu/home)（智谱订餐）的自动点餐工具。

原理：复刻前端 WASM 签名算法生成 `x-sign` 请求签名，直接调用后端 API，
以守护进程方式守望每周菜单发布，菜单一放出立即按策略自动下单。
放餐到十顿全部锁定实测 **18.4 秒**（2026-10-16 首战，零限流）。

> **硬规则：只抢早餐和午餐，永远不碰晚餐。**（脚本内置拦截，`mealTypes` 含 `"3"` 直接退出）
>
> 站点完整逆向档案（认证/签名/接口/频控/方法论）见 [API.md](API.md)。

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [一周作息](#一周作息)
- [工作机制](#工作机制)
- [config.json 完整字段说明](#configjson-完整字段说明)
- [服务器部署](#服务器部署systemd-常驻)
- [多人共部署](#多人共部署一台服务器帮同事一起挂)
- [运维与排障](#运维与排障)
- [项目结构](#项目结构)
- [注意事项](#注意事项)

## 功能特性

- **常驻守望**：systemd 托管按周历作息——平时零请求长眠，周四晚低频兜底，
  周五放餐窗口 5 秒/发高频探测，菜单未发布时静默等待
- **自动抢餐**：菜单一放出立即下单，支持「份数最少优先」或「关键词锁定」策略
- **午餐优先**：扫荡先整轮锁完所有午餐（抢手货），再回头补早餐
- **跨周滚动**：本周全部点完后自动滚向新的下周一~周五，无需人工干预
- **防重复下单**：识别已有订单（含手动点的）自动跳过，随时可手动改菜单
- **启动补漏**：任意时刻重启都会先核对今天~下周五的订单，漏点的当场补上
- **限流自保**：识别「请求频繁」响应后自动静默退避，绝不硬刚
- **签名防污染**：vm 沙箱伪装浏览器环境通过 WASM 环境指纹检查（详见 [API.md](API.md) §3）

## 快速开始

### 环境要求

- Node.js ≥ 18（建议 22），无需任何 npm 依赖
- 服务器时区为 `Asia/Shanghai`，时钟经 NTP 校准（签名带时间戳）

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

编辑 `config.json`，先填 `openId`，`dryRun` 保持 `true`（只探测不下单）：

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

其余节奏字段（`gentleStartHour` / `fastStartHour` / 各档间隔）均有默认值，
见下文字段说明。

### 3. 手动命令

```bash
node sniper.js menu 20261023   # 查看某天三餐菜单（YYYYMMDD 紧凑格式）
node sniper.js check 20261023  # 查看某天已点餐情况 + 配送区域
node sniper.js watch           # 守望模式（前台运行，Ctrl+C 退出）

# 多人部署时指定某位同事的配置目录
CONFIG_DIR=/opt/zhipu-meals/alice node sniper.js check 20261023
```

跑一次 `check`，输出末尾会列出所有可用配送区域，把想要的 `id` 和名称
填进 `addressId` / `addressDetail`。

### 4. dryRun 验证

```bash
node sniper.js watch
```

观察日志确认：菜单探测 → 订单检查 → 选餐策略 → 「dryRun: 模拟下单成功」。
确认选餐合理后，把 `dryRun` 改为 `false` 进入实战。

## 一周作息

| 时段 | 状态 | 请求量 |
|---|---|---|
| 周一 ~ 周四白天 | 静默休眠 | 零请求 |
| 周四 18:00 起（`gentleStartHour`） | 低频守望兜底 | 60s/发 |
| 周五 10:00 起（`fastStartHour`） | 高频守望 | 5s/发，放餐发现延迟 ≤5 秒 |
| 周五下午放餐（实测 15:34~17:27） | 扫荡下单 | 菜单 2s/发，先午餐后早餐，约 18 秒完成 |
| 周末 | 完成态复查 | 每 30 分钟一发订单核对 |
| 下周一 0 点 | 重新入眠 | 零请求，循环往复 |

## 工作机制

### 守望与扫荡

- 守望 = 单点探测：一发只查一个目标（日期×餐次轮转，**午餐目标排前**），
  菜单返回非空即判定放餐
- 扫荡 = 整轮收割：侦察响应自带的菜单零额外请求先出手，随后拉菜单步进
  2s/发，**先整轮午餐（抢手货）再整轮早餐**，每张菜单到手即下单
- 下单失败（如库存被截）瞬间换候选再打，每目标最多 8 次
- 命中限流 → 全局冷却熔断（默认 15 分钟静默），杜绝重试续期
- 网络层：每请求 15 秒超时 + 失败自动换连接重试 3 次，长眠后僵尸连接
  不会挂死进程；每 60 发探测输出一行心跳日志证明存活

### 选餐策略

默认**剩余份数最少优先**：所有有货套餐中抢 `stockRemaining` 最小的
（紧俏 = 大概率好吃，博弈论式选餐）；`safest` 则反过来保底挑余量最大的。

想锁定口味，往 `keywords` 里加关键词：

```json
"keywords": ["麦当劳", "汉堡王"]
```

则只在命中的套餐里再选份数最少的一个；全部未命中则本轮不下单。

### 实测限流画像

| 实测项 | 结论 |
|---|---|
| 串行 GET 持续 0.5 发/秒 | 第 31 发触发限流 |
| 串行 GET 持续 1 发/秒 | 第 25 发触发限流 |
| 串行 GET 5 秒/发 | 持续全天零限流（低于回血速率） |
| 并发齐发 5~40 发 | 全部通过（限流器只看相邻间隔，不拦并发突刺） |
| 下单 POST 连发 16 发 | 全部接受 |
| 限流冷却时长 | 约 13 分钟，期间重试会**续期** |

推测限流器为令牌桶：容量 ≈24-30，回血 ≈0.25-0.5 发/秒。
据此标定三段节奏：守望 5s/发（永不停歇）→ 扫荡拉菜单 2s/发（安全边际
3 倍）→ POST 即时。复测工具见项目结构（`ratehold.js` 等）。

### 工作流程图

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

## config.json 完整字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `openId` | string | 登录凭证，必填，约 30 天过期 |
| `mealTypes` | string[] | 守望餐次：`"1"` 早餐 `"2"` 午餐，禁止含 `"3"` 晚餐；无论填序如何，出手永远午餐在前 |
| `dates` | string[] | 目标日期（`YYYYMMDD`）。留空 `[]` = 动态守望下周一~周五并跨周滚动 |
| `keywords` | string[] | 选餐关键词。留空 `[]` = 份数最少优先；填了则先按关键词过滤再选份数最少 |
| `strategy` | string | 选餐策略：`scarcest` 份数最少优先（默认）；`safest` 余量最多优先保底 |
| `addressId` | number | 配送吧台 ID，用 `check` 命令查询 |
| `addressDetail` | string | 配送吧台名称，与 ID 对应 |
| `dryRun` | boolean | `true` 只探测不下单（调试），实战设 `false` |
| `gentleStartHour` | number | 周四几点起低频守望（60s/发兜底），默认 18 |
| `fastStartHour` | number | 周五几点起高频守望（5s/发），默认 10；兼容旧键 `activeStartHour` |
| `watchGapMs` | number | 高频守望间隔毫秒，默认 5000（连跑 8 小时零限流） |
| `gentleGapMs` | number | 低频守望间隔毫秒，默认 60000（周四晚与周末兜底） |
| `sweepMenuGapMs` | number | 扫荡拉菜单步进毫秒，默认 2000（实测 31 发才触发限流，一场扫荡仅 9 发） |
| `fetchTimeoutMs` | number | 单请求超时毫秒，默认 15000；防长眠后僵尸连接挂死 |
| `maxOrderAttempts` | number | 下单失败立即换候选的最大尝试数，默认 8（POST 不限流） |
| `scarceThreshold` | number | 稀缺阈值：余量低于此值（默认 100）视为抢手货 |
| `rateLimitCooldownMin` | number | 被限流后静默退避分钟数，默认 15（实测冷却约 13 分钟，勿重试续期） |
| `doneSleepMin` | number | 本周全部完成后复查间隔分钟数，默认 30，到期检查是否跨周 |

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

升级与状态：

- 升级代码：`git pull`（或 scp 覆盖）后 `systemctl restart`；
  重启会先跑启动补漏核对订单，已点的不会重复下单
- `state.json` 是已完成订单的落盘记录（自动维护，已 gitignore）。
  想强制重抢某顿：先在网页端取消该订单，30 分钟内复查会自动补抢；
  或删掉 `state.json` 里对应的 `"日期:餐次"` 键后重启

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

## 运维与排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `401 用户不存在` | openId 过期或填错 | 重新登录取一次，更新 config 后重启 |
| `401 签名无效或已过期` | 环境指纹穿帮 / 时钟偏差 / 前端换了 wasm | 校准 NTP；按 [API.md](API.md) §7 更新 `wasm_encrypt.wasm` |
| `500 签名验证失败次数过多` | 触发服务端频控 | 自动退避，静默 10 分钟以上，勿手动重启续期 |
| `422` | 参数格式错（日期未用紧凑 `YYYYMMDD` 等） | 检查 `dates` 配置 |
| 日志长时间无输出 | 非守望时段休眠 | 正常，对照「一周作息」；守望期看每 60 发一条的心跳 |
| 想换某天吃别的 | 已下单占用 | 网页端先取消，复查周期内自动按策略补抢 |
| 怕状态记录失真 | state.json 与真实订单不一致 | 删 `state.json` 重启，启动补漏会全量对账 |

## 项目结构

```
sniper.js            主脚本：守望 / 扫荡 / 启动补漏 / 手动命令
signer.js            签名器：vm 沙箱伪装浏览器环境，跑 WASM 签名
wasm_encrypt.wasm    前端签名 WASM 副本（版本指纹见 API.md §3）
API.md               站点逆向参考档案：认证 / 接口 / 频控 / 方法论
ratehold.js          频控标定：串行步进测限流阈值
probe-concurrent.js  频控标定：并发齐发验证突刺策略
probe-batch.js       频控标定：批次脉冲
ratetest.js          早期接口试探脚本
config.example.json  配置模板（真实 config.json 已 gitignore）
```

## 注意事项

- **请勿调高轮询频率**：高频档 5s/发已贴着限流回血速率标定，再快就会
  触发频控；放餐发现延迟已是最优的 ≤5 秒
- openId 是你的登录凭证，**不要提交到 git、不要发给别人**
  （仓库 `.gitignore` 已默认排除 `config.json` 与 `state.json`）
- 本脚本仅供个人学习研究，请遵守公司订餐平台使用规范

## License

MIT
