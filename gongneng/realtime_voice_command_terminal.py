#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""实时语音转文字 + 机械臂语音指令终端。"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import queue
import re
import sys
import threading
import time
import wave
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_OPENAI_MODEL = "gpt-4o-mini-transcribe"
DEFAULT_LOCAL_MODEL = "openai/whisper-small"
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_CHANNELS = 1
DEFAULT_CHUNK_SIZE = 1024
DEFAULT_ENERGY_THRESHOLD = 520.0
DEFAULT_PREVIEW_INTERVAL = 0.9
DEFAULT_PREVIEW_WINDOW_SECONDS = 4.0
DEFAULT_SILENCE_TIMEOUT = 0.8
DEFAULT_MIN_PHRASE_SECONDS = 0.45
DEFAULT_TTS_VOICE = "zh-CN-XiaoxiaoNeural"
DEFAULT_AI_MODEL = "deepseek-chat"
DEFAULT_AI_BASE_URL = "https://api.deepseek.com"
DEFAULT_AI_API_ENV = "DEEPSEEK_API_KEY"

SERVO_NAME_ALIASES = {
    "腰部": (1, "腰部"),
    "底座": (1, "腰部"),
    "1号舵机": (1, "腰部"),
    "一号舵机": (1, "腰部"),
    "大臂": (2, "大臂"),
    "肩部": (2, "大臂"),
    "2号舵机": (2, "大臂"),
    "二号舵机": (2, "大臂"),
    "小臂": (3, "小臂"),
    "肘部": (3, "小臂"),
    "3号舵机": (3, "小臂"),
    "三号舵机": (3, "小臂"),
    "腕部": (4, "腕部"),
    "腕俯仰": (4, "腕部"),
    "4号舵机": (4, "腕部"),
    "四号舵机": (4, "腕部"),
    "腕旋转": (5, "腕部"),
    "腕滚转": (5, "腕部"),
    "5号舵机": (5, "腕部"),
    "五号舵机": (5, "腕部"),
    "夹爪": (6, "夹爪"),
    "爪子": (6, "夹爪"),
    "6号舵机": (6, "夹爪"),
    "六号舵机": (6, "夹爪"),
}

SPECIAL_COMMAND_PATTERNS = [
    ("restore_zero_pose", ("恢复零位", "恢复0度", "恢复零度", "回零", "回到零位", "回到0度", "复位")),
    ("stop_motion", ("停止动作", "停止机械臂", "急停", "停下", "停止")),
    ("connect_robot", ("连接机械臂", "连接真机", "连接串口")),
    ("disconnect_robot", ("断开机械臂", "断开真机", "断开串口")),
]

DIRECTION_MAP = {
    "向左": "left",
    "左": "left",
    "向右": "right",
    "右": "right",
    "向前": "forward",
    "前": "forward",
    "向后": "backward",
    "后": "backward",
    "张开": "open",
    "打开": "open",
    "闭合": "close",
    "闭上": "close",
}

DIRECTION_LABELS = {
    "left": "向左",
    "right": "向右",
    "forward": "向前",
    "backward": "向后",
    "open": "张开",
    "close": "闭合",
}


def fail(message: str, exit_code: int = 1) -> None:
    print(f"[错误] {message}", file=sys.stderr)
    raise SystemExit(exit_code)


def import_numpy():
    try:
        import numpy as np
    except ImportError:
        fail(
            "缺少 numpy 依赖。\n"
            "请先执行：\n"
            "python -m pip install -r gongneng\\requirements.txt"
        )
    return np


def import_pyaudio():
    try:
        import pyaudio
    except ImportError:
        fail(
            "缺少 PyAudio 依赖。\n"
            "请先执行：\n"
            "python -m pip install -r gongneng\\requirements.txt\n"
            "如果 PyAudio 安装失败，我可以下一步再帮你改成兼容 sounddevice 的版本。"
        )
    return pyaudio


def import_openai_sdk():
    try:
        from openai import OpenAI
    except ImportError:
        fail(
            "缺少 openai 依赖。\n"
            "请先执行：\n"
            "python -m pip install -r gongneng\\requirements.txt"
        )
    return OpenAI


def ensure_openai_api_key() -> None:
    if os.getenv("OPENAI_API_KEY"):
        return

    fail(
        "当前没有检测到 OPENAI_API_KEY。\n"
        "PowerShell 里可以先这样设置：\n"
        '$env:OPENAI_API_KEY="你的密钥"'
    )


