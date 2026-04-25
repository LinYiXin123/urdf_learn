#!/usr/bin/env python

from .genki_def import *


class GroupSyncRead:
    def __init__(self, port, ph, start_address, data_length):
        self.port = port
        self.ph = ph
        self.start_address = start_address
        self.data_length = data_length

        self.last_result = False
        self.is_param_changed = False
        self.param = []
        self.data_dict = {}

        self.clearParam()
        
        GENKI_DEBUG(">>>>>>>>>>>> GroupSyncRead <<<<<<<<<<<<<<")
        GENKI_DEBUG("address: {}  len: {}".format(start_address, data_length))
        GENKI_DEBUG(">>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<")
        
        if ADDRESS_CMD_TABLE.keys().__contains__(start_address) is False or ADDRESS_CMD_TABLE[start_address] is None:
            print("[NOT SUPPORT] start_address: ({}) not support ".format(start_address))

    def makeParam(self):
        if not self.data_dict:  # len(self.data_dict.keys()) == 0:
            return

        self.param = []

        for scs_id in self.data_dict:
            self.param.append(scs_id)

    def addParam(self, scs_id):
        if scs_id in self.data_dict:  # scs_id already exist
            return False

        self.data_dict[scs_id] = []  # [0] * self.data_length

        self.is_param_changed = True
        return True

    def removeParam(self, scs_id):
        if scs_id not in self.data_dict:  # NOT exist
            return

        del self.data_dict[scs_id]

        self.is_param_changed = True

    def clearParam(self):
        self.data_dict.clear()

    def txPacket(self):
        GENKI_DEBUG(">>>>>>>>>>>>>> txPacket <<<<<<<<<<<<<<<<<")
        if len(self.data_dict.keys()) == 0:
            return COMM_NOT_AVAILABLE

        if self.is_param_changed is True or not self.param:
            self.makeParam()

        GENKI_DEBUG("address: {}  len: {}".format(self.start_address, self.data_length))
        GENKI_DEBUG("param: {}".format(self.param))
        
        result = self.ph.syncReadTx(self.port, self.start_address, self.data_length, self.param,
                                  len(self.data_dict.keys()) * 1)
        GENKI_DEBUG("result: {}".format(result))
        GENKI_DEBUG(">>>>>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<<<<<<<")
        return result

    def rxPacket(self):
        #print("group sync read: rx packet")
        self.last_result = False

        result = COMM_RX_FAIL

        if len(self.data_dict.keys()) == 0:
            return COMM_NOT_AVAILABLE

        rxpacket, result = self.ph.rxPacket(self.port)
        
        # for scs_id in self.data_dict:
        #     self.data_dict[scs_id], result, _ = self.ph.readRx(self.port, scs_id, self.data_length)
        #     if result != COMM_SUCCESS:
        #         return result

        if result == COMM_SUCCESS:
            self.last_result = True
            
            pkt_len = rxpacket[3]
            ids_len = len(self.data_dict)
            value_len = int(pkt_len / ids_len)
            for i in range(ids_len):
                self.data_dict[i + 1] = rxpacket[(4 + i * value_len) : (4 + (i + 1) * value_len)]
            
        return result
        

    def txRxPacket(self):        
        GENKI_DEBUG(">>>>>>>>>>>> txRxPacket <<<<<<<<<<<<<<")
        
        result = self.txPacket()
        if result != COMM_SUCCESS:
            return result

        return self.rxPacket()

    def isAvailable(self, scs_id, address, data_length):
        #if self.last_result is False or scs_id not in self.data_dict:
        if scs_id not in self.data_dict:
            return False

        if (address < self.start_address) or (self.start_address + self.data_length - data_length < address):
            return False

        if len(self.data_dict[scs_id])<data_length:
            return False
        return True

    def getData(self, scs_id, address, data_length):
        if not self.isAvailable(scs_id, address, data_length):
            return 0

        if data_length == 1:
            return self.data_dict[scs_id][address - self.start_address]
        elif data_length == 2:
            return GENKI_MAKEWORD(self.data_dict[scs_id][address - self.start_address],
                                self.data_dict[scs_id][address - self.start_address + 1])
        # elif data_length == 4:
        #     return GENKI_MAKEDWORD(GENKI_MAKEWORD(self.data_dict[scs_id][address - self.start_address + 0],
        #                                       self.data_dict[scs_id][address - self.start_address + 1]),
        #                           GENKI_MAKEWORD(self.data_dict[scs_id][address - self.start_address + 2],
        #                                       self.data_dict[scs_id][address - self.start_address + 3]))
        elif data_length == 4:
            value = GENKI_MAKEFLOAT(self.data_dict[scs_id][address - self.start_address], 
                                   self.data_dict[scs_id][address - self.start_address + 1], 
                                   self.data_dict[scs_id][address - self.start_address + 2], 
                                   self.data_dict[scs_id][address - self.start_address + 3], )
            # if scs_id == 6:
            #     return 2048 - int(value * 4069 / 360)  
            # 
            if scs_id == 1:
                value = value - 2
            elif scs_id  == 2:
                value = value + 8
            elif scs_id == 3:
                value = value + 5
            elif scs_id == 4:
                value = value - 3
            elif scs_id == 5:
                value = value + 18
              
            return int(value * 4069 / 360) + 2048
        else:
            return 0