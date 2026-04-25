import time

from .port_handler import PortHandler
from .global_state import Address, Result, ErrorCode
from .utils import short_to_bytes, int_to_bytes

from typing import Union, List

FRAME_HEADER    = 0xAA
FRAME_TAIL      = 0xBB

FRAME_CMD_WRITE         = 0x01
FRAME_CMD_STORE         = 0x02
FRAME_CMD_READ          = 0x03
ID_BROADCAST            = 0x7F




def checksum(id: int, cmd: int, data: List[int]) -> int:
    """
    计算帧校验和
    
    Args:
        id: 设备ID
        cmd: 命令
        data: 数据列表
        
    Returns:
        int: 计算后的校验和(0-255)
    """
    return (id + cmd + len(data) + sum(data)) & 0xFF


def frame_generator(id: int, cmd: int, data: List[int]) -> bytearray:
    """
    帧生成器
    Args:
        id (int): 设备ID
        cmd (int): 命令
        data (List[int]): 数据
    """
    frame = bytearray()
    frame.append(FRAME_HEADER)
    frame.append(FRAME_HEADER)
    frame.append(id)
    frame.append(cmd)
    frame.append(len(data))
    for d in data:
        frame.append(d)
    frame.append(checksum(id, cmd, data))
    frame.append(FRAME_TAIL)
    return frame


