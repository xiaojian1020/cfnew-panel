# 来源与许可

面板程序沿用 CFnew 的实现。本版本中由作者有权许可的代码采用仓库根目录的《CFnew 源码使用与署名许可》：允许合法使用、修改和二次开发，基于本仓库的 AI 改写也须保留来源，不得冒充原创。

这是一份自定义许可，不是标准 MIT 许可。此前已按 MIT 发布的版本仍保留对应授权。内置分流规则另遵循 GPL-3.0，来源、固定版本与完整许可见 src/singbox-rules.NOTICE.md 和 src/singbox-rules.LICENSE；项目自身许可不替代第三方许可。

感谢以下项目和作者：

- [zizifn/edgetunnel](https://github.com/zizifn/edgetunnel)
- [cmliu](https://github.com/cmliu)
- [qwer-search](https://github.com/qwer-search)
- 在线优选资源：[bestcfipas](https://t.me/bestcfipas)
- 分流规则：[MetaCubeX/meta-rules-dat](https://github.com/MetaCubeX/meta-rules-dat)

测试夹具 test/core-fixture.mjs 来自 CFnew 的 core-only 分支，仅用于隔离测试，不会在面板中运行或部署到 Vercel。

## 界面风格参考

面板 UI 的配色与布局参考了 [cmliu/edgetunnel](https://github.com/cmliu/edgetunnel)（GPL-2.0）管理面板的视觉设计。`src/theme.css` 中的 edgetunnel 风格皮肤为独立重写的 CSS，未复制其源代码。
