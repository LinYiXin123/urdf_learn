#!/usr/bin/env python

# Copyright 2024 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import logging
import os
import os.path as osp
import platform
import random
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Generator

import hydra
import numpy as np
import torch
from omegaconf import DictConfig


def none_or_int(value):
    """将字符串 'None' 转换为 None，否则转换为整数。"""
    if value == "None":
        return None
    return int(value)


def inside_slurm():
    """检查 python 进程是否通过 slurm 启动。"""
    # TODO(rcadene): return False for interactive mode `--pty bash`
    return "SLURM_JOB_ID" in os.environ


def get_safe_torch_device(cfg_device: str, log: bool = False) -> torch.device:
    """根据给定的字符串，返回一个 torch.device，并检查设备是否可用。"""
    match cfg_device:
        case "cuda":
            assert torch.cuda.is_available()
            device = torch.device("cuda")
        case "mps":
            assert torch.backends.mps.is_available()
            device = torch.device("mps")
        case "cpu":
            device = torch.device("cpu")
            if log:
                logging.warning("Using CPU, this will be slow.")
        case _:
            device = torch.device(cfg_device)
            if log:
                logging.warning(f"Using custom {cfg_device} device.")

    return device


def get_global_random_state() -> dict[str, Any]:
    """获取 `random`、`numpy` 和 `torch` 的随机状态。"""
    random_state_dict = {
        "random_state": random.getstate(),
        "numpy_random_state": np.random.get_state(),
        "torch_random_state": torch.random.get_rng_state(),
    }
    if torch.cuda.is_available():
        random_state_dict["torch_cuda_random_state"] = torch.cuda.random.get_rng_state()
    return random_state_dict


def set_global_random_state(random_state_dict: dict[str, Any]):
    """设置 `random`、`numpy` 和 `torch` 的随机状态。

    参数:
        random_state_dict: 一个由 `get_global_random_state` 返回形式的字典。
    """
    random.setstate(random_state_dict["random_state"])
    np.random.set_state(random_state_dict["numpy_random_state"])
    torch.random.set_rng_state(random_state_dict["torch_random_state"])
    if torch.cuda.is_available():
        torch.cuda.random.set_rng_state(random_state_dict["torch_cuda_random_state"])


def set_global_seed(seed):
    """设置种子以保证可复现性。"""
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


@contextmanager
def seeded_context(seed: int) -> Generator[None, None, None]:
    """进入上下文时设置种子，退出时恢复先前的随机状态。

    示例用法:

    ```
    a = random.random()  # 生成一个随机数
    with seeded_context(1337):
        b = random.random()  # 生成另一个随机数
    c = random.random()  # 生成又一个随机数，但与我们从未生成 `b` 时一样
    ```
    """
    random_state_dict = get_global_random_state()
    set_global_seed(seed)
    yield None
    set_global_random_state(random_state_dict)


def init_logging():
    """初始化日志记录。"""
    def custom_format(record):
        dt = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        fnameline = f"{record.pathname}:{record.lineno}"
        message = f"{record.levelname} {dt} {fnameline[-15:]:>15} {record.msg}"
        return message

    logging.basicConfig(level=logging.INFO)

    for handler in logging.root.handlers[:]:
        logging.root.removeHandler(handler)

    formatter = logging.Formatter()
    formatter.format = custom_format
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    logging.getLogger().addHandler(console_handler)


def format_big_number(num, precision=0):
    """格式化大数字（例如 1000 -> 1K）。"""
    suffixes = ["", "K", "M", "B", "T", "Q"]
    divisor = 1000.0

    for suffix in suffixes:
        if abs(num) < divisor:
            return f"{num:.{precision}f}{suffix}"
        num /= divisor

    return num


def _relative_path_between(path1: Path, path2: Path) -> Path:
    """返回相对于 path2 的 path1 路径。"""
    path1 = path1.absolute()
    path2 = path2.absolute()
    try:
        return path1.relative_to(path2)
    except ValueError:  # most likely because path1 is not a subpath of path2
        common_parts = Path(osp.commonpath([path1, path2])).parts
        return Path(
            "/".join([".."] * (len(path2.parts) - len(common_parts)) + list(path1.parts[len(common_parts) :]))
        )


def init_hydra_config(config_path: str, overrides: list[str] | None = None) -> DictConfig:
    """仅根据相关配置文件的路径初始化 Hydra 配置。

    对于配置解析，假定配置文件的父目录是 Hydra 配置目录。
    """
    # TODO(alexander-soare): Resolve configs without Hydra initialization.
    hydra.core.global_hydra.GlobalHydra.instance().clear()
    # Hydra needs a path relative to this file.
    hydra.initialize(
        str(_relative_path_between(Path(config_path).absolute().parent, Path(__file__).absolute().parent)),
        version_base="1.2",
    )
    cfg = hydra.compose(Path(config_path).stem, overrides)
    return cfg


def print_cuda_memory_usage():
    """使用此函数定位和调试内存泄漏。"""
    import gc

    gc.collect()
    # Also clear the cache if you want to fully release the memory
    torch.cuda.empty_cache()
    print("Current GPU Memory Allocated: {:.2f} MB".format(torch.cuda.memory_allocated(0) / 1024**2))
    print("Maximum GPU Memory Allocated: {:.2f} MB".format(torch.cuda.max_memory_allocated(0) / 1024**2))
    print("Current GPU Memory Reserved: {:.2f} MB".format(torch.cuda.memory_reserved(0) / 1024**2))
    print("Maximum GPU Memory Reserved: {:.2f} MB".format(torch.cuda.max_memory_reserved(0) / 1024**2))


def capture_timestamp_utc():
    """捕获 UTC 时间戳。"""
    return datetime.now(timezone.utc)


def say(text, blocking=False):
    """使用系统的文本转语音功能朗读文本。"""
    # Check if mac, linux, or windows.
    if platform.system() == "Darwin":
        cmd = f'say "{text}"'
        if not blocking:
            cmd += " &"
    elif platform.system() == "Linux":
        cmd = f'spd-say "{text}"'
        if blocking:
            cmd += "  --wait"
    elif platform.system() == "Windows":
        # TODO(rcadene): Make blocking option work for Windows
        cmd = (
            'PowerShell -Command "Add-Type -AssemblyName System.Speech; '
            f"(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('{text}')\""
        )

    os.system(cmd)


def log_say(text, play_sounds, blocking=False):
    """记录文本并选择性地朗读。"""
    logging.info(text)

    if play_sounds:
        say(text, blocking)
