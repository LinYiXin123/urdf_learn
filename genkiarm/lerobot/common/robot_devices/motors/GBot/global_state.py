
from enum import Enum
from typing import Union, List

from .utils import bytes_to_int, bytes_to_short


class Address(Enum):
    """
    寄存器地址表
    寄存器地址 数据长度
    """
    
    # read only
    DEVICE_UUID         = (0, 4)
    VERSION             = (4, 2)
    MOTOR_TYPE          = (6, 1)
    CURRENT_POSITION    = (7, 2)
    CURRENT_SPEED       = (9, 2)
    CURRENT_LOAD        = (11, 2)
    CURRENT_VOLTAGE     = (13, 1)
    CURRENT_CURRENT     = (14, 2)
    CURRENT_TEMPERATURE = (16, 1)
    # read write
    TORQUE_ENABLE       = (50, 1)
    TARGET_POSITION     = (51, 2)
    # read write store
    ID                  = (70, 1)
    MIN_POSITION        = (71, 2)
    MAX_POSITION        = (73, 2)
    POSITION_OFFSET     = (75, 2)
    MAX_VOLTAGE         = (77, 1)
    MIN_VOLTAGE         = (78, 1)
    MAX_TEMPERATURE     = (79, 1)
    MAX_CURRENT         = (80, 2)
    KP                  = (82, 1)
    KI                  = (83, 1)
    KD                  = (84, 1)
    
    @classmethod
    def get_address(cls, address:int):
        for addr in cls:
            if addr.value[0] == address:
                return addr
        return None


class ErrorCode(Enum):
    """
    错误码表
    """    
    SUCCESS             = 0
    WRITE_ERROR         = 1
    READ_ERROR          = 2
    READ_TIMEOUT        = 3
    
class Result:
    """
    结果类，用于封装返回的结果 
    """
    
    def __init__(self, error: ErrorCode = ErrorCode.SUCCESS, frame: List[int] = None, input: Union[Address, List[Address]] = None):
        self.__error_code = error
        self.__frame = frame
        self.__input = input
        self.__error_code = error
        self.__value_map = {} 
        
        if frame is None:
            return
        if input is None:
            return
        id = frame[2]
        cmd = frame[3]
        if cmd != 0x03:
            return
        if id != 0xFF and id < 128 and id >= 248:
            return
        addresses = []
        if isinstance(input, Address):
            addresses.append(input)
        elif isinstance(input, list):
            addresses.extend(input)

        if id == 0xFF:
            cnt = 6    
        elif id >= 128 and id < 248:
            cnt = 5
        
        while cnt < len(frame) - 2:
            addr = Address.get_address(frame[cnt])
            if addr is None:
                break
            addr_int = addr.value[0]
            addr_len = addr.value[1]
                
            if addr_len == 1:
                self.__value_map[addr_int] = frame[cnt+1]
            elif addr_len == 2:
                self.__value_map[addr_int] = bytes_to_short(bytearray(frame[cnt+1:cnt+3]))
            elif addr_len == 4:
                self.__value_map[addr_int] = bytes_to_int(bytearray(frame[cnt+1:cnt+5]))
            cnt += addr_len + 1
        
    def is_success(self) -> bool:
        """
        判断是否成功
        """
        return self.__error_code == ErrorCode.SUCCESS
    
    def get_error_code(self) -> int:
        """
        获取错误码
        """
        return self.__error_code.value

    def get_error_message(self) -> str:
        """
        获取错误信息
        """
        pass

    def get_data(self, address: Address) -> int:
        """
        获取数据
        """
        address_int = address.value[0]
        if address_int in self.__value_map:
            return self.__value_map[address_int]
        return None
    
    def get_addresses(self) -> List[Address]:
        """
        获取地址列表
        """
        return self.__input