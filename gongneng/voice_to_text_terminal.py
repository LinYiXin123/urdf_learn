#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""终端语音转文字工具。

支持两种输入方式：
1. 直接用麦克风录音，然后调用 OpenAI 语音转文字。
2. 指定已有音频文件，直接转文字。

支持三种转写引擎：
1. auto：优先 OpenAI，缺少密钥时回退本地 Whisper。
2. openai：强制走 OpenAI 在线转写。
3. local：强制走本地 Whisper。

Windows 示例：
    python gongneng\\voice_to_text_terminal.py
    python gongneng\\voice_to_text_terminal.py --seconds 8
    python gongneng\\voice_to_text_terminal.py --audio-file D:\\test.wav
    python gongneng\\voice_to_text_terminal.py --engine local --audio-file D:\\test.wav
    python gongneng\\voice_to_text_terminal.py --list-devices
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_OPENAI_MODEL = "gpt-4o-mini-transcribe"
DEFAULT_LOCAL_MODEL = "openai/whisper-small"
DEFAULT_SAMPLE_RATE = 16000
DEFAULT_CHANNELS = 1


def fail(message: str, exit_code: int = 1) -> None:
    print(f"[错误] {message}", file=sys.stderr)
    raise SystemExit(exit_code)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="终端语音转文字工具")
    parser.add_argument(
        "--engine",
        default="auto",
        choices=("auto", "openai", "local"),
        help="转写引擎：auto / openai / local，默认 auto",
    )
    parser.add_argument(
        "--audio-file",
        help="已有音频文件路径；如果不填，就直接从麦克风录音",
    )
    parser.add_argument(
        "--seconds",
        type=float,
        default=0,
        help="录音秒数；默认 0，表示按回车开始、按回车结束",
    )
    parser.add_argument(
        "--samplerate",
        type=int,
        default=DEFAULT_SAMPLE_RATE,
        help=f"录音采样率，默认 {DEFAULT_SAMPLE_RATE}",
    )
    parser.add_argument(
        "--channels",
        type=int,
        default=DEFAULT_CHANNELS,
        help=f"录音声道数，默认 {DEFAULT_CHANNELS}",
    )
    parser.add_argument(
        "--device",
        type=int,
        help="输入设备编号，可配合 --list-devices 查看",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="列出可用麦克风设备后退出",
    )
    parser.add_argument(
        "--language",
        help="语言提示，例如 zh / en；中文可填 zh",
    )
    parser.add_argument(
        "--prompt",
        help="可选提示词，用来纠正专有名词或术语",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_OPENAI_MODEL,
        help=f"OpenAI 转写模型，默认 {DEFAULT_OPENAI_MODEL}",
    )
    parser.add_argument(
        "--local-model",
        default=DEFAULT_LOCAL_MODEL,
        help=f"本地 Whisper 模型，默认 {DEFAULT_LOCAL_MODEL}",
    )
    parser.add_argument(
        "--output-dir",
        help="输出目录；默认会在 gongneng/output/时间戳 下生成",
    )
    parser.add_argument(
        "--delete-audio",
        action="store_true",
        help="转写完成后删除录下来的 wav 文件",
    )
    return parser.parse_args()


def ensure_api_key() -> None:
    if os.getenv("OPENAI_API_KEY"):
        return

    fail(
        "没有检测到 OPENAI_API_KEY。\n"
        "请先在你自己的终端里设置，例如 PowerShell：\n"
        '$env:OPENAI_API_KEY="你的密钥"\n'
        "然后再运行这个脚本。"
    )


def import_openai():
    try:
        from openai import OpenAI
    except ImportError:
        fail(
            "缺少 openai 依赖。\n"
            "请先执行：\n"
            "python -m pip install -r gongneng\\requirements.txt"
        )
    return OpenAI


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


def detect_installed_module(module_name: str) -> bool:
    try:
        __import__(module_name)
    except ImportError:
        return False
    return True


def format_proxy_hint() -> str:
    proxy_names = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
    proxy_lines = [f"{name}={os.getenv(name)}" for name in proxy_names if os.getenv(name)]
    if not proxy_lines:
        return "当前没有检测到 HTTP(S) 代理环境变量。"
    return "当前检测到代理环境变量：\n" + "\n".join(proxy_lines)


def import_record_dependencies():
    np = import_numpy()

    try:
        import sounddevice as sd
    except ImportError:
        fail(
            "缺少 sounddevice 依赖。\n"
            "请先执行：\n"
            "python -m pip install -r gongneng\\requirements.txt"
        )

    return np, sd


def create_output_dir(user_defined_dir: str | None) -> Path:
    if user_defined_dir:
        output_dir = Path(user_defined_dir).expanduser().resolve()
    else:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = (Path(__file__).resolve().parent / "output" / timestamp).resolve()

    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def save_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def save_json(path: Path, payload: dict) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_devices() -> None:
    _, sd = import_record_dependencies()
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()
    print("可用音频设备：")
    for index, device in enumerate(devices):
        max_input = int(device.get("max_input_channels", 0))
        hostapi_index = device.get("hostapi", "?")
        hostapi = hostapi_index
        if isinstance(hostapi_index, int) and 0 <= hostapi_index < len(hostapis):
            hostapi = hostapis[hostapi_index].get("name", hostapi_index)
        marker = " [可录音]" if max_input > 0 else ""
        print(f"{index:>2}: {device['name']} | 输入通道={max_input} | hostapi={hostapi}{marker}")


