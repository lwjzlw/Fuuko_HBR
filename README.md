# HBR 研究室

在自己电脑上跑的《炽焰天穹》（Heaven Burns Red）小工具：记 box、导出 box 图，给当期的积分挑战、遭遇战、异时层找轴。

## 能做什么

- **Box**：按部队列出全部 SS/SSR，有没有、突破到几一眼就能看到。点卡面改突破和开花，点角色改等级和转生。
- **导出 box 图**：生成一张密排的 box 图（卡面 + 突破数，满突是金框），存下来就能发到社区。
- **从游戏同步**：读本机游戏客户端的缓存，把拥有、突破、等级和编队同步进来。只读缓存文件，不登录账号，也不碰游戏进程。
- **排轴器**：打开就选好正在开放的那一期，点「求最佳轴」，它会用你手里的卡组队、选特殊规则、配技能和饰品、排好每回合的行动，再跑随机模拟比成功率和分数。固定配队、手选规则、长时间搜索（15 分钟到 12 小时）、逐回合手改，都在「更多细致选项」里。
- **Boss 资料**：历期积分挑战、遭遇战、异时层的敌人、规则和行动顺序。

## 开始使用

需要 Python 3.10 以上，不用装任何第三方包。

```powershell
python -B hbr_app.py
```

Windows 上也可以双击 `启动研究室.vbs`。地址是 `http://127.0.0.1:8787`，只对本机开放。

卡面图片不在仓库里，第一次用之前下载一下：

```powershell
python -B scripts/download_images.py
```

个人数据默认放在 `%LOCALAPPDATA%\FuukoWorkbenches\hbr`，想换位置就用 `--data-dir` 或环境变量 `HBR_DATA_DIR`。游戏缓存不在默认位置的话，用 `HBR_CACHE_DIR` 指过去。

## 配合风子工作台

在 [风子工作台](https://github.com/lwjzlw/Fuuko_Workbench) 的「管理」里导入这个项目的 `workbench.json`，HBR 研究室就会出现在首页，能在标签页里打开，也能直接从风子关掉。

## 更新数据

角色、卡面、装备、技能和 Boss 都来自 hbr.quest 的公开数据。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Update-Catalog.ps1
```

它会更新角色、卡面和装备，顺便补齐图片（需要 Node.js）。技能、面板和 Boss 数据由 `scripts/` 下的 `build-skills.py`、`build-stats.py`、`build-bosses.py` 生成，参数看 `--help`。更新数据不会动你的个人档案。

## 开发

```powershell
node --test tests/*.test.mjs
python -B -m unittest discover -s tests
```

前端测试和部分数据脚本要 Node.js 20 以上。

## 许可

代码用 [MIT](LICENSE) 协议开源。游戏名称、角色和美术素材归原权利方所有，数据和算法的来源写在 [NOTICE.md](NOTICE.md)。
