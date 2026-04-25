import enum
import logging
import math
from pyexpat import model
import time
from tkinter import N
import traceback
from copy import deepcopy

from lerobot.common.robot_devices.motors.genki import MODEL_CONTROL_TABLE
import numpy as np
import tqdm

from lerobot.common.robot_devices.utils import RobotDeviceAlreadyConnectedError, RobotDeviceNotConnectedError
from lerobot.common.utils.utils import capture_timestamp_utc


from .GBot import PortHandler, Address, SyncConnector, Result


# 定义电机特有常量
PROTOCOL_VERSION = 1     
# BAUDRATE = 1000000       
BAUDRATE = 230400
TIMEOUT_MS = 1000

CALIBRATION_REQUIRED = ["Goal_Position", "Present_Position"]

# 定义电机控制表 (根据你的电机文档修改)
M1_CONTROL_TABLE = {
    "Model":    Address.MOTOR_TYPE,
    "ID":       Address.ID,
    # 添加M1电机特有控制项
    "Torque_Enable": Address.TORQUE_ENABLE,
    "Present_Position": Address.CURRENT_POSITION,
}

MODEL_CONTROL_TABLE = {
    "genki_M1": M1_CONTROL_TABLE,
    # 添加其他电机的控制项 
}

MODEL_RESOLUTION = {
    "genki_M1": 4096,
}


class TorqueMode(enum.Enum):
    ENABLED = 1
    DISABLED = 0

class DriveMode(enum.Enum):
    NON_INVERTED = 0
    INVERTED = 1

class CalibrationMode(enum.Enum):
    DEGREE = 0
    LINEAR = 1

class JointOutOfRangeError(Exception):
    def __init__(self, message="Joint is out of range"):
        self.message = message
        super().__init__(self.message)