def write_wav(audio_path: Path, audio_data, samplerate: int, channels: int) -> None:
    with wave.open(str(audio_path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)  # int16 = 2 bytes
        wav_file.setframerate(samplerate)
        wav_file.writeframes(audio_data.tobytes())


def record_microphone_audio(
    output_dir: Path,
    samplerate: int,
    channels: int,
    seconds: float,
    device: int | None,
) -> Path:
    np, sd = import_record_dependencies()

    chunks = []
    audio_path = output_dir / "recording.wav"

    def callback(indata, frames, time_info, status):  # noqa: ARG001
        if status:
            print(f"[录音状态] {status}", file=sys.stderr)
        chunks.append(indata.copy())

    stream_kwargs = {
        "samplerate": samplerate,
        "channels": channels,
        "dtype": "int16",
        "callback": callback,
    }
    if device is not None:
        stream_kwargs["device"] = device

    print("\n准备录音。")
    if seconds > 0:
        print(f"将自动录音 {seconds:.1f} 秒...")
    else:
        print("按回车开始录音，再按一次回车结束录音。")
        input()

    started_at = time.time()
    with sd.InputStream(**stream_kwargs):
        if seconds > 0:
            print("录音中...")
            time.sleep(seconds)
        else:
            print("录音中，按回车结束...")
            input()

    if not chunks:
        fail("没有录到任何音频数据，请检查麦克风设备。")

    audio_data = np.concatenate(chunks, axis=0)
    write_wav(audio_path, audio_data, samplerate=samplerate, channels=channels)

    recorded_seconds = len(audio_data) / float(samplerate)
    print(f"录音完成，时长约 {recorded_seconds:.2f} 秒。")
    print(f"音频已保存：{audio_path}")

    save_json(
        output_dir / "recording_meta.json",
        {
            "samplerate": samplerate,
            "channels": channels,
            "seconds_requested": seconds,
            "seconds_recorded": round(recorded_seconds, 3),
            "device": device,
            "started_at": datetime.fromtimestamp(started_at).isoformat(timespec="seconds"),
        },
    )

    return audio_path


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


def read_wav_audio_for_local_whisper(audio_path: Path):
    np = import_numpy()
    try:
        with wave.open(str(audio_path), "rb") as wav_file:
            sample_rate = wav_file.getframerate()
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            frame_bytes = wav_file.readframes(wav_file.getnframes())
    except wave.Error as exc:
        fail(
            f"本地 Whisper 当前仅支持直接读取 PCM wav 文件，无法解析：{audio_path}\n"
            f"底层错误：{exc}\n"
            "如果你是 mp3/m4a 文件，建议先用 --engine openai，或者先转成 wav。"
        )

    if sample_width == 1:
        audio_data = np.frombuffer(frame_bytes, dtype=np.uint8).astype(np.float32)
        audio_data = (audio_data - 128.0) / 128.0
    elif sample_width == 2:
        audio_data = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32)
        audio_data = audio_data / 32768.0
    elif sample_width == 4:
        audio_data = np.frombuffer(frame_bytes, dtype=np.int32).astype(np.float32)
        audio_data = audio_data / 2147483648.0
    else:
        fail(
            f"本地 Whisper 暂不支持 {sample_width * 8} bit 的 wav 文件：{audio_path}\n"
            "建议先转成 16-bit PCM wav，或者改用 --engine openai。"
        )

    if channels > 1:
        audio_data = audio_data.reshape(-1, channels).mean(axis=1)

    return audio_data, sample_rate


class OpenAIFileTranscriber:
    label = "OpenAI"

    def __init__(self, model: str, language: str | None, prompt: str | None) -> None:
        OpenAI = import_openai()
        ensure_api_key()
        self.client = OpenAI()
        self.model = model
        self.language = language
        self.prompt = prompt

    def transcribe_file(self, audio_path: Path) -> str:
        request_args = {
            "model": self.model,
            "response_format": "text",
        }
        if self.language:
            request_args["language"] = self.language
        if self.prompt:
            request_args["prompt"] = self.prompt

        with audio_path.open("rb") as audio_file:
            result = self.client.audio.transcriptions.create(
                file=audio_file,
                **request_args,
            )

        return normalize_transcript_text(result).strip()


