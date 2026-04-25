# GenkiBot

## 介绍

GenkiBot 是一个低成本具身智能学习平台，基于斯坦福的aloha机械臂和开源的lerobot项目修改开发，旨在为机器人学习和智能体开发提供简单、灵活且经济高效的解决方案。

## 软件架构

GenkiBot 的软件架构主要包括以下模块：

teacher端：也叫leader端，负责示教和遥操作。
student端：也叫follower端，负责抓取和运动控制
控制层：实现机器人的运动控制、路径规划等功能。
学习层：集成强化学习、模仿学习等算法，支持智能体训练。

## 安装教程

1. 克隆仓库：
   
   > git clone  https://gitee.com/huahuaze/genkiarm.git
   > cd genkiarm

2. 安装依赖：
   
   > 建议使用conda环境
   > conda create -y -n jszn python=3.10  
   > conda activate jszn
   > cd lerobot
   > pip install -e .
   > pip install -r requirements.txt
   > pip install pyserial

3. 测试遥操作
   
   > python lerobot/scripts/control_robot.py teleoperate   --robot-path lerobot/configs/robot/so100.yaml  --robot-overrides "~cameras"  --display-cameras 0

## 开源许可证

GenkiBot 基于以下开源项目开发，感谢它们的贡献：

lerobot：Apache License 2.0

Diffusion Policy：MIT License

FOWM：MIT License

simxarm：MIT License

ALOHA：MIT License

DETR：Apache License 2.0

请在使用时遵守各项目的许可证要求，详情请查看 LICENSE 文件。
