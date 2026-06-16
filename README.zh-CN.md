# OpenClaw 谷歌搜索插件

[English](./README.md) | [中文](./README.zh-CN.md)

为 OpenClaw 提供一个 `google_search` 工具：在**本地真实浏览器**里（你已登录的
会话）用 Google 搜索，返回精简的结构化结果——而不是把一整页搜索结果快照丢给
模型去解析。

- 最贴近真人：用带你 cookie 的真实浏览器，最不容易触发 Google 的风控。
- 省 token：一次搜索约 2 个浏览器动作、几百 token，而不是 4-5 次工具调用加上
  上万 token 的页面快照。
- 喂给模型更安全：结果的标题/摘要会被包裹成不可信外部内容（防 prompt 注入），
  输出结构与 OpenClaw 原生 `web_search` provider（如 Tavily）一致。

## 快速示例（安装后可以做什么）

安装完成后，可在飞书（或其他 channel）直接使用这些提示词：

- `用 Google 搜一下 OpenClaw 最新的发布说明并总结。`
- `用 google_search 找到 DeepSeek V4 Pro 的官方定价页。`
- `这周大家怎么评价 Claude Opus 4.8？搜索并给我 5 个链接。`

## 工作原理

1. 在一个专属的带标签浏览器标签页中打开 `google.com/search?q=...&udm=14`
   （纯净的「网页」结果视图，无 AI 概览/小组件）。
2. 执行一次页内 `evaluate`，把自然搜索结果抽取为 JSON。
3. 只返回这段 JSON，随后关闭搜索标签页，并清理 Google 弹出的瞬时会话同步
   标签页，做到搜完零残留。

它通过 OpenClaw CLI 驱动现有的 `browser` 插件，因此与 OpenClaw 内部实现解耦，
并复用你已经信任的浏览器会话。浏览器进程默认保持热态（共享资源、保住登录态 =
低风控）；如需搜完连浏览器一起关闭，设置 `closeBrowserAfterSearch`。

## 环境要求

- 已安装并可正常运行的 OpenClaw。
- 启用 `browser` 插件，且有可用的浏览器 profile（插件会按需自动启动浏览器）。

## 安装

```sh
openclaw plugins install /path/to/openclaw-plugin-google-search --link
openclaw plugins enable google-search
# 把 "google_search" 加到 agent 的 tools.alsoAllow，然后重启 gateway
openclaw gateway restart
```

`--link` 让 OpenClaw 直接指向源码目录，因此在这里改代码后，下次重启 gateway
即可加载新版本。

## 配置（可选）

在 `openclaw.json` 的 `plugins.entries.google-search.config` 下设置：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `defaultLang` | `"en"` | Google 界面语言（`hl`），如 `"zh-CN"`。 |
| `region` | — | Google 地区（`gl`），如 `"us"`、`"cn"`。 |
| `browserProfile` | 默认 profile | 使用的 OpenClaw 浏览器 profile。 |
| `maxResultsCap` | `10` | 返回给模型的结果数硬上限。 |
| `closeTabAfterSearch` | `true` | 每次搜索后关闭搜索标签页（并清理噪声标签页）。 |
| `closeBrowserAfterSearch` | `false` | 每次搜索后连整个浏览器一起停止。 |

## 工具参数

`query`（必填）、`num`（1-20，默认 10）、`hl`、`gl`。

## 输出

```jsonc
{
  "query": "deepseek v4 pro",
  "provider": "google",
  "count": 3,
  "tookMs": 9308,
  "externalContent": { "untrusted": true, "source": "web_search", "provider": "google", "wrapped": true },
  "results": [
    { "title": "<<<EXTERNAL_UNTRUSTED_CONTENT ...>>> ...", "url": "https://...", "snippet": "<<<...>>> ..." }
  ]
}
```

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
