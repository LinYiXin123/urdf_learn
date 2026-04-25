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
from pathlib import Path
from typing import Callable

import datasets
import torch
import torch.utils

from lerobot.common.datasets.compute_stats import aggregate_stats
from lerobot.common.datasets.utils import (
    calculate_episode_data_index,
    load_episode_data_index,
    load_hf_dataset,
    load_info,
    load_previous_and_future_frames,
    load_stats,
    load_videos,
    reset_episode_index,
)
from lerobot.common.datasets.video_utils import VideoFrame, load_from_videos

# For maintainers, see lerobot/common/datasets/push_dataset_to_hub/CODEBASE_VERSION.md
CODEBASE_VERSION = "v1.6"
DATA_DIR = Path(os.environ["DATA_DIR"]) if "DATA_DIR" in os.environ else None


class LeRobotDataset(torch.utils.data.Dataset):
    """一个 LeRobot 数据集，可以从本地或 Hugging Face Hub 加载。

    该类处理从 Hugging Face Hub 或本地缓存加载数据集，并提供用于访问样本、元数据和应用图像转换的实用功能。
    它支持基于图像和基于视频的数据集。
    """
    def __init__(
        self,
        repo_id: str,
        root: Path | None = DATA_DIR,
        split: str = "train",
        image_transforms: Callable | None = None,
        delta_timestamps: dict[list[float]] | None = None,
        video_backend: str | None = None,
    ):
        """初始化 LeRobotDataset。

        参数:
            repo_id (str): Hugging Face Hub 上的仓库 ID。
            root (Path | None, optional): 数据集缓存的根目录。默认为 `DATA_DIR` 环境变量。
            split (str, optional): 要加载的数据集拆分（例如，“train”、“val”、“test”）。默认为 "train"。
            image_transforms (Callable | None, optional): 应用于图像样本的可调用转换。默认为 None。
            delta_timestamps (dict[list[float]] | None, optional): 用于加载先前和未来帧的时间戳偏移量字典。默认为 None。
            video_backend (str | None, optional): 用于视频解码的后端。默认为 None，将使用 "pyav"。
        """
        super().__init__()
        self.repo_id = repo_id
        self.root = root
        self.split = split
        self.image_transforms = image_transforms
        self.delta_timestamps = delta_timestamps
        # load data from hub or locally when root is provided
        # TODO(rcadene, aliberts): implement faster transfer
        # https://huggingface.co/docs/huggingface_hub/en/guides/download#faster-downloads
        self.hf_dataset = load_hf_dataset(repo_id, CODEBASE_VERSION, root, split)
        if split == "train":
            self.episode_data_index = load_episode_data_index(repo_id, CODEBASE_VERSION, root)
        else:
            self.episode_data_index = calculate_episode_data_index(self.hf_dataset)
            self.hf_dataset = reset_episode_index(self.hf_dataset)
        self.stats = load_stats(repo_id, CODEBASE_VERSION, root)
        self.info = load_info(repo_id, CODEBASE_VERSION, root)
        if self.video:
            self.videos_dir = load_videos(repo_id, CODEBASE_VERSION, root)
            self.video_backend = video_backend if video_backend is not None else "pyav"

    @property
    def fps(self) -> int:
        """数据收集期间使用的每秒帧数。"""
        return self.info["fps"]

    @property
    def video(self) -> bool:
        """如果此数据集从 mp4 文件加载视频帧，则返回 True。
        如果仅从 png 文件加载图像，则返回 False。
        """
        return self.info.get("video", False)

    @property
    def features(self) -> datasets.Features:
        return self.hf_dataset.features

    @property
    def camera_keys(self) -> list[str]:
        """用于从相机访问图像和视频流的键。"""
        keys = []
        for key, feats in self.hf_dataset.features.items():
            if isinstance(feats, (datasets.Image, VideoFrame)):
                keys.append(key)
        return keys

    @property
    def video_frame_keys(self) -> list[str]:
        """用于访问需要解码为图像的视频帧的键。

        注意：如果数据集仅包含图像，则此列表为空；
        如果数据集仅包含视频，则等于 `self.cameras`；
        在混合图像/视频数据集的情况下，它甚至可以是 `self.cameras` 的子集。
        """
        video_frame_keys = []
        for key, feats in self.hf_dataset.features.items():
            if isinstance(feats, VideoFrame):
                video_frame_keys.append(key)
        return video_frame_keys

    @property
    def num_samples(self) -> int:
        """样本/帧的数量。"""
        return len(self.hf_dataset)

    @property
    def num_episodes(self) -> int:
        """回合的数量。"""
        return len(self.hf_dataset.unique("episode_index"))

    @property
    def tolerance_s(self) -> float:
        """用于在加载的帧的时间戳与请求的帧不够接近时丢弃它们的容差（以秒为单位）。
        仅在提供 `delta_timestamps` 或从 mp4 文件加载视频帧时使用。
        """
        # 1e-4 to account for possible numerical error
        return 1 / self.fps - 1e-4

    def __len__(self):
        return self.num_samples

    def __getitem__(self, idx):
        """按索引检索一个样本。

        此方法处理从数据集中获取项目、应用时间戳增量以加载
        附加帧、从视频文件解码帧以及应用图像转换。

        参数:
            idx (int): 要检索的样本的索引。

        返回:
            dict: 包含样本数据的字典。
        """
        item = self.hf_dataset[idx]

        if self.delta_timestamps is not None:
            item = load_previous_and_future_frames(
                item,
                self.hf_dataset,
                self.episode_data_index,
                self.delta_timestamps,
                self.tolerance_s,
            )

        if self.video:
            item = load_from_videos(
                item,
                self.video_frame_keys,
                self.videos_dir,
                self.tolerance_s,
                self.video_backend,
            )

        if self.image_transforms is not None:
            for cam in self.camera_keys:
                item[cam] = self.image_transforms(item[cam])

        return item

    def __repr__(self):
        return (
            f"{self.__class__.__name__}(\n"
            f"  Repository ID: '{self.repo_id}',\n"
            f"  Split: '{self.split}',\n"
            f"  Number of Samples: {self.num_samples},\n"
            f"  Number of Episodes: {self.num_episodes},\n"
            f"  Type: {'video (.mp4)' if self.video else 'image (.png)'},\n"
            f"  Recorded Frames per Second: {self.fps},\n"
            f"  Camera Keys: {self.camera_keys},\n"
            f"  Video Frame Keys: {self.video_frame_keys if self.video else 'N/A'},\n"
            f"  Transformations: {self.image_transforms},\n"
            f"  Codebase Version: {self.info.get('codebase_version', '< v1.6')},\n"
            f")"
        )

    @classmethod
    def from_preloaded(
        cls,
        repo_id: str = "from_preloaded",
        root: Path | None = None,
        split: str = "train",
        transform: callable = None,
        delta_timestamps: dict[list[float]] | None = None,
        # additional preloaded attributes
        hf_dataset=None,
        episode_data_index=None,
        stats=None,
        info=None,
        videos_dir=None,
        video_backend=None,
    ) -> "LeRobotDataset":
        """从现有数据和属性创建 LeRobotDataset，而不是从文件系统加载。

        在将原始数据转换为 LeRobotDataset 以便在文件系统上保存数据集或上传到 Hub 之前，此方法特别有用。

        注意：元数据属性（如 `repo_id`、`version`、`root` 等）是可选的，并且根据返回数据集的下游用途，可能没有意义。

        返回:
            LeRobotDataset: 一个从预加载数据初始化的 LeRobotDataset 实例。
        """
        # create an empty object of type LeRobotDataset
        obj = cls.__new__(cls)
        obj.repo_id = repo_id
        obj.root = root
        obj.split = split
        obj.image_transforms = transform
        obj.delta_timestamps = delta_timestamps
        obj.hf_dataset = hf_dataset
        obj.episode_data_index = episode_data_index
        obj.stats = stats
        obj.info = info if info is not None else {}
        obj.videos_dir = videos_dir
        obj.video_backend = video_backend if video_backend is not None else "pyav"
        return obj


