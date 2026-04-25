import { MathUtils } from 'three';
// Import feetech SDK for real servo control
import { 
  PortHandler, 
  PacketHandler,
  GroupSyncWrite,
  SCS_LOBYTE,
  SCS_HIBYTE,
  SCS_LOWORD,
  SCS_HIWORD,
} from './feetech/scsservo_sdk.mjs';
// Import constants from our constants file
import {
  COMM_SUCCESS,
  ADDR_SCS_TORQUE_ENABLE,
  ADDR_SCS_GOAL_ACC,
  ADDR_SCS_GOAL_POSITION,
  ADDR_SCS_GOAL_SPEED,
  ADDR_SCS_PRESENT_POSITION,
  ERRBIT_VOLTAGE,
  ERRBIT_ANGLE,
  ERRBIT_OVERHEAT,
  ERRBIT_OVERELE,
  ERRBIT_OVERLOAD
} from './feetech/scsservo_constants.mjs';

const ADDR_SCS_PRESENT_TEMPERATURE = 63;

// Servo control variables
let portHandler = null;
let packetHandler = null;
let isConnectedToRealRobot = false;

// 存储真实舵机的当前位置
let servoCurrentPositions = {
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0
};

// 存储真实舵机的最后一个安全位置
let servoLastSafePositions = {
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0
};

// 舵机通信状态
let servoCommStatus = {
  1: { status: 'idle', lastError: null },
  2: { status: 'idle', lastError: null },
  3: { status: 'idle', lastError: null },
  4: { status: 'idle', lastError: null },
  5: { status: 'idle', lastError: null },
  6: { status: 'idle', lastError: null },
};

const servoFeedbackState = {
  1: { temperature: null, goalRaw: null },
  2: { temperature: null, goalRaw: null },
  3: { temperature: null, goalRaw: null },
  4: { temperature: null, goalRaw: null },
  5: { temperature: null, goalRaw: null },
  6: { temperature: null, goalRaw: null },
};

// 命令队列系统，确保串口操作顺序执行
let commandQueue = [];
let isProcessingQueue = false;

const SERVO_IDS = [1, 2, 3, 4, 5, 6];
const SERVO_DISPLAY_ORDER = [6, 5, 4, 3, 2, 1];
const SERVO_RESOLUTION = 4096;
const SERVO_TICKS_TO_RAD = (Math.PI * 2) / SERVO_RESOLUTION;
const SERVO_TICKS_TO_DEG = 360 / SERVO_RESOLUTION;
const LIVE_SYNC_INTERVAL_MS = 120;
const SERVO_DIRECTION_DEADZONE_DEG = 3;
const RESTORE_ZERO_BUTTON_IDLE_TEXT = '同步缓慢恢复到0°姿态';
const RESTORE_ZERO_STEP_MS = 50;
const RESTORE_ZERO_MS_PER_DEG = 26;
const RESTORE_ZERO_MIN_DURATION_MS = 1600;
const RESTORE_ZERO_MAX_DURATION_MS = 4200;
const RESTORE_ZERO_SPEED_MIN = 40;
const RESTORE_ZERO_SPEED_MAX = 520;
const SLIDER_SYNC_RESUME_DELAY_MS = 260;
const SHOULDER_ASSIST_SUPPORT_SERVO_IDS = Object.freeze([3, 4]);
const SHOULDER_ASSIST_OFFSET_DEG = 45;
const SHOULDER_ASSIST_TARGET_TOLERANCE_TICKS = 28;
const SHOULDER_ASSIST_SUPPORT_MOVE_SPEED = 240;
const SHOULDER_ASSIST_RETURN_MOVE_SPEED = 190;
const SHOULDER_ASSIST_MONITOR_INTERVAL_MS = 120;
const SHOULDER_ASSIST_MONITOR_TIMEOUT_MS = 6000;
const SHOULDER_ASSIST_REISSUE_INTERVAL_MS = 360;
const SERVO_CENTER_POSITIONS = {
  1: 2048,
  2: 2048,
  3: 2048,
  4: 2048,
  5: 2048,
  6: 2048,
};
const SERVO_ZERO_RAW_POSITIONS = Object.freeze({
  // 这组值是已经校好的“模拟器既定 0° 姿态”。
  1: 2002,
  // 2/3/4 号按当前真机零位重新对齐：
  // 旧显示约 +2.5° / +1.4° / +3.7° 时，应视为新的 0°。
  2: 2016,
  3: 2051,
  4: 2040,
  5: 2082,
  6: 2048,
});
const SERVO_ZERO_JOINT_OFFSETS_RAD = Object.freeze({
  1: 0,
  2: 0,
  3: 0,
  4: 0,
  5: 0,
  6: 0,
});
// 真机和当前 URDF 的关节正方向并不完全一致。
// 这里统一把 1-5 号舵机翻转到“用户看到的方向”，夹爪保持原方向。
const SERVO_JOINT_CONFIG = {
  1: { jointIndex: 0, direction: -1, offsetRad: 0 },
  2: { jointIndex: 1, direction: -1, offsetRad: 0 },
  3: { jointIndex: 2, direction: -1, offsetRad: 0 },
  4: { jointIndex: 3, direction: -1, offsetRad: 0 },
  5: { jointIndex: 4, direction: -1, offsetRad: 0 },
  6: { jointIndex: 5, direction: 1, offsetRad: 0 },
};
const SERVO_UI_CONFIG = Object.freeze({
  1: { name: '腰部', servoLabel: '1号舵机', fallbackRangeDeg: 90 },
  2: { name: '大臂', servoLabel: '2号舵机', fallbackRangeDeg: 90 },
  3: { name: '小臂', servoLabel: '3号舵机', fallbackRangeDeg: 90 },
  4: { name: '腕部', servoLabel: '4号舵机', fallbackRangeDeg: 90 },
  5: { name: '腕部', servoLabel: '5号舵机', fallbackRangeDeg: 90 },
  6: { name: '爪子', servoLabel: '6号舵机', fallbackRangeDeg: 80 },
});
const SERVO_SAFETY_PROFILES = Object.freeze({
  2: {
    defaultAcceleration: 7,
    defaultSpeed: 110,
    forwardSpeed: 80,
    forwardDeepSpeed: 58,
    forwardNearLimitSpeed: 42,
    forwardDeepAngleDeg: 35,
    forwardNearLimitAngleDeg: 72,
    forwardSoftLimitAngleDeg: 90,
    forwardRetreatTriggerAngleDeg: 34,
    forwardRetreatStepDeg: -14,
    forwardRetreatSpeed: 48,
    forwardRetreatAcceleration: 5,
    forwardRetreatCooldownMs: 2200,
  },
});
const SERVO_DIRECTION_LABELS = {
  1: { positive: '向右', negative: '向左' },
  2: { positive: '向前', negative: '向后' },
  3: { positive: '向前', negative: '向后' },
  4: { positive: '向前', negative: '向后' },
  5: { positive: '向右', negative: '向左' },
  6: { positive: '张开', negative: '闭合' },
};
const SERVO_STATUS_LABELS = {
  idle: '未连接',
  pending: '通讯中',
  success: '正常',
  warning: '警告',
  error: '错误',
};
const DASHBOARD_PAGES = Object.freeze([
  {
    title: '控制总览',
    caption: '第一页显示滑块控制、状态总览与实时诊断。',
    suggestion: '先连接真机，再观察状态面板和底部六轴角度是否实时同步。',
  },
  {
    title: 'PID 参数',
    caption: '第二页显示 PID 参考档、零位矩阵和偏差热度。',
    suggestion: '参数页用于看 PID 参考、零位原始值和六轴偏差热度，中间模型保持不切页。',
  },
]);
const SERVO_PID_REFERENCE = Object.freeze({
  1: { p: 28, i: 4, d: 16, mode: '姿态' },
  2: { p: 34, i: 6, d: 18, mode: '力臂' },
  3: { p: 32, i: 5, d: 17, mode: '跟随' },
  4: { p: 26, i: 4, d: 15, mode: '细调' },
  5: { p: 24, i: 3, d: 14, mode: '旋转' },
  6: { p: 18, i: 2, d: 10, mode: '夹持' },
});
const DASHBOARD_LAYOUT_STORAGE_KEY = 'urdf_dashboard_layout_v2';
const DASHBOARD_AUTO_SCROLL_SELECTOR = [
  '.stack',
  '.pstack',
  '.metrics',
  '.params',
  '.speed-box',
  '.voice-bridge-box',
  '.servo-slider-panel',
  '.servo-status-grid.compact-status',
  '.servo-telemetry-board',
  '.pid-table',
  '.reference-table',
  '.diagnostic-stack',
  '.notes',
].join(', ');
const DASHBOARD_AUTO_SCROLL_SPEED_PX_PER_SEC = 42;
const DASHBOARD_AUTO_SCROLL_EDGE_HOLD_MS = 320;
const VOICE_BRIDGE_POLL_INTERVAL_MS = 850;
const VOICE_BRIDGE_LOG_LIMIT = 8;
const VOICE_BRIDGE_DIRECTION_ALIASES = Object.freeze({
  left: 'left',
  right: 'right',
  forward: 'forward',
  backward: 'backward',
  back: 'backward',
  open: 'open',
  close: 'close',
  向左: 'left',
  左: 'left',
  向右: 'right',
  右: 'right',
  向前: 'forward',
  前: 'forward',
  向后: 'backward',
  后: 'backward',
  张开: 'open',
  打开: 'open',
  闭合: 'close',
  闭上: 'close',
});
const VOICE_BRIDGE_DIRECTION_SIGNS = Object.freeze({
  1: { left: -1, right: 1 },
  2: { forward: 1, backward: -1 },
  3: { forward: 1, backward: -1 },
  4: { forward: 1, backward: -1 },
  5: { left: -1, right: 1 },
  6: { open: 1, close: -1 },
});
const LEADER_FOLLOWER_TELEOP_INTERVAL_MS = 100;
const LEADER_FOLLOWER_TELEOP_SMOOTHING = 0.45;
const LEADER_FOLLOWER_TELEOP_MIN_DELTA_TICKS = 3;
const MOTION_RECORDING_FILENAME_PREFIX = 'leader_follower_motion';
const PROJECT_MOTION_PLAYBACK_URL = '/motions/leader_follower_motion_20260420_175342.json';
const PROJECT_MOTION_PLAYBACK_ALIGNMENT_SETTLE_MS = 700;
const PROJECT_MOTION_PLAYBACK_ALIGNMENT_SPEED_MIN = 70;
const PROJECT_MOTION_PLAYBACK_ALIGNMENT_SPEED_MAX = 180;

let liveSyncTimer = null;
let liveSyncRunning = false;
let dashboardClockTimer = null;
let restoreZeroButtonResetTimer = null;
let restoreMotionRunId = 0;
let isRestoringToZero = false;
let sliderSyncResumeTimer = null;
let dashboardPageIndex = 0;
let dashboardAutoScrollAnimationId = null;
let dashboardAutoScrollControllers = [];
let servoSupplementalFeedbackCursor = 0;
let voiceBridgeFileHandle = null;
let voiceBridgeMonitorRunning = false;
let voiceBridgePollTimer = null;
let voiceBridgeProcessedLineCount = 0;
let voiceBridgeIsPolling = false;
let voiceBridgeProcessedCommandCount = 0;
let voiceBridgeLogEntries = [];
let voiceBridgeLastCommandSummary = '等待语音指令';
let leaderPortHandler = null;
let leaderPacketHandler = null;
let leaderFollowerTeleopRunning = false;
let leaderFollowerTeleopTimer = null;
let leaderFollowerTeleopBusy = false;
let leaderFollowerTeleopStatusText = '主从待机';
let leaderFollowerTeleopSetupStage = 'idle';
let leaderFollowerTeleopLeaderAnchor = {};
let leaderFollowerTeleopFollowerAnchor = {};
let leaderFollowerTeleopSmoothedLeader = {};
let leaderFollowerTeleopLastTargets = {};
let motionRecordingActive = false;
let motionRecordingStartedAtIso = null;
let motionRecordingStartedPerf = 0;
let motionRecordingSamples = [];
let motionRecordingStatusText = '录制待机';
let motionPlaybackRunning = false;
let motionPlaybackBusy = false;
let motionPlaybackRunId = 0;
let motionPlaybackStatusText = '回放待机';
let projectMotionPlaybackData = null;
const servoSliderCommandState = Object.fromEntries(
  SERVO_IDS.map(servoId => [servoId, { pendingRaw: null, running: false }]),
);
const servoMotionProfileState = Object.fromEntries(
  SERVO_IDS.map(servoId => [servoId, { speed: null, acceleration: null }]),
);
const servoSafetyRetreatState = Object.fromEntries(
  SERVO_IDS.map(servoId => [servoId, { running: false, lastTriggeredAt: 0 }]),
);
const shoulderAssistRecoveryState = {
  active: false,
  running: false,
  monitoring: false,
  shoulderTargetRaw: null,
  supportDeltaDeg: 0,
  lastShoulderCommandAt: 0,
  originalRawPositions: { 3: null, 4: null },
  reliefRawPositions: { 3: null, 4: null },
};

function createServoMap(defaultValue) {
  return Object.fromEntries(SERVO_IDS.map(servoId => [servoId, defaultValue]));
}

function resetShoulderAssistRecoveryState() {
  shoulderAssistRecoveryState.active = false;
  shoulderAssistRecoveryState.running = false;
  shoulderAssistRecoveryState.monitoring = false;
  shoulderAssistRecoveryState.shoulderTargetRaw = null;
  shoulderAssistRecoveryState.supportDeltaDeg = 0;
  shoulderAssistRecoveryState.lastShoulderCommandAt = 0;
  SHOULDER_ASSIST_SUPPORT_SERVO_IDS.forEach(servoId => {
    shoulderAssistRecoveryState.originalRawPositions[servoId] = null;
    shoulderAssistRecoveryState.reliefRawPositions[servoId] = null;
  });
}

function getServoZeroRawPosition(servoId) {
  return SERVO_ZERO_RAW_POSITIONS[servoId] ?? SERVO_CENTER_POSITIONS[servoId] ?? 2048;
}

function getServoZeroJointOffsetRad(servoId) {
  return SERVO_ZERO_JOINT_OFFSETS_RAD[servoId] ?? 0;
}

function getServoDirectionMultiplier(servoId) {
  return SERVO_JOINT_CONFIG[servoId]?.direction || 1;
}

function normalizeServoPositionTicks(positionTicks) {
  const normalized = Math.round(positionTicks) % SERVO_RESOLUTION;
  return normalized < 0 ? normalized + SERVO_RESOLUTION : normalized;
}

function sleepMs(delayMs) {
  return new Promise(resolve => window.setTimeout(resolve, delayMs));
}

function easeInOutCubic(progress) {
  if (progress < 0.5) {
    return 4 * progress * progress * progress;
  }

  return 1 - (Math.pow(-2 * progress + 2, 3) / 2);
}

function initializeVirtualServoState(force = false) {
  const needsInitialization = force || SERVO_IDS.every(
    servoId => servoCurrentPositions[servoId] === 0 && servoLastSafePositions[servoId] === 0,
  );

  if (!needsInitialization) {
    return;
  }

  SERVO_IDS.forEach(servoId => {
    const zeroPosition = getServoZeroRawPosition(servoId);
    servoCurrentPositions[servoId] = zeroPosition;
    servoLastSafePositions[servoId] = zeroPosition;
  });
}

function getServoUiConfig(servoId) {
  return SERVO_UI_CONFIG[servoId] ?? {
    name: `舵机${servoId}`,
    servoLabel: `${servoId}号舵机`,
    fallbackRangeDeg: 180,
  };
}

function getServoStatusKey(servoId) {
  return servoCommStatus[servoId]?.status ?? 'idle';
}

function getServoStatusDataState(servoId) {
  const status = getServoStatusKey(servoId);
  if (status === 'success') {
    return 'success';
  }

  if (status === 'warning') {
    return 'warning';
  }

  if (status === 'error') {
    return 'error';
  }

  return 'idle';
}

function getServoStatusAccentColor(servoId) {
  const status = getServoStatusKey(servoId);
  if (status === 'success') {
    return '#29e0a0';
  }

  if (status === 'warning') {
    return '#ffbf4d';
  }

  if (status === 'error') {
    return '#ff6c7a';
  }

  return '#58d7ff';
}

function getServoAlertCount() {
  return SERVO_IDS.filter(servoId => {
    const status = getServoStatusKey(servoId);
    return status === 'warning' || status === 'error';
  }).length;
}

function getServoOnlineCount() {
  return SERVO_IDS.filter(servoId => getServoStatusKey(servoId) === 'success').length;
}

function formatScaleLimitLabel(directionLabel, angleDeg) {
  if (!Number.isFinite(angleDeg)) {
    return `${directionLabel} --`;
  }

  return `${directionLabel} ${Math.abs(angleDeg).toFixed(0)}°`;
}

function formatSignedAngle(angleDeg) {
  if (!Number.isFinite(angleDeg)) {
    return '--';
  }

  return `${angleDeg >= 0 ? '+' : ''}${angleDeg.toFixed(1)}°`;
}

function formatTelemetryRawValue(rawValue) {
  if (!Number.isFinite(rawValue)) {
    return '--';
  }

  return `${normalizeServoPositionTicks(rawValue)}`;
}

function formatTelemetryTemperatureValue(temperatureValue) {
  if (!Number.isFinite(temperatureValue)) {
    return '--';
  }

  return `${Math.round(temperatureValue)}°C`;
}

function getServoFeedbackGoalRaw(servoId) {
  const pendingRaw = servoSliderCommandState[servoId]?.pendingRaw;
  if (Number.isFinite(pendingRaw)) {
    return normalizeServoPositionTicks(pendingRaw);
  }

  const cachedGoal = servoFeedbackState[servoId]?.goalRaw;
  if (Number.isFinite(cachedGoal)) {
    return normalizeServoPositionTicks(cachedGoal);
  }

  const currentRaw = servoCurrentPositions[servoId];
  if (Number.isFinite(currentRaw) && currentRaw !== 0) {
    return normalizeServoPositionTicks(currentRaw);
  }

  return getServoZeroRawPosition(servoId);
}

function getServoFeedbackStatusMeta(servoId) {
  const currentStatus = getServoStatusKey(servoId);
  const lastError = String(servoCommStatus[servoId]?.lastError ?? '');

  if (!isConnectedToRealRobot) {
    return { label: '超时', state: 'timeout' };
  }

  if (
    (currentStatus === 'error' || currentStatus === 'warning')
    && (lastError.includes('过载') || lastError.includes('卡死'))
  ) {
    return { label: '过载', state: 'overload' };
  }

  if (currentStatus === 'error' || currentStatus === 'warning' || currentStatus === 'idle') {
    return { label: '超时', state: 'timeout' };
  }

  return { label: '正常', state: 'normal' };
}

function resetServoFeedbackTelemetry() {
  servoSupplementalFeedbackCursor = 0;
  SERVO_IDS.forEach(servoId => {
    servoFeedbackState[servoId].temperature = null;
    servoFeedbackState[servoId].goalRaw = Number.isFinite(servoCurrentPositions[servoId]) && servoCurrentPositions[servoId] !== 0
      ? normalizeServoPositionTicks(servoCurrentPositions[servoId])
      : getServoZeroRawPosition(servoId);
  });
}

function updateRestoreZeroHint(message = null, tone = 'default') {
  const hintElement = document.getElementById('restoreZeroPoseHint');
  if (!hintElement) {
    updateDashboardUI();
    return;
  }

  hintElement.className = 'restore-pose-hint';
  if (tone === 'success') {
    hintElement.classList.add('success');
  } else if (tone === 'error') {
    hintElement.classList.add('error');
  }

  if (message) {
    hintElement.textContent = message;
    updateDashboardUI();
    return;
  }

  if (isConnectedToRealRobot) {
    hintElement.textContent = '点一下后，真机会按当前偏差比例同步恢复到模拟器既定 0° 姿态，并尽量同一时刻到位。';
    updateDashboardUI();
    return;
  }

  hintElement.textContent = '未连接真机时，按钮会只让模拟器平滑同步回到既定 0° 姿态。';
  updateDashboardUI();
}

function getServoAngleDegreesFromRawPosition(servoId, rawPosition) {
  const deltaTicks = normalizeServoDelta(rawPosition - getServoZeroRawPosition(servoId));
  return deltaTicks * SERVO_TICKS_TO_DEG * getServoDirectionMultiplier(servoId);
}

function getServoTargetRawPositionFromAngleDegrees(servoId, angleDeg) {
  const direction = getServoDirectionMultiplier(servoId);
  return normalizeServoPositionTicks(
    getServoZeroRawPosition(servoId) + (angleDeg / SERVO_TICKS_TO_DEG / direction),
  );
}

function buildAdjustedServoPosition(position) {
  const clampedPosition = Math.max(0, Math.min(4095, Math.round(position)));
  const lowByte = (clampedPosition & 0xFF00) >> 8;
  const highByte = (clampedPosition & 0x00FF) << 8;
  return (clampedPosition & 0xFFFF0000) | highByte | lowByte;
}

function getServoCurrentRawPositionOrZero(servoId) {
  const currentRaw = servoCurrentPositions[servoId];
  if (Number.isFinite(currentRaw) && currentRaw !== 0) {
    return normalizeServoPositionTicks(currentRaw);
  }

  return getServoZeroRawPosition(servoId);
}

function cloneServoRawMap(rawMap) {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const value = rawMap?.[servoId];
      return [servoId, Number.isFinite(value) ? normalizeServoPositionTicks(value) : null];
    }),
  );
}

function buildCurrentServoRawMap() {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => [servoId, getServoCurrentRawPositionOrZero(servoId)]),
  );
}

function buildServoAngleMap(rawMap) {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const rawValue = rawMap?.[servoId];
      if (!Number.isFinite(rawValue)) {
        return [servoId, null];
      }

      return [servoId, Number(getServoAngleDegreesFromRawPosition(servoId, rawValue).toFixed(3))];
    }),
  );
}

