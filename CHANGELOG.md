## v3.3.11 (2026-10-12)

### UX

- **源备份与恢复收纳**：影视源页的“下载备份 / 选择备份文件 / 恢复备份”不再占据固定卡片，改为放入“批量导入”折叠区，与 MacCMS 的导入/导出交互保持一致。

## v3.3.10 (2026-10-12)

### Fixes

- **根链接简单模式数量保存**：修复根链接在简单选择中保存自定义数量后回退为 1 的问题。保存前会重新读取当前输入框，并按统一质量池排序下发指定数量的源。
- **鉴权码路径保持不变**：本次只修复根链接表单状态同步，不改变鉴权码数量逻辑。

## v3.3.9 (2026-10-12)

### Fixes

- **JAR/扩展配额生效**：源类型数量现在作用于全部可下发站点，`JAR=0` 会彻底移除 JAR/扩展，`JAR=N` 只保留统一质量排序后的前 N 个，不再静默补回未选插件。
- **简单模式数量准确**：根链接和鉴权码的简单数量均按完整有序源列表取前 N，JAR/扩展占用名额；全选保持全部合格源，0 表示不下发。
- **启动依赖清理**：最终没有任何 `type=3` 站点时同步移除全局 `spider`，避免客户端下载并初始化未使用的整包插件。
- **根链接复制修复**：复制根链接改为生产可用的站点根地址，不再指向 404 的 `/config.json`。
- **分类可用数量准确**：精细选择中的源类型数量包含不可搜索 JAR/插件，与最终下发结果一致。
## v3.3.8 (2026-10-12)

### Fixes

- **精细选择保存修复**：补回鉴权码分类数量的归一化函数，修复点击保存时 `normalizeClientBucketMap is not defined` 导致的失败。
- **分类可用数量提示**：根链接与鉴权码的精细选择均显示最终质量池中每个质量等级、源类型的实际可用数量，并限制自定义输入范围。
- **零可用源兜底**：保存前自动将已无可选源的旧自定义数量收敛为“不选”，避免界面与实际下发不一致。

### UX

- **根链接与鉴权码统一**：两者共用相同的质量等级 / 源类型筛选与可用数量统计规则。
- **复制入口前移**：复制根链接和复制鉴权链接按钮移入标题操作区，源选择设置收起时也可直接复制。

# Changelog

## v3.1.0 (2026-06-17)

### Features

- **网盘源清洗**：新增未配置凭证的直连网盘站点自动清洗逻辑，彻底解决 TVBox 客户端启动及切换至网盘标签时的并发超时与卡顿。
- **构建提速**：全面移除多架构 Docker 镜像（ARM64/ARMv7）构建，改为仅生成 `linux/amd64` 单架构镜像，使 GitHub Actions 构建与推送总耗时从 7+ 分钟大幅压缩至 1 分钟以内。

## v2.1.1 (2026-06-10)

### Fixes

- Builder 白屏 + Admin 导航入口 + MacCMS 占位符未替换



## v2.1.0 (2026-06-10)

### Features

- 配置构建器（Builder）+ 版本号管理机制
- live merge mode switch — separated (per-source) vs merged (dedup)
- 新增 Android APK 形态——废旧手机当聚合服务器
- 黑名单变更实时生效（patchMergedConfig）
- 结构化日志 + 正则黑名单 + 智能Base URL + 站点验活 + 本地字体
- 聚合日志 + 分组排序 + 相似去重 + 6主题 + 背景自定义 + JSON 下载端点
- MacCMS 本地模式边缘函数代理回退（/api/:key）
- MacCMS 本地模式 API 代理（/api/:key 路由扩展）
- 直播源频道级合并（方案 D+）+ Native 格式 type 泄漏/CF 子请求修复
- 配置编辑器屏蔽优化（局部更新+批量操作）+ Docker IP 检测
- 网盘扫码登录与 Cookie 统一管理
- MacCMS 萌芽采集自动抓取 + 记忆规则配置 + 聚合超时调整
- 边缘函数代理——本地 Docker 支持 CF/Vercel 代理回退 + 图片 CDN
- 自动抓取 juwanhezi.com 源列表（私有功能）
- JAR 仓库管理体系——DEX 解析 + 精确类匹配 + 图片伪装解码
- TVBox 配置新增 pic 字段支持图片代理前缀
- UA 升级为 TVBox 标准浏览器 UA + 站点测速开关
- 源接口健康监控——累积追踪失败状态，Dashboard/Admin 分级展示
- 全局主题切换（暗色/亮色），三页面统一支持
- 定时任务可配置间隔 + 站点测速增强
- 配置解码器支持图片伪装和加密格式
- JSON 直接导入 + 源名称定制
- 多仓递归展开 + 黑名单修复 + i18n + 多项优化
- 直播源聚合 + JAR代理 + 去重优化 + 可视化配置编辑器
- 补充 CF 边缘代理支持
- MacCMS 源集成 — 验证过滤 + Admin 管理界面

### Fixes

- expose regexBlocked status in /admin/config-data for frontend display
- reapply JAR proxy in patchMergedConfig + live-config realtime parsing
- 配置编辑器 tab 页签多语言支持
- Admin UI 中文化 + 正则黑名单迁移到配置编辑器 + 语法错误修复
- /live-config 端点改为返回 txt 格式（TVBox 直播配置地址兼容）
- MacCMS 聚合验证跳过（有 edge proxy 时信任运行时兜底）
- dashboard 移除刷新按钮 + 复制 clipboard fallback + Node.js 本地 JAR 代理
- 双 UA 回退——okhttp 优先，解析失败自动换浏览器 UA 重试
- DEX 解析器改用 Central Directory 定位——修复 Data Descriptor 模式的 ZIP
- 启用 CF 边缘代理——填入 WORKER_BASE_URL + 清理过时 env 配置
- 亮色主题对比度修复——补全遗漏 #fff 替换 + 加深强调色
- 站点去重统一用 key+api，消除 JAR 差异导致的冗余条目
- correct Docker Hub image name to rio22/tvbox-aggregator
- use --ignore-scripts in Dockerfile for multi-arch ARM compatibility
- 修复聚合后相对路径补全遗漏



## v2.0.0 (2026-04-20)

- Initial release: TVBox 聚合器完整功能