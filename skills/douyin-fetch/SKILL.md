---
name: douyin-fetch
description: 获取/下载抖音（Douyin）视频：按视频 ID、网页链接或分享文案下载无水印原视频，抓取首页推荐流，按关键词搜索视频，并输出标题、作者、时长、分辨率、点赞等元数据 JSON。Use when the user wants to download Douyin videos, fetch Douyin video info, browse the Douyin feed, or search Douyin by keyword (e.g. 下载抖音视频、抖音素材、抖音搜索、douyin.com/video 链接、v.douyin.com 分享链接).
---

# 抖音视频获取

脚本 `scripts/douyin.mjs`（位于本 skill 目录下）用真实的 Chrome 打开抖音页面，由抖音自己的前端 JS 完成接口签名，通过 Chrome DevTools Protocol 拦截 `/aweme/` 接口返回的 JSON，提取视频信息并按直链下载。无第三方依赖。

> yt-dlp 的 Douyin 提取器目前不可用（无论带不带 cookie 都报 `Fresh cookies are needed`），不要走那条路。

## 运行环境

- **Node.js ≥ 22**（需要内置 `WebSocket` / `fetch`）和 **Google Chrome**（或 Chromium）。
- 找 Chrome 的顺序：环境变量 `CHROME_PATH` → 各系统默认安装路径。
- **WSL**：调用 Windows 侧的 `node.exe`，让它启动 Windows 的 Chrome（WSL 里的 Linux node 找不到 Windows Chrome）。脚本路径要转成 Windows 路径：`node.exe "$(wslpath -w <skill目录>/scripts/douyin.mjs)" ...`。在 `/mnt/c`、`/mnt/d` 下的工作目录运行最省事。
- 先检查 `node --version`（或 `node.exe --version`）。

## 用法

```bash
node douyin.mjs video <ID | 链接 | 分享文案> [更多...]          # 下载指定视频（默认全部下载）
node douyin.mjs feed   [--limit 20] [--download N]               # 首页推荐流，下载前 N 条
node douyin.mjs search <关键词> [--limit 20] [--download N] [--headful]
```

通用选项：

| 选项 | 说明 |
|---|---|
| `--out <目录>` | 输出目录，默认当前目录下的 `douyin_output/` |
| `--profile <目录>` | Chrome 配置目录，默认 `~/.douyin-fetch/chrome-profile`，保存验证/登录状态 |
| `--headful` | 显示浏览器窗口（用于人工过验证码 / 扫码登录） |
| `--port <端口>` | CDP 调试端口，默认 9333 |

`video` 模式接受的输入：纯数字 ID、`douyin.com/video/<id>`、带 `modal_id=<id>` 的链接、`v.douyin.com/xxx` 短链，或整段分享文案（会自动从中提取链接）。

## 输出

- `douyin_output/<aweme_id>.mp4`：视频文件。已存在则跳过；下载过程写入 `.part`，完整后才改名。
- `douyin_output/<模式>_<时间戳>.json`：每条的 `aweme_id, desc, author, likes, duration_s, resolution, codec, page_url, cover, is_image_post`。
- 清晰度选择：优先 H.264（剪辑软件兼容性最好），同编码下取最高码率。图文作品（`is_image_post: true`）只列出、不下载。

## 验证码

- `video` 和 `feed` 在无头模式下通常不会触发验证码。
- **`search` 页面在无头模式下会被拦到"验证码中间页"**。处理方式：让用户自己用 `--headful` 跑一次，在弹出的 Chrome 窗口里**手动**完成验证或扫码登录（脚本最多等 180 秒），状态会存进 profile 目录，之后再去掉 `--headful`。
- `--headful` 需要用户在电脑前操作，执行前先告诉用户会弹出窗口、需要做什么。
- **不要**接入打码平台或写代码自动破解验证码。
- 没拿到数据时，脚本会把页面截图存到输出目录，先看截图判断原因。

## 注意事项

- 抖音首页"精选"推荐里有大量 40 分钟以上的长视频，1080p 单个文件可能超过 1GB。批量下载前先列出（不加 `--download`），看一下 `duration_s` 再决定下载哪些。
- 视频直链有时效，过期后要重新运行脚本获取，不要保存直链留着以后再用。
- 长视频下载会花不少时间，用 Bash 运行时把超时设大一些，或者放到后台运行。
- 同一时间只运行一个实例：多个实例会抢同一个 profile 目录和调试端口。确实需要并行时，换 `--port` 和 `--profile`。
- 下载的视频用于参考、学习、个人剪辑素材没问题；如果要剪进作品公开发布，提醒用户注意原作者的版权。
