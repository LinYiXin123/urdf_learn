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
import importlib

import gymnasium as gym
from omegaconf import DictConfig


def make_env(cfg: DictConfig, n_envs: int | None = None) -> gym.vector.VectorEnv | None:
    """根据评估配置创建一个 gym 向量环境。

    n_envs 可用于覆盖配置中的 eval.batch_size。必须至少为 1。

    参数:
        cfg (DictConfig): Hydra 配置对象。
        n_envs (int | None, optional): 要创建的环境数量。如果提供，则覆盖 `cfg.eval.batch_size`。默认为 None。

    返回:
        gym.vector.VectorEnv | None: 创建的 gym 向量环境，如果 `cfg.env.name` 为 "real_world"，则返回 None。

    引发:
        ValueError: 如果 `n_envs` 小于 1。
        ModuleNotFoundError: 如果所需的环境包未安装。
    """
    if n_envs is not None and n_envs < 1:
        raise ValueError("`n_envs must be at least 1")

    if cfg.env.name == "real_world":
        return

    package_name = f"gym_{cfg.env.name}"

    try:
        importlib.import_module(package_name)
    except ModuleNotFoundError as e:
        print(
            f"{package_name} is not installed. Please install it with `pip install 'lerobot[{cfg.env.name}]'`"
        )
        raise e

    gym_handle = f"{package_name}/{cfg.env.task}"
    gym_kwgs = dict(cfg.env.get("gym", {}))

    if cfg.env.get("episode_length"):
        gym_kwgs["max_episode_steps"] = cfg.env.episode_length

    # batched version of the env that returns an observation of shape (b, c)
    env_cls = gym.vector.AsyncVectorEnv if cfg.eval.use_async_envs else gym.vector.SyncVectorEnv
    env = env_cls(
        [
            lambda: gym.make(gym_handle, disable_env_checker=True, **gym_kwgs)
            for _ in range(n_envs if n_envs is not None else cfg.eval.batch_size)
        ]
    )

    return env