def import_local_whisper_stack():
    try:
        import torch
    except ImportError:
        fail(
            "本地 Whisper 需要 torch，但当前没有安装。\n"
            "建议先安装 CPU 版 torch，然后再安装 transformers / accelerate。\n"
            "如果你暂时只想先用在线转写，可以直接设置 OPENAI_API_KEY 后运行 --engine openai。"
        )

    try:
        from transformers import pipeline
    except ImportError:
        fail(
            "缺少 transformers 依赖。\n"
            "请先执行：\n"
            "python -m pip install transformers accelerate"
        )

    return torch, pipeline


def normalize_transcript_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    text = getattr(result, "text", None)
    if isinstance(text, str):
        return text
    if isinstance(result, dict):
        maybe_text = result.get("text")
        if isinstance(maybe_text, str):
            return maybe_text
    return str(result)


def create_output_dir(user_defined_dir: str | None) -> Path:
    if user_defined_dir:
        output_dir = Path(user_defined_dir).expanduser().resolve()
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = (Path(__file__).resolve().parent / "output" / f"realtime_{timestamp}").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def save_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def append_text_line(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as file:
        file.write(text.rstrip() + "\n")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(payload, ensure_ascii=False) + "\n")


def now_text() -> str:
    return datetime.now().strftime("%H:%M:%S")


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def build_level_bar(level: float, threshold: float) -> str:
    safe_threshold = max(1.0, threshold)
    ratio = clamp(level / (safe_threshold * 2.8), 0.0, 1.0)
    total_blocks = 18
    filled_blocks = int(round(ratio * total_blocks))
    return "█" * filled_blocks + "·" * (total_blocks - filled_blocks)


def format_preview_text(text: str, max_length: int = 72) -> str:
    cleaned = " ".join(text.split())
    if len(cleaned) <= max_length:
        return cleaned
    return "..." + cleaned[-(max_length - 3):]


def build_wav_bytes(frames: list[bytes], sample_rate: int, channels: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(frames))
    return buffer.getvalue()


def write_wav_file(path: Path, frames: list[bytes], sample_rate: int, channels: int) -> None:
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(b"".join(frames))


def wav_bytes_to_float_array(wav_bytes: bytes):
    np = import_numpy()
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        frame_bytes = wav_file.readframes(wav_file.getnframes())
    audio_i16 = np.frombuffer(frame_bytes, dtype=np.int16)
    return audio_i16.astype(np.float32) / 32768.0, sample_rate


def detect_installed_module(module_name: str) -> bool:
    try:
        __import__(module_name)
    except ImportError:
        return False
    return True


@dataclass
class AudioFrame:
    data: bytes
    level: float
    timestamp: float


@dataclass
class RuntimeConfig:
    engine: str
    model: str
    language: str | None
    prompt: str | None
    sample_rate: int
    channels: int
    chunk_size: int
    energy_threshold: float
    preview_interval: float
    preview_window_seconds: float
    silence_timeout: float
    min_phrase_seconds: float
    device: int | None
    speak_reply: bool
    tts_engine: str
    tts_voice: str
    command_mode: str
    ai_model: str
    ai_base_url: str
    ai_api_env: str
    save_session_audio: bool
    save_segments: bool


class TerminalRenderer:
    def __init__(self, energy_threshold: float) -> None:
        self.energy_threshold = energy_threshold
        self.last_status_width = 0

    def clear_status_line(self) -> None:
        if self.last_status_width <= 0:
            return
        sys.stdout.write("\r" + (" " * self.last_status_width) + "\r")
        sys.stdout.flush()
        self.last_status_width = 0

    def status(self, level: float, preview_text: str, engine_label: str) -> None:
        bar = build_level_bar(level, self.energy_threshold)
        preview = format_preview_text(preview_text) if preview_text else "等待讲话..."
        line = f"[实时监听] 电平 {bar}  引擎={engine_label}  当前句：{preview}"
        padded_line = "\r" + line
        if len(line) < self.last_status_width:
            padded_line += " " * (self.last_status_width - len(line))
        sys.stdout.write(padded_line)
        sys.stdout.flush()
        self.last_status_width = max(self.last_status_width, len(line))

    def message(self, prefix: str, text: str) -> None:
        self.clear_status_line()
        print(f"{prefix} {text}")

    def info(self, text: str) -> None:
        self.message("[信息]", text)

    def warn(self, text: str) -> None:
        self.message("[提醒]", text)

    def error(self, text: str) -> None:
        self.message("[错误]", text)

    def transcript(self, text: str) -> None:
        self.message(f"[{now_text()}][识别]", text)

    def command(self, text: str) -> None:
        self.message(f"[{now_text()}][指令]", text)

    def reply(self, text: str) -> None:
        self.message(f"[{now_text()}][回应]", text)