function buildServoSpeedMap(speedValues) {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const value = speedValues?.[servoId];
      return [servoId, Number.isFinite(value) ? Math.round(value) : null];
    }),
  );
}

function buildMotionRecordingTimestampLabel() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function downloadTextFile(filename, contents, mimeType = 'application/json') {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function createUniformServoMap(value) {
  return Object.fromEntries(SERVO_IDS.map(servoId => [servoId, value]));
}

function clampPlaybackTargetRawMap(rawMap) {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const rawValue = Number.isFinite(rawMap?.[servoId])
        ? normalizeServoPositionTicks(rawMap[servoId])
        : getServoCurrentRawPositionOrZero(servoId);
      const requestedAngleDeg = getServoAngleDegreesFromRawPosition(servoId, rawValue);
      const safeAngleDeg = clampServoTargetAngleDegrees(servoId, requestedAngleDeg, { showAlertOnClamp: false });
      return [servoId, getServoTargetRawPositionFromAngleDegrees(servoId, safeAngleDeg)];
    }),
  );
}

function applyServoRawMapToDashboard(rawMap, options = {}) {
  const { updateLastSafe = false } = options;
  const safeRawMap = clampPlaybackTargetRawMap(rawMap);

  SERVO_IDS.forEach(servoId => {
    const normalizedTargetRaw = normalizeServoPositionTicks(safeRawMap[servoId]);
    servoCurrentPositions[servoId] = normalizedTargetRaw;
    servoFeedbackState[servoId].goalRaw = normalizedTargetRaw;
    if (updateLastSafe) {
      servoLastSafePositions[servoId] = normalizedTargetRaw;
    }
  });

  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();
  updateServoSliderUI();
  updateServoTelemetryBoard();
  return safeRawMap;
}

function buildPlaybackAlignmentSpeedMap(currentRawMap, targetRawMap) {
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const currentRaw = Number.isFinite(currentRawMap?.[servoId])
        ? normalizeServoPositionTicks(currentRawMap[servoId])
        : getServoCurrentRawPositionOrZero(servoId);
      const targetRaw = Number.isFinite(targetRawMap?.[servoId])
        ? normalizeServoPositionTicks(targetRawMap[servoId])
        : currentRaw;
      const deltaTicks = Math.abs(normalizeServoDelta(targetRaw - currentRaw));
      const speedValue = clampServoSpeed(
        Math.round(
          PROJECT_MOTION_PLAYBACK_ALIGNMENT_SPEED_MIN
          + Math.min(1, deltaTicks / 480) * (PROJECT_MOTION_PLAYBACK_ALIGNMENT_SPEED_MAX - PROJECT_MOTION_PLAYBACK_ALIGNMENT_SPEED_MIN)
        ),
      );
      return [servoId, speedValue];
    }),
  );
}

function getMotionPlaybackStartRawMap(playbackData) {
  if (playbackData?.follower_anchor_raw) {
    return cloneServoRawMap(playbackData.follower_anchor_raw);
  }

  const firstSample = playbackData?.samples?.[0];
  return cloneServoRawMap(
    firstSample?.follower_before_raw
    ?? firstSample?.follower_target_raw
    ?? firstSample?.follower_after_raw
    ?? buildCurrentServoRawMap(),
  );
}

function getMotionPlaybackSampleTargetRawMap(sample) {
  return cloneServoRawMap(
    sample?.follower_target_raw
    ?? sample?.follower_after_raw
    ?? sample?.follower_before_raw
    ?? buildCurrentServoRawMap(),
  );
}

function getMotionPlaybackSampleSpeedMap(sample) {
  const rawSpeedMap = sample?.speed_values ?? createUniformServoMap(90);
  return Object.fromEntries(
    SERVO_IDS.map(servoId => {
      const speedValue = rawSpeedMap?.[servoId];
      return [servoId, clampServoSpeed(Number.isFinite(speedValue) ? speedValue : 90)];
    }),
  );
}

