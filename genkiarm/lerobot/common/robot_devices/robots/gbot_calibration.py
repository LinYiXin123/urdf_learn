import numpy as np

from lerobot.common.robot_devices.motors.gbot import (
    CalibrationMode,
    TorqueMode,
)
from lerobot.common.robot_devices.motors.utils import MotorsBus

URL_TEMPLATE = (
    "https://raw.githubusercontent.com/huggingface/lerobot/main/media/{robot}/{arm}_{position}.webp"
)

# The following positions are provided in nominal degree range ]-180, +180[
# For more info on these constants, see comments in the code where they get used.
ZERO_POSITION_DEGREE = 0
ROTATED_POSITION_DEGREE = 90

def run_arm_manual_calibration(arm: MotorsBus, robot_type: str, arm_name: str, arm_type: str):
    if (arm.read("Torque_Enable") != TorqueMode.DISABLED.value).any():
        raise ValueError("To run calibration, the torque must be disabled on all motors.")

    print(f"\nRunning calibration of {robot_type} {arm_name} {arm_type}...")

    print("\nMove arm to zero position")
    print("See: " + URL_TEMPLATE.format(robot=robot_type, arm=arm_type, position="zero"))
    input("Press Enter to continue...")

    zero_pos = arm.read("Present_Position")
    homing_offset = -zero_pos

    print("\nMove arm to rotated target position")
    print("See: " + URL_TEMPLATE.format(robot=robot_type, arm=arm_type, position="rotated"))
    input("Press Enter to continue...")

    rotated_pos = arm.read("Present_Position")
    drive_mode = (rotated_pos < zero_pos).astype(np.int32)

    print("\nMove arm to rest position")
    print("See: " + URL_TEMPLATE.format(robot=robot_type, arm=arm_type, position="rest"))
    input("Press Enter to continue...")
    print()

    calib_modes = []
    for name in arm.motor_names:
        if name == "gripper":
            calib_modes.append(CalibrationMode.LINEAR.name)
        else:
            calib_modes.append(CalibrationMode.DEGREE.name)

    calib_dict = {
        "homing_offset": homing_offset.tolist(),
        "drive_mode": drive_mode.tolist(),
        "start_pos": zero_pos.tolist(),
        "end_pos": rotated_pos.tolist(),
        "calib_mode": calib_modes,
        "motor_names": arm.motor_names,
    }
    return calib_dict