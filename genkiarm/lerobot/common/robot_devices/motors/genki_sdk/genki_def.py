#!/usr/bin/env python

import struct

def _bytes2float(b):
    return struct.unpack('>f', b)[0]


ADDRESS_CMD_TABLE = {
    42: 0x02,      # Goal_position，joint angle
    56: 0x02
}



BROADCAST_ID    = 0xFE  # 254
MAX_ID          = 0xFC  # 252
GENKI_END       = 0

# Instruction for Genki Protocol
INST_PING       = 1
INST_READ       = 2
INST_WRITE      = 3
INST_REG_WRITE  = 4
INST_ACTION     = 5
INST_SYNC_WRITE = 131  # 0x83
INST_SYNC_READ  = 130  # 0x82

# Communication Result
COMM_SUCCESS        = 0  # tx or rx packet communication success
COMM_PORT_BUSY      = -1  # Port is busy (in use)
COMM_TX_FAIL        = -2  # Failed transmit instruction packet
COMM_RX_FAIL        = -3  # Failed get status packet
COMM_TX_ERROR       = -4  # Incorrect instruction packet
COMM_RX_WAITING     = -5  # Now recieving status packet
COMM_RX_TIMEOUT     = -6  # There is no status packet
COMM_RX_CORRUPT     = -7  # Incorrect status packet
COMM_NOT_AVAILABLE  = -9  #


# Macro for Control Table Value
def GENKI_GETEND():
    global GENKI_END
    return GENKI_END

def GENKI_SETEND(e):
    global GENKI_END
    GENKI_END = e

def GENKI_TOHOST(a, b):
    if (a & (1<<b)):
        return -(a & ~(1<<b))
    else:
        return a


def GENKI_TOSCS(a, b):
    if (a<0):
        return (-a | (1<<b))
    else:
        return a


def GENKI_MAKEWORD(a, b):
    global GENKI_END
    if GENKI_END==0:
        return (a & 0xFF) | ((b & 0xFF) << 8)
    else:
        return (b & 0xFF) | ((a & 0xFF) << 8)


def GENKI_MAKEDWORD(a, b):
    return (a & 0xFFFF) | (b & 0xFFFF) << 16


def GENKI_LOWORD(l):
    return l & 0xFFFF


def GENKI_HIWORD(l):
    return (l >> 16) & 0xFFFF


def GENKI_LOBYTE(w):
    global GENKI_END
    if GENKI_END==0:
        return w & 0xFF
    else:
        return (w >> 8) & 0xFF


def GENKI_HIBYTE(w):
    global SCS_END
    if SCS_END==0:
        return (w >> 8) & 0xFF
    else:
        return w & 0xFF
    
    
def GENKI_MAKEFLOAT(a, b, c, d):
    return _bytes2float(bytes([a, b, c, d]))



import inspect
import os

def get_caller_info():
    # 获取当前调用栈
    stack = inspect.stack()
    
    # stack[1] 是调用当前函数的帧
    caller_frame = stack[2]
    
    # 获取调用者的文件名和行号
    # 获取调用者的文件名（包含路径）
    full_filename = caller_frame.filename
    # 使用 os.path.basename 提取文件名（去掉路径）
    filename = os.path.basename(full_filename)
    lineno = caller_frame.lineno
    
    return filename, lineno

DEBUG = 0

def GENKI_DEBUG(str, end='\r\n'):
    if DEBUG != 1: return
    
    filename, lineno = get_caller_info()
    print("[{} line {}]".format(filename, lineno), end=' ')
    print(str, end=end)