# urdf_learn

一个面向 `URDF / 机械臂 / 具身智能 / 真机控制 / 语音交互` 的综合学习与实验工作区。

这个仓库不是单一模块，而是把文档、机械臂控制代码、网页可视化、语音控制工具和若干辅助脚本放在了一起，方便集中迭代和联调。

## 仓库结构

- [docs](./docs)
  采购、装配、接线、采集流程和执行说明等文档资料。
- [genkiarm](./genkiarm)
  基于 ALOHA / LeRobot 思路整理和改造的低成本具身机械臂代码与配置。
- [playground](./playground)
  浏览器端机械臂可视化与 Web Serial 真机控制面板。
- [gongneng](./gongneng)
  语音转文字、实时语音指令、语音桥接执行等终端工具。
- [scripts](./scripts)
  BOM 生成、执行方案生成、舵机角度读取等辅助脚本。
- [归档](./归档)
  部分历史 STL 模型与归档文件。

## 主要能力

- 机械臂 URDF / 网页可视化调试
- 浏览器端 Web Serial 真机控制
- 语音转写与机械臂语音命令桥接
- 低成本具身机械臂训练与遥操作实验
- 装配、接线、采集流程等项目文档沉淀

## 快速开始

### 1. 浏览器控制面板

如果你想先看机械臂网页控制与可视化：

```powershell
cd playground
npm install
npm run dev
```

然后在浏览器中打开本地开发地址。

说明：

- `playground` 支持虚拟机械臂显示
- 支持通过 `Web Serial API` 连接真实机械臂
- 可以和 `gongneng` 目录下生成的 `robot_command_bridge.jsonl` 做桥接联动

### 2. 语音终端工具

如果你想体验语音输入或语音控制链路：

```powershell
python -m pip install -r gongneng\requirements.txt
python gongneng\voice_to_text_terminal.py
```

实时语音版：

```powershell
python gongneng\realtime_voice_command_terminal.py
```

### 3. GenkiArm / LeRobot 相关代码

如果你想看训练、遥操作和机器人配置，优先从下面几个位置开始：

- [genkiarm/README.md](./genkiarm/README.md)
- [genkiarm/lerobot/configs](./genkiarm/lerobot/configs)
- [genkiarm/lerobot/scripts](./genkiarm/lerobot/scripts)

## 推荐阅读顺序

如果你是第一次看这个仓库，推荐按这个顺序：

1. 先看 [docs](./docs) 了解硬件、接线、采集和执行背景
2. 再看 [playground](./playground) 了解网页控制和可视化
3. 再看 [gongneng](./gongneng) 了解语音输入与桥接控制
4. 最后看 [genkiarm](./genkiarm) 进入训练、配置和真机控制代码

## 说明

- 这个仓库已经排除了 `.venv`、`node_modules`、日志、缓存、临时输出等本地生成内容
- `genkiarm` 在当前仓库中按普通目录纳入管理，便于一次性克隆完整内容
- 如果你只关心某个子方向，可以直接从对应子目录开始阅读