class OpenAIRealtimeTranscriber:
    label = "OpenAI"

    def __init__(self, model: str, language: str | None, prompt: str | None) -> None:
        OpenAI = import_openai_sdk()
        ensure_openai_api_key()
        self.client = OpenAI()
        self.model = model
        self.language = language
        self.prompt = prompt

    def transcribe_wav_bytes(self, wav_bytes: bytes, preview: bool = False) -> str:
        request_args: dict[str, Any] = {
            "model": self.model,
            "response_format": "text",
        }
        if self.language:
            request_args["language"] = self.language

        prompt_parts: list[str] = []
        if self.prompt:
            prompt_parts.append(self.prompt)
        if preview:
            prompt_parts.append("这是实时语音预览，请尽量输出当前已听清的中文内容。")
        if prompt_parts:
            request_args["prompt"] = "；".join(prompt_parts)

        with io.BytesIO(wav_bytes) as audio_buffer:
            audio_buffer.name = "realtime_chunk.wav"
            result = self.client.audio.transcriptions.create(
                file=audio_buffer,
                **request_args,
            )

        return normalize_transcript_text(result).strip()


class LocalWhisperRealtimeTranscriber:
    label = "本地Whisper"

    def __init__(self, model: str, language: str | None) -> None:
        torch, pipeline = import_local_whisper_stack()
        self.model = model
        self.language = language

        pipeline_kwargs: dict[str, Any] = {
            "task": "automatic-speech-recognition",
            "model": self.model,
            "chunk_length_s": 15,
        }

        if detect_installed_module("accelerate"):
            pipeline_kwargs["device_map"] = "auto"
        else:
            pipeline_kwargs["device"] = 0 if torch.cuda.is_available() else -1

        self.pipeline = pipeline(**pipeline_kwargs)

    def transcribe_wav_bytes(self, wav_bytes: bytes, preview: bool = False) -> str:
        samples, sample_rate = wav_bytes_to_float_array(wav_bytes)
        generate_kwargs: dict[str, Any] = {"task": "transcribe"}
        if self.language:
            generate_kwargs["language"] = self.language

        result = self.pipeline(
            {"sampling_rate": sample_rate, "raw": samples},
            generate_kwargs=generate_kwargs,
        )
        return normalize_transcript_text(result).strip()


class SpeechResponder:
    def __init__(self, engine: str, output_dir: Path, voice: str) -> None:
        self.engine = engine
        self.output_dir = (output_dir / "tts").resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.voice = voice

    def speak(self, text: str) -> bool:
        if not text.strip():
            return False

        if self.engine in ("auto", "edge") and self._try_edge_tts(text):
            return True

        if self.engine in ("auto", "pyttsx3") and self._try_pyttsx3(text):
            return True

        return False

    def _try_edge_tts(self, text: str) -> bool:
        try:
            import edge_tts
        except ImportError:
            return False

        output_path = self.output_dir / f"reply_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.mp3"

        async def save_audio() -> None:
            communicator = edge_tts.Communicate(text=text, voice=self.voice)
            await communicator.save(str(output_path))

        def runner() -> None:
            try:
                asyncio.run(save_audio())
                try:
                    os.startfile(str(output_path))
                except OSError:
                    pass
            except Exception as exc:  # noqa: BLE001
                print(f"\n[提醒] edge-tts 播报失败：{exc}")

        threading.Thread(target=runner, daemon=True).start()
        return True

    def _try_pyttsx3(self, text: str) -> bool:
        try:
            import pyttsx3
        except ImportError:
            return False

        def runner() -> None:
            try:
                engine = pyttsx3.init()
                engine.say(text)
                engine.runAndWait()
            except Exception as exc:  # noqa: BLE001
                print(f"\n[提醒] pyttsx3 播报失败：{exc}")

        threading.Thread(target=runner, daemon=True).start()
        return True


@dataclass
class CommandResult:
    action: str
    reply_text: str
    payload: dict[str, Any]


