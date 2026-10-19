# NativeShot

GNOME Shell 扩展：用系统自带截图工具截完图后，自动弹出全屏编辑器，可以快速标注。

## 功能

- 工具：选择、铅笔、矩形、箭头、马赛克、文字
- 6 种颜色，3 种线宽（文字字号 = 线宽 × 6）
- 每个标注是独立图层。在“选择”工具下可以点选、拖动、按 Delete 删除；双击文字（或用文字工具点已有文字）可重新编辑
- 撤销 / 重做（拖动、改字、删除各算一步）
- 保存：**覆盖原截图 PNG，并把编辑后的图写入剪贴板**
- 取消：原截图和剪贴板保持不变

## 快捷键

| 按键 | 作用 |
| --- | --- |
| Esc | 取消并关闭（不改动原文件） |
| Enter / Ctrl+S | 保存并关闭 |
| Ctrl+Z | 撤销 |
| Ctrl+Shift+Z / Ctrl+Y | 重做 |
| Delete | 删除选中的图层（仅“选择”工具） |

## 安装

要求 GNOME Shell 46。目录名必须与 `metadata.json` 里的 `uuid` 一致。

### 从 GitHub 安装（推荐）

需要 `git`。直接 clone 到扩展目录：

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
git clone https://github.com/todouu/nativeshot \
  ~/.local/share/gnome-shell/extensions/nativeshot@todou.local
```

然后重启 Shell（X11：Alt+F2，输入 `r`，回车；Wayland：重新登录），再启用：

```bash
gnome-extensions enable nativeshot@todou.local
```

更新：在扩展目录里 `git pull`，然后同样需要重启 Shell，修改过的 `.js` 才会生效。

### 打包安装

不想保留 git 仓库时，可以在源码目录打包后安装：

```bash
gnome-extensions pack --force \
  --extra-source=editor.js --extra-source=geometry.js --extra-source=render.js
gnome-extensions install --force nativeshot@todou.local.shell-extension.zip
```

## 限制

- 只在 GNOME Shell 46.0 的 X11 会话上测试过，Wayland 未测试，其他版本被 `shell-version` 拒绝加载。
- 保存的 PNG 是拍平的，图层信息不会写入文件。编辑器关闭后无法再选中、移动之前的标注。
- 只对截图 UI（Print 键等）拍摄的截图生效；通过 D-Bus / portal 的交互式截图不会弹出编辑器。
- 系统禁止保存到磁盘（`disable-save-to-disk`）时不会弹出编辑器。

## 许可证

MIT，见 [LICENSE](LICENSE)。
