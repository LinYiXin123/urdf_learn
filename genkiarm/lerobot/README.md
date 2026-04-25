本项目基于 [MIT 的 ALOHA项目和开源lerobot项目]，由 [传智教育] 进行修改
你可以自由使用：将代码用于个人、学术或商业项目。
你可以修改代码：根据自己的需求修改代码，创建衍生作品。
要求：保留版权声明和许可证：在分发原始代码或修改后的代码时，必须保留原始的版权声明、许可证文件和免责声明。

注意：本项目仅用于研究和教育目的，不提供任何形式的保证或支持。使用本项目的结果由用户自行承担。

lerobot/
├── common/                  # 通用模块，包含被广泛使用的组件
│   ├── datasets/            # 数据集处理
│   │   ├── lerobot_dataset.py # 核心数据集类 LeRobotDataset 和 MultiLeRobotDataset
│   │   ├── factory.py         # 创建数据集实例的工厂函数
│   │   ├── online_buffer.py   # 在线学习中用于存储经验的回放缓冲区
│   │   ├── transforms.py      # 数据预处理和增强
│   │   └── ...
│   ├── envs/                  # 环境封装
│   │   └── factory.py         # 创建 Gym 环境实例的工厂函数
│   ├── policies/              # 策略（即模型）定义
│   │   ├── act/                 # ACT (Action-Chunking Transformer) 策略
│   │   ├── diffusion/           # Diffusion-based 策略
│   │   ├── tdmpc/               # TD-MPC 策略
│   │   ├── vqbet/               # VQ-BeT 策略
│   │   ├── factory.py         # 创建策略实例的工厂函数
│   │   └── policy_protocol.py # 定义策略接口的协议
│   ├── robot_devices/         # 真实机器人硬件接口
│   │   ├── cameras/             # 相机驱动
│   │   ├── motors/              # 电机驱动
│   │   └── robots/              # 机器人整体抽象
│   └── utils/                 # 通用工具函数
│       ├── utils.py           # 全局工具，如随机种子设置、日志记录等
│       └── io_utils.py        # I/O 相关工具，如视频写入
├── configs/                   # Hydra 配置文件
│   ├── default.yaml           # 默认配置文件
│   ├── env/                   # 环境相关配置
│   ├── policy/                # 策略相关配置
│   └── robot/                 # 机器人相关配置
├── scripts/                   # 可执行脚本
│   └── train.py               # 核心训练脚本
└── templates/                 # 项目模板