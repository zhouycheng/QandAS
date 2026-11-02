# 共享内容格式

管理端与小程序共用 Markdown 解析、代码标记、内容属性和五部分教学解析校验。解析结果为受限节点树，各客户端用自己的组件渲染。学生 Web 可复用同一节点合同。

在仓库根目录准备依赖：

```sh
npm --prefix packages/content-format ci
npm --prefix packages/content-format run build
npm --prefix packages/content-format test
```

`dist/content-format.js` 是供浏览器与微信 npm 构建消费的独立 CommonJS 文件。Markdown-it、Prism 的依赖在这里预打包，客户端无需解析 Node CLI 依赖。生成目录由 Git 忽略；更新源码后先构建，再运行客户端检查。

Prism 通过 `prism-runtime.js` 显式注入，微信沙箱不依赖浏览器的隐式全局变量。包测试使用独立 VM 加载构建产物，检查代码高亮与受限节点输出；客户端仍需验证组件渲染与代码块横向滚动。

`fixtures/blank-grading.json` 与 `fixtures/scoring.json` 由小程序和 API 测试共同使用。正文规则、版本兼容和交互说明见 [题型与 Markdown 实现](../../docs/question-content-and-practice.md)。
