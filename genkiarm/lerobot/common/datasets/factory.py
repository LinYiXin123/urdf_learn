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

import torch
from omegaconf import ListConfig, OmegaConf

from lerobot.common.datasets.lerobot_dataset import LeRobotDataset, MultiLeRobotDataset
from lerobot.common.datasets.transforms import get_image_transforms


def resolve_delta_timestamps(cfg):
    """通过使用 `eval`（就地）解析 delta_timestamps 配置键。

    如果未指定 delta_timestamps 或已解析（由其值的数据类型证明），则不执行任何操作。
    """
    delta_timestamps = cfg.training.get("delta_timestamps")
    if delta_timestamps is not None:
        for key in delta_timestamps:
            if isinstance(delta_timestamps[key], str):
                # TODO(rcadene, alexander-soare): remove `eval` to avoid exploit
                cfg.training.delta_timestamps[key] = eval(delta_timestamps[key])


def make_dataset(cfg, split: str = "train") -> LeRobotDataset | MultiLeRobotDataset:
    """创建并返回一个 LeRobotDataset 或 MultiLeRobotDataset。

    此函数根据提供的配置处理单个或多个数据集的创建。
    它还设置图像转换，并根据需要覆盖数据集统计信息。

    参数:
        cfg: LeRobot 配置方案的 Hydra 配置。
        split: 用于创建 LeRobotDataset 实例的数据子集。默认为 "train"。

    返回:
        LeRobotDataset | MultiLeRobotDataset: 创建的数据集。

    引发:
        ValueError: 如果 `cfg.dataset_repo_id` 不是字符串或列表配置。
    """
    """
    Args:
        cfg: A Hydra config as per the LeRobot config scheme.
        split: Select the data subset used to create an instance of LeRobotDataset.
            All datasets hosted on [lerobot](https://huggingface.co/lerobot) contain only one subset: "train".
            Thus, by default, `split="train"` selects all the available data. `split` aims to work like the
            slicer in the hugging face datasets:
            https://huggingface.co/docs/datasets/v2.19.0/loading#slice-splits
            As of now, it only supports `split="train[:n]"` to load the first n frames of the dataset or
            `split="train[n:]"` to load the last n frames. For instance `split="train[:1000]"`.
    Returns:
        The LeRobotDataset.
    """
    if not isinstance(cfg.dataset_repo_id, (str, ListConfig)):
        raise ValueError(
            "Expected cfg.dataset_repo_id to be either a single string to load one dataset or a list of "
            "strings to load multiple datasets."
        )

    # A soft check to warn if the environment matches the dataset. Don't check if we are using a real world env (dora).
    if cfg.env.name != "dora":
        if isinstance(cfg.dataset_repo_id, str):
            dataset_repo_ids = [cfg.dataset_repo_id]  # single dataset
        else:
            dataset_repo_ids = cfg.dataset_repo_id  # multiple datasets

        for dataset_repo_id in dataset_repo_ids:
            if cfg.env.name not in dataset_repo_id:
                logging.warning(
                    f"There might be a mismatch between your training dataset ({dataset_repo_id=}) and your "
                    f"environment ({cfg.env.name=})."
                )

    resolve_delta_timestamps(cfg)

    image_transforms = None
    if cfg.training.image_transforms.enable:
        cfg_tf = cfg.training.image_transforms
        image_transforms = get_image_transforms(
            brightness_weight=cfg_tf.brightness.weight,
            brightness_min_max=cfg_tf.brightness.min_max,
            contrast_weight=cfg_tf.contrast.weight,
            contrast_min_max=cfg_tf.contrast.min_max,
            saturation_weight=cfg_tf.saturation.weight,
            saturation_min_max=cfg_tf.saturation.min_max,
            hue_weight=cfg_tf.hue.weight,
            hue_min_max=cfg_tf.hue.min_max,
            sharpness_weight=cfg_tf.sharpness.weight,
            sharpness_min_max=cfg_tf.sharpness.min_max,
            max_num_transforms=cfg_tf.max_num_transforms,
            random_order=cfg_tf.random_order,
        )

    if isinstance(cfg.dataset_repo_id, str):
        dataset = LeRobotDataset(
            cfg.dataset_repo_id,
            split=split,
            delta_timestamps=cfg.training.get("delta_timestamps"),
            image_transforms=image_transforms,
            video_backend=cfg.video_backend,
        )
    else:
        dataset = MultiLeRobotDataset(
            cfg.dataset_repo_id,
            split=split,
            delta_timestamps=cfg.training.get("delta_timestamps"),
            image_transforms=image_transforms,
            video_backend=cfg.video_backend,
        )

    if cfg.get("override_dataset_stats"):
        for key, stats_dict in cfg.override_dataset_stats.items():
            for stats_type, listconfig in stats_dict.items():
                # example of stats_type: min, max, mean, std
                stats = OmegaConf.to_container(listconfig, resolve=True)
                dataset.stats[key][stats_type] = torch.tensor(stats, dtype=torch.float32)

    return dataset
