# zhipu-meals · 智谱订餐自动抢餐脚本

针对 [order.hersweetie.com](https://order.hersweetie.com/feishu/home)（智谱订餐）的自动点餐工具。

原理：复刻前端 WASM 签名算法生成 `x-sign` 请求签名，直接调用后端 API，
以守护进程方式守望每周菜单发布，菜单一放出立即按策略自动下单。

> **硬规则：只抢早餐和午餐，永远不碰晚餐。**（脚本内置拦截，`mealTypes` 含 `"3"` 直接退出）

## 功能特性

- **常驻守望**：systemd 托管，变频巡检（平时 10 分钟、周五放餐窗口 1 分钟），菜单未发布时静默等待
- **自动抢餐**：菜单一放出立即下单，支持「份数最少优先」或「关键词锁定」策略
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
  "addressId": 118,
  "addressDetail": "8层西侧吧台",
  "dryRun": true,
  "activeStartHour": 13,
  "pollIntervalMs": 60000
}
```

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
- 建议各实例轮询间隔稍微错开（如同事的 `idlePollIntervalMs` 设 660000、
  `burstPollIntervalMs` 设 70000），避免同 IP 同秒并发请求
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
| `activeStartHour` | number | 活跃窗口起点：周五几点开始抢，默认 13 |
| `pollIntervalMs` | number | 侦察轮询间隔毫秒，默认 60000（1 分钟 1 发） |
| `requestGapMs` | number | 全局请求步进：任意两请求最小间隔毫秒，默认 4000 |
| `rateLimitCooldownMin` | number | 被限流后静默退避分钟数，默认 10 |
| `doneSleepMin` | number | 本周全部完成后复查间隔分钟数，默认 30，到期检查是否跨周 |

## 活跃窗口 + 侦察/扫荡策略

菜单在**每周五下午**发布，其余时间守望毫无意义。脚本按周历安排作息，
并用两阶段节奏避免触发服务端频控（实测约 25 发/25 分钟即触发）：

- **周一 ~ 周四**：完全静默长眠，**零请求**，一觉睡到周五
- **周五 `activeStartHour`（默认 13:00）**：准点醒来进入**侦察模式**——
  每轮只发 **1 发**菜单探测（游标轮转覆盖全部日期×餐次），60 秒一轮
- **探测到菜单放出**：立即切换**扫荡模式**——全量查询各日期菜单与订单，
  按策略逐顿下单（每请求间隔 ≥ `requestGapMs`），全部点完为止
- **周六 ~ 周日**：全部完成后零请求复查（30 分钟节奏）；手动取消某顿
  会触发自动补抢
- 周一 0 点起重新入眠，循环往复

一周总请求量：侦察期每分钟 1 发 + 放餐后扫荡约 20 发，远低于频控阈值。
若实测放餐时间是周五固定某点（如 14:00），可把 `activeStartHour` 调整为
`14` 进一步收窄窗口。

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
周一~周四：静默长眠（零请求）→ 周五 13:00 自动醒来
侦察模式（每轮仅 1 发，游标轮转日期×餐次）
 ├─ 未放餐 → 60 秒后再侦察
 └─ 探测到菜单放出 → 立即扫荡
扫荡模式（每请求间隔 ≥ requestGapMs）
 ├─ 逐日期查菜单 → 查订单（一天 1 发，返回三餐全量）
 │   ├─ 已有订单（含手动点的）→ 标记完成，跳过
 │   └─ 未点 → 按策略选餐 → 立即下单
 ├─ 命中限流 → 整轮静默退避（默认 10 分钟）
 └─ 全部完成 → 周末每 30 分钟零请求复查（支持取消后补抢）→ 周一重新入眠
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

- **请勿调高轮询频率**：周五高频窗口已是 1 分钟一轮（菜单发布到下单延迟 ≤ 1 分钟），
  平时 10 分钟一轮足够。调到秒级除了触发频控和被请去喝茶没有任何收益
- openId 是你的登录凭证，**不要提交到 git、不要发给别人**
  （仓库 `.gitignore` 已默认排除 `config.json`）
- 本脚本仅供个人学习研究，请遵守公司订餐平台使用规范

## License

MIT