class GBotMotorsBus:
    def __init__(
        self,
        port: str,
        motors: dict[str, tuple[int, str]],
        extra_model_control_table: dict[str, list[tuple]] | None = None,
        extra_model_resolution: dict[str, int] | None = None,
        mock=False,
    ):
        self.port = port
        self.motors = motors
        self.mock = mock
        
        self.model_ctrl_table = deepcopy(MODEL_CONTROL_TABLE)
        if extra_model_control_table:
            self.model_ctrl_table.update(extra_model_control_table)

        self.model_resolution = deepcopy(MODEL_RESOLUTION)
        if extra_model_resolution:
            self.model_resolution.update(extra_model_resolution)
        
        # 初始化电机特有属性
        self.__port_handler: PortHandler = PortHandler()
        self.__port_handler.baudrate = BAUDRATE
        # self.__port_handler.write_timeout = TIMEOUT_MS
        # self.__port_handler.read_timeout = TIMEOUT_MS
        
        self.__sync_connector: SyncConnector = SyncConnector(self.__port_handler)
        
        self.is_connected = False
        
    def connect(self):
        """连接到电机总线"""
        if self.is_connected:
            raise RobotDeviceAlreadyConnectedError(
                f"GBotMotorsBus is already connected to port {self.port}."
            )
        
        try:
            if not self.__port_handler.open(self.port):
                raise OSError(f"Failed to open port '{self.port}'.")
        except Exception as e:
            raise RobotDeviceNotConnectedError(
                f"Failed to connect to port {self.port}. Error: {e}"
            )
        self.is_connected = True
        
    def disconnect(self):
        """断开与电机总线的连接"""
        if not self.is_connected:
            raise RobotDeviceNotConnectedError(
                f"GBotMotorsBus is not connected to port {self.port}."
            )
        # 实现断开逻辑
        try:
            self.__port_handler.close()
        except Exception as e:
            print(f"Failed to disconnect from port {self.port}. Error: {e}")
        self.is_connected = False
        
    def reconnect(self):
        """重新连接电机总线"""
        # 实现重连逻辑
        self.disconnect()
        self.connect()
        
    def are_motors_configured(self):
        """检查电机是否已配置"""
        # 实现你的检查逻辑
        print('#### are_motors_configured')
        pass
        
    def find_motor_indices(self, possible_ids=None, num_retry=2):
        """查找电机ID"""
        # 实现你的查找逻辑
        print('#### find_motor_indices')
        pass
        
    def set_bus_baudrate(self, baudrate):
        """设置总线波特率"""
        # 实现你的波特率设置逻辑
        pass
        
    @property
    def motor_names(self) -> list[str]:
        """获取电机名称列表"""
        return list(self.motors.keys())
        
    @property
    def motor_models(self) -> list[str]:
        """获取电机型号列表"""
        return [model for _, model in self.motors.values()]
        
    @property
    def motor_indices(self) -> list[int]:
        """获取电机ID列表"""
        return [idx for idx, _ in self.motors.values()]
        
    def set_calibration(self, calibration: dict[str, list]):
        """设置校准参数"""
        self.calibration = calibration
        
    def apply_calibration_autocorrect(self, values: np.ndarray | list, motor_names: list[str] | None):
        """This function apply the calibration, automatically detects out of range errors for motors values and attempt to correct.

        For more info, see docstring of `apply_calibration` and `autocorrect_calibration`.
        """
        try:
            values = self.apply_calibration(values, motor_names)
        except JointOutOfRangeError as e:
            print(e)
            self.autocorrect_calibration(values, motor_names)
            values = self.apply_calibration(values, motor_names)
        return values
        
    def apply_calibration(self, values: np.ndarray | list, motor_names: list[str] | None):
        """Convert from unsigned int32 joint position range [0, 2**32[ to the universal float32 nominal degree range ]-180.0, 180.0[ with
        a "zero position" at 0 degree.

        Note: We say "nominal degree range" since the motors can take values outside this range. For instance, 190 degrees, if the motor
        rotate more than a half a turn from the zero position. However, most motors can't rotate more than 180 degrees and will stay in this range.

        Joints values are original in [0, 2**32[ (unsigned int32). Each motor are expected to complete a full rotation
        when given a goal position that is + or - their resolution. For instance, feetech xl330-m077 have a resolution of 4096, and
        at any position in their original range, let's say the position 56734, they complete a full rotation clockwise by moving to 60830,
        or anticlockwise by moving to 52638. The position in the original range is arbitrary and might change a lot between each motor.
        To harmonize between motors of the same model, different robots, or even models of different brands, we propose to work
        in the centered nominal degree range ]-180, 180[.
        """
        if motor_names is None:
            motor_names = self.motor_names

        # Convert from unsigned int32 original range [0, 2**32] to signed float32 range
        values = values.astype(np.float32)

        for i, name in enumerate(motor_names):
            calib_idx = self.calibration["motor_names"].index(name)
            calib_mode = self.calibration["calib_mode"][calib_idx]

            if CalibrationMode[calib_mode] == CalibrationMode.DEGREE:
                drive_mode = self.calibration["drive_mode"][calib_idx]
                homing_offset = self.calibration["homing_offset"][calib_idx]
                _, model = self.motors[name]
                resolution = self.model_resolution[model]

                # Update direction of rotation of the motor to match between leader and follower.
                # In fact, the motor of the leader for a given joint can be assembled in an
                # opposite direction in term of rotation than the motor of the follower on the same joint.
                if drive_mode:
                    values[i] *= -1

                # Convert from range [-2**31, 2**31[ to
                # nominal range ]-resolution, resolution[ (e.g. ]-2048, 2048[)
                values[i] += homing_offset

                # Convert from range ]-resolution, resolution[ to
                # universal float32 centered degree range ]-180, 180[
                values[i] = values[i] / (resolution // 2) * 180 # HALF_TURN_DEGREE

                if (values[i] < -270) or (values[i] > 270): # LOWER_BOUND_DEGREE, UPPER_BOUND_DEGREE
                    raise JointOutOfRangeError(
                        f"Wrong motor position range detected for {name}. "
                        f"Expected to be in nominal range of [-{180}, {180}] degrees (a full rotation), "
                        f"with a maximum range of [{-270}, {270}] degrees to account for joints that can rotate a bit more, "
                        f"but present value is {values[i]} degree. "
                        "This might be due to a cable connection issue creating an artificial 360 degrees jump in motor values. "
                        "You need to recalibrate by running: `python lerobot/scripts/control_robot.py calibrate`"
                    )

            elif CalibrationMode[calib_mode] == CalibrationMode.LINEAR:
                start_pos = self.calibration["start_pos"][calib_idx]
                end_pos = self.calibration["end_pos"][calib_idx]

                # Rescale the present position to a nominal range [0, 100] %,
                # useful for joints with linear motions like Aloha gripper
                values[i] = (values[i] - start_pos) / (end_pos - start_pos) * 100

                if (values[i] < -10) or (values[i] > 110): # LOWER_BOUND_LINEAR, UPPER_BOUND_LINEAR
                    raise JointOutOfRangeError(
                        f"Wrong motor position range detected for {name}. "
                        f"Expected to be in nominal range of [0, 100] % (a full linear translation), "
                        f"with a maximum range of [{-10}, {110}] % to account for some imprecision during calibration, "
                        f"but present value is {values[i]} %. "
                        "This might be due to a cable connection issue creating an artificial jump in motor values. "
                        "You need to recalibrate by running: `python lerobot/scripts/control_robot.py calibrate`"
                    )

        return values
        
    def autocorrect_calibration(self, values: np.ndarray | list, motor_names: list[str] | None):
        """This function automatically detects issues with values of motors after calibration, and correct for these issues.

        Some motors might have values outside of expected maximum bounds after calibration.
        For instance, for a joint in degree, its value can be outside [-270, 270] degrees, which is totally unexpected given
        a nominal range of [-180, 180] degrees, which represents half a turn to the left or right starting from zero position.

        Known issues:
        #1: Motor value randomly shifts of a full turn, caused by hardware/connection errors.
        #2: Motor internal homing offset is shifted of a full turn, caused by using default calibration (e.g Aloha).
        #3: motor internal homing offset is shifted of less or more than a full turn, caused by using default calibration
            or by human error during manual calibration.

        Issues #1 and #2 can be solved by shifting the calibration homing offset by a full turn.
        Issue #3 will be visually detected by user and potentially captured by the safety feature `max_relative_target`,
        that will slow down the motor, raise an error asking to recalibrate. Manual recalibrating will solve the issue.

        Note: A full turn corresponds to 360 degrees but also to 4096 steps for a motor resolution of 4096.
        """
        if motor_names is None:
            motor_names = self.motor_names

        # Convert from unsigned int32 original range [0, 2**32] to signed float32 range
        values = values.astype(np.float32)

        for i, name in enumerate(motor_names):
            calib_idx = self.calibration["motor_names"].index(name)
            calib_mode = self.calibration["calib_mode"][calib_idx]

            if CalibrationMode[calib_mode] == CalibrationMode.DEGREE:
                drive_mode = self.calibration["drive_mode"][calib_idx]
                homing_offset = self.calibration["homing_offset"][calib_idx]
                _, model = self.motors[name]
                resolution = self.model_resolution[model]

                # Update direction of rotation of the motor to match between leader and follower.
                if drive_mode:
                    values[i] *= -1

                # Convert from range [-2**31, 2**31[ to
                # nominal range ]-resolution, resolution[ (e.g. ]-2048, 2048[)
                values[i] += homing_offset

                # Check if there is an issue with the calibration of this motor.
                # We check if the motor value is outside of the maximum range.
                if (values[i] / (resolution // 2) * 180 < -270) or (
                    values[i] / (resolution // 2) * 180 > 270
                ):
                    # There is an issue, we attempt to correct by adding or substracting a full turn to the homing offset.
                    # A full turn corresponds to `resolution` steps.
                    if values[i] > 0:
                        self.calibration["homing_offset"][calib_idx] -= resolution
                    else:
                        self.calibration["homing_offset"][calib_idx] += resolution
        
    def revert_calibration(self, values: np.ndarray | list, motor_names: list[str] | None):
        """Convert back from the universal float32 nominal degree range ]-180.0, 180.0[ to the unsigned int32 joint position range [0, 2**32[.

        For more info, see docstring of `apply_calibration`.
        """
        if motor_names is None:
            motor_names = self.motor_names

        # Convert to float32 to avoid precision issues
        values = values.astype(np.float32)

        for i, name in enumerate(motor_names):
            calib_idx = self.calibration["motor_names"].index(name)
            calib_mode = self.calibration["calib_mode"][calib_idx]

            if CalibrationMode[calib_mode] == CalibrationMode.DEGREE:
                drive_mode = self.calibration["drive_mode"][calib_idx]
                homing_offset = self.calibration["homing_offset"][calib_idx]
                _, model = self.motors[name]
                resolution = self.model_resolution[model]

                # Convert from universal float32 centered degree range ]-180, 180[ to
                # range ]-resolution, resolution[
                values[i] = values[i] * (resolution // 2) / 180 # HALF_TURN_DEGREE

                # Convert from range ]-resolution, resolution[ to
                # range [-2**31, 2**31[
                values[i] -= homing_offset

                # Update direction of rotation of the motor to match between leader and follower.
                if drive_mode:
                    values[i] *= -1

            elif CalibrationMode[calib_mode] == CalibrationMode.LINEAR:
                start_pos = self.calibration["start_pos"][calib_idx]
                end_pos = self.calibration["end_pos"][calib_idx]

                # Rescale the present position from a nominal range [0, 100] % to the original range
                values[i] = values[i] / 100 * (end_pos - start_pos) + start_pos

        # Convert from signed float32 range to unsigned int32 original range [0, 2**32[
        return values.astype(np.int32)
        
    def avoid_rotation_reset(self, values, motor_names, data_name):
        """避免旋转重置"""
        # 实现你的旋转重置处理逻辑
        print('#### avoid_rotation_reset')
        pass
        
    def read_with_motor_ids(self, motor_models, motor_ids, data_name, num_retry=20):
        """通过电机ID读取数据"""
        # 实现取逻辑
        return_list = True
        if not isinstance(motor_ids, list):
            return_list = False
            motor_ids = [motor_ids]
        
        values = []
        for index, motor_idx in enumerate(motor_ids):
            model = motor_models[index]
            address = self.model_ctrl_table[model][data_name]
            if address is None:
                print(f"Invalid data_name '{data_name}' for model '{model}' on Motor '{motor_idx}'.")
                continue
            
            result = self.__sync_connector.read(motor_idx, address)
            if not result.is_success():
                print(f"Failed to read data '{data_name}' for Motor '{motor_idx}'.")
                value = 0
            else:
                value = result.get_data(address)
            values.append(value)
            
        if return_list:
            return values
        else:
            return values[0]
        
    def read(self, data_name, motor_names: str | list[str] | None = None):
        """读取电机数据"""
        if not self.is_connected:
            raise RobotDeviceNotConnectedError(
                f"GBotMotorsBus is not connected to port {self.port}."
            )
        
        if motor_names is None:
            motor_names = self.motor_names
        
        if isinstance(motor_names, str):
            motor_names = [motor_names]
        
        motor_ids = []

        values = []
        for name in motor_names:
            motor_idx, model = self.motors[name]
            motor_ids.append(motor_idx)

            address = self.model_ctrl_table[model][data_name]
            if address is None:
                print(f"Invalid data_name '{data_name}' for model '{model}' on Motor '{motor_idx}'.")
                continue
            
            result = self.__sync_connector.read(motor_idx, address)
            if not result.is_success():
                print(f"Failed to read data '{data_name}' for Motor '{motor_idx}'.")
                value = 0
            else:
                value = result.get_data(address)
            values.append(value)
        
        values = np.array(values)

        if data_name in CALIBRATION_REQUIRED:
            values = self.apply_calibration_autocorrect(values, motor_names)
        
        return values   
        
    def write_with_motor_ids(self, motor_models, motor_ids, data_name, values, num_retry=20):
        """通过电机ID写入数据"""
        # 实现写入逻辑
        if not self.is_connected:
            raise RobotDeviceNotConnectedError(
                f"GBotMotorsBus is not connected to port {self.port}."
            )
        
        for index, motor_idx in enumerate(motor_ids):
            model = motor_models[index]
            address = self.model_ctrl_table[model][data_name]
            if address is None:
                print(f"Invalid data_name '{data_name}' for model '{model}' on Motor '{motor_idx}'.")
                continue

            result = self.__sync_connector.write(motor_idx, address, values[index])
            if result.is_success():
                print(f"Data '{data_name}' written successfully to Motor '{motor_idx}'.")
            else:
                print(f"Failed to write data '{data_name}' to Motor '{motor_idx}'.")
                
    def write(self, data_name, values: int | float | np.ndarray, motor_names: str | list[str] | None = None):
        """写入电机数据"""
        # 实现你的写入逻辑
        if not self.is_connected:
            raise RobotDeviceNotConnectedError(
                f"GBotMotorsBus is not connected to port {self.port}."
            )
        
        if motor_names is None:
            motor_names = self.motor_names
        elif isinstance(motor_names, str):
            motor_names = [motor_names]

        if data_name in CALIBRATION_REQUIRED:
            values = self.revert_calibration(values, motor_names)

        for index, name in enumerate(motor_names):
            motor_idx, model = self.motors[name]
            address = self.model_ctrl_table[model][data_name]

            if address is None:
                print(f"Invalid data_name '{data_name}' for model '{model}' on Motor '{motor_idx}'.")
                continue

            if isinstance(values, (np.ndarray, list)):
                result = self.__sync_connector.write(motor_idx, address, values[index])
            else:
                result = self.__sync_connector.write(motor_idx, address, values)
            if result.is_success():
                print(f"Data '{data_name}' written successfully to Motor '{motor_idx}'.")
            else:
                print(f"Failed to write data '{data_name}' to Motor '{motor_idx}'.")
        
    def __del__(self):
        """析构函数"""
        if getattr(self, "is_connected", False):
            self.disconnect()