class LocalWhisperFileTranscriber:
    label = "本地Whisper"

    def __init__(self, model: str, language: str | None) -> None:
        torch, pipeline = import_local_whisper_stack()
        self.model = model
        self.language = language

        print(
            "\n正在加载本地 Whisper 模型，请稍等..."
            "\n首次运行通常需要联网下载模型文件，CPU 模式下初始化也会更慢一些。"
        )

        pipeline_kwargs: dict[str, Any] = {
            "task": "automatic-speech-recognition",
            "model": self.model,
            "chunk_length_s": 15,
        }

        if detect_installed_module("accelerate"):
            pipeline_kwargs["device_map"] = "auto"
        else:
            pipeline_kwargs["device"] = 0 if torch.cuda.is_available() else -1

        try:
            self.pipeline = pipeline(**pipeline_kwargs)
        except Exception as exc:  # noqa: BLE001
            fail(
                "本地 Whisper 模型初始化失败。\n"
                f"模型：{self.model}\n"
                "这通常是以下几种原因之一：\n"
                "1. 首次运行时无法从 Hugging Face 下载模型；\n"
                "2. 当前代理不可用或不支持 HTTPS；\n"
                "3. 网络环境拦截了 huggingface.co。\n\n"
                f"{format_proxy_hint()}\n\n"
                "建议你优先这样处理：\n"
                "1. 确认代理软件正在运行；\n"
                "2. 如果代理有问题，临时取消 HTTP_PROXY / HTTPS_PROXY 后重试；\n"
                "3. 如果你已经手动下载了模型目录，也可以把目录路径传给 --local-model。\n\n"
                f"底层错误：{exc}"
            )

    def transcribe_file(self, audio_path: Path) -> str:
        samples, sample_rate = read_wav_audio_for_local_whisper(audio_path)
        generate_kwargs: dict[str, Any] = {"task": "transcribe"}
        if self.language:
            generate_kwargs["language"] = self.language

        result = self.pipeline(
            {"sampling_rate": sample_rate, "raw": samples},
            generate_kwargs=generate_kwargs,
        )
        return normalize_transcript_text(result).strip()


def choose_transcriber(
    engine: str,
    openai_model: str,
    local_model: str,
    language: str | None,
    prompt: str | None,
):
    normalized_engine = engine.lower()
    has_api_key = bool(os.getenv("OPENAI_API_KEY"))
    has_openai = detect_installed_module("openai")
    has_transformers = detect_installed_module("transformers")
    has_torch = detect_installed_module("torch")

    if normalized_engine == "auto":
        if has_openai and has_api_key:
            return OpenAIFileTranscriber(openai_model, language, prompt), "openai"
        if has_transformers and has_torch:
            return LocalWhisperFileTranscriber(local_model, language), "local"
        fail(
            "当前无法自动选择转写引擎。\n"
            "可用方案有两种：\n"
            "1. 安装 openai 并设置 OPENAI_API_KEY；\n"
            "2. 安装 torch + transformers + accelerate，使用本地 Whisper。"
        )

    if normalized_engine == "openai":
        return OpenAIFileTranscriber(openai_model, language, prompt), "openai"

    if normalized_engine == "local":
        return LocalWhisperFileTranscriber(local_model, language), "local"

    fail(f"不支持的引擎：{engine}")


def transcribe_audio(audio_path: Path, transcriber) -> str:
    print(f"\n开始转写，请稍等... 当前引擎：{getattr(transcriber, 'label', '未知')}")
    return transcriber.transcribe_file(audio_path)


def main() -> int:
    args = parse_args()

    if args.list_devices:
        list_devices()
        return 0

    output_dir = create_output_dir(args.output_dir)

    if args.audio_file:
        audio_path = Path(args.audio_file).expanduser().resolve()
        if not audio_path.exists():
            fail(f"音频文件不存在：{audio_path}")
        print(f"使用现有音频文件：{audio_path}")
    else:
        audio_path = record_microphone_audio(
            output_dir=output_dir,
            samplerate=args.samplerate,
            channels=args.channels,
            seconds=args.seconds,
            device=args.device,
        )

    transcriber, resolved_engine = choose_transcriber(
        engine=args.engine,
        openai_model=args.model,
        local_model=args.local_model,
        language=args.language,
        prompt=args.prompt,
    )

    transcript_text = transcribe_audio(
        audio_path=audio_path,
        transcriber=transcriber,
    )

    transcript_path = output_dir / "transcript.txt"
    save_text(transcript_path, transcript_text)

    save_json(
        output_dir / "session.json",
        {
            "audio_path": str(audio_path),
            "transcript_path": str(transcript_path),
            "engine_requested": args.engine,
            "engine_resolved": resolved_engine,
            "engine_label": getattr(transcriber, "label", resolved_engine),
            "openai_model": args.model,
            "local_model": args.local_model,
            "language": args.language,
            "prompt": args.prompt,
            "audio_source": "file" if args.audio_file else "microphone",
            "generated_at": datetime.now().isoformat(timespec="seconds"),
        },
    )

    print("\n转写结果：")
    print("-" * 60)
    print(transcript_text or "[空结果]")
    print("-" * 60)
    print(f"文字已保存：{transcript_path}")

    if args.delete_audio and not args.audio_file:
        try:
            audio_path.unlink(missing_ok=True)
            print(f"已删除临时录音：{audio_path}")
        except OSError:
            pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
