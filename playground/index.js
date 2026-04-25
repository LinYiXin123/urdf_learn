import {
  WebGLRenderer,
  PerspectiveCamera,
  Scene,
  Mesh,
  PlaneGeometry,
  ShadowMaterial,
  DirectionalLight,
  PCFSoftShadowMap,
  // sRGBEncoding,
  Color,
  AmbientLight,
  Box3,
  LoadingManager,
  MathUtils,
  MeshPhysicalMaterial,
  DoubleSide,
  ACESFilmicToneMapping,
  CanvasTexture,
  Float32BufferAttribute,
  RepeatWrapping,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import URDFLoader from 'urdf-loader';
// 导入控制工具函数
import { setupKeyboardControls, setupControlPanel } from './robotControls.js';

// 声明为全局变量
let scene, camera, renderer, controls;
// 将robot设为全局变量，便于其他模块访问
window.robot = null;
let keyboardUpdate;

init();
render();

function init() {

  scene = new Scene();
  scene.background = new Color(0x030918);

  camera = new PerspectiveCamera();
  // 默认从真机正面那一侧观察，避免一进入就是背面。
  camera.position.set(-5, 5, -5);
  camera.lookAt(0, 1, 0);

  renderer = new WebGLRenderer({ antialias: true });
  // renderer.outputEncoding = sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.physicallyCorrectLights = true;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  document.body.appendChild(renderer.domElement);

  const directionalLight = new DirectionalLight(0xbfe9ff, 1.15);
  directionalLight.castShadow = true;
  directionalLight.shadow.mapSize.setScalar(1024);
  directionalLight.position.set(5, 28, 9);
  scene.add(directionalLight);

  // Add second directional light for better reflections
  const directionalLight2 = new DirectionalLight(0x7bb8ff, 0.72);
  directionalLight2.position.set(-6, 12, -7);
  scene.add(directionalLight2);

  const ambientLight = new AmbientLight(0x75d5ff, 0.36);
  scene.add(ambientLight);

  const groundMaterial = new MeshPhysicalMaterial({
    color: 0x0a1832,
    metalness: 0.52,
    roughness: 0.4,
    reflectivity: 0.08,
    clearcoat: 0.45,
    side: DoubleSide,
    transparent: true,
    opacity: 0.42,
    emissive: 0x081427,
    emissiveIntensity: 0.55,
  });
  
  // 创建格子纹理的地面
  const gridSize = 60;
  const divisions = 60;
  
  // 创建网格地面
  const ground = new Mesh(new PlaneGeometry(gridSize, gridSize, divisions, divisions), groundMaterial);
  
  // 添加格子纹理
  const geometry = ground.geometry;
  const positionAttribute = geometry.getAttribute('position');
  
  // 创建格子纹理的UV坐标
  const uvs = [];
  const gridScale = 0.01; // 控制格子的密度
  
  for (let i = 0; i < positionAttribute.count; i++) {
    const x = positionAttribute.getX(i);
    const y = positionAttribute.getY(i);
    
    uvs.push(x * gridScale, y * gridScale);
  }
  
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  
  // 更新材质，添加格子纹理
  groundMaterial.map = createGridTexture();
  groundMaterial.roughnessMap = createGridTexture();
  
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 4;
  controls.target.set(0, 1, 0);
  controls.update();

  // 根据URL hash或默认加载模型
  function loadModelFromHash() {
    // 获取URL hash（去掉#号）
    let modelToLoad = 'genkiarm';
    
    // 加载模型
    const manager = new LoadingManager();
    const loader = new URDFLoader(manager);

    loader.load(`/URDF/${modelToLoad}.urdf`, result => {
      window.robot = result;
    });

    // 等待模型加载完成
    manager.onLoad = () => {
      window.robot.rotation.x = - Math.PI / 2;
      window.robot.rotation.z = - Math.PI;
      window.robot.traverse(c => {
        c.castShadow = true;
      });
      console.log(window.robot.joints);
      // 记录关节限制信息到控制台，便于调试
      logJointLimits(window.robot);
      
      window.robot.updateMatrixWorld(true);

      const bb = new Box3();
      bb.setFromObject(window.robot);

      window.robot.scale.set(15, 15, 15);
      window.robot.position.y -= bb.min.y;
      scene.add(window.robot);

      // Initialize keyboard controls
      keyboardUpdate = setupKeyboardControls(window.robot);
    };
  }

  // 初始加载模型
  loadModelFromHash();

  onResize();
  window.addEventListener('resize', onResize);

  // Setup UI for control panel
  setupControlPanel();
}

/**
 * 输出关节限制信息到控制台
 * @param {Object} robot - 机器人对象
 */
function logJointLimits(robot) {
  if (!robot || !robot.joints) return;
  
  console.log("Robot joint limits:");
  Object.entries(robot.joints).forEach(([name, joint]) => {
    console.log(`Joint: ${name}`);
    console.log(`  Type: ${joint.jointType}`);
    
    if (joint.jointType !== 'fixed' && joint.jointType !== 'continuous') {
      console.log(`  Limits: ${joint.limit.lower.toFixed(4)} to ${joint.limit.upper.toFixed(4)} rad`);
      console.log(`  Current value: ${Array.isArray(joint.jointValue) ? joint.jointValue.join(', ') : joint.jointValue}`);
    } else if (joint.jointType === 'continuous') {
      console.log(`  No limits (continuous joint)`);
    } else {
      console.log(`  No limits (fixed joint)`);
    }
  });
}

function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

function render() {
  requestAnimationFrame(render);
  
  // Update joint positions based on keyboard input
  if (keyboardUpdate) {
    keyboardUpdate();
  }
  
  renderer.render(scene, camera);
}

// 添加创建格子纹理的函数
function createGridTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  
  const context = canvas.getContext('2d');
  
  // 填充深蓝底色并叠加发光网格
  context.fillStyle = '#081427';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.lineWidth = 1;
  context.strokeStyle = '#2f8fc4';
  
  const cellSize = 32; // 每个格子的大小
  
  for (let i = 0; i <= canvas.width; i += cellSize) {
    context.beginPath();
    context.moveTo(i, 0);
    context.lineTo(i, canvas.height);
    context.stroke();
  }
  
  for (let i = 0; i <= canvas.height; i += cellSize) {
    context.beginPath();
    context.moveTo(0, i);
    context.lineTo(canvas.width, i);
    context.stroke();
  }
  
  // 修复: 使用已导入的 CanvasTexture，而不是 THREE.CanvasTexture
  const texture = new CanvasTexture(canvas);
  // 修复: 使用已导入的 RepeatWrapping，而不是 THREE.RepeatWrapping
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(10, 10);
  
  return texture;
}
