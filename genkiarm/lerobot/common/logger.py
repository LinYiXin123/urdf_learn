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
"""Borrowed from https://github.com/fyhMer/fowm/blob/main/src/logger.py

# TODO(rcadene, alexander-soare): clean this file
"""

import logging
import os
import re
from glob import glob
from pathlib import Path
import shutil
import sys
import torch
from huggingface_hub.constants import SAFETENSORS_SINGLE_FILE
from omegaconf import DictConfig, OmegaConf
from termcolor import colored
from torch.optim import Optimizer
from torch.optim.lr_scheduler import LRScheduler

from lerobot.common.policies.policy_protocol import Policy
from lerobot.common.utils.utils import get_global_random_state, set_global_random_state



import os
import shutil
import logging
from pathlib import Path

# 建议在您的代码初始化部分设置日志记录器
# 如果您已经有日志系统，可以忽略此行
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def create_symlink_or_copy(src, dst):
    """
    尽最大努力创建从 src 到 dst 的符号链接，如果失败则回退到复制。
    此函数被设计为“永不崩溃”，它会捕获并记录所有内部异常，而不会让它们中断程序执行。

    健壮性逻辑：
    1.  **前置检查**：验证源路径是否存在，如果不存在则记录错误并直接返回。
    2.  **强制删除目标**：检查目标路径是否存在。如果存在，会先尝试将其彻底删除，为后续操作扫清障碍。
    3.  **尝试符号链接**：优先尝试创建符号链接，这是最高效的方式。
    4.  **回退到复制**：如果链接失败，则回退到复制操作（能自动区分文件和目录）。
    5.  **最终异常捕获**：即使删除、链接和复制全部失败，也只会记录错误，不会抛出异常。
    """
    src_path = Path(src).resolve()
    dst_path = Path(dst)

    # 1. 健壮性检查：源路径必须存在
    if not src_path.exists():
        logging.error(f"源路径不存在，无法执行操作: '{src_path}'")
        return

    # 2. 关键步骤：在任何操作前，确保目标路径是干净的
    try:
        # os.path.islink() 或 Path.is_symlink() 可以检查路径是否为符号链接 [1, 2, 3, 4]
        if dst_path.is_symlink() or dst_path.exists():
            logging.info(f"目标路径 '{dst_path}' 已存在，将强制删除它。")
            if dst_path.is_dir() and not dst_path.is_symlink():
                shutil.rmtree(dst_path)
            else:
                # .unlink() 可以安全地删除文件或符号链接
                dst_path.unlink()
    except Exception as e:
        logging.error(f"删除已存在的目标 '{dst_path}' 时失败，无法继续操作。错误: {e}")
        return

    # 3. 优先尝试创建符号链接
    try:
        # pathlib 的 symlink_to 能更好地处理跨平台目录链接 [8]
        dst_path.symlink_to(src_path, target_is_directory=src_path.is_dir())
        logging.info(f"成功创建符号链接: '{dst_path}' -> '{src_path}'")
        return  # 操作成功，提前返回
    except (AttributeError, NotImplementedError, OSError) as e:
        logging.warning(f"创建符号链接失败 (错误: '{e}'), 将回退到复制操作。")

    # 4. 如果链接失败，则回退到复制操作（最终保障）
    try:
        if src_path.is_dir():
            # shutil.copytree 用于递归地复制整个目录 [6, 15]
            shutil.copytree(src_path, dst_path)
        else:
            # shutil.copy2 用于复制单个文件并保留元数据 [12]
            # 理论上父目录已存在，但为保险起见再次确认
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src_path, dst_path)
        logging.info(f"成功将 '{src_path}' 复制到 '{dst_path}'")
    except Exception as e:
        # 这是最后的防线，即使复制也失败了，也只记录错误，不让程序崩溃
        logging.error(f"最终的回退复制操作也失败了！源: '{src_path}', 目标: '{dst_path}'. 错误: {e}")

def log_output_dir(out_dir):
    logging.info(colored("Output dir:", "yellow", attrs=["bold"]) + f" {out_dir}")