class MultiLeRobotDataset(torch.utils.data.Dataset):
    """一个由多个底层 `LeRobotDataset` 组成的数据集。

    底层的 `LeRobotDataset` 被有效地连接起来，并且该类采用了 `LeRobotDataset` 的大部分 API 结构。
    """

    def __init__(
        self,
        repo_ids: list[str],
        root: Path | None = DATA_DIR,
        split: str = "train",
        image_transforms: Callable | None = None,
        delta_timestamps: dict[list[float]] | None = None,
        video_backend: str | None = None,
    ):
        """初始化 MultiLeRobotDataset。

        参数:
            repo_ids (list[str]): 要加载的 Hugging Face Hub 上的仓库 ID 列表。
            root (Path | None, optional): 数据集缓存的根目录。默认为 `DATA_DIR` 环境变量。
            split (str, optional): 要加载的数据集拆分。默认为 "train"。
            image_transforms (Callable | None, optional): 应用于图像样本的可调用转换。默认为 None。
            delta_timestamps (dict[list[float]] | None, optional): 用于加载先前和未来帧的时间戳偏移量字典。默认为 None。
            video_backend (str | None, optional): 用于视频解码的后端。默认为 None。

        引发:
            ValueError: 如果子数据集之间的 `info` 属性不一致。
            RuntimeError: 如果多个数据集之间没有共同的键。
        """
        super().__init__()
        self.repo_ids = repo_ids
        # Construct the underlying datasets passing everything but `transform` and `delta_timestamps` which
        # are handled by this class.
        self._datasets = [
            LeRobotDataset(
                repo_id,
                root=root,
                split=split,
                delta_timestamps=delta_timestamps,
                image_transforms=image_transforms,
                video_backend=video_backend,
            )
            for repo_id in repo_ids
        ]
        # Check that some properties are consistent across datasets. Note: We may relax some of these
        # consistency requirements in future iterations of this class.
        for repo_id, dataset in zip(self.repo_ids, self._datasets, strict=True):
            if dataset.info != self._datasets[0].info:
                raise ValueError(
                    f"Detected a mismatch in dataset info between {self.repo_ids[0]} and {repo_id}. This is "
                    "not yet supported."
                )
        # Disable any data keys that are not common across all of the datasets. Note: we may relax this
        # restriction in future iterations of this class. For now, this is necessary at least for being able
        # to use PyTorch's default DataLoader collate function.
        self.disabled_data_keys = set()
        intersection_data_keys = set(self._datasets[0].hf_dataset.features)
        for dataset in self._datasets:
            intersection_data_keys.intersection_update(dataset.hf_dataset.features)
        if len(intersection_data_keys) == 0:
            raise RuntimeError(
                "Multiple datasets were provided but they had no keys common to all of them. The "
                "multi-dataset functionality currently only keeps common keys."
            )
        for repo_id, dataset in zip(self.repo_ids, self._datasets, strict=True):
            extra_keys = set(dataset.hf_dataset.features).difference(intersection_data_keys)
            logging.warning(
                f"keys {extra_keys} of {repo_id} were disabled as they are not contained in all the "
                "other datasets."
            )
            self.disabled_data_keys.update(extra_keys)

        self.root = root
        self.split = split
        self.image_transforms = image_transforms
        self.delta_timestamps = delta_timestamps
        self.stats = aggregate_stats(self._datasets)

    @property
    def repo_id_to_index(self):
        """返回一个从数据集 repo_id 到此类自动创建的数据集索引的映射。

        此索引作为数据键合并到 `__getitem__` 返回的字典中。
        """
        return {repo_id: i for i, repo_id in enumerate(self.repo_ids)}

    @property
    def repo_index_to_id(self):
        """返回 repo_id_to_index 的逆映射。"""
        return {v: k for k, v in self.repo_id_to_index}

    @property
    def fps(self) -> int:
        """数据收集期间使用的每秒帧数。

        注意：目前，这依赖于 `__init__` 中的检查，以确保所有子数据集具有相同的 info。
        """
        return self._datasets[0].info["fps"]

    @property
    def video(self) -> bool:
        """如果此数据集从 mp4 文件加载视频帧，则返回 True。

        如果仅从 png 文件加载图像，则返回 False。

        注意：目前，这依赖于 `__init__` 中的检查，以确保所有子数据集具有相同的 info。
        """
        return self._datasets[0].info.get("video", False)

    @property
    def features(self) -> datasets.Features:
        features = {}
        for dataset in self._datasets:
            features.update({k: v for k, v in dataset.features.items() if k not in self.disabled_data_keys})
        return features

    @property
    def camera_keys(self) -> list[str]:
        """用于从相机访问图像和视频流的键。"""
        keys = []
        for key, feats in self.features.items():
            if isinstance(feats, (datasets.Image, VideoFrame)):
                keys.append(key)
        return keys

    @property
    def video_frame_keys(self) -> list[str]:
        """用于访问需要解码为图像的视频帧的键。

        注意：如果数据集仅包含图像，则此列表为空；
        如果数据集仅包含视频，则等于 `self.cameras`；
        在混合图像/视频数据集的情况下，它甚至可以是 `self.cameras` 的子集。
        """
        video_frame_keys = []
        for key, feats in self.features.items():
            if isinstance(feats, VideoFrame):
                video_frame_keys.append(key)
        return video_frame_keys

    @property
    def num_samples(self) -> int:
        """样本/帧的数量。"""
        return sum(d.num_samples for d in self._datasets)

    @property
    def num_episodes(self) -> int:
        """回合的数量。"""
        return sum(d.num_episodes for d in self._datasets)

    @property
    def tolerance_s(self) -> float:
        """用于在加载的帧的时间戳与请求的帧不够接近时丢弃它们的容差（以秒为单位）。
        仅在提供 `delta_timestamps` 或从 mp4 文件加载视频帧时使用。
        """
        # 1e-4 to account for possible numerical error
        return 1 / self.fps - 1e-4

    def __len__(self):
        return self.num_samples

    def __getitem__(self, idx: int) -> dict[str, torch.Tensor]:
        """按索引检索一个样本。

        此方法确定要从哪个子数据集中获取项目，检索该项目，
        添加一个 `dataset_index` 键，并删除在所有子数据集中不通用的键。

        参数:
            idx (int): 要检索的样本的索引。

        返回:
            dict[str, torch.Tensor]: 包含样本数据的字典。

        引发:
            IndexError: 如果索引超出范围。
            AssertionError: 如果在找到正确的子数据集之前循环完成。
        """
        if idx >= len(self):
            raise IndexError(f"Index {idx} out of bounds.")
        # Determine which dataset to get an item from based on the index.
        start_idx = 0
        dataset_idx = 0
        for dataset in self._datasets:
            if idx >= start_idx + dataset.num_samples:
                start_idx += dataset.num_samples
                dataset_idx += 1
                continue
            break
        else:
            raise AssertionError("We expect the loop to break out as long as the index is within bounds.")
        item = self._datasets[dataset_idx][idx - start_idx]
        item["dataset_index"] = torch.tensor(dataset_idx)
        for data_key in self.disabled_data_keys:
            if data_key in item:
                del item[data_key]

        return item

    def __repr__(self):
        return (
            f"{self.__class__.__name__}(\n"
            f"  Repository IDs: '{self.repo_ids}',\n"
            f"  Split: '{self.split}',\n"
            f"  Number of Samples: {self.num_samples},\n"
            f"  Number of Episodes: {self.num_episodes},\n"
            f"  Type: {'video (.mp4)' if self.video else 'image (.png)'},\n"
            f"  Recorded Frames per Second: {self.fps},\n"
            f"  Camera Keys: {self.camera_keys},\n"
            f"  Video Frame Keys: {self.video_frame_keys if self.video else 'N/A'},\n"
            f"  Transformations: {self.image_transforms},\n"
            f")"
        )
