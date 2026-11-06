# 首页公告入口

首页右侧以透明 PNG 呈现漫画贴纸风格的筒状喇叭，素材位于 `../miniprogram/assets/home/announcement-megaphone.png`，输出 256 × 256 像素。珊瑚红筒身、明黄口沿与两条声波，以深蓝粗描边和奶油白外轮廓衔接蓝色页头。

素材由内置 imagegen 生成并经用户选定，部署时等比缩小并保留透明通道。生成提示词要点：漫画贴纸图标、右上朝向的筒状喇叭、珊瑚红与明黄纯色块、深蓝粗描边、沿造型的奶油白外轮廓、两条声波、透明背景、小尺寸清晰可辨。

当前布局与动效参数见根目录 `docs/home-announcement-motion.md`。

## 公告角标

`announcement-top.png` 与 `announcement-new.png` 使用内置 imagegen 生成，正文分别为 Top 与 New。字形采用黄色圆润斜体、深蓝描边、珊瑚红外边和奶油白外轮廓；Top 参照已选定的 New 素材替换文字。透明 PNG 在标签右上角以 40 × 24px 等比显示。

生成要求：精确呈现大小写，轮廓紧贴字形，保持透明背景和小尺寸可读性。Top 与最新状态重合时显示 Top。
