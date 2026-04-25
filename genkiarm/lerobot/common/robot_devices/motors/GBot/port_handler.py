from serial import Serial
from serial.tools import list_ports


class PortHandler:
    def __init__(self):
        self.__serial: Serial = None
    
        self._port = None
        self._baudrate = 115200
        self._bytesize = 8
        self._parity = 'N'
        self._stopbits = 1
        
        self._read_timeout = None
        self._write_timeout = None
        
        self.__is_running = False
        
        self.__write_callback = None
        self.__read_callback = None
    
    # port 属性的 getter 和 setter
    @property
    def port(self):
        """获取端口"""
        return self._port

    @port.setter
    def port(self, value):
        """设置端口"""
        if self.__serial and self.__serial.is_open:
            raise ValueError("无法修改已打开的串口端口")
        self._port = value

    # baudrate 属性的 getter 和 setter
    @property
    def baudrate(self):
        """获取波特率"""
        return self._baudrate

    @baudrate.setter
    def baudrate(self, value):
        """设置波特率"""
        if self.__serial and self.__serial.is_open:
            raise ValueError("无法修改已打开的串口波特率")
        self._baudrate = value

    # bytesize 属性的 getter 和 setter
    @property
    def bytesize(self):
        """获取数据位"""
        return self._bytesize

    @bytesize.setter
    def bytesize(self, value):
        """设置数据位"""
        if self.__serial and self.__serial.is_open:
            raise ValueError("无法修改已打开的串口数据位")
        self._bytesize = value

    # parity 属性的 getter 和 setter
    @property
    def parity(self):
        """获取校验位"""
        return self._parity

    @parity.setter
    def parity(self, value):
        """设置校验位"""
        if self.__serial and self.__serial.is_open:
            raise ValueError("无法修改已打开的串口校验位")
        self._parity = value.upper()[0]

    # stopbits 属性的 getter 和 setter
    @property
    def stopbits(self):
        """获取停止位"""
        return self._stopbits

    @stopbits.setter
    def stopbits(self, value):
        """设置停止位"""
        if self.__serial and self.__serial.is_open:
            raise ValueError("无法修改已打开的串口停止位")
        self._stopbits = value
        
    # read_timeout 属性的 getter 和 setter
    @property
    def read_timeout(self):
        """获取读取超时"""
        return self.read_timeout

    @read_timeout.setter
    def read_timeout(self, value):
        """设置读取超时"""
        self._read_timeout = value
        
        if self.__serial and self.__serial.is_open:
            self.__serial.timeout = value

    # write_timeout 属性的 getter 和 setter
    @property
    def write_timeout(self):
        """获取写入超时"""
        return self._write_timeout

    @write_timeout.setter
    def write_timeout(self, value):
        """设置写入超时"""
        self.write_timeout = value
        
        if self.__serial and self.__serial.is_open:
            self.__serial.write_timeout = value
        
    def open(self, port) -> bool:
        self.close()
        
        try:
            self._port = port
            self.__serial = Serial(port=port, 
                                baudrate=self._baudrate, 
                                bytesize=self.bytesize, 
                                parity=self.parity, 
                                stopbits=self._stopbits,
                                timeout=self._read_timeout,
                                write_timeout=self._write_timeout)
            self.__is_running = True
            return True
        except Exception as e:
            return False
        
    def is_open(self) -> bool:
        # if self.__serial and self.__is_running:
        if self.__serial and self.__serial.is_open:
            return True
        
        return False
            
    def close(self):
        # if self.__serial and self.__serial.__is_running:
        if self.__serial and self.__serial.is_open:
            self.__serial.close()
            self.__is_running = False
            self.__serial = None
        
    def list_ports(self):
        ports = list_ports.comports()
        port_info = [(port.device, port.description, port.hwid) for port in ports]
        return port_info
    
    def read_port(self, length:int):
        if self.__serial and self.__serial.is_open:
            # self.__serial.reset_input_buffer()
            data = self.__serial.read(length)
            self.__notify_read_callback(data)
            return data
    
    def write_port(self, data):
        if self.__serial and self.__serial.is_open:
            self.__serial.reset_input_buffer()
            self.__serial.write(data)
            self.__serial.flush()
            
            self.__notify_write_callback(data) 
        
    def in_waiting(self):
        if self.__serial and self.__serial.is_open:
            return self.__serial.in_waiting
        return 0
    
    def add_write_callback(self, callback):
        if callback is None:
            return
        
        if self.__write_callback is None:
            self.__write_callback = []
        
        if callback not in self.__write_callback:
            self.__write_callback.append(callback)
    
    def remove_write_callback(self, callback):
        if callback is None:
            return

        if self.__write_callback is not None and callback in self.__write_callback:
            self.__write_callback.remove(callback)

    def __notify_write_callback(self, data):
        if self.__write_callback is not None:
            for callback in self.__write_callback:
                callback(data)

    def add_read_callback(self, callback):
        if callback is None:
            return

        if self.__read_callback is None:
            self.__read_callback = []

        if callback not in self.__read_callback:
            self.__read_callback.append(callback)
    
    def remove_read_callback(self, callback):
        if callback is None:
            return

        if self.__read_callback is not None and callback in self.__read_callback:
            self.__read_callback.remove(callback)
            
    def __notify_read_callback(self, data):
        if self.__read_callback is not None:
            for callback in self.__read_callback:
                callback(data)