class SyncConnector:
    def __init__(self, portHandler: PortHandler):
        self.__port_handler = portHandler
        
    def _process_address_data(self, address: Union[Address, List[Address]], data_value: Union[List[int], int]) -> List[int]:
        """
        处理地址和数据到字节列表
        Args:
            address: 寄存器地址
            data_value: 要写入的值
        Returns:
            处理后的数据列表
        Raises:
            ValueError: 如果地址和值不匹配或无效
            OverflowError: 如果值超出范围
        """
        data = []
        if isinstance(address, list):
            if not isinstance(data_value, list):
                raise ValueError("如果提供多个地址，值也必须以列表形式提供")
            if len(address) != len(data_value):
                raise ValueError("地址和值的数量必须匹配")
            if len(address) == 0:
                raise ValueError("必须提供至少一个地址")
            if len(address) > 4:
                raise ValueError("最多只能提供4个地址")
            
            for i in range(len(address)):
                reg = address[i].value[0]
                value_len = address[i].value[1]
                data.append(reg)
                data.append(value_len)
                if value_len == 1:
                    data.append(data_value[i] & 0xFF)
                elif value_len == 2:
                    data.extend(short_to_bytes(data_value[i]))
                elif value_len == 4:
                    data.extend(int_to_bytes(data_value[i]))
                else:
                    raise ValueError("无效的值长度")
        else:
            reg = address.value[0]
            value_len = address.value[1]
            data.append(reg)
            data.append(value_len)
            if value_len == 1:
                data.append(data_value & 0xFF)
            elif value_len == 2:
                data.extend(short_to_bytes(data_value))
            elif value_len == 4:
                data.extend(int_to_bytes(data_value))
            else:
                raise ValueError("无效的值长度")
        return data
        
    def _validate_frame_header(self, frame: List[int]) -> bool:
        """验证帧头部格式"""
        return len(frame) >= 7 and frame[0] == FRAME_HEADER and frame[1] == FRAME_HEADER
        
    def _validate_frame_length(self, frame: List[int]) -> bool:
        """验证帧长度"""
        data_length = frame[4]
        return data_length <= 48 and len(frame) >= 7 + data_length
        
    def _validate_frame_tail(self, frame: List[int]) -> bool:
        """验证帧尾部"""
        data_length = frame[4]
        return frame[6 + data_length] == FRAME_TAIL
        
    def _validate_frame_checksum(self, frame: List[int]) -> bool:
        """验证帧校验和"""
        data_length = frame[4]
        checksum = sum(frame[2:5 + data_length]) & 0xFF
        return checksum == frame[5 + data_length]
        
    def _validate_frame(self, frame: List[int]) -> bool:
        """
        验证帧格式是否正确
        
        Args:
            frame: 待验证的帧数据
            
        Returns:
            bool: True表示验证通过
        """
        return (self._validate_frame_header(frame) and 
                self._validate_frame_length(frame) and 
                self._validate_frame_tail(frame) and 
                self._validate_frame_checksum(frame))
        
    def _parse_response_frame(self) -> Result:
        """
        解析响应帧
        
        Returns:
            Result: 操作结果
        """
        retry_cnt = 0
        read_list = []
        state = 0
        self.__port_handler.read_timeout = 1
        while True:
            in_waiting = self.__port_handler.in_waiting()
            if in_waiting == 0:
                if retry_cnt < 5:
                    retry_cnt += 1
                    time.sleep(0.01)
                    continue
                else:
                    state = -1
                    break
                
            read_list.extend(list(self.__port_handler.read_port(in_waiting)))
                
            while len(read_list) >= 7:
                if read_list[0] != FRAME_HEADER or read_list[1] != FRAME_HEADER:
                    read_list.pop(0)
                    continue
                data_length = read_list[4]
                if data_length > 48:
                    read_list.pop(0)
                    continue
                if len(read_list) < 7 + data_length:
                    break
                if read_list[6 + data_length]!= FRAME_TAIL:
                    read_list.pop(0)
                    continue
                checksum = 0
                for i in range(2, 5 + data_length):
                    checksum += read_list[i]
                checksum = checksum & 0xFF
                if checksum != read_list[5 + data_length]:
                    read_list.pop(0)
                    continue
                # 将数据添加到结果列表，移除已解析的数据
                read_list = read_list[0:7 + data_length]
                state = 1
                break
                
            if state == 1:
                break
             
        if state == -1:
            return Result(error=ErrorCode.READ_TIMEOUT)
        elif state == 0:
            return Result(error=ErrorCode.READ_ERROR)
        else:
            return Result(frame=read_list)
                    
    def write(self, id: int, address: Union[Address, List[Address]], value: Union[int, List[int]]) -> Result:
        """
        写入数据
        """
        if id > 120:
            raise ValueError("ID must be less than 120")
        
        try:
            data = self._process_address_data(address, value)
            frame = frame_generator(id, FRAME_CMD_WRITE, data)
            self.__port_handler.write_port(frame)
        except Exception as e:
            return Result(error=ErrorCode.WRITE_ERROR)
        
        try:
            return self._parse_response_frame()
        except Exception as e:
            return Result(error=ErrorCode.READ_ERROR)        
    
    def store(self, id: int, address: Union[Address, List[Address]], value: Union[List[int], int]) -> Result:
        """
        持久写数据
        Args:
            address (Union[Address, List[Address]]): 寄存器地址
            data (Union[List[int], int]): 要持久写入的值
        
        Returns:
            Result: 操作结果
        
        Raises:
            ValueError: 如果地址和值不匹配或无效
            OverflowError: 如果值超出范围
        """
        if id > 120:
            raise ValueError("ID must be less than 120")
        
        try:
            data = self._process_address_data(address, value)
            frame = frame_generator(id, FRAME_CMD_STORE, data)
            self.__port_handler.write_port(frame)
        except Exception as e:
            return Result(error=ErrorCode.WRITE_ERROR)
        
        try:
            return self._parse_response_frame()
        except Exception as e:
            return Result(error=ErrorCode.READ_ERROR)    
    
    def read(self, id: Union[List[int], int], address: Union[Address, List[Address]]) -> Union[List[Result], Result]:
        """
        读数据
        Args:
            address (Union[Address, List[Address]]): 寄存器地址
        """
        ids = [] 
        if isinstance(id, list):
            ids.extend(id)
        else:
            ids.append(id)
        
        if len(ids) == 0:
            raise ValueError("ID must be at least one")
        
        data = []
        if len(ids) > 1:
            data.extend(ids)
        
        if isinstance(address, list):
            for addr in address:
                reg = addr.value[0]          # 寄存器地址
                value_len = addr.value[1]    # 数据长度
                data.append(reg)
                data.append(value_len)
        else:
            reg = address.value[0]          # 寄存器地址
            value_len = address.value[1]    # 数据长度
            data.append(reg)
            data.append(value_len)
                
        if len(ids) > 1:
            frame = frame_generator(ID_BROADCAST, FRAME_CMD_READ, data)
        else:
            frame = frame_generator(ids[0], FRAME_CMD_READ, data)

        # 发送帧
        try:
            self.__port_handler.write_port(frame)
        except Exception as e:
            return Result(error=ErrorCode.WRITE_ERROR)
        
        # 解析响应帧
        # 如果是广播帧，需要解析多个响应帧
        results = []
        read_list = []
        
        current = 0
        read_cnt = len(ids)
        self.__port_handler.read_timeout = 1
        while current < read_cnt:
            state = 0
            retry_cnt = 0
            result_list = []
            while True:
                in_waiting = self.__port_handler.in_waiting()
                if in_waiting == 0:
                    if retry_cnt < 5:
                        retry_cnt += 1
                        time.sleep(0.01)
                        continue
                    else:
                        state = -1
                        break
                
                read_list.extend(list(self.__port_handler.read_port(in_waiting)))
                
                while len(read_list) >= 7:
                    if read_list[0] != FRAME_HEADER or read_list[1] != FRAME_HEADER:
                        read_list.pop(0)
                        continue
                    
                    data_length = read_list[4]
                    if data_length > 48:
                        read_list.pop(0)
                        continue
                    if len(read_list) < 7 + data_length:
                        break
                    if read_list[6 + data_length]!= FRAME_TAIL:
                        read_list.pop(0)
                        continue
                    
                    checksum = 0
                    for i in range(2, 5 + data_length):
                        checksum += read_list[i]
                    checksum = checksum & 0xFF
                    if checksum != read_list[5 + data_length]:
                        read_list.pop(0)
                        continue
                    # 将数据添加到结果列表，移除已解析的数据
                    result_list.extend(read_list[0:7 + data_length])
                    read_list = read_list[7 + data_length:]
                    state = 1
                    break
                
                if state == 1:
                    break
            
            current += 1            
            if state != 1:
                results.append(Result(error=ErrorCode.READ_ERROR))
            else:
                results.append(Result(frame=result_list, input=address))
                
        if read_cnt == 1:
            return results[0]
        else:
            return results
                    