async function loadProjectMotionPlaybackData() {
  if (projectMotionPlaybackData) {
    return projectMotionPlaybackData;
  }

  const response = await fetch(PROJECT_MOTION_PLAYBACK_URL, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`加载项目动作失败：HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload?.samples) || payload.samples.length === 0) {
    throw new Error('项目动作文件中没有可回放的 samples。');
  }

  projectMotionPlaybackData = payload;
  return projectMotionPlaybackData;
}

function clampServoAngleWithinLimits(servoId, angleDeg) {
  const limits = getServoSliderLimitsDegrees(servoId, window.robot);
  return Math.max(limits.min, Math.min(limits.max, angleDeg));
}

function getShoulderAssistTravelDirection(shoulderTargetRaw) {
  const currentAngleDeg = getServoAngleDegrees(2);
  const targetAngleDeg = getServoAngleDegreesFromRawPosition(2, shoulderTargetRaw);
  const angleDeltaDeg = targetAngleDeg - currentAngleDeg;

  if (Math.abs(angleDeltaDeg) >= 1) {
    return angleDeltaDeg > 0 ? 1 : -1;
  }

  if (Math.abs(currentAngleDeg) >= SERVO_DIRECTION_DEADZONE_DEG) {
    return currentAngleDeg > 0 ? 1 : -1;
  }

  return 0;
}

function isServoNearRawTarget(servoId, targetRaw, toleranceTicks = SHOULDER_ASSIST_TARGET_TOLERANCE_TICKS) {
  const currentRaw = getServoCurrentRawPositionOrZero(servoId);
  return Math.abs(normalizeServoDelta(currentRaw - targetRaw)) <= toleranceTicks;
}

async function commandServoRawPosition(servoId, targetRaw, options = {}) {
  const {
    skipLimitCheck = true,
    updateLastSafe = true,
  } = options;

  const previousRaw = getServoCurrentRawPositionOrZero(servoId);
  const normalizedTargetRaw = normalizeServoPositionTicks(targetRaw);

  servoFeedbackState[servoId].goalRaw = normalizedTargetRaw;
  servoCurrentPositions[servoId] = normalizedTargetRaw;
  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();

  const success = await writeServoPosition(servoId, normalizedTargetRaw, skipLimitCheck);
  if (success) {
    if (updateLastSafe) {
      servoLastSafePositions[servoId] = normalizedTargetRaw;
    }
    return true;
  }

  servoCurrentPositions[servoId] = previousRaw;
  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();
  return false;
}

async function syncWriteSelectedServoPositionsWithSpeeds(servoIds, targetPositions, speedValues = {}) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler || servoIds.length === 0) {
    return false;
  }

  return queueCommand(async () => {
    const syncWrite = new GroupSyncWrite(
      portHandler,
      packetHandler,
      ADDR_SCS_GOAL_POSITION,
      6,
    );

    try {
      for (const servoId of servoIds) {
        const normalizedTarget = normalizeServoPositionTicks(targetPositions[servoId] ?? getServoCurrentRawPositionOrZero(servoId));
        const adjustedTarget = buildAdjustedServoPosition(normalizedTarget);
        const speedValue = clampServoSpeed(speedValues[servoId] ?? 0);
        const data = [
          SCS_LOBYTE(SCS_LOWORD(adjustedTarget)),
          SCS_HIBYTE(SCS_LOWORD(adjustedTarget)),
          SCS_LOBYTE(SCS_HIWORD(adjustedTarget)),
          SCS_HIBYTE(SCS_HIWORD(adjustedTarget)),
          SCS_LOBYTE(speedValue),
          SCS_HIBYTE(speedValue),
        ];

        const added = syncWrite.addParam(servoId, data);
        if (!added) {
          throw new Error(`辅助联动参数写入失败：舵机 ${servoId}`);
        }
      }

      const result = await syncWrite.txPacket();
      if (result !== COMM_SUCCESS) {
        throw new Error(`辅助联动同步写入失败，代码：${result}`);
      }

      return true;
    } catch (error) {
      console.error('Selected sync write failed:', error);
      return false;
    } finally {
      syncWrite.clearParam();
    }
  });
}

async function moveShoulderSupportServos(rawPositionMap, options = {}) {
  const {
    speed = SHOULDER_ASSIST_SUPPORT_MOVE_SPEED,
    updateLastSafe = true,
  } = options;
  const previousRawPositions = {};
  const targetSpeedMap = {};

  for (const servoId of SHOULDER_ASSIST_SUPPORT_SERVO_IDS) {
    const targetRaw = rawPositionMap[servoId];
    if (!Number.isFinite(targetRaw)) {
      continue;
    }

    previousRawPositions[servoId] = getServoCurrentRawPositionOrZero(servoId);
    const normalizedTarget = normalizeServoPositionTicks(targetRaw);
    targetSpeedMap[servoId] = speed;
    servoFeedbackState[servoId].goalRaw = normalizedTarget;
    servoCurrentPositions[servoId] = normalizedTarget;
  }

  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();

  const success = await syncWriteSelectedServoPositionsWithSpeeds(
    SHOULDER_ASSIST_SUPPORT_SERVO_IDS,
    rawPositionMap,
    targetSpeedMap,
  );

  if (success) {
    if (updateLastSafe) {
      SHOULDER_ASSIST_SUPPORT_SERVO_IDS.forEach(servoId => {
        if (Number.isFinite(rawPositionMap[servoId])) {
          servoLastSafePositions[servoId] = normalizeServoPositionTicks(rawPositionMap[servoId]);
        }
      });
    }
    return true;
  }

  SHOULDER_ASSIST_SUPPORT_SERVO_IDS.forEach(servoId => {
    if (Number.isFinite(previousRawPositions[servoId])) {
      servoCurrentPositions[servoId] = previousRawPositions[servoId];
    }
  });
  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();
  return false;
}

async function monitorShoulderAssistRecovery() {
  if (
    shoulderAssistRecoveryState.monitoring
    || !shoulderAssistRecoveryState.active
    || !Number.isFinite(shoulderAssistRecoveryState.shoulderTargetRaw)
  ) {
    return;
  }

  shoulderAssistRecoveryState.monitoring = true;
  const monitorStartedAt = Date.now();

  try {
    while (shoulderAssistRecoveryState.active && isConnectedToRealRobot && portHandler?.isOpen) {
      if (Date.now() - monitorStartedAt > SHOULDER_ASSIST_MONITOR_TIMEOUT_MS) {
        break;
      }

      await sleepMs(SHOULDER_ASSIST_MONITOR_INTERVAL_MS);

      const currentShoulderRaw = await readServoPosition(2, { silent: true });
      if (currentShoulderRaw !== null) {
        servoCurrentPositions[2] = currentShoulderRaw;
        applyServoPoseToRobot(window.robot);
        updateServoStatusUI();
      }

      if (isServoNearRawTarget(2, shoulderAssistRecoveryState.shoulderTargetRaw)) {
        await maybeRestoreShoulderAssistRecovery();
        return;
      }

      if (Date.now() - shoulderAssistRecoveryState.lastShoulderCommandAt >= SHOULDER_ASSIST_REISSUE_INTERVAL_MS) {
        const currentShoulderAngleDeg = getServoAngleDegrees(2);
        const targetShoulderAngleDeg = getServoAngleDegreesFromRawPosition(
          2,
          shoulderAssistRecoveryState.shoulderTargetRaw,
        );

        await ensureServoMotionProfile(2, currentShoulderAngleDeg, targetShoulderAngleDeg);
        await commandServoRawPosition(2, shoulderAssistRecoveryState.shoulderTargetRaw, {
          skipLimitCheck: true,
          updateLastSafe: false,
        });
        shoulderAssistRecoveryState.lastShoulderCommandAt = Date.now();
      }
    }
  } finally {
    shoulderAssistRecoveryState.monitoring = false;
  }
}

async function activateShoulderAssistRecovery(errorMessage = '') {
  if (!isConnectedToRealRobot || !portHandler?.isOpen) {
    return false;
  }

  const shoulderTargetRaw = normalizeServoPositionTicks(getServoFeedbackGoalRaw(2));
  shoulderAssistRecoveryState.shoulderTargetRaw = shoulderTargetRaw;

  if (shoulderAssistRecoveryState.active || shoulderAssistRecoveryState.running || shoulderAssistRecoveryState.monitoring) {
    if (!shoulderAssistRecoveryState.monitoring) {
      void monitorShoulderAssistRecovery();
    }
    return true;
  }

  const travelDirection = getShoulderAssistTravelDirection(shoulderTargetRaw);
  if (travelDirection === 0) {
    return false;
  }

  shoulderAssistRecoveryState.running = true;

  try {
    stopLiveServoSync();

    if (!shoulderAssistRecoveryState.active) {
      shoulderAssistRecoveryState.active = true;
      shoulderAssistRecoveryState.supportDeltaDeg = travelDirection > 0
        ? -SHOULDER_ASSIST_OFFSET_DEG
        : SHOULDER_ASSIST_OFFSET_DEG;

      SHOULDER_ASSIST_SUPPORT_SERVO_IDS.forEach(servoId => {
        const currentRaw = getServoCurrentRawPositionOrZero(servoId);
        const currentAngleDeg = getServoAngleDegreesFromRawPosition(servoId, currentRaw);
        const reliefAngleDeg = clampServoAngleWithinLimits(
          servoId,
          currentAngleDeg + shoulderAssistRecoveryState.supportDeltaDeg,
        );

        shoulderAssistRecoveryState.originalRawPositions[servoId] = currentRaw;
        shoulderAssistRecoveryState.reliefRawPositions[servoId] = getServoTargetRawPositionFromAngleDegrees(
          servoId,
          reliefAngleDeg,
        );
      });

      await moveShoulderSupportServos(shoulderAssistRecoveryState.reliefRawPositions, {
        speed: SHOULDER_ASSIST_SUPPORT_MOVE_SPEED,
        updateLastSafe: false,
      });
      await sleepMs(140);
      showAlert(
        'servo',
        `2号舵机检测到过载或卡死，3号和4号已反向卸力45°，等待2号回到目标位置后会自动恢复。${errorMessage ? ` 原因：${errorMessage}` : ''}`,
        4800,
      );
    }

    shoulderAssistRecoveryState.shoulderTargetRaw = shoulderTargetRaw;

    const currentShoulderAngleDeg = getServoAngleDegrees(2);
    const targetShoulderAngleDeg = getServoAngleDegreesFromRawPosition(2, shoulderTargetRaw);
    await ensureServoMotionProfile(2, currentShoulderAngleDeg, targetShoulderAngleDeg);
    await commandServoRawPosition(2, shoulderTargetRaw, {
      skipLimitCheck: true,
      updateLastSafe: false,
    });
    shoulderAssistRecoveryState.lastShoulderCommandAt = Date.now();
    void monitorShoulderAssistRecovery();

    return true;
  } catch (error) {
    console.error('Shoulder assist recovery failed:', error);
    return false;
  } finally {
    shoulderAssistRecoveryState.running = false;
    scheduleLiveSyncResume(320);
  }
}

async function maybeRestoreShoulderAssistRecovery() {
  if (
    !shoulderAssistRecoveryState.active
    || shoulderAssistRecoveryState.running
    || !Number.isFinite(shoulderAssistRecoveryState.shoulderTargetRaw)
  ) {
    return false;
  }

  if (!isServoNearRawTarget(2, shoulderAssistRecoveryState.shoulderTargetRaw)) {
    return false;
  }

  shoulderAssistRecoveryState.running = true;

  try {
    stopLiveServoSync();
    await moveShoulderSupportServos(shoulderAssistRecoveryState.originalRawPositions, {
      speed: SHOULDER_ASSIST_RETURN_MOVE_SPEED,
      updateLastSafe: false,
    });
    SHOULDER_ASSIST_SUPPORT_SERVO_IDS.forEach(servoId => {
      const restoredRaw = shoulderAssistRecoveryState.originalRawPositions[servoId];
      if (Number.isFinite(restoredRaw)) {
        servoLastSafePositions[servoId] = normalizeServoPositionTicks(restoredRaw);
      }
    });
    showAlert('servo', '2号舵机已回到目标位置，3号和4号已恢复原本姿态。', 3600);
    resetShoulderAssistRecoveryState();
    return true;
  } catch (error) {
    console.error('Shoulder assist restore failed:', error);
    return false;
  } finally {
    shoulderAssistRecoveryState.running = false;
    scheduleLiveSyncResume(320);
  }
}

function clampServoSpeed(speed) {
  return Math.max(0, Math.min(2000, Math.round(speed)));
}

function calculateRestoreDurationMs(maxDeltaDeg) {
  return Math.min(
    RESTORE_ZERO_MAX_DURATION_MS,
    Math.max(RESTORE_ZERO_MIN_DURATION_MS, maxDeltaDeg * RESTORE_ZERO_MS_PER_DEG),
  );
}

function calculateRestoreSpeedValue(distanceTicks, durationMs) {
  if (distanceTicks <= 0 || durationMs <= 0) {
    return 0;
  }

  const ticksPerSecond = distanceTicks / (durationMs / 1000);
  const scaledSpeed = clampServoSpeed(ticksPerSecond);
  if (scaledSpeed <= 0) {
    return RESTORE_ZERO_SPEED_MIN;
  }

  return Math.max(RESTORE_ZERO_SPEED_MIN, Math.min(RESTORE_ZERO_SPEED_MAX, scaledSpeed));
}

function getServoSafetyProfile(servoId) {
  return SERVO_SAFETY_PROFILES[servoId] ?? null;
}

function getServoProtectedMotionConfig(servoId, currentAngleDeg, targetAngleDeg) {
  const profile = getServoSafetyProfile(servoId);
  if (!profile) {
    return { speed: null, acceleration: null };
  }

  let speed = profile.defaultSpeed ?? null;
  const acceleration = profile.defaultAcceleration ?? null;

  if (servoId === 2) {
    const movingForward = Number.isFinite(currentAngleDeg) && Number.isFinite(targetAngleDeg)
      ? targetAngleDeg > currentAngleDeg
      : targetAngleDeg > 0;

    if (movingForward) {
      speed = profile.forwardSpeed ?? speed;

      if (targetAngleDeg >= profile.forwardDeepAngleDeg) {
        speed = profile.forwardDeepSpeed ?? speed;
      }

      if (targetAngleDeg >= profile.forwardNearLimitAngleDeg) {
        speed = profile.forwardNearLimitSpeed ?? speed;
      }
    }
  }

  return { speed, acceleration };
}

function clampServoTargetAngleDegrees(servoId, targetAngleDeg, options = {}) {
  const { showAlertOnClamp = false } = options;
  const profile = getServoSafetyProfile(servoId);
  if (!profile || !Number.isFinite(targetAngleDeg)) {
    return targetAngleDeg;
  }

  let clampedAngleDeg = targetAngleDeg;

  if (Number.isFinite(profile.forwardSoftLimitAngleDeg) && clampedAngleDeg > profile.forwardSoftLimitAngleDeg) {
    clampedAngleDeg = profile.forwardSoftLimitAngleDeg;

    if (showAlertOnClamp) {
      const servoName = getServoUiConfig(servoId).name;
      showAlert('joint', `${servoName}向前已进入保护区，已自动限制到安全范围。`, 2600);
    }
  }

  return clampedAngleDeg;
}

function applyServoProtectedSpeedCap(servoId, currentAngleDeg, targetAngleDeg, speedValue) {
  const { speed } = getServoProtectedMotionConfig(servoId, currentAngleDeg, targetAngleDeg);
  if (!Number.isFinite(speed)) {
    return speedValue;
  }

  return Math.min(speedValue, speed);
}

async function ensureServoMotionProfile(servoId, currentAngleDeg, targetAngleDeg) {
  const { speed, acceleration } = getServoProtectedMotionConfig(servoId, currentAngleDeg, targetAngleDeg);
  const appliedState = servoMotionProfileState[servoId];

  if (Number.isFinite(acceleration) && appliedState.acceleration !== acceleration) {
    const success = await writeServoAcceleration(servoId, acceleration);
    if (success) {
      appliedState.acceleration = acceleration;
    }
  }

  if (Number.isFinite(speed) && appliedState.speed !== speed) {
    const success = await writeServoSpeed(servoId, speed);
    if (success) {
      appliedState.speed = speed;
    }
  }
}

async function triggerServoSafetyRetreat(servoId, errorMessage = '', options = {}) {
  const { reason = 'overload' } = options;
  const profile = getServoSafetyProfile(servoId);
  if (!profile || !isConnectedToRealRobot || !portHandler?.isOpen) {
    return;
  }

  const retreatState = servoSafetyRetreatState[servoId];
  const now = Date.now();
  if (retreatState.running || (now - retreatState.lastTriggeredAt) < (profile.forwardRetreatCooldownMs ?? 1500)) {
    return;
  }

  const currentAngleDeg = getServoAngleDegrees(servoId);
  if (!Number.isFinite(currentAngleDeg)) {
    return;
  }

  if (
    reason !== 'overload'
    && currentAngleDeg < (profile.forwardRetreatTriggerAngleDeg ?? 20)
  ) {
    return;
  }

  retreatState.running = true;
  retreatState.lastTriggeredAt = now;

  try {
    if (reason === 'overload') {
      if (shoulderAssistRecoveryState.active || shoulderAssistRecoveryState.running || shoulderAssistRecoveryState.monitoring) {
        void monitorShoulderAssistRecovery();
        return;
      }

      const assistStarted = await activateShoulderAssistRecovery(errorMessage);
      if (assistStarted) {
        return;
      }
    }

    stopLiveServoSync();

    const retreatStepDeg = currentAngleDeg >= 0
      ? (profile.forwardRetreatStepDeg ?? -10)
      : Math.abs(profile.forwardRetreatStepDeg ?? 10);
    const safeTargetAngleDeg = clampServoAngleWithinLimits(
      servoId,
      currentAngleDeg + retreatStepDeg,
    );
    const safeTargetRaw = getServoTargetRawPositionFromAngleDegrees(servoId, safeTargetAngleDeg);

    await writeServoAcceleration(servoId, profile.forwardRetreatAcceleration ?? profile.defaultAcceleration ?? 6);
    await writeServoSpeed(servoId, profile.forwardRetreatSpeed ?? profile.forwardDeepSpeed ?? profile.defaultSpeed ?? 50);

    servoCurrentPositions[servoId] = safeTargetRaw;
    const success = await writeServoPosition(servoId, safeTargetRaw, true);

    if (success) {
      servoLastSafePositions[servoId] = safeTargetRaw;
      applyServoPoseToRobot(window.robot);
      updateServoStatusUI();
      showAlert('servo', `2号舵机已触发保护，已自动回退到更安全的位置。${errorMessage ? ` 原因：${errorMessage}` : ''}`, 4200);
    }
  } catch (error) {
    console.error(`Safety retreat failed for servo ${servoId}:`, error);
  } finally {
    retreatState.running = false;
    scheduleLiveSyncResume(450);
  }
}

function getServoSliderLimitsDegrees(servoId, robot = window.robot) {
  const uiConfig = getServoUiConfig(servoId);
  const fallbackRangeDeg = uiConfig.fallbackRangeDeg ?? 180;

  if (!robot || !robot.joints) {
    const minDeg = clampServoTargetAngleDegrees(servoId, -fallbackRangeDeg);
    return { min: minDeg, max: fallbackRangeDeg };
  }

  const jointNames = getRobotJointNames(robot);
  const jointConfig = SERVO_JOINT_CONFIG[servoId];
  if (!jointConfig || jointConfig.jointIndex >= jointNames.length) {
    const minDeg = clampServoTargetAngleDegrees(servoId, -fallbackRangeDeg);
    return { min: minDeg, max: fallbackRangeDeg };
  }

  const jointName = jointNames[jointConfig.jointIndex];
  const joint = robot.joints[jointName];
  if (
    !joint ||
    joint.jointType === 'continuous' ||
    joint.jointType === 'fixed' ||
    joint.ignoreLimits ||
    !joint.limit ||
    !Number.isFinite(joint.limit.lower) ||
    !Number.isFinite(joint.limit.upper)
  ) {
    const minDeg = clampServoTargetAngleDegrees(servoId, -fallbackRangeDeg);
    return { min: minDeg, max: fallbackRangeDeg };
  }

  const zeroJointOffset = getServoZeroJointOffsetRad(servoId);
  const direction = jointConfig.direction || 1;
  const lowerDeg = MathUtils.radToDeg((joint.limit.lower - zeroJointOffset) / direction);
  const upperDeg = MathUtils.radToDeg((joint.limit.upper - zeroJointOffset) / direction);
  const minDeg = Math.min(lowerDeg, upperDeg);
  const maxDeg = Math.max(lowerDeg, upperDeg);

  if (!Number.isFinite(minDeg) || !Number.isFinite(maxDeg) || minDeg === maxDeg) {
    const minDeg = clampServoTargetAngleDegrees(servoId, -fallbackRangeDeg);
    return { min: minDeg, max: fallbackRangeDeg };
  }

  return {
    min: clampServoTargetAngleDegrees(servoId, minDeg),
    max: maxDeg,
  };
}

function updateServoSliderVisual(sliderElement, value, min, max) {
  if (!sliderElement || max <= min) {
    return;
  }

  const zeroPercent = ((0 - min) / (max - min)) * 100;
  const valuePercent = ((value - min) / (max - min)) * 100;
  const activeStart = Math.max(0, Math.min(100, Math.min(zeroPercent, valuePercent)));
  const activeEnd = Math.max(0, Math.min(100, Math.max(zeroPercent, valuePercent)));

  sliderElement.style.setProperty('--slider-zero', `${Math.max(0, Math.min(100, zeroPercent))}%`);
  sliderElement.style.setProperty('--slider-active-start', `${activeStart}%`);
  sliderElement.style.setProperty('--slider-active-end', `${activeEnd}%`);
}

function renderServoSliderPanel() {
  const sliderPanel = document.getElementById('servoSliderPanel');
  if (!sliderPanel) {
    return;
  }

  sliderPanel.innerHTML = SERVO_DISPLAY_ORDER.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);
    return `
      <div class="servo-row" id="servo-${servoId}-card">
        <div class="servo-row-head">
          <div class="servo-row-main">
            <div class="servo-slider-name">${uiConfig.name}</div>
            <div class="servo-slider-id">${uiConfig.servoLabel}</div>
          </div>
          <div id="servo-${servoId}-angle" class="servo-angle-chip">+0.0°</div>
        </div>
        <div class="servo-row-meta">
          <div id="servo-${servoId}-direction" class="servo-direction-text">方向：中位</div>
          <div id="servo-${servoId}-mini-status" class="servo-mini-status" data-state="idle">未连接</div>
        </div>
        <input
          id="servo-${servoId}-slider"
          class="servo-slider-control"
          type="range"
          min="-180"
          max="180"
          step="0.1"
          value="0"
        />
        <div class="servo-slider-scale">
          <span id="servo-${servoId}-scale-start">向前 90°</span>
          <span>0° 零位</span>
          <span id="servo-${servoId}-scale-end">向后 90°</span>
        </div>
      </div>
    `;
  }).join('');

  SERVO_IDS.forEach(servoId => {
    const sliderElement = document.getElementById(`servo-${servoId}-slider`);
    if (!sliderElement) {
      return;
    }

    sliderElement.addEventListener('input', event => {
      const nextAngleDeg = Number.parseFloat(event.target.value);
      handleServoSliderInput(servoId, nextAngleDeg);
    });
  });

  updateServoSliderUI();
}

function renderServoTelemetryBoard() {
  const telemetryBoard = document.getElementById('servoTelemetryBoard');
  if (!telemetryBoard) {
    return;
  }

  telemetryBoard.innerHTML = SERVO_DISPLAY_ORDER.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);
    return `
      <div class="telemetry-card" id="telemetry-${servoId}-card">
        <div class="telemetry-feedback-grid telemetry-feedback-grid-top">
          <div class="telemetry-feedback">
            <span class="telemetry-feedback-label">温度</span>
            <strong id="telemetry-${servoId}-temp" class="telemetry-feedback-value">--</strong>
          </div>
          <div class="telemetry-feedback">
            <span class="telemetry-feedback-label">目标</span>
            <strong id="telemetry-${servoId}-goal" class="telemetry-feedback-value">--</strong>
          </div>
        </div>
        <div class="telemetry-ring" id="telemetry-${servoId}-ring">
          <div class="telemetry-inner">
            <span>${uiConfig.servoLabel}</span>
            <strong id="telemetry-${servoId}-angle" class="telemetry-angle">0.0°</strong>
          </div>
        </div>
        <div class="telemetry-summary">
          <div class="telemetry-name">${uiConfig.name}</div>
          <div id="telemetry-${servoId}-direction" class="telemetry-direction">方向：中位</div>
        </div>
        <div class="telemetry-feedback-grid telemetry-feedback-grid-bottom">
          <div class="telemetry-feedback">
            <span class="telemetry-feedback-label">位置</span>
            <strong id="telemetry-${servoId}-position" class="telemetry-feedback-value">--</strong>
          </div>
          <div id="telemetry-${servoId}-status-box" class="telemetry-feedback telemetry-feedback-state" data-state="timeout">
            <span class="telemetry-feedback-label">状态</span>
            <strong id="telemetry-${servoId}-status-text" class="telemetry-feedback-value">超时</strong>
          </div>
        </div>
      </div>
    `;
  }).join('');

  updateServoTelemetryBoard();
}

function updateServoTelemetryBoard() {
  const telemetryBoard = document.getElementById('servoTelemetryBoard');
  if (!telemetryBoard) {
    return;
  }

  initializeVirtualServoState();

  SERVO_IDS.forEach(servoId => {
    const ringElement = document.getElementById(`telemetry-${servoId}-ring`);
    const angleElement = document.getElementById(`telemetry-${servoId}-angle`);
    const directionElement = document.getElementById(`telemetry-${servoId}-direction`);
    const temperatureElement = document.getElementById(`telemetry-${servoId}-temp`);
    const goalElement = document.getElementById(`telemetry-${servoId}-goal`);
    const positionElement = document.getElementById(`telemetry-${servoId}-position`);
    const statusTextElement = document.getElementById(`telemetry-${servoId}-status-text`);
    const statusBoxElement = document.getElementById(`telemetry-${servoId}-status-box`);
    if (
      !ringElement
      || !angleElement
      || !directionElement
      || !temperatureElement
      || !goalElement
      || !positionElement
      || !statusTextElement
      || !statusBoxElement
    ) {
      return;
    }

    const limits = getServoSliderLimitsDegrees(servoId, window.robot);
    const angleDeg = getServoAngleDegrees(servoId);
    const maxMagnitude = Math.max(Math.abs(limits.min), Math.abs(limits.max), 1);
    const ringProgress = Math.max(6, Math.min(100, (Math.abs(angleDeg) / maxMagnitude) * 100));
    const feedbackStatus = getServoFeedbackStatusMeta(servoId);

    ringElement.style.setProperty('--ring-progress', `${ringProgress}%`);
    ringElement.style.setProperty('--telemetry-accent', getServoStatusAccentColor(servoId));
    angleElement.textContent = formatSignedAngle(angleDeg);
    directionElement.textContent = `方向：${getServoDirectionText(servoId, angleDeg)}`;
    temperatureElement.textContent = formatTelemetryTemperatureValue(servoFeedbackState[servoId]?.temperature);
    goalElement.textContent = formatTelemetryRawValue(getServoFeedbackGoalRaw(servoId));
    positionElement.textContent = formatTelemetryRawValue(servoCurrentPositions[servoId]);
    statusTextElement.textContent = feedbackStatus.label;
    statusBoxElement.dataset.state = feedbackStatus.state;
  });
}

function getDashboardPageMeta(index = dashboardPageIndex) {
  return DASHBOARD_PAGES[index] ?? DASHBOARD_PAGES[0];
}

function getServoPoseSnapshot() {
  initializeVirtualServoState();

  return SERVO_IDS.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);
    const angleDeg = getServoAngleDegrees(servoId);
    const statusKey = getServoStatusKey(servoId);

    return {
      servoId,
      name: uiConfig.name,
      servoLabel: uiConfig.servoLabel,
      angleDeg,
      absoluteAngleDeg: Math.abs(angleDeg),
      currentRaw: normalizeServoPositionTicks(servoCurrentPositions[servoId] ?? getServoZeroRawPosition(servoId)),
      zeroRaw: getServoZeroRawPosition(servoId),
      directionText: getServoDirectionText(servoId, angleDeg),
      statusKey,
    };
  });
}

function renderPidReferencePanel() {
  const pidPanel = document.getElementById('pidReferencePanel');
  if (!pidPanel) {
    return;
  }

  pidPanel.innerHTML = SERVO_DISPLAY_ORDER.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);
    const preset = SERVO_PID_REFERENCE[servoId] ?? { p: 0, i: 0, d: 0, mode: '预留' };

    return `
      <div class="pid-row">
        <div class="matrix-name">${uiConfig.name}</div>
        <div class="pid-value">P ${preset.p}</div>
        <div class="pid-value">I ${preset.i}</div>
        <div class="pid-value">D ${preset.d}</div>
        <div class="mode-badge">${preset.mode}</div>
      </div>
    `;
  }).join('');
}

function renderServoReferencePanel() {
  const referencePanel = document.getElementById('servoReferencePanel');
  if (!referencePanel) {
    return;
  }

  referencePanel.innerHTML = SERVO_DISPLAY_ORDER.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);

    return `
      <div class="reference-row">
        <div class="matrix-name">${uiConfig.name}</div>
        <div id="servo-${servoId}-zero-raw" class="matrix-value">零位 ${getServoZeroRawPosition(servoId)}</div>
        <div id="servo-${servoId}-current-raw" class="matrix-value">当前 ${getServoZeroRawPosition(servoId)}</div>
        <div id="servo-${servoId}-current-angle" class="matrix-value">+0.0°</div>
      </div>
    `;
  }).join('');

  updateServoReferencePanel();
}

function updateServoReferencePanel() {
  const referencePanel = document.getElementById('servoReferencePanel');
  if (!referencePanel) {
    return;
  }

  initializeVirtualServoState();

  SERVO_IDS.forEach(servoId => {
    const currentRawElement = document.getElementById(`servo-${servoId}-current-raw`);
    const angleElement = document.getElementById(`servo-${servoId}-current-angle`);
    const zeroRawElement = document.getElementById(`servo-${servoId}-zero-raw`);
    if (!currentRawElement || !angleElement || !zeroRawElement) {
      return;
    }

    zeroRawElement.textContent = `零位 ${getServoZeroRawPosition(servoId)}`;
    currentRawElement.textContent = `当前 ${normalizeServoPositionTicks(servoCurrentPositions[servoId])}`;
    angleElement.textContent = formatSignedAngle(getServoAngleDegrees(servoId));
  });
}

function renderServoDiagnosticsPanel() {
  const diagnosticsPanel = document.getElementById('servoDiagnosticsPanel');
  if (!diagnosticsPanel) {
    return;
  }

  diagnosticsPanel.innerHTML = SERVO_DISPLAY_ORDER.map(servoId => {
    const uiConfig = getServoUiConfig(servoId);
    return `
      <div class="diagnostic-row">
        <div class="diagnostic-name">${uiConfig.name}</div>
        <div class="diagnostic-bar"><span id="diagnostic-${servoId}-fill"></span></div>
        <div id="diagnostic-${servoId}-meta" class="diagnostic-meta">中位</div>
      </div>
    `;
  }).join('');

  updateServoDiagnosticsPanel();
}

function updateServoDiagnosticsPanel() {
  const diagnosticsPanel = document.getElementById('servoDiagnosticsPanel');
  if (!diagnosticsPanel) {
    return;
  }

  const snapshot = getServoPoseSnapshot();
  const maxAngle = Math.max(1, ...snapshot.map(item => item.absoluteAngleDeg));
  const dominant = snapshot.reduce((best, current) => (
    !best || current.absoluteAngleDeg > best.absoluteAngleDeg ? current : best
  ), null);
  const movingCount = snapshot.filter(item => item.absoluteAngleDeg >= SERVO_DIRECTION_DEADZONE_DEG).length;
  const averageAngle = snapshot.reduce((sum, item) => sum + item.absoluteAngleDeg, 0) / snapshot.length;

  snapshot.forEach(item => {
    const fillElement = document.getElementById(`diagnostic-${item.servoId}-fill`);
    const metaElement = document.getElementById(`diagnostic-${item.servoId}-meta`);
    if (!fillElement || !metaElement) {
      return;
    }

    const percent = Math.max(6, Math.min(100, (item.absoluteAngleDeg / maxAngle) * 100));
    fillElement.style.width = `${percent}%`;
    fillElement.style.background = item.statusKey === 'error'
      ? 'linear-gradient(90deg, rgba(255,111,131,.96), rgba(255,154,176,.94))'
      : item.statusKey === 'warning'
        ? 'linear-gradient(90deg, rgba(255,191,77,.96), rgba(255,221,134,.94))'
        : 'linear-gradient(90deg, rgba(89,215,255,.96), rgba(78,127,255,.96))';
    metaElement.textContent = `${item.directionText} / ${formatSignedAngle(item.angleDeg)}`;
  });

  const maxDeviationElement = document.getElementById('dashboardMaxDeviation');
  const avgDeviationElement = document.getElementById('dashboardAvgDeviation');
  const dominantServoElement = document.getElementById('dashboardDominantServo');
  const movingCountElement = document.getElementById('dashboardMovingCount');
  const summaryElement = document.getElementById('dashboardDiagnosticSummary');

  if (maxDeviationElement) {
    maxDeviationElement.textContent = `${maxAngle.toFixed(1)}°`;
  }

  if (avgDeviationElement) {
    avgDeviationElement.textContent = `${averageAngle.toFixed(1)}°`;
  }

  if (dominantServoElement) {
    dominantServoElement.textContent = dominant?.name ?? '--';
  }

  if (movingCountElement) {
    movingCountElement.textContent = `${movingCount}`;
  }

  if (summaryElement) {
    summaryElement.textContent = movingCount === 0
      ? '当前所有关节接近零位'
      : `${dominant?.name ?? '关节'}偏差最大，当前共有 ${movingCount} 个关节离开零位`;
  }
}

function applyDashboardPage(nextPageIndex) {
  const safePageIndex = Math.max(0, Math.min(DASHBOARD_PAGES.length - 1, nextPageIndex));
  dashboardPageIndex = safePageIndex;

  const leftTrack = document.getElementById('dashboardLeftTrack');
  const rightTrack = document.getElementById('dashboardRightTrack');
  const offset = `translateX(-${safePageIndex * 50}%)`;

  if (leftTrack) {
    leftTrack.style.transform = offset;
  }

  if (rightTrack) {
    rightTrack.style.transform = offset;
  }

  document.querySelectorAll('[data-dashboard-page-btn]').forEach(button => {
    const buttonIndex = Number.parseInt(button.dataset.dashboardPageBtn ?? '0', 10);
    button.classList.toggle('active', buttonIndex === safePageIndex);
  });

  updateDashboardUI();
}

function setupDashboardPager() {
  const previousButton = document.getElementById('dashboardPagePrev');
  const nextButton = document.getElementById('dashboardPageNext');

  document.querySelectorAll('[data-dashboard-page-btn]').forEach(button => {
    button.addEventListener('click', () => {
      const nextPageIndex = Number.parseInt(button.dataset.dashboardPageBtn ?? '0', 10);
      applyDashboardPage(nextPageIndex);
    });
  });

  previousButton?.addEventListener('click', () => {
    applyDashboardPage((dashboardPageIndex - 1 + DASHBOARD_PAGES.length) % DASHBOARD_PAGES.length);
  });

  nextButton?.addEventListener('click', () => {
    applyDashboardPage((dashboardPageIndex + 1) % DASHBOARD_PAGES.length);
  });

  applyDashboardPage(dashboardPageIndex);
}

function parseDashboardCssPixels(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readDashboardLayoutDefaults(shellElement) {
  const shellStyles = window.getComputedStyle(shellElement);
  const leftPanelElement = shellElement.querySelector('.side-left');
  const rightPanelElement = shellElement.querySelector('.side-right');
  const topPanelElement = shellElement.querySelector('.top');
  const bottomPanelElement = document.getElementById('dashboardBottom');

  return {
    topHeight: Math.round(topPanelElement?.getBoundingClientRect().height ?? parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-top-height'), 90)),
    leftWidth: Math.round(leftPanelElement?.getBoundingClientRect().width ?? parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-left-width'), 292)),
    rightWidth: Math.round(rightPanelElement?.getBoundingClientRect().width ?? parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-right-width'), 292)),
    bottomHeight: Math.round(bottomPanelElement?.getBoundingClientRect().height ?? parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-bottom-height'), 220)),
  };
}

function clampDashboardLayout(layout, shellElement) {
  const shellRect = shellElement.getBoundingClientRect();
  const shellStyles = window.getComputedStyle(shellElement);
  const splitterSize = parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-splitter-size'), 10);
  const minTopHeight = 118;
  const maxTopHeight = Math.max(minTopHeight, Math.min(168, shellRect.height * 0.18));
  const topHeight = Math.min(
    maxTopHeight,
    Math.max(minTopHeight, layout.topHeight ?? parseDashboardCssPixels(shellStyles.getPropertyValue('--dashboard-top-height'), 90)),
  );
  const shellGap = parseDashboardCssPixels(shellStyles.rowGap, 10);
  const shellInnerWidth = shellRect.width
    - parseDashboardCssPixels(shellStyles.paddingLeft, 0)
    - parseDashboardCssPixels(shellStyles.paddingRight, 0);
  const shellInnerHeight = shellRect.height
    - parseDashboardCssPixels(shellStyles.paddingTop, 0)
    - parseDashboardCssPixels(shellStyles.paddingBottom, 0);

  const minSideWidth = 220;
  const minCenterWidth = Math.max(520, Math.min(860, shellInnerWidth * 0.36));
  const maxCombinedSideWidth = Math.max(minSideWidth * 2, shellInnerWidth - minCenterWidth - splitterSize * 2 - 8);
  const maxSingleSideWidth = Math.max(minSideWidth, maxCombinedSideWidth - minSideWidth);

  let leftWidth = Math.min(maxSingleSideWidth, Math.max(minSideWidth, layout.leftWidth));
  let rightWidth = Math.min(maxSingleSideWidth, Math.max(minSideWidth, layout.rightWidth));

  if (leftWidth + rightWidth > maxCombinedSideWidth) {
    const overflowWidth = leftWidth + rightWidth - maxCombinedSideWidth;
    if (leftWidth >= rightWidth) {
      leftWidth = Math.max(minSideWidth, leftWidth - overflowWidth);
    } else {
      rightWidth = Math.max(minSideWidth, rightWidth - overflowWidth);
    }
  }

  if (leftWidth + rightWidth > maxCombinedSideWidth) {
    const overflowWidth = leftWidth + rightWidth - maxCombinedSideWidth;
    leftWidth = Math.max(minSideWidth, leftWidth - overflowWidth / 2);
    rightWidth = Math.max(minSideWidth, rightWidth - overflowWidth / 2);
  }

  const minBottomHeight = 150;
  const minMainHeight = Math.max(300, Math.min(520, shellInnerHeight * 0.38));
  const maxBottomHeight = Math.max(
    minBottomHeight,
    shellInnerHeight - topHeight - splitterSize - shellGap * 3 - minMainHeight,
  );
  const bottomHeight = Math.min(maxBottomHeight, Math.max(minBottomHeight, layout.bottomHeight));

  return {
    topHeight: Math.round(topHeight),
    leftWidth: Math.round(leftWidth),
    rightWidth: Math.round(rightWidth),
    bottomHeight: Math.round(bottomHeight),
  };
}

function applyDashboardLayout(shellElement, layout) {
  shellElement.style.setProperty('--dashboard-top-height', `${layout.topHeight}px`);
  shellElement.style.setProperty('--dashboard-left-width', `${layout.leftWidth}px`);
  shellElement.style.setProperty('--dashboard-right-width', `${layout.rightWidth}px`);
  shellElement.style.setProperty('--dashboard-bottom-height', `${layout.bottomHeight}px`);
}

function captureCurrentDashboardLayout(shellElement) {
  const topPanelElement = shellElement.querySelector('.top');
  const leftPanelElement = shellElement.querySelector('.side-left');
  const rightPanelElement = shellElement.querySelector('.side-right');
  const bottomPanelElement = document.getElementById('dashboardBottom');
  const fallbackLayout = readDashboardLayoutDefaults(shellElement);

  return clampDashboardLayout({
    topHeight: Math.round(topPanelElement?.getBoundingClientRect().height ?? fallbackLayout.topHeight),
    leftWidth: Math.round(leftPanelElement?.getBoundingClientRect().width ?? fallbackLayout.leftWidth),
    rightWidth: Math.round(rightPanelElement?.getBoundingClientRect().width ?? fallbackLayout.rightWidth),
    bottomHeight: Math.round(bottomPanelElement?.getBoundingClientRect().height ?? fallbackLayout.bottomHeight),
  }, shellElement);
}

function loadDashboardLayout(shellElement) {
  const defaults = readDashboardLayoutDefaults(shellElement);

  try {
    const savedLayout = JSON.parse(window.localStorage.getItem(DASHBOARD_LAYOUT_STORAGE_KEY) ?? 'null');
    if (!savedLayout || typeof savedLayout !== 'object') {
      return defaults;
    }

    return clampDashboardLayout({
      topHeight: savedLayout.topHeight ?? defaults.topHeight,
      leftWidth: savedLayout.leftWidth ?? defaults.leftWidth,
      rightWidth: savedLayout.rightWidth ?? defaults.rightWidth,
      bottomHeight: savedLayout.bottomHeight ?? defaults.bottomHeight,
    }, shellElement);
  } catch (error) {
    console.warn('Failed to load dashboard layout:', error);
    return defaults;
  }
}

function saveDashboardLayout(layout) {
  try {
    window.localStorage.setItem(DASHBOARD_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch (error) {
    console.warn('Failed to save dashboard layout:', error);
  }
}

function persistCurrentDashboardLayout(shellElement) {
  const currentMeasuredLayout = captureCurrentDashboardLayout(shellElement);
  saveDashboardLayout(currentMeasuredLayout);
  return currentMeasuredLayout;
}

function setupDashboardResizers() {
  const shellElement = document.getElementById('dashboardShell');
  const leftResizer = document.getElementById('leftStageResizer');
  const rightResizer = document.getElementById('stageRightResizer');
  const bottomResizer = document.getElementById('mainBottomResizer');

  if (!shellElement || !leftResizer || !rightResizer || !bottomResizer) {
    return;
  }

  const defaultLayout = readDashboardLayoutDefaults(shellElement);
  let currentLayout = loadDashboardLayout(shellElement);
  applyDashboardLayout(shellElement, currentLayout);

  const resizerMap = new Map([
    [leftResizer, 'left'],
    [rightResizer, 'right'],
    [bottomResizer, 'bottom'],
  ]);

  let dragState = null;

  const finishDrag = () => {
    if (!dragState) {
      return;
    }

    dragState.element.classList.remove('dragging');
    document.body.classList.remove('dashboard-resizing', 'resize-row');
    saveDashboardLayout(currentLayout);
    dragState = null;
  };

  const handlePointerMove = event => {
    if (!dragState) {
      return;
    }

    event.preventDefault();

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    const nextLayout = { ...dragState.startLayout };

    if (dragState.type === 'left') {
      nextLayout.leftWidth = dragState.startLayout.leftWidth + deltaX;
    } else if (dragState.type === 'right') {
      nextLayout.rightWidth = dragState.startLayout.rightWidth - deltaX;
    } else if (dragState.type === 'bottom') {
      nextLayout.bottomHeight = dragState.startLayout.bottomHeight + deltaY;
    }

    currentLayout = clampDashboardLayout(nextLayout, shellElement);
    applyDashboardLayout(shellElement, currentLayout);
  };

  const handlePointerUp = () => {
    finishDrag();
  };

  const beginDrag = (event, type, element) => {
    event.preventDefault();

    dragState = {
      type,
      element,
      startX: event.clientX,
      startY: event.clientY,
      startLayout: { ...currentLayout },
    };

    element.classList.add('dragging');
    document.body.classList.add('dashboard-resizing');
    if (type === 'bottom') {
      document.body.classList.add('resize-row');
    }
  };

  [leftResizer, rightResizer, bottomResizer].forEach(element => {
    const type = resizerMap.get(element);

    element.addEventListener('pointerdown', event => beginDrag(event, type, element));
    element.addEventListener('dblclick', () => {
      currentLayout = { ...defaultLayout };
      applyDashboardLayout(shellElement, currentLayout);
      saveDashboardLayout(currentLayout);
    });
  });

  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  window.addEventListener('resize', () => {
    currentLayout = clampDashboardLayout(currentLayout, shellElement);
    applyDashboardLayout(shellElement, currentLayout);
    saveDashboardLayout(currentLayout);
  });

  window.requestAnimationFrame(() => {
    currentLayout = persistCurrentDashboardLayout(shellElement);
    applyDashboardLayout(shellElement, currentLayout);
  });

  window.addEventListener('pagehide', () => {
    currentLayout = persistCurrentDashboardLayout(shellElement);
  });

  window.dashboardLayoutTools = {
    captureCurrentLayout: () => {
      currentLayout = persistCurrentDashboardLayout(shellElement);
      applyDashboardLayout(shellElement, currentLayout);
      console.log('Saved dashboard layout:', currentLayout);
      return currentLayout;
    },
    resetToSavedLayout: () => {
      currentLayout = loadDashboardLayout(shellElement);
      applyDashboardLayout(shellElement, currentLayout);
      return currentLayout;
    },
  };
}

function setupDashboardWheelIsolation() {
  const wheelSafeSelectors = [
    '.top',
    '.side .viewport',
    '.stack',
    '.pstack',
    '.metrics',
    '.params',
    '.speed-box',
    '.servo-slider-panel',
    '.servo-status-grid.compact-status',
    '.servo-telemetry-board',
    '.pid-table',
    '.reference-table',
    '.diagnostic-stack',
    '.notes',
    '.bottom',
  ];

  document.querySelectorAll(wheelSafeSelectors.join(',')).forEach(element => {
    element.addEventListener('wheel', event => {
      event.stopPropagation();
    }, { passive: true });
  });
}

function getDashboardAutoScrollAxis(element) {
  if (!element || !element.isConnected) {
    return null;
  }

  const verticalOverflow = element.scrollHeight - element.clientHeight;
  if (verticalOverflow > 8) {
    return 'y';
  }

  const horizontalOverflow = element.scrollWidth - element.clientWidth;
  if (horizontalOverflow > 8) {
    return 'x';
  }

  return null;
}

function isDashboardAutoScrollVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  if (element.getClientRects().length === 0) {
    return false;
  }

  const styles = window.getComputedStyle(element);
  if (styles.display === 'none' || styles.visibility === 'hidden' || Number.parseFloat(styles.opacity || '1') === 0) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  return rect.width > 0
    && rect.height > 0
    && rect.bottom > 0
    && rect.right > 0
    && rect.top < viewportHeight
    && rect.left < viewportWidth;
}

function teardownDashboardAutoScrollPanels() {
  if (dashboardAutoScrollAnimationId !== null) {
    window.cancelAnimationFrame(dashboardAutoScrollAnimationId);
    dashboardAutoScrollAnimationId = null;
  }

  dashboardAutoScrollControllers.forEach(controller => {
    controller.cleanup?.();
  });

  dashboardAutoScrollControllers = [];
}

function tickDashboardAutoScroll(timestamp) {
  dashboardAutoScrollControllers.forEach(controller => {
    const { element } = controller;
    if (!element || !element.isConnected) {
      return;
    }

    const axis = getDashboardAutoScrollAxis(element);
    const currentPosition = axis === 'x' ? element.scrollLeft : element.scrollTop;

    if (!axis || controller.paused || !isDashboardAutoScrollVisible(element)) {
      controller.position = currentPosition;
      controller.lastTimestamp = timestamp;
      return;
    }

    if (controller.axis !== axis) {
      controller.axis = axis;
      controller.position = currentPosition;
      controller.lastTimestamp = timestamp;
      return;
    }

    controller.position = currentPosition;

    if (controller.holdUntil > timestamp) {
      controller.lastTimestamp = timestamp;
      return;
    }

    const deltaSeconds = Math.max(0, (timestamp - controller.lastTimestamp) / 1000);
    controller.lastTimestamp = timestamp;

    if (deltaSeconds <= 0) {
      return;
    }

    const maxScroll = axis === 'x'
      ? Math.max(0, element.scrollWidth - element.clientWidth)
      : Math.max(0, element.scrollHeight - element.clientHeight);

    if (maxScroll <= 0) {
      return;
    }

    let nextPosition = controller.position + (controller.direction * DASHBOARD_AUTO_SCROLL_SPEED_PX_PER_SEC * deltaSeconds);

    if (nextPosition >= maxScroll) {
      nextPosition = maxScroll;
      controller.direction = -1;
      controller.holdUntil = timestamp + DASHBOARD_AUTO_SCROLL_EDGE_HOLD_MS;
    } else if (nextPosition <= 0) {
      nextPosition = 0;
      controller.direction = 1;
      controller.holdUntil = timestamp + DASHBOARD_AUTO_SCROLL_EDGE_HOLD_MS;
    }

    controller.position = nextPosition;

    if (axis === 'x') {
      element.scrollLeft = nextPosition;
    } else {
      element.scrollTop = nextPosition;
    }
  });

  if (dashboardAutoScrollControllers.length === 0) {
    dashboardAutoScrollAnimationId = null;
    return;
  }

  dashboardAutoScrollAnimationId = window.requestAnimationFrame(tickDashboardAutoScroll);
}

function setupDashboardAutoScrollPanels() {
  teardownDashboardAutoScrollPanels();

  const panelElements = Array.from(document.querySelectorAll(DASHBOARD_AUTO_SCROLL_SELECTOR))
    .filter((element, index, list) => list.indexOf(element) === index);

  dashboardAutoScrollControllers = panelElements.map(element => {
    const now = performance.now();
    const controller = {
      element,
      axis: getDashboardAutoScrollAxis(element),
      paused: false,
      direction: 1,
      holdUntil: now + DASHBOARD_AUTO_SCROLL_EDGE_HOLD_MS,
      lastTimestamp: now,
      position: getDashboardAutoScrollAxis(element) === 'x' ? element.scrollLeft : element.scrollTop,
      cleanup: null,
    };

    const syncPosition = () => {
      controller.axis = getDashboardAutoScrollAxis(element);
      controller.position = controller.axis === 'x' ? element.scrollLeft : element.scrollTop;
      controller.lastTimestamp = performance.now();
    };

    const pauseScroll = () => {
      controller.paused = true;
      syncPosition();
    };

    const resumeScroll = () => {
      controller.paused = false;
      syncPosition();
    };

    const handleFocusOut = event => {
      const nextFocusedElement = event.relatedTarget;
      if (nextFocusedElement instanceof Node && element.contains(nextFocusedElement)) {
        return;
      }

      resumeScroll();
    };

    const handleScroll = () => {
      syncPosition();
    };

    element.addEventListener('pointerenter', pauseScroll);
    element.addEventListener('pointerleave', resumeScroll);
    element.addEventListener('focusin', pauseScroll);
    element.addEventListener('focusout', handleFocusOut);
    element.addEventListener('scroll', handleScroll, { passive: true });

    controller.cleanup = () => {
      element.removeEventListener('pointerenter', pauseScroll);
      element.removeEventListener('pointerleave', resumeScroll);
      element.removeEventListener('focusin', pauseScroll);
      element.removeEventListener('focusout', handleFocusOut);
      element.removeEventListener('scroll', handleScroll);
    };

    return controller;
  });

  if (dashboardAutoScrollControllers.length > 0) {
    dashboardAutoScrollAnimationId = window.requestAnimationFrame(tickDashboardAutoScroll);
  }
}

function updateDashboardClock() {
  const clockElement = document.getElementById('dashboardClock');
  if (!clockElement) {
    return;
  }

  clockElement.textContent = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

function startDashboardClock() {
  if (dashboardClockTimer !== null) {
    clearInterval(dashboardClockTimer);
  }

  updateDashboardClock();
  dashboardClockTimer = window.setInterval(updateDashboardClock, 1000);
}

function updateDashboardUI() {
  const connectionElement = document.getElementById('dashboardConnectionState');
  const syncElement = document.getElementById('dashboardSyncState');
  const syncBadgeElement = document.getElementById('dashboardSyncStateBadge');
  const onlineCountElement = document.getElementById('dashboardOnlineCount');
  const alertCountElement = document.getElementById('dashboardAlertCount');
  const poseStateElement = document.getElementById('dashboardPoseState');
  const pageCaptionElement = document.getElementById('dashboardPageCaption');
  const pageLabelElement = document.getElementById('dashboardPageLabel');
  const pageTextElement = document.getElementById('dashboardPageText');
  const bottomPageLabelElement = document.getElementById('dashboardBottomPageLabel');
  const bottomSyncElement = document.getElementById('dashboardBottomSyncState');
  const bottomConnectionElement = document.getElementById('dashboardBottomConnectionState');
  const actionSuggestionElement = document.getElementById('dashboardActionSuggestion');
  const hintElement = document.getElementById('restoreZeroPoseHint');
  const alertCount = getServoAlertCount();
  const onlineCount = isConnectedToRealRobot ? getServoOnlineCount() : 0;
  const currentPage = getDashboardPageMeta();

  let connectionText = '模拟器待机';
  let connectionState = 'idle';
  if (leaderFollowerTeleopRunning) {
    connectionText = '主从遥操作';
    connectionState = alertCount > 0 ? 'warning' : 'active';
  } else if (motionPlaybackRunning || motionPlaybackBusy) {
    connectionText = isConnectedToRealRobot ? '项目动作回放' : '轨迹预览中';
    connectionState = alertCount > 0 ? 'warning' : 'active';
  } else if (!isConnectedToRealRobot && alertCount > 0) {
    connectionText = '连接异常';
    connectionState = 'error';
  } else if (isRestoringToZero) {
    connectionText = '恢复零位中';
    connectionState = 'warning';
  } else if (isConnectedToRealRobot && liveSyncRunning) {
    connectionText = '真机实时联动';
    connectionState = alertCount > 0 ? 'warning' : 'active';
  } else if (isConnectedToRealRobot) {
    connectionText = '真机已连接';
    connectionState = alertCount > 0 ? 'warning' : 'active';
  }

  let syncText = '待机';
  let syncState = 'idle';
  if (leaderFollowerTeleopRunning) {
    syncText = '教师端跟随';
    syncState = alertCount > 0 ? 'warning' : 'active';
  } else if (motionPlaybackRunning || motionPlaybackBusy) {
    syncText = isConnectedToRealRobot ? '真机回放' : '模拟回放';
    syncState = alertCount > 0 ? 'warning' : 'active';
  } else if (!isConnectedToRealRobot && alertCount > 0) {
    syncText = '等待重连';
    syncState = 'error';
  } else if (isRestoringToZero) {
    syncText = '同步恢复中';
    syncState = 'warning';
  } else if (isConnectedToRealRobot && liveSyncRunning) {
    syncText = '实时同步';
    syncState = alertCount > 0 ? 'warning' : 'active';
  } else if (isConnectedToRealRobot) {
    syncText = '已连接待命';
    syncState = alertCount > 0 ? 'warning' : 'active';
  }

  if (alertCount > 0 && !isRestoringToZero) {
    syncState = 'warning';
  }

  if (connectionElement) {
    connectionElement.textContent = connectionText;
    connectionElement.dataset.state = connectionState;
  }

  if (syncElement) {
    syncElement.textContent = syncText;
  }

  if (syncBadgeElement) {
    syncBadgeElement.textContent = syncText;
    syncBadgeElement.dataset.state = syncState;
  }

  if (onlineCountElement) {
    onlineCountElement.textContent = `${onlineCount} / 6`;
  }

  if (alertCountElement) {
    alertCountElement.textContent = `${alertCount}`;
    alertCountElement.style.color = alertCount > 0 ? '#ffbf4d' : '';
  }

  if (pageCaptionElement) {
    pageCaptionElement.textContent = currentPage.caption;
  }

  if (pageLabelElement) {
    pageLabelElement.textContent = currentPage.title;
  }

  if (pageTextElement) {
    pageTextElement.textContent = currentPage.title;
  }

  if (bottomPageLabelElement) {
    bottomPageLabelElement.textContent = currentPage.title;
  }

  if (bottomSyncElement) {
    bottomSyncElement.textContent = syncText;
  }

  if (bottomConnectionElement) {
    bottomConnectionElement.textContent = connectionText;
  }

  if (actionSuggestionElement) {
    actionSuggestionElement.textContent = currentPage.suggestion;
  }

  if (poseStateElement) {
    poseStateElement.textContent = hintElement?.textContent
      || '模拟器已准备，可先在中间 3D 模型区观察姿态变化。';
  }
}

function updateServoSliderUI() {
  const sliderPanel = document.getElementById('servoSliderPanel');
  if (!sliderPanel) {
    return;
  }

  initializeVirtualServoState();

  SERVO_IDS.forEach(servoId => {
    const sliderElement = document.getElementById(`servo-${servoId}-slider`);
    const angleElement = document.getElementById(`servo-${servoId}-angle`);
    const directionElement = document.getElementById(`servo-${servoId}-direction`);
    const miniStatusElement = document.getElementById(`servo-${servoId}-mini-status`);
    const scaleStartElement = document.getElementById(`servo-${servoId}-scale-start`);
    const scaleEndElement = document.getElementById(`servo-${servoId}-scale-end`);

    if (!sliderElement || !angleElement || !directionElement || !scaleStartElement || !scaleEndElement) {
      return;
    }

    const limits = getServoSliderLimitsDegrees(servoId, window.robot);
    const angleDeg = getServoAngleDegrees(servoId);
    const clampedAngleDeg = Math.min(limits.max, Math.max(limits.min, angleDeg));
    const directionLabels = SERVO_DIRECTION_LABELS[servoId] ?? { positive: '正向', negative: '反向' };

    sliderElement.min = limits.min.toFixed(1);
    sliderElement.max = limits.max.toFixed(1);
    sliderElement.step = '0.1';
    sliderElement.value = clampedAngleDeg.toFixed(1);
    sliderElement.disabled = isRestoringToZero;
    updateServoSliderVisual(sliderElement, clampedAngleDeg, limits.min, limits.max);

    angleElement.textContent = formatSignedAngle(angleDeg);
    directionElement.textContent = `方向：${getServoDirectionText(servoId, angleDeg)}`;
    scaleStartElement.textContent = formatScaleLimitLabel(directionLabels.negative, limits.min);
    scaleEndElement.textContent = formatScaleLimitLabel(directionLabels.positive, limits.max);

    if (miniStatusElement) {
      const statusText = SERVO_STATUS_LABELS[getServoStatusKey(servoId)] ?? '未连接';
      miniStatusElement.textContent = statusText;
      miniStatusElement.dataset.state = getServoStatusDataState(servoId);
    }
  });
}

function cancelRestoreMotion(reason = null) {
  if (!isRestoringToZero) {
    return;
  }

  restoreMotionRunId += 1;
  isRestoringToZero = false;
  if (reason) {
    updateRestoreZeroHint(reason);
  }
}

function hasPendingSliderWrites() {
  return SERVO_IDS.some(servoId => {
    const commandState = servoSliderCommandState[servoId];
    return commandState.running || commandState.pendingRaw !== null;
  });
}

function scheduleLiveSyncResume(delayMs = SLIDER_SYNC_RESUME_DELAY_MS) {
  if (sliderSyncResumeTimer) {
    clearTimeout(sliderSyncResumeTimer);
  }

  if (!isConnectedToRealRobot || !portHandler?.isOpen || isRestoringToZero) {
    return;
  }

  sliderSyncResumeTimer = window.setTimeout(() => {
    sliderSyncResumeTimer = null;
    if (!hasPendingSliderWrites() && !isRestoringToZero && isConnectedToRealRobot && portHandler?.isOpen) {
      startLiveServoSync();
    }
  }, delayMs);
}

async function flushServoSliderWriteQueue(servoId) {
  const commandState = servoSliderCommandState[servoId];
  commandState.running = true;

  try {
    while (commandState.pendingRaw !== null) {
      const targetRawPosition = commandState.pendingRaw;
      commandState.pendingRaw = null;

      try {
        const currentAngleDeg = getServoAngleDegrees(servoId);
        const targetAngleDeg = getServoAngleDegreesFromRawPosition(servoId, targetRawPosition);
        await ensureServoMotionProfile(servoId, currentAngleDeg, targetAngleDeg);
        const success = await writeServoPosition(servoId, targetRawPosition);
        if (success) {
          servoLastSafePositions[servoId] = targetRawPosition;
          servoCommStatus[servoId].status = 'success';
          servoCommStatus[servoId].lastError = null;
        }
      } catch (error) {
        console.error(`Slider control failed for servo ${servoId}:`, error);
      }
    }
  } finally {
    commandState.running = false;
    scheduleLiveSyncResume();
  }
}

function queueServoSliderWrite(servoId, rawPosition) {
  if (!isConnectedToRealRobot || !portHandler?.isOpen) {
    return;
  }

  if (sliderSyncResumeTimer) {
    clearTimeout(sliderSyncResumeTimer);
    sliderSyncResumeTimer = null;
  }

  SERVO_IDS.forEach(servoId => {
    servoSliderCommandState[servoId].pendingRaw = null;
  });

  stopLiveServoSync();
  const commandState = servoSliderCommandState[servoId];
  commandState.pendingRaw = normalizeServoPositionTicks(rawPosition);
  servoFeedbackState[servoId].goalRaw = commandState.pendingRaw;

  if (!commandState.running) {
    flushServoSliderWriteQueue(servoId);
  }
}

function handleServoSliderInput(servoId, angleDeg) {
  if (!Number.isFinite(angleDeg)) {
    return;
  }

  initializeVirtualServoState();

  if (leaderFollowerTeleopRunning) {
    void stopLeaderFollowerTeleop('已切换为网页滑块手动控制，主从遥操作已停止。');
  }

  const protectedAngleDeg = clampServoTargetAngleDegrees(servoId, angleDeg, { showAlertOnClamp: true });

  if (isRestoringToZero) {
    cancelRestoreMotion('已切换为滑块手动控制。');
  }

  if (shoulderAssistRecoveryState.active && [2, 3, 4].includes(servoId)) {
    resetShoulderAssistRecoveryState();
  }

  const nextRawPosition = getServoTargetRawPositionFromAngleDegrees(servoId, protectedAngleDeg);
  servoCurrentPositions[servoId] = nextRawPosition;
  servoFeedbackState[servoId].goalRaw = normalizeServoPositionTicks(nextRawPosition);

  if (!isConnectedToRealRobot) {
    servoLastSafePositions[servoId] = nextRawPosition;
  } else {
    servoCommStatus[servoId].status = 'pending';
    servoCommStatus[servoId].lastError = null;
    queueServoSliderWrite(servoId, nextRawPosition);
  }

  applyServoPoseToRobot(window.robot);
  updateServoStatusUI();
}

async function restoreServoPoseToZero() {
  const restoreButton = document.getElementById('restoreZeroPose');
  const connectButton = document.getElementById('connectRealRobot');
  if (!restoreButton) {
    return;
  }

  if (restoreZeroButtonResetTimer) {
    clearTimeout(restoreZeroButtonResetTimer);
    restoreZeroButtonResetTimer = null;
  }

  if (!window.robot || getRobotJointNames(window.robot).length === 0) {
    const message = '模拟器模型还没加载完成，请稍后再试。';
    updateRestoreZeroHint(message, 'error');
    showAlert('joint', message, 3500);
    return;
  }

  initializeVirtualServoState();
  if (leaderFollowerTeleopRunning) {
    await stopLeaderFollowerTeleop('已切换为恢复零位，主从遥操作已停止。');
  }
  if (motionPlaybackRunning || motionPlaybackBusy) {
    await stopProjectMotionPlayback('已切换为恢复零位，项目动作回放已停止。');
  }
  resetShoulderAssistRecoveryState();

  const shouldControlHardware = isConnectedToRealRobot && portHandler?.isOpen;
  const shouldResumeLiveSync = shouldControlHardware && liveSyncRunning;

  if (sliderSyncResumeTimer) {
    clearTimeout(sliderSyncResumeTimer);
    sliderSyncResumeTimer = null;
  }

  stopLiveServoSync();
  restoreButton.disabled = true;
  if (connectButton) {
    connectButton.disabled = true;
  }
  restoreButton.textContent = '正在缓慢恢复...';
  updateRestoreZeroHint('正在按比例缓慢恢复到模拟器既定 0° 姿态...', 'default');

  try {
    if (shouldControlHardware) {
      const successfulReads = await syncServoPositionsFromHardware();
      if (successfulReads.length === 0) {
        throw new Error('暂时读取不到舵机位置');
      }
    }

    const startRawPositions = createServoMap(0);
    const deltaTicksMap = createServoMap(0);
    const absoluteDistanceTicksMap = createServoMap(0);
    let maxDeltaDeg = 0;

    SERVO_IDS.forEach(servoId => {
      const currentRawPosition = Number.isFinite(servoCurrentPositions[servoId])
        ? servoCurrentPositions[servoId]
        : getServoZeroRawPosition(servoId);
      const targetRawPosition = getServoZeroRawPosition(servoId);
      const deltaTicks = normalizeServoDelta(targetRawPosition - currentRawPosition);

      startRawPositions[servoId] = currentRawPosition;
      deltaTicksMap[servoId] = deltaTicks;
      absoluteDistanceTicksMap[servoId] = Math.abs(deltaTicks);
      maxDeltaDeg = Math.max(maxDeltaDeg, Math.abs(deltaTicks * SERVO_TICKS_TO_DEG));
    });

    if (maxDeltaDeg < 0.3) {
      updateRestoreZeroHint('当前已经接近 0° 姿态了。', 'success');
      restoreButton.textContent = '已经在0°';
      return;
    }

    const currentRunId = ++restoreMotionRunId;
    isRestoringToZero = true;
    updateServoSliderUI();
    updateDashboardUI();

    const durationMs = calculateRestoreDurationMs(maxDeltaDeg);
    const startedAt = performance.now();

    if (shouldControlHardware) {
      const targetRawPositions = createServoMap(0);
      const speedValues = createServoMap(0);

      SERVO_IDS.forEach(servoId => {
        const currentAngleDeg = getServoAngleDegreesFromRawPosition(servoId, startRawPositions[servoId]);
        const targetAngleDeg = getServoAngleDegreesFromRawPosition(servoId, getServoZeroRawPosition(servoId));
        targetRawPositions[servoId] = getServoZeroRawPosition(servoId);
        servoFeedbackState[servoId].goalRaw = targetRawPositions[servoId];
        speedValues[servoId] = applyServoProtectedSpeedCap(
          servoId,
          currentAngleDeg,
          targetAngleDeg,
          calculateRestoreSpeedValue(absoluteDistanceTicksMap[servoId], durationMs),
        );
      });

      for (const servoId of SERVO_IDS) {
        await ensureServoMotionProfile(
          servoId,
          getServoAngleDegreesFromRawPosition(servoId, startRawPositions[servoId]),
          getServoAngleDegreesFromRawPosition(servoId, targetRawPositions[servoId]),
        );
      }

      await syncWriteServoPositionsWithSpeeds(targetRawPositions, speedValues);
    }

    while (true) {
      if (currentRunId !== restoreMotionRunId) {
        throw new Error('__restore_cancelled__');
      }

      const loopStartedAt = performance.now();
      const progress = Math.min(1, (loopStartedAt - startedAt) / durationMs);
      const easedProgress = easeInOutCubic(progress);

      SERVO_IDS.forEach(servoId => {
        const nextRawPosition = startRawPositions[servoId] + (deltaTicksMap[servoId] * easedProgress);
        servoCurrentPositions[servoId] = normalizeServoPositionTicks(nextRawPosition);
      });

      applyServoPoseToRobot(window.robot);
      updateServoStatusUI();

      if (progress >= 1) {
        break;
      }

      const loopElapsed = performance.now() - loopStartedAt;
      await sleepMs(Math.max(16, RESTORE_ZERO_STEP_MS - loopElapsed));
    }

    SERVO_IDS.forEach(servoId => {
      const targetRawPosition = getServoZeroRawPosition(servoId);
      servoCurrentPositions[servoId] = targetRawPosition;
      servoLastSafePositions[servoId] = targetRawPosition;
    });

    applyServoPoseToRobot(window.robot);
    updateServoStatusUI();

    if (shouldControlHardware) {
      await sleepMs(140);
      await syncServoPositionsFromHardware();
    }

    updateRestoreZeroHint('已恢复到模拟器既定 0° 姿态。', 'success');
    restoreButton.textContent = '已恢复到0°';
  } catch (error) {
    if (error?.message === '__restore_cancelled__') {
      restoreButton.textContent = '已切换手动控制';
    } else {
      const message = `恢复 0° 失败：${error.message || '未知错误'}`;
      console.error('Restore to zero failed:', error);
      updateRestoreZeroHint(message, 'error');
      showAlert('servo', message, 4500);
      restoreButton.textContent = '恢复失败，请重试';
    }
  } finally {
    isRestoringToZero = false;
    updateServoSliderUI();
    updateDashboardUI();

    if (shouldResumeLiveSync && isConnectedToRealRobot && portHandler?.isOpen) {
      startLiveServoSync();
    } else if (shouldControlHardware) {
      scheduleLiveSyncResume();
    }

    restoreButton.disabled = false;
    if (connectButton) {
      connectButton.disabled = false;
    }
    restoreZeroButtonResetTimer = window.setTimeout(() => {
      restoreButton.textContent = RESTORE_ZERO_BUTTON_IDLE_TEXT;
      updateRestoreZeroHint();
      restoreZeroButtonResetTimer = null;
    }, 1800);
  }
}

/**
 * 显示警告提醒
 * @param {string} type - 提醒类型 ('joint' 虚拟关节限位, 'servo' 真实舵机错误)
 * @param {string} message - 显示的消息
 * @param {number} duration - 显示持续时间(毫秒)，默认3秒
 */
function showAlert(type, message, duration = 3000) {
  const alertId = type === 'joint' ? 'jointLimitAlert' : 'servoLimitAlert';
  const alertElement = document.getElementById(alertId);
  
  if (alertElement) {
    // 设置消息并显示
    alertElement.textContent = message;
    alertElement.style.display = 'block';
    
    // 设置定时器，自动隐藏
    setTimeout(() => {
      alertElement.style.display = 'none';
    }, duration);
  }
}

function pushVoiceBridgeLog(message, state = 'idle') {
  voiceBridgeLogEntries.unshift({
    message,
    state,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  });
  voiceBridgeLogEntries = voiceBridgeLogEntries.slice(0, VOICE_BRIDGE_LOG_LIMIT);
  updateVoiceBridgeUI();
}

function updateVoiceBridgeUI() {
  const stateElement = document.getElementById('voiceBridgeState');
  const fileNameElement = document.getElementById('voiceBridgeFileName');
  const commandElement = document.getElementById('voiceBridgeLastCommand');
  const logElement = document.getElementById('voiceBridgeLog');
  const selectButton = document.getElementById('selectVoiceBridgeFile');
  const toggleButton = document.getElementById('toggleVoiceBridgeMonitor');

  const hasFile = Boolean(voiceBridgeFileHandle);
  const stateClass = voiceBridgeMonitorRunning ? 'active' : (hasFile ? 'warning' : 'idle');
  const stateText = voiceBridgeMonitorRunning ? '监听中' : (hasFile ? '已就绪' : '未选择');

  if (stateElement) {
    stateElement.className = `chip ${stateClass}`;
    stateElement.textContent = stateText;
  }

  if (fileNameElement) {
    if (!hasFile) {
      fileNameElement.textContent = '未选择桥接文件。建议选择 gongneng/output/.../robot_command_bridge.jsonl';
    } else {
      fileNameElement.textContent = `当前文件：${voiceBridgeFileHandle.name} | 已处理 ${voiceBridgeProcessedCommandCount} 条新增命令`;
    }
  }

  if (commandElement) {
    commandElement.textContent = voiceBridgeLastCommandSummary;
  }

  if (logElement) {
    logElement.innerHTML = '';
    if (voiceBridgeLogEntries.length === 0) {
      const emptyItem = document.createElement('div');
      emptyItem.className = 'voice-bridge-log-item';
      emptyItem.dataset.state = 'idle';
      emptyItem.textContent = '暂无桥接日志';
      logElement.appendChild(emptyItem);
    } else {
      voiceBridgeLogEntries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'voice-bridge-log-item';
        item.dataset.state = entry.state;
        item.textContent = `[${entry.time}] ${entry.message}`;
        logElement.appendChild(item);
      });
    }
  }

  if (toggleButton) {
    toggleButton.disabled = !hasFile;
    toggleButton.textContent = voiceBridgeMonitorRunning ? '停止监听' : '开始监听';
  }

  if (selectButton) {
    selectButton.disabled = voiceBridgeIsPolling;
  }
}

function stopVoiceBridgeMonitor({ silent = false } = {}) {
  voiceBridgeMonitorRunning = false;
  voiceBridgeIsPolling = false;
  if (voiceBridgePollTimer) {
    clearTimeout(voiceBridgePollTimer);
    voiceBridgePollTimer = null;
  }
  if (!silent) {
    pushVoiceBridgeLog('已停止监听桥接文件。', 'warning');
  } else {
    updateVoiceBridgeUI();
  }
}

async function selectVoiceBridgeFile() {
  if (!window.showOpenFilePicker) {
    showAlert('servo', '当前浏览器不支持文件桥接监听，请使用最新版 Edge 或 Chrome。', 4500);
    return;
  }

  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      excludeAcceptAllOption: false,
      types: [
        {
          description: '机器人桥接文件',
          accept: {
            'application/json': ['.jsonl', '.json'],
            'text/plain': ['.jsonl', '.txt'],
          },
        },
      ],
    });

    const file = await handle.getFile();
    const lines = file
      .text ? await file.text() : '';
    const existingLines = lines
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    voiceBridgeFileHandle = handle;
    voiceBridgeProcessedLineCount = existingLines.length;
    voiceBridgeProcessedCommandCount = 0;
    voiceBridgeLogEntries = [];
    voiceBridgeLastCommandSummary = '等待新增语音命令';
    stopVoiceBridgeMonitor({ silent: true });
    pushVoiceBridgeLog(`已选择桥接文件 ${file.name}，将从新增内容开始监听。`, 'success');
  } catch (error) {
    if (error?.name === 'AbortError') {
      return;
    }
    console.error('Voice bridge file selection failed:', error);
    showAlert('servo', `选择桥接文件失败：${error.message || '未知错误'}`, 4500);
  }
}

function normalizeBridgeDirection(direction) {
  if (!direction) {
    return null;
  }
  const normalized = String(direction).trim();
  return VOICE_BRIDGE_DIRECTION_ALIASES[normalized] ?? VOICE_BRIDGE_DIRECTION_ALIASES[normalized.toLowerCase()] ?? null;
}

function getBridgeServoDeltaSign(servoId, direction) {
  const normalizedDirection = normalizeBridgeDirection(direction);
  if (!normalizedDirection) {
    return null;
  }
  return VOICE_BRIDGE_DIRECTION_SIGNS[servoId]?.[normalizedDirection] ?? null;
}

async function executeVoiceBridgeCommand(command) {
  const action = String(command?.action || command?.payload?.kind || '').trim();
  const payload = command?.payload ?? {};
  const rawText = String(payload.raw_text || command?.raw_text || '').trim();
  voiceBridgeLastCommandSummary = rawText || action || '收到桥接命令';
  updateVoiceBridgeUI();

  if (!action) {
    pushVoiceBridgeLog('收到一条缺少 action 的桥接记录，已跳过。', 'warning');
    return;
  }

  if (action === 'connect_robot') {
    if (isConnectedToRealRobot) {
      pushVoiceBridgeLog('桥接命令要求连接真机，但网页已经连接。', 'success');
      return;
    }
    pushVoiceBridgeLog('收到连接真机命令，请在网页顶部手动点击“连接真实机械臂”完成浏览器授权。', 'warning');
    showAlert('servo', '语音要求连接真机，请手动点击网页顶部“连接真实机械臂”。', 4200);
    return;
  }

  if (action === 'disconnect_robot') {
    if (!isConnectedToRealRobot) {
      pushVoiceBridgeLog('桥接命令要求断开真机，但当前本就未连接。', 'idle');
      return;
    }
    await toggleRealRobotConnection();
    pushVoiceBridgeLog('已按桥接命令断开真实机械臂。', 'success');
    return;
  }

  if (!isConnectedToRealRobot || !portHandler?.isOpen) {
    pushVoiceBridgeLog(`收到 ${action} 命令，但网页尚未连接真实机械臂。`, 'warning');
    showAlert('servo', '桥接命令已到达，但网页尚未连接真实机械臂。', 4200);
    return;
  }

  if (leaderFollowerTeleopRunning) {
    pushVoiceBridgeLog(`收到 ${action} 命令，但当前正在执行主从遥操作，已跳过。`, 'warning');
    showAlert('servo', '当前主从遥操作正在运行，语音桥接命令已跳过。', 4200);
    return;
  }

  if (action === 'restore_zero_pose') {
    await restoreServoPoseToZero();
    pushVoiceBridgeLog('已执行恢复 0° 姿态。', 'success');
    return;
  }

  if (action === 'stop_motion') {
    cancelRestoreMotion('已收到桥接停止命令。');
    commandQueue = [];
    isProcessingQueue = false;
    SERVO_IDS.forEach(servoId => {
      servoSliderCommandState[servoId].pendingRaw = null;
    });
    pushVoiceBridgeLog('已清空网页侧待执行命令。若真机仍在惯性运动，请人工关注。', 'warning');
    showAlert('servo', '已清空网页侧命令队列。若真机仍在运动，请人工急停。', 4200);
    return;
  }

  if (action === 'servo_move') {
    const servoId = Number(payload.servo_id);
    const angleDeg = Number(payload.angle_deg);
    const directionSign = getBridgeServoDeltaSign(servoId, payload.direction);

    if (!SERVO_IDS.includes(servoId) || !Number.isFinite(angleDeg) || !Number.isFinite(directionSign)) {
      pushVoiceBridgeLog(`servo_move 参数不完整，已跳过：${JSON.stringify(payload)}`, 'error');
      return;
    }

    if (isRestoringToZero) {
      cancelRestoreMotion('已切换为桥接语音控制。');
    }

    if (shoulderAssistRecoveryState.active && [2, 3, 4].includes(servoId)) {
      resetShoulderAssistRecoveryState();
    }

    const currentAngleDeg = getServoAngleDegrees(servoId);
    const requestedAngleDeg = currentAngleDeg + (directionSign * angleDeg);
    const targetAngleDeg = clampServoTargetAngleDegrees(servoId, requestedAngleDeg, { showAlertOnClamp: true });
    const targetRaw = getServoTargetRawPositionFromAngleDegrees(servoId, targetAngleDeg);

    await ensureServoMotionProfile(servoId, currentAngleDeg, targetAngleDeg);
    const success = await commandServoRawPosition(servoId, targetRaw, {
      skipLimitCheck: true,
      updateLastSafe: true,
    });

    if (success) {
      pushVoiceBridgeLog(`已执行 ${servoId} 号舵机动作：${rawText || `${payload.direction} ${angleDeg}°`}`, 'success');
    } else {
      pushVoiceBridgeLog(`执行 ${servoId} 号舵机动作失败：${rawText || `${payload.direction} ${angleDeg}°`}`, 'error');
    }
    return;
  }

  pushVoiceBridgeLog(`收到暂未支持的桥接动作 ${action}，已跳过。`, 'warning');
}

async function pollVoiceBridgeFile() {
  if (!voiceBridgeMonitorRunning || !voiceBridgeFileHandle || voiceBridgeIsPolling) {
    return;
  }

  voiceBridgeIsPolling = true;

  try {
    const file = await voiceBridgeFileHandle.getFile();
    const text = await file.text();
    const lines = text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (voiceBridgeProcessedLineCount > lines.length) {
      voiceBridgeProcessedLineCount = 0;
      pushVoiceBridgeLog('检测到桥接文件被重建，已从头重新监听。', 'warning');
    }

    const newLines = lines.slice(voiceBridgeProcessedLineCount);
    voiceBridgeProcessedLineCount = lines.length;

    for (const line of newLines) {
      try {
        const command = JSON.parse(line);
        voiceBridgeProcessedCommandCount += 1;
        await executeVoiceBridgeCommand(command);
      } catch (error) {
        console.error('Voice bridge command parse/execute failed:', error, line);
        pushVoiceBridgeLog(`桥接行解析失败，已跳过：${line.slice(0, 80)}`, 'error');
      }
    }
  } catch (error) {
    console.error('Voice bridge polling failed:', error);
    pushVoiceBridgeLog(`监听桥接文件失败：${error.message || '未知错误'}`, 'error');
    stopVoiceBridgeMonitor({ silent: true });
  } finally {
    voiceBridgeIsPolling = false;
    updateVoiceBridgeUI();
    if (voiceBridgeMonitorRunning) {
      voiceBridgePollTimer = window.setTimeout(pollVoiceBridgeFile, VOICE_BRIDGE_POLL_INTERVAL_MS);
    }
  }
}

function toggleVoiceBridgeMonitor() {
  if (voiceBridgeMonitorRunning) {
    stopVoiceBridgeMonitor();
    return;
  }

  if (!voiceBridgeFileHandle) {
    showAlert('servo', '请先选择 robot_command_bridge.jsonl 文件。', 3500);
    return;
  }

  voiceBridgeMonitorRunning = true;
  pushVoiceBridgeLog('已开始监听桥接文件新增命令。', 'success');
  voiceBridgePollTimer = window.setTimeout(pollVoiceBridgeFile, 0);
}

function updateLeaderFollowerTeleopUI() {
  const button = document.getElementById('toggleLeaderFollowerTeleop');
  const stateElement = document.getElementById('leaderFollowerTeleopState');

  if (button) {
    if (leaderFollowerTeleopRunning) {
      button.textContent = '停止主从遥操作';
    } else if (leaderFollowerTeleopSetupStage === 'awaiting_follower') {
      button.textContent = '选择学生端并启动';
    } else {
      button.textContent = '连接主从遥操作';
    }
    button.classList.toggle('active', leaderFollowerTeleopRunning);
    button.disabled = leaderFollowerTeleopBusy && !leaderFollowerTeleopRunning;
  }

  if (stateElement) {
    stateElement.dataset.state = leaderFollowerTeleopRunning
      ? 'active'
      : (leaderFollowerTeleopSetupStage === 'awaiting_follower' ? 'warning' : 'idle');
    stateElement.textContent = leaderFollowerTeleopStatusText;
  }

  updateMotionRecordingUI();
  updateMotionPlaybackUI();
}

function updateMotionRecordingUI() {
  const button = document.getElementById('toggleMotionRecording');
  const stateElement = document.getElementById('motionRecordingState');

  if (button) {
    button.textContent = motionRecordingActive ? '停止并导出动作' : '开始录制动作';
    button.classList.toggle('active', motionRecordingActive);
    button.disabled = motionPlaybackRunning || motionPlaybackBusy || (!motionRecordingActive && !leaderFollowerTeleopRunning);
  }

  if (stateElement) {
    stateElement.dataset.state = motionRecordingActive ? 'active' : 'idle';
    stateElement.textContent = motionRecordingActive
      ? `录制中 ${motionRecordingSamples.length} 帧`
      : motionRecordingStatusText;
  }
}

function updateMotionPlaybackUI() {
  const button = document.getElementById('toggleProjectMotionPlayback');
  const stateElement = document.getElementById('projectMotionPlaybackState');

  if (button) {
    if (motionPlaybackRunning) {
      button.textContent = '停止项目回放';
    } else if (motionPlaybackBusy) {
      button.textContent = '准备项目回放...';
    } else {
      button.textContent = '回放项目动作';
    }
    button.classList.toggle('active', motionPlaybackRunning);
    button.disabled = motionPlaybackBusy || (!motionPlaybackRunning && (leaderFollowerTeleopRunning || motionRecordingActive));
  }

  if (stateElement) {
    stateElement.dataset.state = motionPlaybackRunning
      ? 'active'
      : (motionPlaybackBusy ? 'warning' : 'idle');
    stateElement.textContent = motionPlaybackStatusText;
  }
}

function startMotionRecording() {
  if (!leaderFollowerTeleopRunning) {
    showAlert('servo', '请先启动网页里的主从遥操作，再开始录制动作。', 3600);
    return;
  }

  motionRecordingActive = true;
  motionRecordingSamples = [];
  motionRecordingStartedAtIso = new Date().toISOString();
  motionRecordingStartedPerf = performance.now();
  motionRecordingStatusText = '录制中';
  updateMotionRecordingUI();
  updateMotionPlaybackUI();
  updateRestoreZeroHint('动作录制已开始。现在可以直接掰教师端，停止后会自动导出 JSON 文件。', 'success');
  showAlert('servo', '已开始录制主从动作。停止后会自动下载 JSON 轨迹文件。', 3600);
}

function stopMotionRecording(reason = '动作录制已停止并导出文件。') {
  if (!motionRecordingActive) {
    motionRecordingStatusText = '录制待机';
    updateMotionRecordingUI();
    return null;
  }

  motionRecordingActive = false;
  const stoppedAtIso = new Date().toISOString();
  const durationMs = Math.max(0, Math.round(performance.now() - motionRecordingStartedPerf));
  const recordingPayload = {
    version: 1,
    mode: 'leader_follower_teleop',
    started_at: motionRecordingStartedAtIso,
    stopped_at: stoppedAtIso,
    duration_ms: durationMs,
    sample_count: motionRecordingSamples.length,
    teleop_interval_ms: LEADER_FOLLOWER_TELEOP_INTERVAL_MS,
    servo_ids: SERVO_IDS,
    servo_zero_raw_positions: SERVO_ZERO_RAW_POSITIONS,
    leader_anchor_raw: cloneServoRawMap(leaderFollowerTeleopLeaderAnchor),
    follower_anchor_raw: cloneServoRawMap(leaderFollowerTeleopFollowerAnchor),
    samples: motionRecordingSamples,
  };

  const fileName = `${MOTION_RECORDING_FILENAME_PREFIX}_${buildMotionRecordingTimestampLabel()}.json`;
  downloadTextFile(fileName, JSON.stringify(recordingPayload, null, 2));

  motionRecordingStatusText = `已导出 ${motionRecordingSamples.length} 帧`;
  motionRecordingSamples = [];
  motionRecordingStartedAtIso = null;
  motionRecordingStartedPerf = 0;
  updateMotionRecordingUI();
  updateMotionPlaybackUI();
  updateRestoreZeroHint(reason, 'success');
  showAlert('servo', `动作录制已导出：${fileName}`, 4200);
  return recordingPayload;
}

function toggleMotionRecording() {
  if (motionRecordingActive) {
    stopMotionRecording('动作录制已停止并导出文件。');
    return;
  }

  startMotionRecording();
}

function recordLeaderFollowerTeleopSample(leaderRawMap, followerBeforeRawMap, followerAfterRawMap, targets, speedValues, changed) {
  if (!motionRecordingActive) {
    return;
  }

  motionRecordingSamples.push({
    frame_index: motionRecordingSamples.length,
    t_ms: Math.max(0, Math.round(performance.now() - motionRecordingStartedPerf)),
    captured_at: new Date().toISOString(),
    changed,
    leader_raw: cloneServoRawMap(leaderRawMap),
    leader_deg: buildServoAngleMap(leaderRawMap),
    follower_before_raw: cloneServoRawMap(followerBeforeRawMap),
    follower_before_deg: buildServoAngleMap(followerBeforeRawMap),
    follower_target_raw: cloneServoRawMap(targets),
    follower_target_deg: buildServoAngleMap(targets),
    follower_after_raw: cloneServoRawMap(followerAfterRawMap),
    follower_after_deg: buildServoAngleMap(followerAfterRawMap),
    speed_values: buildServoSpeedMap(speedValues),
  });

  updateMotionRecordingUI();
}

async function stopProjectMotionPlayback(reason = '项目动作回放已停止。') {
  motionPlaybackRunId += 1;
  const wasRunning = motionPlaybackRunning || motionPlaybackBusy;
  motionPlaybackRunning = false;
  motionPlaybackBusy = false;
  motionPlaybackStatusText = reason;
  updateMotionPlaybackUI();
  updateMotionRecordingUI();
  updateDashboardUI();

  if (wasRunning && isConnectedToRealRobot && portHandler?.isOpen) {
    scheduleLiveSyncResume(320);
  }
}

async function startProjectMotionPlayback() {
  if (leaderFollowerTeleopRunning) {
    showAlert('servo', '请先停止主从遥操作，再开始项目动作回放。', 3800);
    return;
  }

  if (motionRecordingActive) {
    showAlert('servo', '请先停止动作录制，再开始项目动作回放。', 3800);
    return;
  }

  motionPlaybackBusy = true;
  motionPlaybackStatusText = '正在加载动作';
  updateMotionPlaybackUI();
  updateMotionRecordingUI();
  updateRestoreZeroHint('正在加载项目里的动作文件，并准备回放。', 'default');

  const useHardware = isConnectedToRealRobot && portHandler?.isOpen;
  const currentRunId = motionPlaybackRunId + 1;
  motionPlaybackRunId = currentRunId;

  try {
    const playbackData = await loadProjectMotionPlaybackData();
    const samples = playbackData.samples;
    const playbackStartRawMap = clampPlaybackTargetRawMap(getMotionPlaybackStartRawMap(playbackData));
    const currentRawMap = buildCurrentServoRawMap();
    const alignmentSpeedMap = buildPlaybackAlignmentSpeedMap(currentRawMap, playbackStartRawMap);

    motionPlaybackRunning = true;
    motionPlaybackBusy = false;
    motionPlaybackStatusText = useHardware ? '真机对齐起点' : '模拟对齐起点';
    updateMotionPlaybackUI();
    updateMotionRecordingUI();
    updateDashboardUI();

    stopLiveServoSync();

    if (useHardware) {
      const aligned = await syncWriteServoPositionsWithSpeeds(playbackStartRawMap, alignmentSpeedMap);
      if (!aligned) {
        throw new Error('真机回放起点对齐失败。');
      }
    }
    applyServoRawMapToDashboard(playbackStartRawMap, { updateLastSafe: useHardware });
    await sleepMs(PROJECT_MOTION_PLAYBACK_ALIGNMENT_SETTLE_MS);

    const playbackStartedPerf = performance.now();
    for (const sample of samples) {
      if (currentRunId !== motionPlaybackRunId) {
        throw new Error('__playback_cancelled__');
      }

      const sampleTimeMs = Number.isFinite(sample?.t_ms) ? sample.t_ms : 0;
      const waitMs = sampleTimeMs - (performance.now() - playbackStartedPerf);
      if (waitMs > 1) {
        await sleepMs(waitMs);
      }

      const targetRawMap = clampPlaybackTargetRawMap(getMotionPlaybackSampleTargetRawMap(sample));
      const speedMap = getMotionPlaybackSampleSpeedMap(sample);

      if (useHardware) {
        const success = await syncWriteServoPositionsWithSpeeds(targetRawMap, speedMap);
        if (!success) {
          throw new Error(`真机回放失败，帧 ${sample.frame_index ?? 0} 写入未成功。`);
        }
      }

      applyServoRawMapToDashboard(targetRawMap, { updateLastSafe: useHardware });
      motionPlaybackStatusText = `回放中 ${Math.min(samples.length, (sample.frame_index ?? 0) + 1)}/${samples.length}`;
      updateMotionPlaybackUI();
    }

    motionPlaybackRunning = false;
    motionPlaybackBusy = false;
    motionPlaybackStatusText = `已回放 ${samples.length} 帧`;
    updateMotionPlaybackUI();
    updateMotionRecordingUI();
    updateDashboardUI();
    updateRestoreZeroHint(
      useHardware
        ? '项目动作已回放到真机。可以继续手动控制、再次回放，或点击恢复零位。'
        : '项目动作已在模拟器中回放完成。连接真机后可直接把同一动作下发到学生端。',
      'success',
    );
    showAlert('servo', useHardware ? '项目动作已回放到真机。' : '项目动作已在模拟器中回放完成。', 4200);

    if (useHardware) {
      scheduleLiveSyncResume(320);
    }
  } catch (error) {
    if (error?.message !== '__playback_cancelled__') {
      console.error('Project motion playback failed:', error);
      showAlert('servo', `项目动作回放失败：${error.message || '未知错误'}`, 4800);
      updateRestoreZeroHint(`项目动作回放失败：${error.message || '未知错误'}`, 'error');
    } else {
      updateRestoreZeroHint('项目动作回放已停止。', 'default');
    }
    motionPlaybackRunning = false;
    motionPlaybackBusy = false;
    motionPlaybackStatusText = error?.message === '__playback_cancelled__' ? '回放已停止' : '回放失败';
    updateMotionPlaybackUI();
    updateMotionRecordingUI();
    updateDashboardUI();
    if (useHardware) {
      scheduleLiveSyncResume(320);
    }
  }
}

async function toggleProjectMotionPlayback() {
  if (motionPlaybackRunning || motionPlaybackBusy) {
    await stopProjectMotionPlayback('回放已停止');
    showAlert('servo', '项目动作回放已停止。', 3200);
    return;
  }

  await startProjectMotionPlayback();
}

async function requestOpenedSerialPort(promptText) {
  if (!navigator.serial) {
    throw new Error('当前浏览器不支持 Web Serial，请使用最新版 Chrome 或 Edge。');
  }

  if (promptText) {
    updateRestoreZeroHint(promptText, 'default');
  }

  const handler = new PortHandler();
  handler.setBaudRate(1000000);
  const selected = await handler.requestPort();
  if (!selected) {
    throw new Error(handler.getLastError?.() || '未选择串口');
  }

  const opened = await handler.openPort();
  if (!opened) {
    throw new Error(handler.getLastError?.() || '未能打开串口');
  }

  return handler;
}

function decodeServoRawPosition(rawPosition) {
  const lowByte = (rawPosition & 0xFF00) >> 8;
  const highByte = (rawPosition & 0x00FF) << 8;
  return ((rawPosition & 0xFFFF0000) | highByte | lowByte) & 0xFFFF;
}

async function readServoRawFromBus(busPortHandler, busPacketHandler, servoId) {
  const [rawPosition, result, error] = await busPacketHandler.read4ByteTxRx(
    busPortHandler,
    servoId,
    ADDR_SCS_PRESENT_POSITION,
  );

  if (result !== COMM_SUCCESS || error !== 0) {
    return null;
  }

  return decodeServoRawPosition(rawPosition);
}

async function readServoRawMapFromBus(busPortHandler, busPacketHandler) {
  const values = {};
  for (const servoId of SERVO_IDS) {
    values[servoId] = await readServoRawFromBus(busPortHandler, busPacketHandler, servoId);
  }
  return values;
}

function hasAllServoReadings(rawMap) {
  return SERVO_IDS.every(servoId => Number.isFinite(rawMap?.[servoId]));
}

async function closeLeaderPort() {
  if (leaderPortHandler?.isOpen) {
    try {
      await leaderPortHandler.closePort();
    } catch (error) {
      console.warn('关闭教师端串口失败：', error);
    }
  }
  leaderPortHandler = null;
  leaderPacketHandler = null;
}

async function stopLeaderFollowerTeleop(reason = '主从遥操作已停止。') {
  if (motionRecordingActive) {
    stopMotionRecording('主从遥操作已停止，录制文件已自动导出。');
  }

  if (motionPlaybackRunning || motionPlaybackBusy) {
    await stopProjectMotionPlayback('主从遥操作已停止，项目动作回放已结束。');
  }

  leaderFollowerTeleopRunning = false;
  leaderFollowerTeleopSetupStage = 'idle';
  if (leaderFollowerTeleopTimer) {
    clearTimeout(leaderFollowerTeleopTimer);
    leaderFollowerTeleopTimer = null;
  }

  await closeLeaderPort();
  leaderFollowerTeleopLeaderAnchor = {};
  leaderFollowerTeleopFollowerAnchor = {};
  leaderFollowerTeleopSmoothedLeader = {};
  leaderFollowerTeleopLastTargets = {};
  leaderFollowerTeleopStatusText = '主从待机';
  updateLeaderFollowerTeleopUI();
  updateDashboardUI();

  if (reason) {
    updateRestoreZeroHint(reason, 'default');
  }
}

function buildTeleopTargetPositions(leaderRawMap) {
  const targets = {};
  const speedValues = {};
  let changed = false;

  SERVO_IDS.forEach(servoId => {
    const rawLeader = leaderRawMap[servoId];
    const anchorLeader = leaderFollowerTeleopLeaderAnchor[servoId];
    const anchorFollower = leaderFollowerTeleopFollowerAnchor[servoId];
    if (!Number.isFinite(rawLeader) || !Number.isFinite(anchorLeader) || !Number.isFinite(anchorFollower)) {
      targets[servoId] = getServoCurrentRawPositionOrZero(servoId);
      speedValues[servoId] = 80;
      return;
    }

    const previousSmooth = Number.isFinite(leaderFollowerTeleopSmoothedLeader[servoId])
      ? leaderFollowerTeleopSmoothedLeader[servoId]
      : rawLeader;
    const smoothDelta = normalizeServoDelta(rawLeader - previousSmooth);
    const smoothedLeader = normalizeServoPositionTicks(
      previousSmooth + (smoothDelta * LEADER_FOLLOWER_TELEOP_SMOOTHING),
    );
    leaderFollowerTeleopSmoothedLeader[servoId] = smoothedLeader;

    const leaderDelta = normalizeServoDelta(smoothedLeader - anchorLeader);
    let targetRaw = normalizeServoPositionTicks(anchorFollower + leaderDelta);
    const requestedAngleDeg = getServoAngleDegreesFromRawPosition(servoId, targetRaw);
    const safeAngleDeg = clampServoTargetAngleDegrees(servoId, requestedAngleDeg, { showAlertOnClamp: false });
    targetRaw = getServoTargetRawPositionFromAngleDegrees(servoId, safeAngleDeg);

    const currentRaw = getServoCurrentRawPositionOrZero(servoId);
    const targetDeltaTicks = Math.abs(normalizeServoDelta(targetRaw - currentRaw));
    const lastTarget = leaderFollowerTeleopLastTargets[servoId];
    if (!Number.isFinite(lastTarget) || Math.abs(normalizeServoDelta(targetRaw - lastTarget)) >= LEADER_FOLLOWER_TELEOP_MIN_DELTA_TICKS) {
      changed = true;
    }

    targets[servoId] = targetRaw;
    speedValues[servoId] = clampServoSpeed(Math.max(55, Math.min(360, Math.round(targetDeltaTicks * 0.9))));
  });

  return { targets, speedValues, changed };
}

async function runLeaderFollowerTeleopLoop() {
  if (!leaderFollowerTeleopRunning || leaderFollowerTeleopBusy) {
    return;
  }

  leaderFollowerTeleopBusy = true;
  updateLeaderFollowerTeleopUI();
  const startedAt = performance.now();

  try {
    const leaderRawMap = await readServoRawMapFromBus(leaderPortHandler, leaderPacketHandler);
    if (!hasAllServoReadings(leaderRawMap)) {
      throw new Error('教师端 1-6 号舵机没有全部读到。');
    }

    const followerBeforeRawMap = buildCurrentServoRawMap();
    const { targets, speedValues, changed } = buildTeleopTargetPositions(leaderRawMap);
    if (changed) {
      stopLiveServoSync();
      const success = await syncWriteServoPositionsWithSpeeds(targets, speedValues);
      if (!success) {
        throw new Error('学生端同步写入失败。');
      }

      SERVO_IDS.forEach(servoId => {
        const targetRaw = normalizeServoPositionTicks(targets[servoId]);
        servoCurrentPositions[servoId] = targetRaw;
        servoLastSafePositions[servoId] = targetRaw;
        servoFeedbackState[servoId].goalRaw = targetRaw;
        leaderFollowerTeleopLastTargets[servoId] = targetRaw;
      });

      applyServoPoseToRobot(window.robot);
      updateServoStatusUI();
    }

    const followerAfterRawMap = buildCurrentServoRawMap();
    recordLeaderFollowerTeleopSample(
      leaderRawMap,
      followerBeforeRawMap,
      followerAfterRawMap,
      changed ? targets : followerAfterRawMap,
      speedValues,
      changed,
    );

    leaderFollowerTeleopStatusText = '主从跟随中';
    updateRestoreZeroHint('主从遥操作运行中：教师端动作正在写入学生端。', 'success');
  } catch (error) {
    console.error('Leader/follower teleop failed:', error);
    showAlert('servo', `主从遥操作异常：${error.message || '未知错误'}`, 5000);
    await stopLeaderFollowerTeleop(`主从遥操作异常：${error.message || '未知错误'}`);
    return;
  } finally {
    leaderFollowerTeleopBusy = false;
    updateLeaderFollowerTeleopUI();
  }

  if (leaderFollowerTeleopRunning) {
    const elapsed = performance.now() - startedAt;
    const delay = Math.max(20, LEADER_FOLLOWER_TELEOP_INTERVAL_MS - elapsed);
    leaderFollowerTeleopTimer = window.setTimeout(runLeaderFollowerTeleopLoop, delay);
  }
}

async function toggleLeaderFollowerTeleop() {
  if (motionPlaybackRunning || motionPlaybackBusy) {
    await stopProjectMotionPlayback('已切换为主从遥操作，项目动作回放已停止。');
  }

  if (leaderFollowerTeleopRunning || leaderPortHandler?.isOpen) {
    if (leaderFollowerTeleopRunning) {
      await stopLeaderFollowerTeleop('主从遥操作已停止，学生端保持连接，可继续网页手动控制。');
      return;
    }

    if (leaderFollowerTeleopSetupStage !== 'awaiting_follower') {
      await stopLeaderFollowerTeleop('主从遥操作准备已取消。');
      return;
    }
  }

  const button = document.getElementById('toggleLeaderFollowerTeleop');
  let shouldStartTeleopLoop = false;
  leaderFollowerTeleopBusy = true;
  leaderFollowerTeleopStatusText = leaderFollowerTeleopSetupStage === 'awaiting_follower'
    ? '选择学生端'
    : '选择教师端';
  updateLeaderFollowerTeleopUI();
  updateDashboardUI();

  try {
    if (leaderFollowerTeleopSetupStage === 'awaiting_follower') {
      portHandler = await requestOpenedSerialPort('请选择学生端串口，也就是要跟随动作的那台机械臂。');
      packetHandler = new PacketHandler(1);
      isConnectedToRealRobot = true;
      commandQueue = [];
      isProcessingQueue = false;
    } else {
      cancelRestoreMotion('正在切换到主从遥操作。');
      resetShoulderAssistRecoveryState();
      stopLiveServoSync();

      leaderPortHandler = await requestOpenedSerialPort('请选择教师端串口，也就是你要手动掰动的那台机械臂。');
      leaderPacketHandler = new PacketHandler(1);

      if (!isConnectedToRealRobot || !portHandler?.isOpen) {
        leaderFollowerTeleopSetupStage = 'awaiting_follower';
        leaderFollowerTeleopStatusText = '请选择学生端';
        updateLeaderFollowerTeleopUI();
        updateDashboardUI();
        updateRestoreZeroHint('教师端已选择。请再次点击“选择学生端并启动”，然后选择要跟随动作的学生端串口。', 'warning');
        return;
      }
    }

    const followerReads = await initializeServoTelemetry();
    if (followerReads.length === 0) {
      throw new Error('学生端已打开，但读取不到 1-6 号舵机。');
    }

    const leaderRawMap = await readServoRawMapFromBus(leaderPortHandler, leaderPacketHandler);
    if (!hasAllServoReadings(leaderRawMap)) {
      throw new Error('教师端已打开，但读取不到完整 1-6 号舵机。');
    }

    leaderFollowerTeleopLeaderAnchor = { ...leaderRawMap };
    leaderFollowerTeleopFollowerAnchor = Object.fromEntries(
      SERVO_IDS.map(servoId => [servoId, getServoCurrentRawPositionOrZero(servoId)]),
    );
    leaderFollowerTeleopSmoothedLeader = { ...leaderRawMap };
    leaderFollowerTeleopLastTargets = { ...leaderFollowerTeleopFollowerAnchor };
    leaderFollowerTeleopRunning = true;
    leaderFollowerTeleopSetupStage = 'idle';
    leaderFollowerTeleopStatusText = '主从跟随中';

    const connectButton = document.getElementById('connectRealRobot');
    if (connectButton) {
      connectButton.classList.add('connected');
      connectButton.textContent = '断开真实机械臂';
    }

    showAlert('servo', '主从遥操作已启动。教师端当前姿态作为相对零点，学生端会跟随后续动作。', 4200);
    shouldStartTeleopLoop = true;
  } catch (error) {
    console.error('Leader/follower teleop connection failed:', error);
    showAlert('servo', `主从遥操作连接失败：${error.message || '未知错误'}`, 5500);
    await stopLeaderFollowerTeleop(`主从遥操作连接失败：${error.message || '未知错误'}`);
  } finally {
    leaderFollowerTeleopBusy = false;
    if (button) {
      button.disabled = false;
    }
    updateLeaderFollowerTeleopUI();
    updateDashboardUI();
    if (shouldStartTeleopLoop && leaderFollowerTeleopRunning && !leaderFollowerTeleopTimer) {
      leaderFollowerTeleopTimer = window.setTimeout(runLeaderFollowerTeleopLoop, 0);
    }
  }
}

/**
 * 添加命令到队列并执行
 * @param {Function} commandFn - 一个返回Promise的函数
 * @returns {Promise} 命令执行的Promise
 */
function queueCommand(commandFn) {
  return new Promise((resolve, reject) => {
    // 添加命令到队列
    commandQueue.push({
      execute: commandFn,
      resolve,
      reject
    });
    
    // 如果队列未在处理中，开始处理
    if (!isProcessingQueue) {
      processCommandQueue();
    }
  });
}

/**
 * 处理命令队列
 */
async function processCommandQueue() {
  if (commandQueue.length === 0) {
    isProcessingQueue = false;
    return;
  }
  
  isProcessingQueue = true;
  const command = commandQueue.shift();
  
  try {
    // 在执行下一个命令前等待一小段时间
    await new Promise(resolve => setTimeout(resolve, 5));
    const result = await command.execute();
    command.resolve(result);
  } catch (error) {
    command.reject(error);
    console.error('Command execution error:', error);
  }
  
  // 继续处理队列中的下一个命令
  await processCommandQueue();
}

/**
 * 检查关节值是否在URDF定义的限制范围内
 * @param {Object} joint - 关节对象
 * @param {number} newValue - 新的关节值
 * @returns {boolean} 如果在限制范围内则返回true
 */
function isJointWithinLimits(joint, newValue) {
  // 如果关节类型是continuous或类型是fixed，则没有限制
  if (joint.jointType === 'continuous' || joint.jointType === 'fixed') {
    return true;
  }
  
  // 如果关节设置了ignoreLimits标志，也返回true
  if (joint.ignoreLimits) {
    return true;
  }
  
  // 检查关节值是否在上下限范围内
  // 注意：对于多自由度关节，需要检查每个值
  if (Array.isArray(newValue)) {
    // 对于多自由度关节如planar、floating等
    return true; // 这种情况较为复杂，需要根据实际情况处理
  } else {
    // 对于单自由度关节，如revolute或prismatic
    return newValue >= joint.limit.lower && newValue <= joint.limit.upper;
  }
}

function getRobotJointNames(robot = window.robot) {
  if (!robot || !robot.joints) {
    return [];
  }

  return Object.keys(robot.joints).filter(name => robot.joints[name].jointType !== 'fixed');
}

function normalizeServoDelta(deltaTicks) {
  let delta = deltaTicks;
  const halfTurn = SERVO_RESOLUTION / 2;

  while (delta > halfTurn) {
    delta -= SERVO_RESOLUTION;
  }

  while (delta < -halfTurn) {
    delta += SERVO_RESOLUTION;
  }

  return delta;
}

function clampJointToLimits(joint, value) {
  if (!joint || joint.jointType === 'fixed' || joint.jointType === 'continuous' || joint.ignoreLimits) {
    return value;
  }

  return Math.min(joint.limit.upper, Math.max(joint.limit.lower, value));
}

function getServoAngleDegrees(servoId) {
  const zeroRawPosition = getServoZeroRawPosition(servoId);
  const deltaTicks = normalizeServoDelta(servoCurrentPositions[servoId] - zeroRawPosition);
  return deltaTicks * SERVO_TICKS_TO_DEG * getServoDirectionMultiplier(servoId);
}

function getServoDirectionText(servoId, angleDeg) {
  if (!Number.isFinite(angleDeg) || Math.abs(angleDeg) < SERVO_DIRECTION_DEADZONE_DEG) {
    return '中位';
  }

  const labels = SERVO_DIRECTION_LABELS[servoId] ?? { positive: '正向', negative: '反向' };
  return angleDeg >= 0 ? labels.positive : labels.negative;
}

function applyServoPoseToRobot(robot = window.robot) {
  if (!robot || !robot.joints) {
    return;
  }

  const jointNames = getRobotJointNames(robot);
  if (jointNames.length === 0) {
    return;
  }

  SERVO_IDS.forEach(servoId => {
    const config = SERVO_JOINT_CONFIG[servoId];
    const zeroRawPosition = getServoZeroRawPosition(servoId);
    if (!config || zeroRawPosition === undefined || config.jointIndex >= jointNames.length) {
      return;
    }

    const jointName = jointNames[config.jointIndex];
    const joint = robot.joints[jointName];
    if (!joint) {
      return;
    }

    const deltaTicks = normalizeServoDelta(servoCurrentPositions[servoId] - zeroRawPosition);
    const deltaRad = deltaTicks * SERVO_TICKS_TO_RAD * config.direction;
    const zeroJointOffsetRad = getServoZeroJointOffsetRad(servoId);
    const nextValue = clampJointToLimits(joint, zeroJointOffsetRad + deltaRad);

    joint.setJointValue(nextValue);
  });

  robot.updateMatrixWorld?.(true);
}

async function readServoRegister1Byte(servoId, address) {
  if (!portHandler || !packetHandler || !isConnectedToRealRobot) {
    return null;
  }

  return queueCommand(async () => {
    try {
      const [value, result, error] = await packetHandler.read1ByteTxRx(
        portHandler,
        servoId,
        address,
      );

      if (result !== COMM_SUCCESS || error !== 0) {
        return null;
      }

      return value & 0xFF;
    } catch (error) {
      return null;
    }
  });
}

async function readServoRegister2Byte(servoId, address) {
  if (!portHandler || !packetHandler || !isConnectedToRealRobot) {
    return null;
  }

  return queueCommand(async () => {
    try {
      const [value, result, error] = await packetHandler.read2ByteTxRx(
        portHandler,
        servoId,
        address,
      );

      if (result !== COMM_SUCCESS || error !== 0) {
        return null;
      }

      return value & 0xFFFF;
    } catch (error) {
      return null;
    }
  });
}

async function refreshServoSupplementalFeedback(servoId) {
  const [temperature, goalRaw] = await Promise.all([
    readServoRegister1Byte(servoId, ADDR_SCS_PRESENT_TEMPERATURE),
    readServoRegister2Byte(servoId, ADDR_SCS_GOAL_POSITION),
  ]);

  if (Number.isFinite(temperature) && temperature >= 0 && temperature < 200) {
    servoFeedbackState[servoId].temperature = temperature;
  }

  if (Number.isFinite(goalRaw)) {
    servoFeedbackState[servoId].goalRaw = normalizeServoPositionTicks(goalRaw);
  }
}

async function refreshNextServoSupplementalFeedback() {
  if (!isConnectedToRealRobot || !portHandler?.isOpen) {
    return;
  }

  const servoId = SERVO_IDS[servoSupplementalFeedbackCursor % SERVO_IDS.length];
  servoSupplementalFeedbackCursor = (servoSupplementalFeedbackCursor + 1) % SERVO_IDS.length;
  await refreshServoSupplementalFeedback(servoId);
}

async function syncServoPositionsFromHardware() {
  const successfulReads = [];

  for (const servoId of SERVO_IDS) {
    const currentPosition = await readServoPosition(servoId, { silent: true });
    if (currentPosition !== null) {
      servoCurrentPositions[servoId] = currentPosition;
      servoLastSafePositions[servoId] = currentPosition;
      successfulReads.push(servoId);
    }
  }

  if (successfulReads.length > 0) {
    await refreshNextServoSupplementalFeedback();
    await maybeRestoreShoulderAssistRecovery();
  }

  if (successfulReads.length > 0) {
    applyServoPoseToRobot(window.robot);
    updateServoStatusUI();
  }

  return successfulReads;
}

function stopLiveServoSync() {
  liveSyncRunning = false;
  if (liveSyncTimer) {
    clearTimeout(liveSyncTimer);
    liveSyncTimer = null;
  }
  updateDashboardUI();
}

function startLiveServoSync() {
  stopLiveServoSync();
  liveSyncRunning = true;
  updateDashboardUI();

  const loop = async () => {
    if (!liveSyncRunning || !isConnectedToRealRobot || !portHandler?.isOpen) {
      return;
    }

    const startedAt = performance.now();

    try {
      await syncServoPositionsFromHardware();
    } catch (error) {
      console.error('Live servo sync failed:', error);
    }

    const elapsed = performance.now() - startedAt;
    const delay = Math.max(20, LIVE_SYNC_INTERVAL_MS - elapsed);
    liveSyncTimer = window.setTimeout(loop, delay);
  };

  liveSyncTimer = window.setTimeout(loop, 0);
}

async function initializeServoTelemetry() {
  let successfulReads = await syncServoPositionsFromHardware();

  if (successfulReads.length === 0 && packetHandler?.getProtocolEnd?.() !== 0) {
    console.warn('No servo feedback with protocol_end=1, retrying with protocol_end=0');
    packetHandler = new PacketHandler(0);
    successfulReads = await syncServoPositionsFromHardware();
  }

  if (successfulReads.length > 0) {
    for (const servoId of SERVO_IDS) {
      await refreshServoSupplementalFeedback(servoId);
    }
    updateServoTelemetryBoard();
  }

  applyServoPoseToRobot(window.robot);

  return successfulReads;
}

/**
 * 设置键盘控制
 * @param {Object} robot - 要控制的机器人对象
 * @returns {Function} 用于在渲染循环中更新关节的函数
 */
export function setupKeyboardControls(robot) {
  const keyState = {};
  // Get the keyboard control section element
  const keyboardControlSection = document.getElementById('keyboardControlSection');
  let keyboardActiveTimeout;

  initializeVirtualServoState();
  applyServoPoseToRobot(robot);
  updateServoStatusUI();

  // Get initial stepSize from the HTML slider
  const speedControl = document.getElementById('speedControl');
  let stepSize = speedControl ? MathUtils.degToRad(parseFloat(speedControl.value)) : MathUtils.degToRad(0.2);
  
  // 默认的按键-关节映射
  const keyMappings = {
    '1': { jointIndex: 0, direction: -1 },
    'q': { jointIndex: 0, direction: 1 },
    '2': { jointIndex: 1, direction: -1 },
    'w': { jointIndex: 1, direction: 1 },
    '3': { jointIndex: 2, direction: 1 },
    'e': { jointIndex: 2, direction: -1 },
    '4': { jointIndex: 3, direction: 1 },
    'r': { jointIndex: 3, direction: -1 },
    '5': { jointIndex: 4, direction: 1 },
    't': { jointIndex: 4, direction: -1 },
    '6': { jointIndex: 5, direction: 1 },
    'y': { jointIndex: 5, direction: -1 },
  };
  
  // 获取机器人实际的关节名称
  const jointNames = robot && robot.joints ? 
    Object.keys(robot.joints).filter(name => robot.joints[name].jointType !== 'fixed') : [];
  console.log('Available joints:', jointNames);
  
  // Function to set the div as active
  const setKeyboardSectionActive = () => {
    if (keyboardControlSection) {
      keyboardControlSection.classList.add('control-active');
      
      // Clear existing timeout if any
      if (keyboardActiveTimeout) {
        clearTimeout(keyboardActiveTimeout);
      }
      
      // Set timeout to remove the active class after 2 seconds of inactivity
      keyboardActiveTimeout = setTimeout(() => {
        keyboardControlSection.classList.remove('control-active');
      }, 2000);
    }
  };
  
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    keyState[key] = true;
    
    // Add visual styling to show pressed key
    const keyElement = document.querySelector(`.key[data-key="${key}"]`);
    if (keyElement) {
      keyElement.classList.add('key-pressed');
      
      // Highlight the keyboard control section
      setKeyboardSectionActive();
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    keyState[key] = false;
    
    // Remove visual styling when key is released
    const keyElement = document.querySelector(`.key[data-key="${key}"]`);
    if (keyElement) {
      keyElement.classList.remove('key-pressed');
    }
  });

  // 添加速度控制功能
  if (speedControl) {
    speedControl.addEventListener('input', (e) => {
      // 从滑块获取值 (0.5 到 10)，然后转换为弧度
      const speedFactor = parseFloat(e.target.value);
      stepSize = MathUtils.degToRad(speedFactor);
      
      // 更新速度显示
      const speedDisplay = document.getElementById('speedValue');
      if (speedDisplay) {
        speedDisplay.textContent = speedFactor.toFixed(1);
      }
    });
  }

  function updateJoints() {
    if (!robot || !robot.joints) return;

    let keyPressed = false;

    // 处理每个按键映射
    Object.keys(keyState).forEach(key => {
      if (keyState[key] && keyMappings[key]) {
        keyPressed = true;
        const { jointIndex, direction } = keyMappings[key];
        
        // 根据索引获取关节名称（如果可用）
        if (jointIndex < jointNames.length) {
          const jointName = jointNames[jointIndex];
          
          // 检查关节是否存在于机器人中
          if (robot.joints[jointName]) {
            // 如果连接到真实机器人，先检查该舵机是否有错误状态
            const servoId = jointIndex + 1;
            if (isConnectedToRealRobot && servoCommStatus[servoId].status === 'error') {
              console.warn(`舵机 ${servoId} 当前处于错误状态，已阻止虚拟关节继续运动。`);
              return; // 跳过这个关节的更新
            }
            
            // 获取当前关节值
            const currentValue = robot.joints[jointName].angle;
            // 计算新的关节值
            const newValue = currentValue + direction * stepSize;
            
            // 检查是否超出关节限制
            if (!isJointWithinLimits(robot.joints[jointName], newValue)) {
              console.warn(`关节 ${jointName} 将超过限位，已阻止继续运动。`);
              // 显示虚拟关节限位提醒
              showAlert('joint', `关节 ${jointName} 已达到限位！`);
              return; // 跳过这个关节的更新
            }
            
            // 如果连接到真实机器人，同时控制真实舵机
            if (isConnectedToRealRobot) {
              // 注意: 真实舵机ID从1到6，而jointIndex从0到5
              
              // 计算舵机相对位移量 (角度变化量转换为舵机步数)
              // 大约4096步对应一圈(2π)
              const currentAngleDeg = getServoAngleDegreesFromRawPosition(servoId, servoCurrentPositions[servoId]);
              const angleStepDeg = MathUtils.radToDeg(direction * stepSize);
              const tentativeTargetAngleDeg = currentAngleDeg + angleStepDeg;
              const protectedTargetAngleDeg = clampServoTargetAngleDegrees(
                servoId,
                tentativeTargetAngleDeg,
                { showAlertOnClamp: true },
              );
              const newPosition = getServoTargetRawPositionFromAngleDegrees(servoId, protectedTargetAngleDeg);
              
              // 重要说明：虚拟关节与真实舵机使用不同的位置和限制系统
              // 虚拟关节使用弧度制，受URDF中定义的限制约束
              // 真实舵机使用0-4095的步数范围，没有应用虚拟关节的限制
              
              // 暂存舵机位置（虚拟舵机还没更新）
              const prevPosition = servoCurrentPositions[servoId];
              // 更新当前位置记录
              servoCurrentPositions[servoId] = newPosition;
              
              // 更新舵机状态为待处理
              servoCommStatus[servoId].status = 'pending';
              updateServoStatusUI();
              
              // 使用队列系统控制舵机，防止并发访问
              // 等待舵机移动结果，决定是否更新虚拟关节
              const targetAngleDeg = getServoAngleDegreesFromRawPosition(servoId, newPosition);

              ensureServoMotionProfile(servoId, currentAngleDeg, targetAngleDeg)
                .then(() => writeServoPosition(servoId, newPosition))
                .then(success => {
                  // 如果舵机移动成功，更新最后成功位置并设置虚拟关节位置
                  if (success) {
                    // 更新最后安全位置
                    servoLastSafePositions[servoId] = newPosition;
                    applyServoPoseToRobot(robot);

                    // 更新舵机状态为成功
                    servoCommStatus[servoId].status = 'success';
                    updateServoStatusUI();
                  } else {
                    // 如果舵机移动失败，恢复当前位置记录
                    servoCurrentPositions[servoId] = prevPosition;
                    console.warn(`Failed to move servo ${servoId}. Virtual joint not updated.`);
                    
                    // 显示舵机错误提醒
                    showAlert('servo', `舵机 ${servoId} 运动失败！`);
                    
                    // 尝试将舵机恢复到最后一个安全位置
                    if (servoLastSafePositions[servoId] !== prevPosition) {
                      console.log(`Attempting to move servo ${servoId} back to last safe position...`);
                      writeServoPosition(servoId, servoLastSafePositions[servoId], true)
                        .then(recoverySuccess => {
                          if (recoverySuccess) {
                            console.log(`Successfully moved servo ${servoId} back to safe position.`);
                            servoCurrentPositions[servoId] = servoLastSafePositions[servoId];
                          } else {
                            console.error(`Failed to move servo ${servoId} back to safe position.`);
                            // 显示舵机恢复错误提醒
                            showAlert('servo', `舵机 ${servoId} 无法恢复到安全位置！`, 4000);
                          }
                        })
                        .catch(error => {
                          console.error(`Error moving servo ${servoId} back to safe position:`, error);
                          // 显示舵机恢复错误提醒
                          showAlert('servo', `舵机 ${servoId} 恢复失败：${error.message || '未知错误'}`, 4000);
                        });
                    }
                  }
                })
                .catch(error => {
                  // 舵机控制失败，不更新虚拟关节，恢复当前位置记录
                  servoCurrentPositions[servoId] = prevPosition;
                  console.error(`Error controlling servo ${servoId}:`, error);
                  servoCommStatus[servoId].status = 'error';
                  servoCommStatus[servoId].lastError = error.message || '通信错误';
                  updateServoStatusUI();
                  
                  // 显示舵机错误提醒
                  showAlert('servo', `舵机 ${servoId} 错误：${error.message || '通信失败'}`);
                  
                  // 尝试将舵机恢复到最后一个安全位置
                  if (servoLastSafePositions[servoId] !== prevPosition) {
                    console.log(`Attempting to move servo ${servoId} back to last safe position...`);
                    writeServoPosition(servoId, servoLastSafePositions[servoId], true)
                      .then(recoverySuccess => {
                        if (recoverySuccess) {
                          console.log(`Successfully moved servo ${servoId} back to safe position.`);
                          servoCurrentPositions[servoId] = servoLastSafePositions[servoId];
                        } else {
                          console.error(`Failed to move servo ${servoId} back to safe position.`);
                          // 显示舵机恢复错误提醒
                          showAlert('servo', `舵机 ${servoId} 无法恢复到安全位置！`, 4000);
                        }
                      })
                      .catch(error => {
                        console.error(`Error moving servo ${servoId} back to safe position:`, error);
                        // 显示舵机恢复错误提醒
                        showAlert('servo', `舵机 ${servoId} 恢复失败：${error.message || '未知错误'}`, 4000);
                      });
                  }
                });
            } else {
              // 如果没有连接真实机器人，也同步更新虚拟舵机状态和滑块界面
              const currentAngleDeg = getServoAngleDegreesFromRawPosition(servoId, servoCurrentPositions[servoId]);
              const angleStepDeg = MathUtils.radToDeg(direction * stepSize);
              const tentativeTargetAngleDeg = currentAngleDeg + angleStepDeg;
              const protectedTargetAngleDeg = clampServoTargetAngleDegrees(
                servoId,
                tentativeTargetAngleDeg,
                { showAlertOnClamp: true },
              );
              servoCurrentPositions[servoId] = getServoTargetRawPositionFromAngleDegrees(servoId, protectedTargetAngleDeg);
              servoLastSafePositions[servoId] = servoCurrentPositions[servoId];
              applyServoPoseToRobot(robot);
              updateServoStatusUI();
            }
          }
        }
      }
    });

    // If any key is pressed, set the keyboard section as active
    if (keyPressed) {
      setKeyboardSectionActive();
    }

    // 更新机器人
    if (robot.updateMatrixWorld) {
      robot.updateMatrixWorld(true);
    }
  }

  // 返回更新函数，以便可以在渲染循环中调用
  return updateJoints;
}

/**
 * 设置控制面板UI
 */
export function setupControlPanel() {
  const controlPanel = document.getElementById('controlPanel');
  const togglePanel = document.getElementById('togglePanel');
  const hideControls = document.getElementById('hideControls');

  // 处理折叠/展开控制面板
  if (hideControls) {
    hideControls.addEventListener('click', () => {
      controlPanel.style.display = 'none';
      togglePanel.style.display = 'block';
    });
  }

  if (togglePanel) {
    togglePanel.addEventListener('click', () => {
      controlPanel.style.display = 'block';
      togglePanel.style.display = 'none';
    });
  }

  // 初始化速度显示
  const speedDisplay = document.getElementById('speedValue');
  const speedControl = document.getElementById('speedControl');
  if (speedDisplay && speedControl) {
    speedDisplay.textContent = speedControl.value;
  }

  initializeVirtualServoState();
  resetShoulderAssistRecoveryState();
  resetServoFeedbackTelemetry();
  renderServoSliderPanel();
  renderServoTelemetryBoard();
  renderPidReferencePanel();
  renderServoReferencePanel();
  renderServoDiagnosticsPanel();
  setupDashboardPager();
  setupDashboardResizers();
  setupDashboardWheelIsolation();
  setupDashboardAutoScrollPanels();
  startDashboardClock();
  updateServoStatusUI();

  const servoStatusContainer = document.getElementById('servoStatusContainer');
  if (servoStatusContainer) {
    servoStatusContainer.classList.add('open');
    servoStatusContainer.style.display = 'block';
  }
  
  // 设置可折叠部分的逻辑
  setupCollapsibleSections();

  // 添加真实机器人连接事件处理
  const connectButton = document.getElementById('connectRealRobot');
  if (connectButton) {
    connectButton.addEventListener('click', toggleRealRobotConnection);
  }

  const restoreZeroButton = document.getElementById('restoreZeroPose');
  if (restoreZeroButton) {
    restoreZeroButton.textContent = RESTORE_ZERO_BUTTON_IDLE_TEXT;
    restoreZeroButton.addEventListener('click', restoreServoPoseToZero);
  }

  const selectVoiceBridgeFileButton = document.getElementById('selectVoiceBridgeFile');
  if (selectVoiceBridgeFileButton) {
    selectVoiceBridgeFileButton.addEventListener('click', selectVoiceBridgeFile);
  }

  const toggleVoiceBridgeMonitorButton = document.getElementById('toggleVoiceBridgeMonitor');
  if (toggleVoiceBridgeMonitorButton) {
    toggleVoiceBridgeMonitorButton.addEventListener('click', toggleVoiceBridgeMonitor);
  }

  const toggleLeaderFollowerTeleopButton = document.getElementById('toggleLeaderFollowerTeleop');
  if (toggleLeaderFollowerTeleopButton) {
    toggleLeaderFollowerTeleopButton.addEventListener('click', () => {
      void toggleLeaderFollowerTeleop();
    });
  }

  const toggleMotionRecordingButton = document.getElementById('toggleMotionRecording');
  if (toggleMotionRecordingButton) {
    toggleMotionRecordingButton.addEventListener('click', toggleMotionRecording);
  }

  const toggleProjectMotionPlaybackButton = document.getElementById('toggleProjectMotionPlayback');
  if (toggleProjectMotionPlaybackButton) {
    toggleProjectMotionPlaybackButton.addEventListener('click', () => {
      void toggleProjectMotionPlayback();
    });
  }

  updateVoiceBridgeUI();
  updateLeaderFollowerTeleopUI();
  updateMotionRecordingUI();
  updateMotionPlaybackUI();
  updateRestoreZeroHint();
  
  // Joycon和VR连接按钮的占位处理（未来实现）
  const connectJoyconButton = document.getElementById('connectJoycon');
  if (connectJoyconButton) {
    connectJoyconButton.addEventListener('click', () => {
      console.log('Joycon connection not yet implemented');
      alert('Joycon connection will be implemented in the future.');
    });
  }
  
  const connectVRButton = document.getElementById('connectVR');
  if (connectVRButton) {
    connectVRButton.addEventListener('click', () => {
      console.log('VR connection not yet implemented');
      alert('VR connection will be implemented in the future.');
    });
  }
}

/**
 * 设置可折叠部分的功能
 */
function setupCollapsibleSections() {
  // 获取所有可折叠部分的标头
  const collapsibleHeaders = document.querySelectorAll('.collapsible-header');
  
  collapsibleHeaders.forEach(header => {
    header.addEventListener('click', () => {
      // 切换当前可折叠部分的打开/关闭状态
      const section = header.parentElement;
      section.classList.toggle('open');
    });
  });
}

/**
 * 通用舵机错误处理函数
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} result - 通信结果代码
 * @param {number} error - 错误代码
 * @param {string} operation - 操作类型描述（如'read'、'position'等）
 * @param {boolean} isWarning - 是否作为警告处理（而非错误）
 * @returns {boolean} 操作是否成功
 */
function handleServoError(servoId, result, error, operation, isWarning = false, suppressAlert = false) {
  if (!servoCommStatus[servoId]) return false;
  
  if (result === COMM_SUCCESS && !isWarning) {
    servoCommStatus[servoId].status = 'success';
    servoCommStatus[servoId].lastError = null;
    return true;
  }
  
  // 设置状态（警告或错误）
  servoCommStatus[servoId].status = isWarning ? 'warning' : 'error';
  
  // 构造状态前缀
  const statusPrefix = isWarning ? '' : (result !== COMM_SUCCESS ? '通信失败：' : '');
  
  let errorMessage = '';
  
  // 检查错误码
  if (error & ERRBIT_OVERLOAD) {
    errorMessage = `${statusPrefix}过载或卡死${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overload error (${error})`);
  } else if (error & ERRBIT_OVERHEAT) {
    errorMessage = `${statusPrefix}过热${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overheat error (${error})`);
  } else if (error & ERRBIT_VOLTAGE) {
    errorMessage = `${statusPrefix}电压异常${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with voltage error (${error})`);
  } else if (error & ERRBIT_ANGLE) {
    errorMessage = `${statusPrefix}角度传感器异常${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with angle sensor error (${error})`);
  } else if (error & ERRBIT_OVERELE) {
    errorMessage = `${statusPrefix}过流${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${operation} ${isWarning ? 'warning' : 'failed'} with overcurrent error (${error})`);
  } else if (error !== 0 || result !== COMM_SUCCESS) {
    errorMessage = `${statusPrefix}${isWarning ? '未知错误码' : '操作失败'}：${error}${!isWarning ? `（代码: ${result}）` : ''}`;
    servoCommStatus[servoId].lastError = errorMessage;
    const logFn = isWarning ? console.warn : console.error;
    logFn(`Servo ${servoId} ${isWarning ? 'returned unknown error code' : operation + ' failed'}: ${error}`);
  } else {
    // 不太可能到达这里，但以防万一
    servoCommStatus[servoId].status = 'success';
    servoCommStatus[servoId].lastError = null;
    return true;
  }
  
  // 在UI上显示错误提醒，严重错误才弹出提醒
  if (!suppressAlert && (!isWarning || error & (ERRBIT_OVERLOAD | ERRBIT_OVERHEAT | ERRBIT_VOLTAGE))) {
    showAlert('servo', `舵机 ${servoId}：${errorMessage}`);
  }

  if (servoId === 2 && (error & ERRBIT_OVERLOAD)) {
    void triggerServoSafetyRetreat(servoId, errorMessage, { reason: 'overload' });
  } else if (
    servoId === 2 &&
    !isWarning &&
    (error & ERRBIT_VOLTAGE)
  ) {
    void triggerServoSafetyRetreat(servoId, errorMessage, { reason: 'voltage' });
  }
  
  updateServoStatusUI();
  return false;
}

// 添加真实机器人操作相关的函数
/**
 * 切换真实机器人连接状态
 */
async function toggleRealRobotConnection() {
  const connectButton = document.getElementById('connectRealRobot');
  const servoStatusContainer = document.getElementById('servoStatusContainer');
  
  if (!connectButton) return;

  if (motionPlaybackRunning || motionPlaybackBusy) {
    await stopProjectMotionPlayback('正在切换真实机械臂连接状态，项目动作回放已停止。');
  }

  if (leaderFollowerTeleopRunning) {
    await stopLeaderFollowerTeleop('已停止主从遥操作，正在切换真实机械臂连接状态。');
  }
  
  if (!isConnectedToRealRobot) {
    try {
      // Create new instances if needed
      if (!portHandler) portHandler = new PortHandler();
      
      // 使用固定的协议类型 SCS(1)
      const protocolEnd = 1;
      if (!packetHandler || packetHandler.getProtocolEnd() !== protocolEnd) {
        packetHandler = new PacketHandler(protocolEnd);
      }
      
      // Request serial port
      connectButton.disabled = true;
      connectButton.textContent = '连接中...';
      stopLiveServoSync();
      
      // 重置所有舵机状态为idle
      for (let servoId = 1; servoId <= 6; servoId++) {
        servoCommStatus[servoId] = { status: 'idle', lastError: null };
      }
      resetShoulderAssistRecoveryState();
      resetServoFeedbackTelemetry();
      updateServoStatusUI();
      
      // 显示舵机状态区域
      if (servoStatusContainer) {
        servoStatusContainer.style.display = 'block';
        // 确保状态面板默认是打开的
        servoStatusContainer.classList.add('open');
      }
      
      const success = await portHandler.requestPort();
      if (!success) {
        throw new Error(portHandler.getLastError?.() || '未能选择串口');
      }
      
      // 使用固定波特率 1000000
      const baudrate = 1000000;
      portHandler.setBaudRate(baudrate);
      
      // Open the port
      const opened = await portHandler.openPort();
      if (!opened) {
        const portMessage = portHandler.getLastError?.() || '未能打开串口';
        throw new Error(`${portMessage}。该串口可能正被其他浏览器标签页或串口工具占用。`);
      }

      isConnectedToRealRobot = true;
      
      // 清空命令队列
      commandQueue = [];
      isProcessingQueue = false;
      
      const successfulReads = await initializeServoTelemetry();
      if (successfulReads.length === 0) {
        throw new Error('已连接串口，但无法读取舵机位置。请先关闭其他串口工具后重试，必要时重新插拔控制板。');
      }

      for (const servoId of SERVO_IDS) {
        const currentAngleDeg = getServoAngleDegrees(servoId);
        await ensureServoMotionProfile(servoId, currentAngleDeg, currentAngleDeg);
      }
      
      startLiveServoSync();
      
      // Update UI
      connectButton.classList.add('connected');
      connectButton.textContent = '断开真实机械臂';
      updateRestoreZeroHint('已连接真实机械臂，现在可以拖动滑块控制真机，也可以点按钮缓慢恢复到既定 0° 姿态。');
      
    } catch (error) {
      console.error('Connection error:', error);
      alert(`连接失败：${error.message}`);
      connectButton.textContent = '连接真实机械臂';
      connectButton.classList.remove('connected');
      stopLiveServoSync();
      isConnectedToRealRobot = false;
      
      if (portHandler?.isOpen) {
        try {
          await portHandler.closePort();
        } catch (closeError) {
          console.warn('Error closing port after failed connection:', closeError);
        }
      }
      
      // 显示连接错误提醒
      showAlert('servo', `连接真实机械臂失败：${error.message}`, 5000);
      
      // 连接失败，更新所有舵机状态为error
      for (let servoId = 1; servoId <= 6; servoId++) {
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || '连接失败';
      }
      resetShoulderAssistRecoveryState();
      resetServoFeedbackTelemetry();
      updateServoStatusUI();
      updateRestoreZeroHint(`连接失败：${error.message || '未知错误'}`, 'error');
    } finally {
      connectButton.disabled = false;
    }
  } else {
    // Disconnect
    try {
      cancelRestoreMotion();
      stopLiveServoSync();
      if (sliderSyncResumeTimer) {
        clearTimeout(sliderSyncResumeTimer);
        sliderSyncResumeTimer = null;
      }

      SERVO_IDS.forEach(servoId => {
        servoSliderCommandState[servoId].pendingRaw = null;
      });
      // 清空命令队列
      commandQueue = [];
      isProcessingQueue = false;
      
      if (portHandler && portHandler.isOpen) {
        await portHandler.closePort();
      }
      
      // 断开后保留当前模拟器姿态，只重置通信状态
      for (let servoId = 1; servoId <= 6; servoId++) {
        servoCommStatus[servoId] = { status: 'idle', lastError: null };
        servoMotionProfileState[servoId] = { speed: null, acceleration: null };
      }
      resetShoulderAssistRecoveryState();
      resetServoFeedbackTelemetry();
      
      // 大屏模式下，断开后也保留状态面板，只更新为未连接
      if (servoStatusContainer) {
        servoStatusContainer.style.display = 'block';
        servoStatusContainer.classList.add('open');
      }
      
      // Update UI
      connectButton.classList.remove('connected');
      connectButton.textContent = '连接真实机械臂';
      isConnectedToRealRobot = false;
      updateServoStatusUI();
      updateRestoreZeroHint();
    } catch (error) {
      console.error('Disconnection error:', error);
    }
  }
}

/**
 * 读取舵机当前位置
 * @param {number} servoId - 舵机ID (1-6)
 * @returns {number|null} 当前位置值 (0-4095)或失败时返回null
 */
async function readServoPosition(servoId, options = {}) {
  if (!portHandler || !packetHandler) return null;
  const { silent = false } = options;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      if (servoCommStatus[servoId]) {
        servoCommStatus[servoId].status = 'pending';
        servoCommStatus[servoId].lastError = null;
        updateServoStatusUI();
      }
      
      // 读取当前位置
      const [rawPosition, result, error] = await packetHandler.read4ByteTxRx(
        portHandler,
        servoId,
        ADDR_SCS_PRESENT_POSITION
      );
      
      // 使用通用错误处理函数
      if (!handleServoError(servoId, result, error, 'position reading', false, silent)) {
        return null;
      }
      
      // 修复字节顺序问题 - 通常SCS舵机使用小端序(Little Endian)
      // 从0xD04变为0x40D (从3332变为1037)
      // 我们只关心最低的两个字节，所以可以通过位运算修复
      const lowByte = (rawPosition & 0xFF00) >> 8;  // 取高字节并右移到低位
      const highByte = (rawPosition & 0x00FF) << 8; // 取低字节并左移到高位
      const position = (rawPosition & 0xFFFF0000) | highByte | lowByte;
      
      // 输出调试信息
      console.log(`Servo ${servoId} raw: 0x${rawPosition.toString(16)}, fixed: 0x${position.toString(16)}`);
      
      return position & 0xFFFF; // 只取低16位，这是舵机位置的有效范围
    } catch (error) {
      console.error(`Error reading position from servo ${servoId}:`, error);
      
      // 更新舵机状态为错误
      if (servoCommStatus[servoId]) {
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || '通信错误';
        updateServoStatusUI();
      }
      
      return null;
    }
  });
}

/**
 * 直接写入舵机扭矩使能（不使用队列，仅供内部使用）
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} enable - 0: 关闭, 1: 开启
 */
async function writeTorqueEnableRaw(servoId, enable) {
  if (!portHandler || !packetHandler) return;
  
  try {
    const [result, error] = await packetHandler.write1ByteTxRx(
      portHandler, 
      servoId, 
      ADDR_SCS_TORQUE_ENABLE, 
      enable ? 1 : 0
    );
    
    if (result !== COMM_SUCCESS) {
      console.error(`Failed to write torque enable to servo ${servoId}: ${error}`);
    }
  } catch (error) {
    console.error(`Error writing torque enable to servo ${servoId}:`, error);
  }
}

/**
 * 写入舵机位置
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} position - 位置值 (0-4095)
 * @param {boolean} [skipLimitCheck=false] - 是否为恢复操作，已不再检查虚拟关节限制
 */
async function writeServoPosition(servoId, position, skipLimitCheck = false) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      // Write position to servo
      position = Math.max(0, Math.min(4095, position)); // Clamp to valid range
      const adjustedPosition = buildAdjustedServoPosition(position);
      servoFeedbackState[servoId].goalRaw = normalizeServoPositionTicks(position);
      
      const [result, error] = await packetHandler.write4ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_POSITION, 
        adjustedPosition & 0xFFFF // 只使用低16位
      );
      
      // 使用通用错误处理函数，通信成功但有错误时作为警告处理
      const isSuccess = result === COMM_SUCCESS;
      if (isSuccess && error !== 0) {
        // 通信成功但有硬件警告
        handleServoError(servoId, result, error, 'position control', true);
      } else {
        // 通信失败或无错误
        handleServoError(servoId, result, error, 'position control');
      }
      
      return isSuccess;
    } catch (error) {
      console.error(`Error writing position to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || '通信错误';
      updateServoStatusUI();
      throw error;
    }
  });
}

async function syncWriteServoPositionsWithSpeeds(targetPositions, speedValues) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return false;

  return queueCommand(async () => {
    const syncWrite = new GroupSyncWrite(
      portHandler,
      packetHandler,
      ADDR_SCS_GOAL_POSITION,
      6,
    );

    try {
      SERVO_IDS.forEach(servoId => {
        servoCommStatus[servoId].status = 'pending';
        servoCommStatus[servoId].lastError = null;
        servoFeedbackState[servoId].goalRaw = normalizeServoPositionTicks(targetPositions[servoId] ?? getServoZeroRawPosition(servoId));
      });
      updateServoStatusUI();

      for (const servoId of SERVO_IDS) {
        const targetPosition = buildAdjustedServoPosition(targetPositions[servoId] ?? getServoZeroRawPosition(servoId));
        const speedValue = clampServoSpeed(speedValues[servoId] ?? 0);
        const data = [
          SCS_LOBYTE(SCS_LOWORD(targetPosition)),
          SCS_HIBYTE(SCS_LOWORD(targetPosition)),
          SCS_LOBYTE(SCS_HIWORD(targetPosition)),
          SCS_HIBYTE(SCS_HIWORD(targetPosition)),
          SCS_LOBYTE(speedValue),
          SCS_HIBYTE(speedValue),
        ];

        const added = syncWrite.addParam(servoId, data);
        if (!added) {
          throw new Error(`同步写入参数失败：舵机 ${servoId}`);
        }
      }

      const result = await syncWrite.txPacket();
      if (result !== COMM_SUCCESS) {
        throw new Error(`同步写入失败，代码：${result}`);
      }

      SERVO_IDS.forEach(servoId => {
        servoCommStatus[servoId].status = 'success';
        servoCommStatus[servoId].lastError = null;
      });
      updateServoStatusUI();
      return true;
    } catch (error) {
      SERVO_IDS.forEach(servoId => {
        servoCommStatus[servoId].status = 'error';
        servoCommStatus[servoId].lastError = error.message || '同步写入失败';
      });
      updateServoStatusUI();
      throw error;
    } finally {
      syncWrite.clearParam();
    }
  });
}

/**
 * 设置舵机加速度
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} acceleration - 加速度值 (0-254)
 */
async function writeServoAcceleration(servoId, acceleration) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      acceleration = Math.max(0, Math.min(254, acceleration)); // Clamp to valid range
      
      const [result, error] = await packetHandler.write1ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_ACC, 
        acceleration
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'acceleration control');
    } catch (error) {
      console.error(`Error writing acceleration to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || '通信错误';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 设置舵机速度
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} speed - 速度值 (0-2000)
 */
async function writeServoSpeed(servoId, speed) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      speed = Math.max(0, Math.min(2000, speed)); // Clamp to valid range
      
      const [result, error] = await packetHandler.write2ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_GOAL_SPEED, 
        speed
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'speed control');
    } catch (error) {
      console.error(`Error writing speed to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || '通信错误';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 设置舵机扭矩开关
 * @param {number} servoId - 舵机ID (1-6)
 * @param {number} enable - 0: 关闭, 1: 开启
 */
async function writeTorqueEnable(servoId, enable) {
  if (!isConnectedToRealRobot || !portHandler || !packetHandler) return;
  
  return queueCommand(async () => {
    try {
      // 更新舵机状态为处理中
      servoCommStatus[servoId].status = 'pending';
      servoCommStatus[servoId].lastError = null;
      updateServoStatusUI();
      
      const [result, error] = await packetHandler.write1ByteTxRx(
        portHandler, 
        servoId, 
        ADDR_SCS_TORQUE_ENABLE, 
        enable ? 1 : 0
      );
      
      // 使用通用错误处理函数
      return handleServoError(servoId, result, error, 'torque control');
    } catch (error) {
      console.error(`Error writing torque enable to servo ${servoId}:`, error);
      servoCommStatus[servoId].status = 'error';
      servoCommStatus[servoId].lastError = error.message || '通信错误';
      updateServoStatusUI();
      throw error;
    }
  });
}

/**
 * 更新舵机通信状态UI
 */
function updateServoStatusUI() {
  // 检查是否存在状态显示区域
  const statusContainer = document.getElementById('servoStatusContainer');
  if (!statusContainer) {
    updateServoSliderUI();
    updateServoTelemetryBoard();
    updateDashboardUI();
    return;
  }
  
  // 更新每个舵机的状态
  for (let servoId = 1; servoId <= 6; servoId++) {
    const statusElement = document.getElementById(`servo-${servoId}-status`);
    if (statusElement) {
      const servoStatus = servoCommStatus[servoId];
      
      // 根据状态设置颜色
      let statusColor = '#8aa6c5'; // 默认灰色 (idle)
      
      if (servoStatus.status === 'success') {
        statusColor = '#29e0a0'; // 绿色
      } else if (servoStatus.status === 'error') {
        statusColor = '#ff6c7a'; // 红色
      } else if (servoStatus.status === 'pending') {
        statusColor = '#58d7ff'; // 蓝色
      } else if (servoStatus.status === 'warning') {
        statusColor = '#ffbf4d'; // 橙色（警告状态）
      }
      
      // 更新状态文本和颜色
      statusElement.style.color = statusColor;
      const angleDeg = getServoAngleDegrees(servoId);
      const angleText = formatSignedAngle(angleDeg);
      const directionText = getServoDirectionText(servoId, angleDeg);
      const statusText = SERVO_STATUS_LABELS[servoStatus.status] ?? servoStatus.status;
      statusElement.innerHTML = `${statusText}<br>${directionText} / ${angleText}`;
      
      // 更新错误信息提示
      const errorElement = document.getElementById(`servo-${servoId}-error`);
      if (errorElement) {
        if (servoStatus.lastError) {
          errorElement.textContent = servoStatus.lastError;
          errorElement.style.display = 'block';
        } else {
          errorElement.style.display = 'none';
        }
      }
    }
  }

  updateServoSliderUI();
  updateServoTelemetryBoard();
  updateServoReferencePanel();
  updateServoDiagnosticsPanel();
  updateDashboardUI();
}
