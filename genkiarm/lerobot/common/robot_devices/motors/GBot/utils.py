import struct


def bytes_to_short(data: bytes, signed: bool = False, byteorder: str = 'little') -> int:
    """
    将bytes转为short（16位整数）。
    
    Args:
        data (bytes): 要转换的bytes（必须为2字节）。
        signed (bool): 是否是有符号short，默认False（无符号）。
        byteorder (str): 字节序，'little'（小端）或 'big'（大端），默认小端。
    
    Returns:
        int: 转换后的short值。
    
    Raises:
        ValueError: 如果data长度不为2字节。
    """
    if len(data) != 2:
        raise ValueError("Data must be exactly 2 bytes long")

    # 选择字节序
    prefix = '<' if byteorder == 'little' else '>'
    format_char = 'h' if signed else 'H'
    return struct.unpack(f"{prefix}{format_char}", data)[0]


def short_to_bytes(value: int, signed: bool = False, byteorder: str = 'little') -> bytes:
    """
    将short（16位整数）转为bytes。
    
    Args:
        value (int): 要转换的short值（范围：有符号[-32768, 32767]，无符号[0, 65535]）。
        signed (bool): 是否是有符号short，默认False（无符号）。
        byteorder (str): 字节序，'little'（小端）或 'big'（大端），默认小端。
    
    Returns:
        bytes: 转换后的2字节bytes。
    
    Raises:
        OverflowError: 如果value超出short范围。
    """
    if signed:
        format_char = 'h'  # 有符号short
        min_val, max_val = -32768, 32767
    else:
        format_char = 'H'  # 无符号short
        min_val, max_val = 0, 65535

    if not (min_val <= value <= max_val):
        raise OverflowError(f"Value {value} out of range for {'signed' if signed else 'unsigned'} short")

    # 选择字节序
    prefix = '<' if byteorder == 'little' else '>'
    return struct.pack(f"{prefix}{format_char}", value)
    

def bytes_to_int(byte_data, signed=False, byteorder='little'):
    """
    将 4 字节转换为 int（支持动态字节序）

    :param byte_data: 4 字节数据
    :param signed: 是否解析为有符号整数
    :param byteorder: 字节序 ('big' 或 'little')
    :return: 转换后的 int
    """
    if len(byte_data) != 4:
        raise ValueError("输入必须是 4 字节")
    fmt_char = 'i' if signed else 'I'
    fmt_str = ('>' if byteorder == 'big' else '<') + fmt_char
    return struct.unpack(fmt_str, byte_data)[0]


def int_to_bytes(int_value, signed=False, byteorder='little'):
    """
    将 int 转换为 4 字节（支持动态字节序）

    :param int_value: 需在有效范围内（有符号: -2^31 ~ 2^31-1，无符号: 0 ~ 2^32-1）
    :param signed: 是否处理有符号整数
    :param byteorder: 字节序 ('big' 或 'little')
    :return: 4 字节数据
    """
    if signed and not (-2**31 <= int_value < 2**31):
        raise ValueError("有符号整数超出 4 字节范围")
    elif not signed and not (0 <= int_value < 2**32):
        raise ValueError("无符号整数超出 4 字节范围")
    fmt_char = 'i' if signed else 'I'
    fmt_str = ('>' if byteorder == 'big' else '<') + fmt_char
    return struct.pack(fmt_str, int_value)
