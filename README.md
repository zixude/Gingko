# Gingko Lite

一个极小、本地优先的银杏式树形卡片画布。它从 Gingko Writer 的核心结构语义重新实现，只保留：

- 完整树按层级横向展开、同级卡片纵向排列；
- 点击卡片后，活动卡、祖先链与最近访问的后代在各自列中自动对齐；
- 非当前路径退暗，后代区域通过动态圆角连续连接；
- 各列独立纵向滚动，当前深度驱动横向镜头；
- 新建、编辑、删除、拖拽移动卡片；
- 新建空项目；
- 打开和保存单个、可读的 `.gingko.json` 项目文件；
- Web UI 与 MCP Agent 共用一个本地 Tree Runtime；
- revision、原子批事务与实时事件流保护人机协作。

没有账户、云同步、数据库、支付、Electron 或遥测。服务仅监听本机。

## 运行

需要 Node.js 20 或更高版本。

```bash
npm install
npm start
```

浏览器访问 <http://127.0.0.1:3000>。

## 使用

- **新建**：清空为一个空项目；
- **打开**：从浏览器选择 `.gingko.json`；
- **保存文件**：通过浏览器下载完整项目文件；
- 单击卡片切换活动路径，双击或点击铅笔进入编辑；
- 活动卡四周按钮可新建同级、子级、编辑或删除；
- 悬停卡片左缘后拖动手柄；上方落点表示同级插入，右侧落点表示放入子级，组内末卡下方落点表示追加同级。

项目文件不引用外部资源，使用普通 JSON，可直接备份、复制或版本管理。

## MCP

Streamable HTTP 地址：<http://127.0.0.1:3000/mcp>。

MCP 与浏览器共享服务端内存中的权威项目状态；服务重启前，请在浏览器中保存项目文件。主要能力：

- `read_project`、`read_node`、`search_nodes`：理解完整结构与局部上下文；
- `create_node`、`update_node`、`delete_node`、`move_node`：细粒度编辑；
- `insert_subtree`、`merge_nodes`、`batch_apply`：整片研究分支与原子事务；
- `focus_node`：让 Agent 在共享画布中展示当前工作位置；
- `rename_project`、`new_project`：项目级操作。

所有写工具均返回最新 revision；传入 `expectedRevision` 可拒绝过期写入。MCP 不直接修改 JSON 文件或浏览器 DOM。

## 模块边界

- `src/tree.js`：纯树模型、操作与空间投影；
- `src/runtime/`：权威状态、查询、事务、revision 与事件；
- `src/adapters/mcp.js`：可替换的 MCP 适配器；
- `public/runtime-client.js`：浏览器 Runtime 适配器；
- `public/app.js`：银杏式空间交互。

## 测试

```bash
npm test
```

## 来源与许可

树模型、操作语义与列投影视图参考了 [Gingko Writer](https://github.com/gingko/client)。本项目保留其 MIT 许可证，见 [`LICENSE`](./LICENSE)。
