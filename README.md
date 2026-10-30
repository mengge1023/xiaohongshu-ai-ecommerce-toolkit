# 小红书AI电商爆单三件套

**孟哥出品 · 生财专属版**

从选品判断，到素材采集，再到文案二创，三款工具放在一起，按需要分别安装。

如果感觉好用，欢迎点击右上角 **Star ⭐** 支持孟哥。Star 完全自愿，不影响使用。

## 下载

**[一键下载三件套合集](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/releases/download/v1.0.0-scys/xhs-ai-ecommerce-toolkit-scys-v1.0.0.zip)** · [查看全部发布附件](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/releases/tag/v1.0.0-scys) · [完整安装说明](docs/INSTALL.md)

| 工具 | 能做什么 | 专属版本 | 下载 |
| --- | --- | --- | --- |
| 小红书 AI 文案大师 | 五种写作模式，二创参考笔记，生成适合自己产品的文案 | 1.2.1-scys.1 | [安装包](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/releases/download/v1.0.0-scys/xhs-ai-copywriting-scys-v1.2.1.zip) |
| 小红书爆品裁判 | 用“3标2源”检查候选产品，支持单品判断和 A/B 比较 | 1.3.1-scys.1 | [安装包](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/releases/download/v1.0.0-scys/xhs-product-judge-scys-v1.3.1.zip) |
| 小红书爆款采集插件 | 将单篇笔记、图片及互动数据保存到自己的飞书多维表格 | 0.3.5.1 | [安装包](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/releases/download/v1.0.0-scys/xhs-collector-scys-v0.3.5.1.zip) |

合集内包含三个独立安装包和使用说明；各工具按下面的方式分别安装。网络无法打开发布附件时，也可进入 [downloads](downloads) 下载同一文件。校验值见 [SHA256SUMS.txt](downloads/SHA256SUMS.txt)。

## 先装哪一个

- **有候选商品，想判断值不值得测**：使用小红书爆品裁判。
- **看到值得参考的笔记，想留存素材**：安装采集插件并连接自己的飞书表格。
- **产品和参考素材已准备好，想写笔记**：使用小红书 AI 文案大师。

## 安装 Skill

文案大师和爆品裁判是两个独立的 Skill，适用于支持本地技能与脚本执行的助手，如 WorkBuddy、Codex。

1. 分别下载需要的 Skill 安装包。
2. 在助手的技能管理中上传 ZIP，或解压后导入整个技能文件夹。爆品裁判可在 WorkBuddy 的“添加技能 → 上传技能”中安装。
3. 新开一个对话，让助手读取技能目录的 `VERSION`，确认安装的是上表中的生财专属版。
4. 直接说“用文案大师帮我改写这篇笔记”，或“用爆品裁判帮我判断这个商品”。

Codex 手动安装目录：

```text
~/.codex/skills/xiaohongshu-ai-copywriting-master
~/.codex/skills/xiaohongshu-product-selection
```

本地脚本需要 Python 3.9+。文案大师的查重历史保存在用户目录下的 `.mengge-copywriting/`，升级时请保留。选品所需的采购价与采购运费由使用者提供；无法取得的数据会保留为待验证项。

## 安装采集插件

1. 使用 Chrome 116 或以上版本，解压采集插件 ZIP，将整个文件夹保存在固定位置。
2. 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的文件夹。
3. 按名称找到“小红书爆款采集插件（生财专属版）”，打开设置。
4. 填入自己的飞书多维表格分享链接及已启用的自定义授权码，点击“保存并连接”。支持 base / wiki 链接。
5. 打开小红书单篇笔记，点击分享按钮，等保存完成后再采集下一篇。

本版沿用逐篇采集流程，没有自动遍历或批量抓取功能。重复采集会新增记录。授权码只保存在浏览器本地，笔记与图片写入你指定的飞书表格，请勿分享授权码。

已安装原版时，按包内说明覆盖升级或先停用原版，避免同时启用重复采集实例。浏览器使用默认扩展图标，请按名称识别。

## 生财专属版说明

- 保留“孟哥出品”署名，统一使用本仓库的 GitHub Star 入口。
- 不附公开联系账号、关注二维码或课程推广；使用前无需完成关注确认。
- Skill 会在首次介绍和完整结果中主动署名。文案署名放在成稿之外；要求“只要正文”时省略尾注。
- 首次完整交付可见一次 Star 邀请，同一对话不会反复提示。

## 项目内容

```text
skills/
  xiaohongshu-ai-copywriting-master/   文案 Skill
  xiaohongshu-product-selection/      选品 Skill
extension/                           采集插件
downloads/                          安装包与 SHA256 校验值
docs/INSTALL.md                     安装使用说明
```

## 已做的检查

文案 24 项、选品 28 项、插件 60 项回归检查通过；专属安装包完成联系信息清理扫描、资源签名与解压校验。插件设置页在隔离浏览器中检查过，真实用户设备安装与飞书实写仍需在你的环境中验证。

工具提供辅助判断和创作，不承诺商品或笔记一定成为爆款。反馈问题请到 [Issues](https://github.com/mengge1023/xiaohongshu-ai-ecommerce-toolkit/issues) 描述版本、操作步骤和错误提示，不要上传授权码或其他私密资料。