class CommandProcessor:
    def __init__(
        self,
        mode: str,
        bridge_path: Path,
        speak_reply: bool,
        tts_engine: str,
        tts_voice: str,
        output_dir: Path,
        ai_model: str,
        ai_base_url: str,
        ai_api_env: str,
    ) -> None:
        self.mode = mode
        self.bridge_path = bridge_path
        self.speak_reply = speak_reply
        self.speech_responder = SpeechResponder(tts_engine, output_dir, tts_voice)
        self.ai_model = ai_model
        self.ai_base_url = ai_base_url.rstrip("/")
        self.ai_api_env = ai_api_env
        self.ai_client = None

        if self.mode == "ai":
            self.ai_client = self._build_ai_client()

    def process(self, text: str) -> CommandResult | None:
        if self.mode == "off":
            return None

        if self.mode == "rule":
            result = self._rule_based_command(text)
        else:
            result = self._ai_command(text)

        if not result:
            return None

        bridge_payload = {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "action": result.action,
            "payload": result.payload,
        }
        append_jsonl(self.bridge_path, bridge_payload)

        if self.speak_reply:
            self.speech_responder.speak(result.reply_text)

        return result

    def _build_ai_client(self):
        api_key = os.getenv(self.ai_api_env) or os.getenv("OPENAI_API_KEY")
        if not api_key:
            fail(
                f"当前选择了 AI 指令模式，但没有检测到密钥。\n"
                f"请先在 PowerShell 设置：\n"
                f'$env:{self.ai_api_env}="你的密钥"'
            )

        OpenAI = import_openai_sdk()
        return OpenAI(api_key=api_key, base_url=self.ai_base_url)

    def _ai_command(self, text: str) -> CommandResult | None:
        if self.ai_client is None:
            return None

        system_prompt = (
            "你是机械臂语音指令解析器。"
            "请把用户中文指令解析成 JSON。"
            "必须输出严格 JSON 对象，不要输出 markdown。"
            "字段包括：recognized(boolean), action(string), servo_id(number|null), "
            "servo_name(string|null), direction(string|null), angle_deg(number|null), "
            "reply_text(string), safety_note(string|null)。"
            "action 可选值：restore_zero_pose, stop_motion, connect_robot, disconnect_robot, servo_move, unknown。"
            "direction 可选值：left,right,forward,backward,open,close。"
            "如果不能确定，就把 action 设为 unknown，recognized 设为 false。"
        )

        user_prompt = (
            "请解析下面这句机械臂语音指令，并输出 JSON：\n"
            f"{text}"
        )

        try:
            response = self.ai_client.chat.completions.create(
                model=self.ai_model,
                response_format={"type": "json_object"},
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.1,
            )
            content = response.choices[0].message.content or "{}"
            payload = json.loads(content)
        except Exception:
            return self._rule_based_command(text)

        if not payload.get("recognized"):
            return self._rule_based_command(text)

        action = str(payload.get("action") or "unknown")
        reply_text = str(payload.get("reply_text") or "已识别到指令，当前先写入桥接文件。")
        normalized_payload = {
            "kind": action,
            "raw_text": text,
            "servo_id": payload.get("servo_id"),
            "servo_name": payload.get("servo_name"),
            "direction": payload.get("direction"),
            "angle_deg": payload.get("angle_deg"),
            "safety_note": payload.get("safety_note"),
        }
        return CommandResult(
            action=action,
            reply_text=reply_text,
            payload=normalized_payload,
        )

    def _rule_based_command(self, text: str) -> CommandResult | None:
        normalized = text.replace("，", "").replace("。", "").replace(" ", "")

        for action, keywords in SPECIAL_COMMAND_PATTERNS:
            if any(keyword in normalized for keyword in keywords):
                reply_map = {
                    "restore_zero_pose": "已识别到恢复 0° 姿态指令，当前先写入桥接文件，稍后我可以继续帮你接真机执行。",
                    "stop_motion": "已识别到停止指令，当前先写入桥接文件。",
                    "connect_robot": "已识别到连接机械臂指令，当前先写入桥接文件。",
                    "disconnect_robot": "已识别到断开机械臂指令，当前先写入桥接文件。",
                }
                return CommandResult(
                    action=action,
                    reply_text=reply_map[action],
                    payload={"kind": action, "raw_text": text},
                )

        match = re.search(
            r"(腰部|底座|大臂|肩部|小臂|肘部|腕部|腕俯仰|腕旋转|腕滚转|夹爪|爪子|[1-6]号舵机|[一二三四五六]号舵机)"
            r".{0,8}?"
            r"(向左|向右|向前|向后|张开|打开|闭合|闭上|左|右|前|后)"
            r".{0,8}?"
            r"(-?\d+(?:\.\d+)?)?",
            normalized,
        )
        if not match:
            return None

        raw_servo_name, raw_direction, raw_angle = match.groups()
        servo_id, servo_name = self._resolve_servo_name(raw_servo_name)
        direction_key = DIRECTION_MAP[raw_direction]
        angle_deg = float(raw_angle) if raw_angle else 15.0

        payload = {
            "kind": "servo_move",
            "servo_id": servo_id,
            "servo_name": servo_name,
            "direction": direction_key,
            "direction_label": DIRECTION_LABELS[direction_key],
            "angle_deg": angle_deg,
            "raw_text": text,
        }
        reply_text = (
            f"已识别到 {servo_name}（{servo_id}号舵机）{DIRECTION_LABELS[direction_key]} "
            f"{angle_deg:.1f}°，当前先写入桥接文件。"
        )
        return CommandResult(
            action="servo_move",
            reply_text=reply_text,
            payload=payload,
        )

    def _resolve_servo_name(self, servo_name: str) -> tuple[int, str]:
        if servo_name in SERVO_NAME_ALIASES:
            return SERVO_NAME_ALIASES[servo_name]

        chinese_servo_map = {
            "一号舵机": "1号舵机",
            "二号舵机": "2号舵机",
            "三号舵机": "3号舵机",
            "四号舵机": "4号舵机",
            "五号舵机": "5号舵机",
            "六号舵机": "6号舵机",
        }
        normalized = chinese_servo_map.get(servo_name, servo_name)
        return SERVO_NAME_ALIASES.get(normalized, (0, servo_name))


