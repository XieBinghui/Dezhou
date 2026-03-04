# 单桌私用网页版德州扑克

单桌（10人）No-Limit Texas Hold'em，昵称直进，无公开注册。

## 功能

- 单桌 10 人现金桌（盲注固定，默认 1/2）
- 房主机制：房主控制开局；全员准备后才可开始本局/下一局
- 买入固定 100BB（默认 200），支持清零后补码
- 一局完整流程：Preflop/Flop/Turn/River/Showdown
- Fold/Check/Call/Bet/Raise/All-in
- 公共牌与手牌可视化（红黑花色 + 背面牌）
- 局中动作可见性：座位最近动作 + 右侧动作流
- 摊牌可视化：仅展示进入摊牌玩家的亮牌与最佳五张
- 位置标注：庄家 / 小盲 / 大盲 / 枪口 / 低位 / 劫位 / 关煞
- 超时与断线托管：可过牌则过牌，否则弃牌
- 基础审计日志：`data/audit.log`

## 项目结构

- `apps/server`: Express + Socket.IO + 牌局引擎
- `apps/web`: React + Vite 单页客户端
- `packages/shared`: 前后端共享类型与事件协议

## 本地开发

```bash
npm install
npm run build -w @dezhou/shared
npm run dev -w @dezhou/server
npm run dev -w @dezhou/web
```

前端默认 `http://localhost:5173`，后端默认 `http://localhost:3000`。

### 本机单人压测模式

在浏览器访问前端时加参数：`http://localhost:5173/?localtest=1`

- 侧边栏会出现「补满到6人 / 补满到10人 / 清理测试玩家」
- 测试玩家会自动入座并自动行动，便于单人快速跑对局流程
- 支持「自动跑30局」压测，包含总超时与卡局恢复，输出平均每局耗时与异常次数
- 仅用于本机测试，线上环境不要开启

## 测试

```bash
npm run test -w @dezhou/server
```

- 已包含规则矩阵回归：
  - 最小加注边界表（Preflop/River 边界、最小下注/最小加注到）
  - 全下重开全路径（不足额不重开、足额重开、未行动位最小再加注）
  - 复杂并列边池拆分（主池单赢家 + 边池并列、奇数筹码拆分）

## 稳定性压测（10人/100局）

```bash
npm run stress:stability
```

- 默认参数：10 人、100 局、含断线/托管/重连路径
- 可选环境变量：
  - `STRESS_PLAYERS`（默认 `10`）
  - `STRESS_HANDS`（默认 `100`）
  - `STRESS_ACTION_SECONDS`（默认 `2`）
  - `STRESS_MAX_STEPS`（默认 `120000`）
  - `STRESS_SEED`（默认 `20260304`）
- 输出报告：`data/stability-report.json`

## 发布候选版门槛检查（RC）

```bash
npm run rc:check
```

- RC 检查包含：
  - 构建通过
  - 规则回归测试通过
  - 100 局稳定性压测通过
  - 状态一致性检查通过（无状态不同步）
  - 审计追溯检查通过（`hand_start`/`hand_end`/动作链完整）

## CI（自动验收）

- 已接入 GitHub Actions：`.github/workflows/ci.yml`
- 触发时机：`push` 到 `main/master` 或 `pull_request`
- 执行内容：`npm ci` + `npm run rc:check`
- 失败时自动上传排错附件（Artifact：`ci-failure-debug`）：
  - `stability-report.json`
  - `stability-audit-tail.log`
  - `audit-recent.log`
  - `ci-rc.log`

## Docker 运行

```bash
docker compose up --build
```

- 前端（容器）：`http://localhost:5173`
- 反向代理入口（nginx）：`http://localhost:8080`
- 后端 health：`http://localhost:3000/health`

## 备注

当前版本已实现 MVP 玩法闭环；Redis/PostgreSQL 容器已预置，但服务端当前核心牌局状态以内存为主，审计日志落文件。后续可平滑替换为 Redis 状态存储 + PostgreSQL 持久化。
