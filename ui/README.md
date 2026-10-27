# ui/ — 跟人交流用的页面

这里放的页面是拿去问人、让人拍板的：人看着它和角色讨论，按「定下」。都挂在工作台那一个地址底下（`tools/workbench.js` 调 `server.js` 的 `handle`），不另开口。

| 页面 | 地址 | 读写 |
|---|---|---|
| 故事 | `/stories` | 读 `business/故事/<nn>-<故事名>.json`（业务分析写）；「定下」写 `confirmed`；地址带 `#<文件>#<步骤>` 直接走到那一步 |
| 聚合设计 | `/agg` | 读 `aggregate-design/<聚合>.json` 与业务语句；「定下」写 `confirmed` |
| 模块 | `/modules` | 读聚合设计与模型；拖动、改名存 `aggregate-design/modules.json`，「定下」写 `confirmed` |

- 每个页面一个文件夹：`client.js`（浏览器里跑）、`style.css`。`common/` 是共用的颜色（明暗两套）与小工具。
- 数据形状见 `agents/model/shapes.md`「aggregate-design」。页面只画数据，不存图。
- **写回都带版本号**：读到时那份文件的指纹。文件在这期间被别人改过就拒（409），页面重取后再按。整份覆盖会盖掉角色刚写的。
- **定下记指纹**：`confirmed.stamp` 是定下那一刻其余内容的指纹；内容再改，页面显示「改过」，门禁当没定。
- 页面每 4 秒问一次文件变没变，角色改了文件，开着的页面自己跟上。
- 地址带 `?tab=life&view=ln` 直接打开那一页，发给人的链接就停在那里。
