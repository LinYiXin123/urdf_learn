#!/usr/bin/env python
"""实时读取 6 个舵机角度，并输出更直观的方向列表。"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
PYSDK_DIR = REPO_ROOT / "playground" / "feetech" / "pysdk"
if str(PYSDK_DIR) not in sys.path:
    sys.path.insert(0, str(PYSDK_DIR))

try:
    from scservo_sdk import (  # type: ignore
        COMM_SUCCESS,
        PacketHandler,
        PortHandler,
        SCS_HIWORD,
        SCS_LOWORD,
        SCS_TOHOST,
    )
except ModuleNotFoundError as exc:
    if exc.name == "serial":
        raise SystemExit(
            "缺少依赖: pyserial\n"
            "请先执行:\n"
            "  python -m pip install pyserial"
        ) from exc
    raise


ADDR_SCS_PRESENT_POSITION = 56
SERVO_RESOLUTION = 4096
DEFAULT_PORT = "COM5"
DEFAULT_BAUDRATE = 1_000_000
DEFAULT_PROTOCOL_END = "auto"
DEFAULT_IDS = [1, 2, 3, 4, 5, 6]
DEFAULT_CENTERS = [2048, 2048, 2048, 2048, 2048, 2048]
DEFAULT_ZERO_RAW = [2002, 2044, 2067, 2082, 2082, 2048]
DEFAULT_HZ = 20.0
DEFAULT_DEADZONE_DEG = 3.0

SERVO_LABELS = {
    1: "腰部",
    2: "肩部",
    3: "肘部",
    4: "腕俯仰",
    5: "腕旋转",
    6: "夹爪",
}

# 这里是默认方向定义。
# 如果你发现某个关节方向反了，直接把正负标签对调即可。
DIRECTION_LABELS = {
    1: ("左", "右"),
    2: ("后", "前"),
    3: ("后", "前"),
    4: ("后", "前"),
    5: ("左", "右"),
    6: ("开", "合"),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="实时输出舵机角度和方向列表")
    parser.add_argument("--port", default=DEFAULT_PORT, help="串口号，默认 COM5")
    parser.add_argument(
        "--baudrate",
        type=int,
        default=DEFAULT_BAUDRATE,
        help="波特率，默认 1000000",
    )
    parser.add_argument(
        "--protocol-end",
        choices=("auto", "0", "1"),
        default=DEFAULT_PROTOCOL_END,
        help="协议端，默认 auto，会自动尝试 1 再尝试 0",
    )
    parser.add_argument(
        "--ids",
        type=int,
        nargs="+",
        default=DEFAULT_IDS,
        help="舵机 ID 列表，默认 1 2 3 4 5 6",
    )
    parser.add_argument(
        "--centers",
        type=int,
        nargs="+",
        default=DEFAULT_CENTERS,
        help="中位值，默认全部 2048",
    )
    parser.add_argument(
        "--zero-raw",
        type=int,
        nargs="+",
        default=DEFAULT_ZERO_RAW,
        help="应视为 0° 的原始回读值，默认就是你当前真机零位",
    )
    parser.add_argument(
        "--hz",
        type=float,
        default=DEFAULT_HZ,
        help="刷新频率，默认 20Hz",
    )
    parser.add_argument(
        "--deadzone-deg",
        type=float,
        default=DEFAULT_DEADZONE_DEG,
        help="小于这个角度就显示为中位，默认 3 度",
    )
    parser.add_argument("--once", action="store_true", help="只读取一次后退出")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if not args.ids:
        raise SystemExit("没有提供舵机 ID")
    if len(args.centers) not in (1, len(args.ids)):
        raise SystemExit("--centers 要么提供 1 个值，要么和 --ids 数量一致")
    if len(args.zero_raw) not in (1, len(args.ids)):
        raise SystemExit("--zero-raw 要么提供 1 个值，要么和 --ids 数量一致")


def expand_centers(ids: list[int], centers: list[int]) -> dict[int, int]:
    if len(centers) == 1:
        return {servo_id: centers[0] for servo_id in ids}
    return {servo_id: center for servo_id, center in zip(ids, centers)}


def expand_zero_raw(ids: list[int], zero_raw: list[int]) -> dict[int, int]:
    if len(zero_raw) == 1:
        return {servo_id: zero_raw[0] for servo_id in ids}
    return {servo_id: raw for servo_id, raw in zip(ids, zero_raw)}


def protocol_candidates(protocol_end: str) -> list[int]:
    if protocol_end == "auto":
        return [1, 0]
    return [int(protocol_end)]


def normalize_signed_ticks(raw_ticks: int, center_ticks: int) -> int:
    delta = raw_ticks - center_ticks
    half_turn = SERVO_RESOLUTION // 2

    while delta > half_turn:
        delta -= SERVO_RESOLUTION
    while delta < -half_turn:
        delta += SERVO_RESOLUTION

    return delta


def ticks_to_deg(ticks: int) -> float:
    return ticks * 360.0 / SERVO_RESOLUTION


def read_servo_state(port_handler: PortHandler, packet_handler, servo_id: int) -> dict[str, object]:
    raw_position_speed, comm_result, error = packet_handler.read4ByteTxRx(
        port_handler,
        servo_id,
        ADDR_SCS_PRESENT_POSITION,
    )

    if comm_result != COMM_SUCCESS:
        return {
            "id": servo_id,
            "ok": False,
            "error": packet_handler.getTxRxResult(comm_result),
        }

    if error != 0:
        return {
            "id": servo_id,
            "ok": False,
            "error": packet_handler.getRxPacketError(error) or f"舵机错误码: {error}",
        }

    position = SCS_LOWORD(raw_position_speed)
    speed_raw = SCS_HIWORD(raw_position_speed)
    speed_signed = SCS_TOHOST(speed_raw, 15)

    return {
        "id": servo_id,
        "ok": True,
        "position": position,
        "speed_signed": speed_signed,
    }


def try_read_cycle(
    port_handler: PortHandler,
    requested_protocol: str,
    servo_ids: list[int],
) -> tuple[int, list[dict[str, object]]]:
    last_protocol = protocol_candidates(requested_protocol)[0]
    last_states: list[dict[str, object]] = []

    for protocol in protocol_candidates(requested_protocol):
        packet_handler = PacketHandler(protocol)
        states = [
            read_servo_state(port_handler, packet_handler, servo_id)
            for servo_id in servo_ids
        ]
        last_protocol = protocol
        last_states = states

        if any(bool(state["ok"]) for state in states):
            return protocol, states

    return last_protocol, last_states


def direction_text(servo_id: int, current_deg: float, deadzone_deg: float) -> str:
    if abs(current_deg) < deadzone_deg:
        return "中位"

    positive_label, negative_label = DIRECTION_LABELS.get(servo_id, ("正向", "反向"))
    return positive_label if current_deg >= 0 else negative_label


def clear_screen() -> None:
    sys.stdout.write("\x1b[2J\x1b[H")
    sys.stdout.flush()


def build_list(
    states: list[dict[str, object]],
    centers: dict[int, int],
    zero_raw_positions: dict[int, int],
    hz: float,
    port: str,
    baudrate: int,
    protocol_end: int,
    deadzone_deg: float,
) -> str:
    lines: list[str] = []
    lines.append(
        f"实时方向列表  端口={port}  波特率={baudrate}  协议端={protocol_end}  刷新率={hz:.1f}Hz"
    )
    lines.append("按 Ctrl+C 停止。\n")
    lines.append(f"{'编号':>2}  {'名称':<8} {'角度(度)':>10}  {'方向':<4}  {'速度':>6}  状态")
    lines.append("-" * 60)

    for state in states:
        servo_id = int(state["id"])
        label = SERVO_LABELS.get(servo_id, f"舵机{servo_id}")

        if not state["ok"]:
            lines.append(
                f"{servo_id:>2}  {label:<8} {'-':>10}  {'-':<4}  {'-':>6}  {state['error']}"
            )
            continue

        raw_ticks = int(state["position"])
        center_ticks = centers[servo_id]
        zero_raw_ticks = zero_raw_positions[servo_id]
        delta_ticks = normalize_signed_ticks(raw_ticks, zero_raw_ticks)
        current_deg = ticks_to_deg(delta_ticks)
        direction = direction_text(servo_id, current_deg, deadzone_deg)
        speed = int(state["speed_signed"])

        lines.append(
            f"{servo_id:>2}  {label:<8} {abs(current_deg):>10.2f}  {direction:<4}  {speed:>6}  正常"
        )

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    validate_args(args)

    centers = expand_centers(args.ids, args.centers)
    zero_raw_positions = expand_zero_raw(args.ids, args.zero_raw)
    interval = 0.0 if args.once else (1.0 / max(args.hz, 0.1))

    port_handler = PortHandler(args.port)

    try:
        opened = port_handler.openPort()
    except Exception as exc:
        print(f"打开串口 {args.port} 失败: {exc}")
        print("如果串口被占用，请先关闭浏览器页面、串口助手或其他读串口脚本。")
        return 1

    if not opened:
        print(f"打开串口 {args.port} 失败。")
        return 1

    try:
        baud_ok = port_handler.setBaudRate(args.baudrate)
        if not baud_ok:
            print(f"设置波特率 {args.baudrate} 失败。")
            return 1

        while True:
            started_at = time.perf_counter()
            active_protocol, states = try_read_cycle(
                port_handler=port_handler,
                requested_protocol=args.protocol_end,
                servo_ids=args.ids,
            )

            clear_screen()
            print(
                build_list(
                    states=states,
                    centers=centers,
                    zero_raw_positions=zero_raw_positions,
                    hz=args.hz,
                    port=args.port,
                    baudrate=args.baudrate,
                    protocol_end=active_protocol,
                    deadzone_deg=args.deadzone_deg,
                )
            )

            if args.once:
                break

            elapsed = time.perf_counter() - started_at
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        if port_handler.is_open:
            port_handler.closePort()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