class MicrophoneStream:
    def __init__(
        self,
        sample_rate: int,
        channels: int,
        chunk_size: int,
        device: int | None,
        save_session_audio: bool,
        output_dir: Path,
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.chunk_size = chunk_size
        self.device = device
        self.save_session_audio = save_session_audio
        self.output_dir = output_dir
        self.audio_queue: queue.Queue[AudioFrame] = queue.Queue()
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.pyaudio_module = import_pyaudio()
        self.np = import_numpy()
        self.audio_interface = self.pyaudio_module.PyAudio()
        self.stream = None
        self.session_wav_path: Path | None = None
        self.session_writer = None
        self.sample_width = 2

    def start(self) -> None:
        stream_kwargs: dict[str, Any] = {
            "format": self.pyaudio_module.paInt16,
            "channels": self.channels,
            "rate": self.sample_rate,
            "input": True,
            "frames_per_buffer": self.chunk_size,
        }
        if self.device is not None:
            stream_kwargs["input_device_index"] = self.device

        try:
            self.stream = self.audio_interface.open(**stream_kwargs)
        except Exception as exc:  # noqa: BLE001
            fail(f"麦克风打开失败：{exc}")

        if self.save_session_audio:
            self.session_wav_path = self.output_dir / "session_audio.wav"
            self.session_writer = wave.open(str(self.session_wav_path), "wb")
            self.session_writer.setnchannels(self.channels)
            self.session_writer.setsampwidth(self.sample_width)
            self.session_writer.setframerate(self.sample_rate)

        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()

    def _capture_loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                data = self.stream.read(self.chunk_size, exception_on_overflow=False)
            except Exception as exc:  # noqa: BLE001
                if not self.stop_event.is_set():
                    print(f"\n[错误] 麦克风读取失败：{exc}", file=sys.stderr)
                break

            if self.session_writer is not None:
                self.session_writer.writeframes(data)

            audio_array = self.np.frombuffer(data, dtype=self.np.int16).astype(self.np.float32)
            if audio_array.size == 0:
                level = 0.0
            else:
                level = float(self.np.sqrt(self.np.mean(audio_array * audio_array)))

            self.audio_queue.put(AudioFrame(data=data, level=level, timestamp=time.time()))

    def stop(self) -> None:
        self.stop_event.set()

        if self.stream is not None:
            try:
                self.stream.stop_stream()
                self.stream.close()
            except Exception:  # noqa: BLE001
                pass

        if self.thread is not None:
            self.thread.join(timeout=1.2)

        if self.session_writer is not None:
            self.session_writer.close()
            self.session_writer = None

        try:
            self.audio_interface.terminate()
        except Exception:  # noqa: BLE001
            pass

    @classmethod
    def list_devices(cls) -> None:
        pyaudio = import_pyaudio()
        interface = pyaudio.PyAudio()
        try:
            print("可用麦克风设备：")
            for index in range(interface.get_device_count()):
                info = interface.get_device_info_by_index(index)
                max_input_channels = int(info.get("maxInputChannels", 0))
                if max_input_channels <= 0:
                    continue
                default_rate = int(info.get("defaultSampleRate", DEFAULT_SAMPLE_RATE))
                name = info.get("name", f"设备{index}")
                print(f"{index:>2}: {name} | 输入通道={max_input_channels} | 默认采样率={default_rate}")
        finally:
            interface.terminate()


def choose_transcriber(engine: str, openai_model: str, local_model: str, language: str | None, prompt: str | None):
    normalized_engine = engine.lower()
    has_api_key = bool(os.getenv("OPENAI_API_KEY"))
    has_openai = detect_installed_module("openai")
    has_transformers = detect_installed_module("transformers")
    has_torch = detect_installed_module("torch")

    if normalized_engine == "auto":
        if has_openai and has_api_key:
            return OpenAIRealtimeTranscriber(openai_model, language, prompt), "openai"
        if has_transformers and has_torch:
            return LocalWhisperRealtimeTranscriber(local_model, language), "local"
        fail(
            "当前无法自动选择转写引擎。\n"
            "可用方案有两种：\n"
            "1. 安装 openai 并设置 OPENAI_API_KEY；\n"
            "2. 安装 torch + transformers + accelerate，使用本地 Whisper。"
        )

    if normalized_engine == "openai":
        return OpenAIRealtimeTranscriber(openai_model, language, prompt), "openai"

    if normalized_engine == "local":
        return LocalWhisperRealtimeTranscriber(local_model, language), "local"

    fail(f"不支持的引擎：{engine}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="实时语音转文字 + 机械臂指令终端")
    parser.add_argument("--engine", default="auto", choices=("auto", "openai", "local"), help="转写引擎：auto / openai / local，默认 auto")
    parser.add_argument("--model", default=DEFAULT_OPENAI_MODEL, help=f"OpenAI 转写模型，默认 {DEFAULT_OPENAI_MODEL}")
    parser.add_argument("--local-model", default=DEFAULT_LOCAL_MODEL, help=f"本地 Whisper 模型，默认 {DEFAULT_LOCAL_MODEL}")
    parser.add_argument("--language", default="zh", help="语言提示，默认 zh")
    parser.add_argument(
        "--prompt",
        default="机械臂，URDF，舵机，腰部，大臂，小臂，腕部，夹爪，回零，恢复零位，向前，向后，向左，向右。",
        help="给语音识别的提示词，提升专有名词识别率",
    )
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE, help=f"采样率，默认 {DEFAULT_SAMPLE_RATE}")
    parser.add_argument("--channels", type=int, default=DEFAULT_CHANNELS, help=f"声道数，默认 {DEFAULT_CHANNELS}")
    parser.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK_SIZE, help=f"每次从麦克风读取的帧数，默认 {DEFAULT_CHUNK_SIZE}")
    parser.add_argument("--energy-threshold", type=float, default=DEFAULT_ENERGY_THRESHOLD, help=f"静音阈值，默认 {DEFAULT_ENERGY_THRESHOLD}")
    parser.add_argument("--preview-interval", type=float, default=DEFAULT_PREVIEW_INTERVAL, help=f"讲话时刷新识别预览的间隔秒数，默认 {DEFAULT_PREVIEW_INTERVAL}")
    parser.add_argument("--preview-window-seconds", type=float, default=DEFAULT_PREVIEW_WINDOW_SECONDS, help=f"预览识别使用的最近音频窗口秒数，默认 {DEFAULT_PREVIEW_WINDOW_SECONDS}")
    parser.add_argument("--silence-timeout", type=float, default=DEFAULT_SILENCE_TIMEOUT, help=f"连续静音多久后认为一句话结束，默认 {DEFAULT_SILENCE_TIMEOUT}")
    parser.add_argument("--min-phrase-seconds", type=float, default=DEFAULT_MIN_PHRASE_SECONDS, help=f"最短有效讲话秒数，默认 {DEFAULT_MIN_PHRASE_SECONDS}")
    parser.add_argument("--device", type=int, help="输入设备编号，可配合 --list-devices 查看")
    parser.add_argument("--list-devices", action="store_true", help="列出可用麦克风设备后退出")
    parser.add_argument("--command-mode", default="rule", choices=("off", "rule", "ai"), help="指令模式：off 仅转写；rule 本地规则识别；ai 预留给后续模型接入")
    parser.add_argument("--ai-model", default=DEFAULT_AI_MODEL, help=f"AI 指令理解模型，默认 {DEFAULT_AI_MODEL}")
    parser.add_argument("--ai-base-url", default=DEFAULT_AI_BASE_URL, help=f"AI 指令接口基础地址，默认 {DEFAULT_AI_BASE_URL}")
    parser.add_argument("--ai-api-env", default=DEFAULT_AI_API_ENV, help=f"读取 AI 密钥的环境变量名，默认 {DEFAULT_AI_API_ENV}")
    parser.add_argument("--bridge-file", help="动作桥接文件路径；默认写到当前输出目录下的 robot_command_bridge.jsonl")
    parser.add_argument("--speak-reply", action="store_true", help="识别到控制指令后，自动用 TTS 读出回应")
    parser.add_argument("--tts-engine", default="auto", choices=("auto", "edge", "pyttsx3"), help="TTS 引擎：auto 优先 edge-tts，失败回退 pyttsx3")
    parser.add_argument("--tts-voice", default=DEFAULT_TTS_VOICE, help=f"edge-tts 语音名，默认 {DEFAULT_TTS_VOICE}")
    parser.add_argument("--output-dir", help="输出目录；默认会在 gongneng/output/ 下新建实时目录")
    parser.add_argument("--save-session-audio", action="store_true", help="保存整段会话 wav 音频")
    parser.add_argument("--save-segments", action="store_true", help="把每句最终识别前的音频单独保存成 wav")
    return parser.parse_args()


