# douyin-fetch

一个用来获取抖音视频的 Claude Code skill，可以：

- 按 ID、链接或分享文案下载视频
- 抓取首页推荐流
- 按关键词搜索
- 输出元数据 JSON

## 原理

脚本用真实的 Chrome 打开抖音页面，接口签名由抖音自己的前端代码完成。脚本通过 Chrome DevTools Protocol 拦截 `/aweme/` 接口的 JSON，从中提取视频信息，再按直链流式下载。不依赖任何第三方包。

## 安装

**作为插件安装（推荐）**，在 Claude Code 里运行：

```
/plugin marketplace add Cznorth/douyin-fetch-skill
/plugin install douyin-fetch@douyin-fetch
```

**手动安装**：把 `skills/douyin-fetch/` 复制到 `~/.claude/skills/`。

需要 Node.js ≥ 22 和 Google Chrome。在 WSL 里使用时，用 Windows 侧的 `node.exe`。

## 直接运行脚本

```bash
node skills/douyin-fetch/scripts/douyin.mjs video https://www.douyin.com/video/7692362301278682995
node skills/douyin-fetch/scripts/douyin.mjs feed --limit 20 --download 3
node skills/douyin-fetch/scripts/douyin.mjs search 猫 --headful   # 第一次需手动过验证码
```

完整的参数说明和注意事项见 [`skills/douyin-fetch/SKILL.md`](skills/douyin-fetch/SKILL.md)。

## 已知限制

- **搜索**：无头模式会被验证码拦下。第一次需要加 `--headful`，在弹出的窗口里手动完成验证或扫码登录，状态会保存在 `~/.douyin-fetch/chrome-profile`。
- **yt-dlp**：截至 2026.08.19 版，它的 Douyin 提取器不可用，所以本工具没有基于它实现。
- **长视频**：推荐流里有很多 40 分钟以上的长视频，1080p 单个文件可能超过 1GB。

## 免责声明

本工具仅用于个人学习和研究。请遵守抖音用户协议和相关法律法规。下载的内容版权归原作者所有，二次发布前请取得授权。
