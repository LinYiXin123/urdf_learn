# LeRobot 双臂采集流程模板

适用前提：

- 两台机械臂都已经装好
- 两台控制板都能被 Windows 识别
- 两个 UVC 相机都能被 Windows 正常识别
- 已完成舵机 `1–6` ID 设置

## 1. 创建环境

```powershell
conda create -y -n lerobot python=3.12
conda activate lerobot
conda install -y -c conda-forge ffmpeg
pip install "lerobot[feetech]"
```

## 2. 找串口

```powershell
lerobot-find-port
```

记录两个串口：

- `COM_FOLLOWER`
- `COM_LEADER`

## 3. 设置和标定 follower

```powershell
lerobot-setup-motors --robot.type=so100_follower --robot.port=COM_FOLLOWER
lerobot-calibrate --robot.type=so100_follower --robot.port=COM_FOLLOWER --robot.id=follower_arm
```

## 4. 设置和标定 leader

```powershell
lerobot-setup-motors --teleop.type=so100_leader --teleop.port=COM_LEADER
lerobot-calibrate --teleop.type=so100_leader --teleop.port=COM_LEADER --teleop.id=leader_arm
```

## 5. 登录 Hugging Face

```powershell
huggingface-cli login --token <YOUR_TOKEN> --add-to-git-credential
```

## 6. 录制第一批数据

把下面命令里的：

- `COM_FOLLOWER`
- `COM_LEADER`
- `<HF_USER>`

替换成你自己的值。

```powershell
lerobot-record --robot.type=so100_follower --robot.port=COM_FOLLOWER --robot.id=follower_arm --robot.cameras="{ front: {type: opencv, index_or_path: 0, width: 1280, height: 720, fps: 30}, side: {type: opencv, index_or_path: 1, width: 1280, height: 720, fps: 30}}" --teleop.type=so100_leader --teleop.port=COM_LEADER --teleop.id=leader_arm --dataset.repo_id=<HF_USER>/so100_custom_record --dataset.num_episodes=5 --dataset.single_task="pick and place a cube" --display_data=true
```

## 7. 回放第一条数据

```powershell
lerobot-replay --robot.type=so100_follower --robot.port=COM_FOLLOWER --robot.id=follower_arm --dataset.repo_id=<HF_USER>/so100_custom_record --dataset.episode=0
```

## 8. 第一版成功标准

第一版不要求 AI 自主抓取。

只要完成下面 4 件事，就算采集链路跑通：

- 两台臂都能识别
- 两个相机都能采图
- 能录 5 个 episode
- 能回放第 1 个 episode