def build_runtime_config(args: argparse.Namespace) -> RuntimeConfig:
    return RuntimeConfig(
        engine=args.engine,
        model=args.model,
        language=args.language,
        prompt=args.prompt,
        sample_rate=args.sample_rate,
        channels=args.channels,
        chunk_size=args.chunk_size,
        energy_threshold=args.energy_threshold,
        preview_interval=args.preview_interval,
        preview_window_seconds=args.preview_window_seconds,
        silence_timeout=args.silence_timeout,
        min_phrase_seconds=args.min_phrase_seconds,
        device=args.device,
        speak_reply=args.speak_reply,
        tts_engine=args.tts_engine,
        tts_voice=args.tts_voice,
        command_mode=args.command_mode,
        ai_model=args.ai_model,
        ai_base_url=args.ai_base_url,
        ai_api_env=args.ai_api_env,
        save_session_audio=args.save_session_audio,
        save_segments=args.save_segments,
    )


def transcribe_safe(renderer: TerminalRenderer, transcriber, wav_bytes: bytes, preview: bool) -> str:
    try:
        return transcriber.transcribe_wav_bytes(wav_bytes, preview=preview).strip()
    except Exception as exc:  # noqa: BLE001
        if preview:
            renderer.warn(f"预览识别失败：{exc}")
        else:
            renderer.error(f"最终识别失败：{exc}")
        return ""


