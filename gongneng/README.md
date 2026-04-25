# 语音功能目录

这个目录现在有两套可以单独运行的终端工具：

- `voice_to_text_terminal.py`
  适合“录一段，再整体转文字”。
- `realtime_voice_command_terminal.py`
  适合“实时讲话，一边说一边出字”，并且已经预留了语音控制机械臂的桥接接口。

对应的 Windows 启动脚本：

- `start_voice_to_text.bat`
- `start_realtime_voice_command_terminal.bat`

## 先安装依赖

在项目根目录执行：

```powershell
python -m pip install -r gongneng\requirements.txt
```

如果你后面要走本地 Whisper，还需要额外安装 `torch`。

说明：

- `voice_to_text_terminal.py` 用 `sounddevice` 录音，转写可走 OpenAI 或本地 Whisper
- `realtime_voice_command_terminal.py` 主要用 `PyAudio`
- `edge-tts` 和 `pyttsx3` 用于语音回应
- `transformers + accelerate` 用于本地 Whisper 路线

## OpenAI 密钥

如果你要走 OpenAI 实时转写：

```powershell
$env:OPENAI_API_KEY="你的密钥"
```

如果你暂时没有密钥：

- `voice_to_text_terminal.py` 可以直接用 `--engine local`
- `voice_to_text_terminal.py` 默认 `--engine auto`，检测到本地 Whisper 依赖时也会自动回退
- `realtime_voice_command_terminal.py` 也可以走本地 Whisper 路线

## 工具 1：整段录音再转文字

直接运行：

```powershell
python gongneng\voice_to_text_terminal.py
```

常用示例：

```powershell
python gongneng\voice_to_text_terminal.py --seconds 8
python gongneng\voice_to_text_terminal.py --audio-file D:\test.wav
python gongneng\voice_to_text_terminal.py --engine openai --language zh
python gongneng\voice_to_text_terminal.py --engine local --audio-file D:\test.wav
python gongneng\voice_to_text_terminal.py --list-devices
```

说明：

- `--engine auto`：优先 OpenAI；如果没配 `OPENAI_API_KEY`，会尝试本地 Whisper
- `--engine openai`：强制走在线转写
- `--engine local`：强制走本地 Whisper
- `--model`：OpenAI 转写模型，默认 `gpt-4o-mini-transcribe`
- `--local-model`：本地 Whisper 模型，默认 `openai/whisper-small`
- 本地 Whisper 当前直接读取 PCM wav 文件；如果你传的是 `mp3/m4a`，建议先用 `--engine openai` 或先转成 `wav`

## 工具 2：实时讲话边说边出字

直接运行：

```powershell
python gongneng\realtime_voice_command_terminal.py
```

或者用 bat：

```powershell
gongneng\start_realtime_voice_command_terminal.bat
```

默认行为：

- 持续监听麦克风
- 讲话时滚动显示“当前句”预览
- 停顿后固化为最终识别文本
- 把识别到的机械臂语音口令写入桥接文件

### 查看麦克风设备

```powershell
python gongneng\realtime_voice_command_terminal.py --list-devices
```

### 指定设备

```powershell
python gongneng\realtime_voice_command_terminal.py --device 1
```

### 强制走 OpenAI 转写

```powershell
python gongneng\realtime_voice_command_terminal.py --engine openai --language zh
```

### 强制走本地 Whisper

```powershell
python gongneng\realtime_voice_command_terminal.py --engine local --language zh
```

### 开启语音回应

```powershell
python gongneng\realtime_voice_command_terminal.py --speak-reply
```

## 实时版的重要参数

- `--engine auto|openai|local`
- `--command-mode off|rule|ai`
- `--device 设备号`
- `--energy-threshold 数值`
- `--preview-interval 秒数`
- `--silence-timeout 秒数`
- `--save-session-audio`
- `--save-segments`
- `--speak-reply`

## 当前已经预留好的机械臂控制链路

实时版现在已经有这几层：

1. 麦克风采集
2. 实时转写
3. 本地规则口令识别
4. 动作桥接文件输出
5. TTS 回应

实时语音脚本会先把动作写到：

`robot_command_bridge.jsonl`

网页大屏已经可以选择并监听这个桥接文件，再复用 Web Serial 真机控制能力执行新增动作。推荐流程：

1. 先打开 `playground` 网页并点击“连接真实机械臂”
2. 在网页“语音桥接执行”卡片里选择最新的 `robot_command_bridge.jsonl`
3. 点击“开始监听”
4. 再运行实时语音脚本

注意：网页默认只执行“开始监听之后新增的命令”，不会回放旧记录。

完整链路现在是：

1. `语音文本 -> AI 模型理解`
2. `AI 结构化指令 -> 机械臂动作`
3. `robot_command_bridge.jsonl -> 网页真机执行`
4. `动作执行结果 -> 网页日志 / 语音回应`

## 当前已支持识别的一些口令示例

- `恢复零位`
- `回到零位`
- `停止`
- `连接机械臂`
- `断开机械臂`
- `腰部向左 20 度`
- `大臂向前 15 度`
- `小臂向后 10 度`
- `夹爪张开`
- `6号舵机闭合 8 度`

## 输出内容

实时版默认会生成：

- `session.json`
- `realtime_transcript.txt`
- `robot_command_bridge.jsonl`
- `tts/` 目录

如果你加了 `--save-session-audio`，还会生成：

- `session_audio.wav`

如果你加了 `--save-segments`，还会生成：

- `segment_001.wav`
- `segment_002.wav`
- `...`

## 说明

这版是“实时滚动预览 + 停顿后最终确认”的准实时方案，已经适合做语音控制入口。

下一步最自然的是继续打磨：

- 真机安全策略
- 语音识别阈值
- DeepSeek 请求超时和错误兜底

让整条链路更稳。
