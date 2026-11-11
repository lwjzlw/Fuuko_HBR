# shared

`wbkit.py`、`wbkit.js`、`fuuko.css` 来自 [风子工作台](https://github.com/lwjzlw/Fuuko_Workbench) 的 `shared/`，放在这里是为了让 HBR 研究室不依赖风子也能单独运行。网页里的 `/_shared/` 由这个目录提供。

独立窗口程序（FuukoHost.exe）不包含在这里。打开窗口时会依次找环境变量 `FUUKO_HOST`、旁边的 `Fuuko/shared/host/bin/`，都找不到就用默认浏览器。

要更新这几个文件，从风子工作台的 `shared/` 复制同名文件覆盖即可。
