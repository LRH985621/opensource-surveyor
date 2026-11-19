# Open Source Surveyor · 开源项目周报

面向个人和小团队的 GitHub 项目雷达。每周从公开仓库中发现能改善视觉效果、降低推理成本、提高运行效率或支持代理记忆的工具，输出中文 Markdown 周报。使用 Node.js 标准库，无第三方运行依赖，无需调用付费模型。

## 为什么有效

1. 按四个方向搜索 GitHub 公开仓库，并持续跟踪一批项目。每次成功采样时保存星标、fork、许可证和最近推送时间。
2. 对同一仓库，选取相隔 5–9 天且最接近 7 天的有效快照，按实测日均星标净增排序。首期和刚发现的项目只有基线，不会被写成周涨星结果。
3. 把趋势榜和推荐分开。`useful`、`ignore`、`installed` 只影响项目推荐和归档决策；实测历史不变。GitHub 不可用时，报告会标记缓存数据，已有快照不会被覆盖。

效果：把分散的检索、对比和记录变成一份可重复生成的周报。本机原型的一次计划任务运行覆盖了 **141 个公开仓库**；另一次归档试验下载了 **8 个固定提交**并逐个复核了 SHA-256。尚未测量节约多少人时、费用或推理时间。周榜只覆盖采样仓库，不是 GitHub 全站排行榜。

## 快速开始

需要 **Node.js 24.5+**。在仓库根目录运行：

```sh
npm test
node weekly-surveyor.mjs
node weekly-surveyor.mjs --feedback astral-sh/uv useful
```

默认在 `~/.opensource-surveyor` 保存数据，最新报告为 `reports/latest.md`。`SURVEY_DATA_DIR` 可指定其他目录，`SURVEY_TIME_ZONE` 可指定报告时区（例如 `Asia/Shanghai`）。匿名访问可运行；如有配额问题，可通过环境变量提供 `GITHUB_TOKEN`，不要将 token 写入源码。使用 `HTTPS_PROXY` 等代理环境变量时，可用 `node --use-env-proxy weekly-surveyor.mjs`。

Windows 用户可以在 PowerShell 中注册每周一 09:00 的任务，按本机时区运行：

```powershell
.\register-weekly.ps1 -Preview
.\register-weekly.ps1
```

任务在当前用户会话中运行，完成后弹出本机提醒。请将仓库保存在固定位置；同名任务存在时脚本会停止，以免覆盖既有配置。其他系统可以使用自己的定时器执行相同 Node 命令。

## 可选源码归档

默认只调查并生成报告。手动加 `--download`，或注册时加 `-Download`，才允许脚本按规则归档。每方向每次最多归档一个项目；要求有实测增长（至少日均净增 5 星）或被标记为有用，并检查维护时间、许可证和磁盘配额。脚本只保存固定提交的源码压缩包，记录提交和 SHA-256，单个最多 200 MiB、隔离区最多 2 GiB。不会解压、安装或执行第三方代码；哈希可核对文件内容，不能证明内容安全。

## 贡献与许可

欢迎用 Issue 提议新查询方向，也欢迎提交 PR。改动前后请跑 `npm test`；测试不访问网络。请勿提交日志、快照、反馈、下载档或令牌。项目源码使用 [MIT 许可证](LICENSE)，被调查仓库仍适用各自的许可证。

## English

Open Source Surveyor samples public GitHub repositories for visuals, inference cost, runtime efficiency, and agent memory. It compares observations taken 5–9 days apart and writes a local Chinese Markdown report. The first run establishes a baseline; rankings only cover sampled repositories. Feedback changes recommendations, not the measured leaderboard.

Use Node.js 24.5 or newer. Run `npm test` or `node weekly-surveyor.mjs`. Set `SURVEY_DATA_DIR` to change the data directory, `SURVEY_TIME_ZONE` to change the report's timezone, or `GITHUB_TOKEN` for authenticated API requests. On Windows, `register-weekly.ps1` can schedule a weekly run. Source downloads require an explicit `--download` flag (or `-Download` for scheduling); downloaded files are never extracted or executed by the tool.