def cfg_to_group(cfg: DictConfig, return_list: bool = False) -> list[str] | str:
    """Return a group name for logging. Optionally returns group name as list."""
    lst = [
        f"policy:{cfg.policy.name}",
        f"dataset:{cfg.dataset_repo_id}",
        f"env:{cfg.env.name}",
        f"seed:{cfg.seed}",
    ]
    return lst if return_list else "-".join(lst)


def get_wandb_run_id_from_filesystem(checkpoint_dir: Path) -> str:
    # Get the WandB run ID.
    paths = glob(str(checkpoint_dir / "../wandb/latest-run/run-*"))
    if len(paths) != 1:
        raise RuntimeError("Couldn't get the previous WandB run ID for run resumption.")
    match = re.search(r"run-([^\.]+).wandb", paths[0].split("/")[-1])
    if match is None:
        raise RuntimeError("Couldn't get the previous WandB run ID for run resumption.")
    wandb_run_id = match.groups(0)[0]
    return wandb_run_id


class Logger:
    """Primary logger object. Logs either locally or using wandb.

    The logger creates the following directory structure:

    provided_log_dir
    ├── .hydra  # hydra's configuration cache
    ├── checkpoints
    │   ├── specific_checkpoint_name
    │   │   ├── pretrained_model  # Hugging Face pretrained model directory
    │   │   │   ├── ...
    │   │   └── training_state.pth  # optimizer, scheduler, and random states + training step
    |   ├── another_specific_checkpoint_name
    │   │   ├── ...
    |   ├── ...
    │   └── last  # a softlink to the last logged checkpoint
    """

    pretrained_model_dir_name = "pretrained_model"
    training_state_file_name = "training_state.pth"

    def __init__(self, cfg: DictConfig, log_dir: str, wandb_job_name: str | None = None):
        """
        Args:
            log_dir: The directory to save all logs and training outputs to.
            job_name: The WandB job name.
        """
        self._cfg = cfg
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.checkpoints_dir = self.get_checkpoints_dir(log_dir)
        self.last_checkpoint_dir = self.get_last_checkpoint_dir(log_dir)
        self.last_pretrained_model_dir = self.get_last_pretrained_model_dir(log_dir)

        # Set up WandB.
        self._group = cfg_to_group(cfg)
        project = cfg.get("wandb", {}).get("project")
        entity = cfg.get("wandb", {}).get("entity")
        enable_wandb = cfg.get("wandb", {}).get("enable", False)
        run_offline = not enable_wandb or not project
        if run_offline:
            logging.info(colored("Logs will be saved locally.", "yellow", attrs=["bold"]))
            self._wandb = None
        else:
            os.environ["WANDB_SILENT"] = "true"
            import wandb

            wandb_run_id = None
            if cfg.resume:
                wandb_run_id = get_wandb_run_id_from_filesystem(self.checkpoints_dir)

            wandb.init(
                id=wandb_run_id,
                project=project,
                entity=entity,
                name=wandb_job_name,
                notes=cfg.get("wandb", {}).get("notes"),
                tags=cfg_to_group(cfg, return_list=True),
                dir=log_dir,
                config=OmegaConf.to_container(cfg, resolve=True),
                # TODO(rcadene): try set to True
                save_code=False,
                # TODO(rcadene): split train and eval, and run async eval with job_type="eval"
                job_type="train_eval",
                resume="must" if cfg.resume else None,
            )
            print(colored("Logs will be synced with wandb.", "blue", attrs=["bold"]))
            logging.info(f"Track this run --> {colored(wandb.run.get_url(), 'yellow', attrs=['bold'])}")
            self._wandb = wandb

    @classmethod
    def get_checkpoints_dir(cls, log_dir: str | Path) -> Path:
        """Given the log directory, get the sub-directory in which checkpoints will be saved."""
        return Path(log_dir) / "checkpoints"

    @classmethod
    def get_last_checkpoint_dir(cls, log_dir: str | Path) -> Path:
        """Given the log directory, get the sub-directory in which the last checkpoint will be saved."""
        return cls.get_checkpoints_dir(log_dir) / "last"

    @classmethod
    def get_last_pretrained_model_dir(cls, log_dir: str | Path) -> Path:
        """
        Given the log directory, get the sub-directory in which the last checkpoint's pretrained weights will
        be saved.
        """
        return cls.get_last_checkpoint_dir(log_dir) / cls.pretrained_model_dir_name

    def save_model(self, save_dir: Path, policy: Policy, wandb_artifact_name: str | None = None):
        """Save the weights of the Policy model using PyTorchModelHubMixin.

        The weights are saved in a folder called "pretrained_model" under the checkpoint directory.

        Optionally also upload the model to WandB.
        """
        self.checkpoints_dir.mkdir(parents=True, exist_ok=True)
        policy.save_pretrained(save_dir)
        # Also save the full Hydra config for the env configuration.
        OmegaConf.save(self._cfg, save_dir / "config.yaml")
        if self._wandb and not self._cfg.wandb.disable_artifact:
            # note wandb artifact does not accept ":" or "/" in its name
            artifact = self._wandb.Artifact(wandb_artifact_name, type="model")
            artifact.add_file(save_dir / SAFETENSORS_SINGLE_FILE)
            self._wandb.log_artifact(artifact)
        if self.last_checkpoint_dir.exists():
            shutil.rmtree(self.last_checkpoint_dir, ignore_errors=True)

    def save_training_state(
        self,
        save_dir: Path,
        train_step: int,
        optimizer: Optimizer,
        scheduler: LRScheduler | None,
    ):
        """Checkpoint the global training_step, optimizer state, scheduler state, and random state.

        All of these are saved as "training_state.pth" under the checkpoint directory.
        """
        training_state = {
            "step": train_step,
            "optimizer": optimizer.state_dict(),
            **get_global_random_state(),
        }
        if scheduler is not None:
            training_state["scheduler"] = scheduler.state_dict()
        torch.save(training_state, save_dir / self.training_state_file_name)

    def save_checkpoint(
        self,
        train_step: int,
        policy: Policy,
        optimizer: Optimizer,
        scheduler: LRScheduler | None,
        identifier: str,
    ):
        """Checkpoint the model weights and the training state."""
        checkpoint_dir = self.checkpoints_dir / str(identifier)
        wandb_artifact_name = (
            None
            if self._wandb is None
            else f"{self._group.replace(':', '_').replace('/', '_')}-{self._cfg.seed}-{identifier}"
        )
        self.save_model(
            checkpoint_dir / self.pretrained_model_dir_name, policy, wandb_artifact_name=wandb_artifact_name
        )
        self.save_training_state(checkpoint_dir, train_step, optimizer, scheduler)
        create_symlink_or_copy(checkpoint_dir.absolute(), self.last_checkpoint_dir)

    def load_last_training_state(self, optimizer: Optimizer, scheduler: LRScheduler | None) -> int:
        """
        Given the last checkpoint in the logging directory, load the optimizer state, scheduler state, and
        random state, and return the global training step.
        """
        training_state = torch.load(self.last_checkpoint_dir / self.training_state_file_name)
        optimizer.load_state_dict(training_state["optimizer"])
        if scheduler is not None:
            scheduler.load_state_dict(training_state["scheduler"])
        elif "scheduler" in training_state:
            raise ValueError(
                "The checkpoint contains a scheduler state_dict, but no LRScheduler was provided."
            )
        # Small hack to get the expected keys: use `get_global_random_state`.
        set_global_random_state({k: training_state[k] for k in get_global_random_state()})
        return training_state["step"]

    def log_dict(self, d, step, mode="train"):
        assert mode in {"train", "eval"}
        # TODO(alexander-soare): Add local text log.
        if self._wandb is not None:
            for k, v in d.items():
                if not isinstance(v, (int, float, str)):
                    logging.warning(
                        f'WandB logging of key "{k}" was ignored as its type is not handled by this wrapper.'
                    )
                    continue
                self._wandb.log({f"{mode}/{k}": v}, step=step)

    def log_video(self, video_path: str, step: int, mode: str = "train"):
        assert mode in {"train", "eval"}
        assert self._wandb is not None
        wandb_video = self._wandb.Video(video_path, fps=self._cfg.fps, format="mp4")
        self._wandb.log({f"{mode}/video": wandb_video}, step=step)