def finalize_phrase(
    phrase_frames: list[bytes],
    phrase_index: int,
    runtime: RuntimeConfig,
    output_dir: Path,
    transcript_path: Path,
    transcriber,
    renderer: TerminalRenderer,
    command_processor: CommandProcessor,
) -> str:
    wav_bytes = build_wav_bytes(phrase_frames, runtime.sample_rate, runtime.channels)
    final_text = transcribe_safe(renderer, transcriber, wav_bytes, preview=False)

    if runtime.save_segments:
        segment_path = output_dir / f"segment_{phrase_index:03d}.wav"
        write_wav_file(segment_path, phrase_frames, runtime.sample_rate, runtime.channels)

    if final_text:
        append_text_line(transcript_path, f"[{now_text()}] {final_text}")
        renderer.transcript(final_text)
        command_result = command_processor.process(final_text)
        if command_result:
            renderer.command(command_result.reply_text)
            if command_result.action == "ai_pending":
                renderer.reply("AI 控制流程接口已留好，等你给我密钥后我继续往下接。")
    else:
        renderer.warn("这句话没有识别出有效文本。")

    return final_text


def run_realtime_loop(
    runtime: RuntimeConfig,
    output_dir: Path,
    bridge_path: Path,
    transcriber,
    renderer: TerminalRenderer,
) -> None:
    transcript_path = output_dir / "realtime_transcript.txt"
    save_json(
        output_dir / "session.json",
        {
            "started_at": datetime.now().isoformat(timespec="seconds"),
            "bridge_file": str(bridge_path),
            "runtime": asdict(runtime),
            "engine_label": getattr(transcriber, "label", runtime.engine),
        },
    )

    mic = MicrophoneStream(
        sample_rate=runtime.sample_rate,
        channels=runtime.channels,
        chunk_size=runtime.chunk_size,
        device=runtime.device,
        save_session_audio=runtime.save_session_audio,
        output_dir=output_dir,
    )
    command_processor = CommandProcessor(
        mode=runtime.command_mode,
        bridge_path=bridge_path,
        speak_reply=runtime.speak_reply,
        tts_engine=runtime.tts_engine,
        tts_voice=runtime.tts_voice,
        output_dir=output_dir,
        ai_model=runtime.ai_model,
        ai_base_url=runtime.ai_base_url,
        ai_api_env=runtime.ai_api_env,
    )

    phrase_frames: list[bytes] = []
    phrase_byte_count = 0
    phrase_started_at = 0.0
    last_voice_at = 0.0
    last_preview_at = 0.0
    last_level = 0.0
    preview_text = ""
    phrase_index = 0
    preview_chunk_limit = max(1, int((runtime.preview_window_seconds * runtime.sample_rate) / runtime.chunk_size))

    mic.start()
    renderer.info(f"实时监听已启动。输出目录：{output_dir}")
    renderer.info(f"当前引擎：{getattr(transcriber, 'label', runtime.engine)} | 指令模式：{runtime.command_mode} | 按 Ctrl+C 结束。")
    renderer.info("默认逻辑是：讲话时滚动预览，停顿后固化为最终文本；识别到机械臂口令后会写入桥接文件。")

    try:
        while True:
            try:
                frame = mic.audio_queue.get(timeout=0.08)
            except queue.Empty:
                frame = None

            now = time.time()

            if frame is not None:
                last_level = frame.level
                is_voice = frame.level >= runtime.energy_threshold

                if is_voice and phrase_started_at <= 0:
                    phrase_started_at = frame.timestamp
                    last_preview_at = 0.0
                    preview_text = ""

                if phrase_started_at > 0:
                    phrase_frames.append(frame.data)
                    phrase_byte_count += len(frame.data)
                    if is_voice:
                        last_voice_at = frame.timestamp

                if phrase_started_at > 0:
                    phrase_seconds = phrase_byte_count / (2 * runtime.channels * runtime.sample_rate)
                    should_preview = phrase_seconds >= runtime.min_phrase_seconds and now - last_preview_at >= runtime.preview_interval
                    if should_preview:
                        preview_frames = phrase_frames[-preview_chunk_limit:]
                        preview_wav = build_wav_bytes(preview_frames, runtime.sample_rate, runtime.channels)
                        maybe_preview = transcribe_safe(renderer, transcriber, preview_wav, preview=True)
                        if maybe_preview:
                            preview_text = maybe_preview
                        last_preview_at = now

            if phrase_started_at > 0 and last_voice_at > 0 and (now - last_voice_at) >= runtime.silence_timeout:
                phrase_seconds = phrase_byte_count / (2 * runtime.channels * runtime.sample_rate)
                if phrase_seconds >= runtime.min_phrase_seconds:
                    phrase_index += 1
                    finalize_phrase(
                        phrase_frames=phrase_frames,
                        phrase_index=phrase_index,
                        runtime=runtime,
                        output_dir=output_dir,
                        transcript_path=transcript_path,
                        transcriber=transcriber,
                        renderer=renderer,
                        command_processor=command_processor,
                    )
                else:
                    renderer.warn("检测到一小段声音，但太短，已忽略。")

                phrase_frames = []
                phrase_byte_count = 0
                phrase_started_at = 0.0
                last_voice_at = 0.0
                last_preview_at = 0.0
                preview_text = ""

            renderer.status(last_level, preview_text, getattr(transcriber, "label", runtime.engine))

    except KeyboardInterrupt:
        renderer.clear_status_line()
        print()
        if phrase_frames:
            phrase_seconds = phrase_byte_count / (2 * runtime.channels * runtime.sample_rate)
            if phrase_seconds >= runtime.min_phrase_seconds:
                phrase_index += 1
                renderer.info("检测到你结束前还有一句未固化，正在做最后一次识别...")
                finalize_phrase(
                    phrase_frames=phrase_frames,
                    phrase_index=phrase_index,
                    runtime=runtime,
                    output_dir=output_dir,
                    transcript_path=transcript_path,
                    transcriber=transcriber,
                    renderer=renderer,
                    command_processor=command_processor,
                )
        renderer.info("实时监听已停止。")
    finally:
        mic.stop()
        renderer.clear_status_line()
        if mic.session_wav_path is not None:
            renderer.info(f"整段会话音频已保存：{mic.session_wav_path}")
        renderer.info(f"转写文本文件：{transcript_path}")
        renderer.info(f"动作桥接文件：{bridge_path}")


def main() -> int:
    args = parse_args()

    if args.list_devices:
        MicrophoneStream.list_devices()
        return 0

    output_dir = create_output_dir(args.output_dir)
    bridge_path = Path(args.bridge_file).expanduser().resolve() if args.bridge_file else output_dir / "robot_command_bridge.jsonl"
    runtime = build_runtime_config(args)
    renderer = TerminalRenderer(runtime.energy_threshold)

    transcriber, resolved_engine = choose_transcriber(
        engine=runtime.engine,
        openai_model=runtime.model,
        local_model=args.local_model,
        language=runtime.language,
        prompt=runtime.prompt,
    )
    runtime.engine = resolved_engine

    run_realtime_loop(
        runtime=runtime,
        output_dir=output_dir,
        bridge_path=bridge_path,
        transcriber=transcriber,
        renderer=renderer,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
