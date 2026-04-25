#!/usr/bin/env python
"""Realtime monitor for Feetech ST/STS servos on a shared bus.

Default setup matches this repository:
- Port: COM5
- Baudrate: 1000000
- Servo IDs: 1..6
- Protocol end: auto (tries 1, then 0 if needed)

Examples:
    python scripts/read_servo_angles.py
    python scripts/read_servo_angles.py --once
    python scripts/read_servo_angles.py --port COM5 --hz 20
    python scripts/read_servo_angles.py --protocol-end 0
"""

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
            "Missing dependency: pyserial\n"
            "Install it with:\n"
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
SERVO_LABELS = {
    1: "腰部",
    2: "肩部",
    3: "肘部",
    4: "腕俯仰",
    5: "腕旋转",
    6: "夹爪",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Realtime readout for 6 Feetech bus servos."
    )
    parser.add_argument("--port", default=DEFAULT_PORT, help="Serial port, default COM5")
    parser.add_argument(
        "--baudrate",
        type=int,
        default=DEFAULT_BAUDRATE,
        help="Serial baudrate, default 1000000",
    )
    parser.add_argument(
        "--protocol-end",
        choices=("auto", "0", "1"),
        default=DEFAULT_PROTOCOL_END,
        help="Protocol end: auto, 0, or 1. Default: auto.",
    )
    parser.add_argument(
        "--ids",
        type=int,
        nargs="+",
        default=DEFAULT_IDS,
        help="Servo IDs to poll, default: 1 2 3 4 5 6",
    )
    parser.add_argument(
        "--centers",
        type=int,
        nargs="+",
        default=DEFAULT_CENTERS,
        help="Center position per servo for signed angle output, default all 2048",
    )
    parser.add_argument(
        "--zero-raw",
        type=int,
        nargs="+",
        default=DEFAULT_ZERO_RAW,
        help="Raw positions that should be treated as 0 degrees, default matches current robot zero pose",
    )
    parser.add_argument(
        "--hz",
        type=float,
        default=10.0,
        help="Refresh rate in Hz, default 10",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Read once and exit",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if len(args.ids) == 0:
        raise SystemExit("No servo IDs were provided.")
    if len(args.centers) not in (1, len(args.ids)):
        raise SystemExit("--centers must provide either 1 value or one value per servo ID.")
    if len(args.zero_raw) not in (1, len(args.ids)):
        raise SystemExit("--zero-raw must provide either 1 value or one value per servo ID.")


def expand_centers(ids: list[int], centers: list[int]) -> dict[int, int]:
    if len(centers) == 1:
        return {servo_id: centers[0] for servo_id in ids}
    return {servo_id: center for servo_id, center in zip(ids, centers)}


def expand_zero_raw(ids: list[int], zero_raw: list[int]) -> dict[int, int]:
    if len(zero_raw) == 1:
        return {servo_id: zero_raw[0] for servo_id in ids}
    return {servo_id: raw for servo_id, raw in zip(ids, zero_raw)}


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


def ticks_to_rad(ticks: int) -> float:
    return math.radians(ticks_to_deg(ticks))


def read_servo_state(
    port_handler: PortHandler,
    packet_handler,
    servo_id: int,
) -> dict[str, float | int | str | None]:
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
            "error": packet_handler.getRxPacketError(error) or f"Servo error code: {error}",
        }

    position = SCS_LOWORD(raw_position_speed)
    speed_raw = SCS_HIWORD(raw_position_speed)
    speed_signed = SCS_TOHOST(speed_raw, 15)

    return {
        "id": servo_id,
        "ok": True,
        "position": position,
        "speed_raw": speed_raw,
        "speed_signed": speed_signed,
    }


def protocol_candidates(protocol_end: str) -> list[int]:
    if protocol_end == "auto":
        return [1, 0]
    return [int(protocol_end)]


def try_read_cycle(
    port_handler: PortHandler,
    requested_protocol: str,
    servo_ids: list[int],
) -> tuple[int, list[dict[str, float | int | str | None]]]:
    last_protocol = protocol_candidates(requested_protocol)[0]
    last_states: list[dict[str, float | int | str | None]] = []

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


def build_table(
    states: list[dict[str, float | int | str | None]],
    centers: dict[int, int],
    zero_raw_positions: dict[int, int],
    hz: float,
    port: str,
    baudrate: int,
    protocol_end: int,
) -> str:
    lines = []
    lines.append(
        f"实时舵机监视器  端口={port}  波特率={baudrate}  协议端={protocol_end}  刷新率={hz:.1f}Hz"
    )
    lines.append("按 Ctrl+C 停止。\n")
    lines.append(
        f"{'编号':>2}  {'名称':<8} {'原始值':>6}  {'中位':>6}  {'差值':>6}  {'绝对角':>9}  {'当前角':>10}  {'当前弧度':>10}  {'速度':>6}  状态"
    )
    lines.append("-" * 100)

    for state in states:
        servo_id = int(state["id"])
        label = SERVO_LABELS.get(servo_id, f"servo_{servo_id}")
        if not state["ok"]:
            lines.append(
                f"{servo_id:>2}  {label:<8} {'-':>6}  {'-':>6}  {'-':>6}  {'-':>9}  {'-':>10}  {'-':>10}  {'-':>6}  {state['error']}"
            )
            continue

        raw_ticks = int(state["position"])
        center_ticks = centers[servo_id]
        zero_raw_ticks = zero_raw_positions[servo_id]
        delta_ticks = normalize_signed_ticks(raw_ticks, zero_raw_ticks)
        raw_deg = ticks_to_deg(raw_ticks)
        current_deg = ticks_to_deg(delta_ticks)
        current_rad = ticks_to_rad(delta_ticks)
        speed_signed = int(state["speed_signed"])

        lines.append(
            f"{servo_id:>2}  {label:<8} {raw_ticks:>6}  {center_ticks:>6}  {delta_ticks:>6}  {raw_deg:>9.2f}  {current_deg:>10.2f}  {current_rad:>10.4f}  {speed_signed:>6}  正常"
        )

    return "\n".join(lines)


def clear_screen() -> None:
    if os.name == "nt":
        sys.stdout.write("\x1b[2J\x1b[H")
        sys.stdout.flush()
    else:
        sys.stdout.write("\x1b[2J\x1b[H")
        sys.stdout.flush()


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
        print(f"Failed to open port {args.port}: {exc}")
        print("If the port is busy, close the browser controller, serial monitor, or any other app using COM5.")
        return 1

    if not opened:
        print(f"Failed to open port {args.port}.")
        return 1

    try:
        try:
            baud_ok = port_handler.setBaudRate(args.baudrate)
        except Exception as exc:
            print(f"Failed to configure baudrate {args.baudrate}: {exc}")
            return 1

        if not baud_ok:
            print(f"Failed to set baudrate {args.baudrate}.")
            return 1

        while True:
            loop_start = time.perf_counter()
            active_protocol, states = try_read_cycle(
                port_handler=port_handler,
                requested_protocol=args.protocol_end,
                servo_ids=args.ids,
            )

            clear_screen()
            print(
                build_table(
                    states=states,
                    centers=centers,
                    zero_raw_positions=zero_raw_positions,
                    hz=args.hz,
                    port=args.port,
                    baudrate=args.baudrate,
                    protocol_end=active_protocol,
                )
            )

            if args.once:
                break

            elapsed = time.perf_counter() - loop_start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    except KeyboardInterrupt:
        print("\nStopped by user.")
    finally:
        if port_handler.is_open:
            port_handler.closePort()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
