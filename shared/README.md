# 内置共用组件

`wbkit.py`、`wbkit.js`、`fuuko.css` 复制自风子工作台框架的 `shared/`（2026-11-10），让 HBR 研究室不依赖同级的 `Shared` 目录，可以单独发布和运行。网页里的 `/_shared/` 由这里提供。

窗口程序（FuukoHost.exe）不随本项目复制。独立打开窗口时，`hbr_app.py` 按顺序查找：环境变量 `FUUKO_HOST`、同级 `Fuuko/shared/host/bin/`、同级 `Shared/host/bin/`；都找不到就用默认浏览器打开。

更新方法：用风子框架 `shared/` 里的同名文件覆盖这三个文件，再跑 `python -m unittest discover -s tests`。
