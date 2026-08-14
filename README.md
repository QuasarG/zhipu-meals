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
  "idlePollIntervalMs": 600000,
  "burstPollIntervalMs": 60000
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
| `idlePollIntervalMs` | number | 平时轮询间隔毫秒，默认 600000（10 分钟） |
| `burstPollIntervalMs` | number | 周五放餐窗口轮询间隔毫秒，默认 60000（1 分钟） |
| `burstStartHour` | number | 周五几点进入高频窗口，默认 0（全天） |
| `perDateGapMs` | number | 多日期巡检时日期间请求间隔，默认 2000 |
| `rateLimitCooldownMin` | number | 被限流后静默退避分钟数，默认 10 |
| `doneSleepMin` | number | 本周全部完成后长休眠分钟数，默认 30，到期后检查是否跨周 |

## 变频守望策略

菜单一般在**每周五下午**发布。脚本采用两档频率自动切换：

- **平时（周六~周四）**：每 10 分钟一轮低频盯梢——反正菜单还没放，安静等
- **周五全天**：自动切换 1 分钟一轮高频——放餐瞬间（最多延迟 1 分钟）即完成全部下单

这样一周的请求量从 10000+ 发降到几百发，既不触发频控，也不错过首发。
若观测到实际放餐时间是周五固定某点（如 14:00），可把 `burstStartHour` 设为
`14`，让高频窗口更精准、其余时段更安静。

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
每轮巡检（平时 10 分钟 / 周五 1 分钟自动变频）
 ├─ 对每个目标日期、每个餐次：查菜单（未发布 = 静默，仅此 1 发请求）
 ├─ 菜单已发布 → 查当日订单（一天仅 1 发，返回三餐全量）
 │   ├─ 已有订单（含手动点的）→ 标记完成，跳过
 │   └─ 未点 → 按策略选餐 → 立即下单
 ├─ 命中限流 → 整轮静默退避（默认 10 分钟）
 └─ 本周全部完成 → 长休眠（默认 30 分钟）→ 到期自动跨周滚动
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
