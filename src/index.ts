import './style.css'
import $ from 'jquery';
import * as THREE from 'three';
import { TrackballControls } from 'three/examples/jsm/controls/TrackballControls.js';
import { CSG } from 'three-csg-ts';
import { Subscription, interval } from 'rxjs';
import { gsap } from 'gsap';
import { randomScrambleForEvent } from 'cubing/scramble';
// @ts-ignore
import min2phase from './min2phase.js';
import { CFOPSolver } from './cfop-solver';
import {
  connectGanCube,
  GanCubeConnection,
  GanCubeEvent,
  GanCubeMove,
  MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampCalcSkew,
  cubeTimestampLinearFit
} from 'gan-web-bluetooth';
import { faceletsToPattern } from './utils';

// --- HMR Cleanup ---
document.getElementById('cube-container')?.querySelectorAll('canvas').forEach(c => c.remove());

// --- Setup ---
const scene = new THREE.Scene();
const mainCubeGroup = new THREE.Group();
scene.add(mainCubeGroup);

const highlighterGroup = new THREE.Group();
mainCubeGroup.add(highlighterGroup);

const container = document.getElementById('cube-container')!;
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const controls = new TrackballControls(camera, renderer.domElement);
controls.rotateSpeed = 4.0;
controls.dynamicDampingFactor = 0.1;
camera.position.set(3, 3, 3);
controls.update();

// Basic Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.5));

const light1 = new THREE.DirectionalLight(0xffffff, 1.0);
light1.position.set(5, 10, 7);
scene.add(light1);

const light2 = new THREE.DirectionalLight(0xffffff, 0.5);
light2.position.set(-5, -5, -5);
scene.add(light2);

// Create a simple environment map for reflections
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
scene.environment = pmremGenerator.fromScene(new THREE.Scene()).texture;

// --- Constants ---
const cubieSize = 1;
const SPACING = 1.05;
const SOLVED_STATE = "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";
const ANIMATION_DURATION = 0.05; // Speed of cube turns in seconds

var conn: GanCubeConnection | null = null;
var lastMoves: GanCubeMove[] = [];
var solutionMoves: GanCubeMove[] = [];

var cubeQuaternion: THREE.Quaternion = new THREE.Quaternion();
var basis: THREE.Quaternion | null = null;
var lastVelocity: THREE.Vector3 = new THREE.Vector3();
var lastGyroTimestamp: number = 0;

var timerState: "IDLE" | "READY" | "RUNNING" | "STOPPED" = "IDLE";
var localTimer: Subscription | null = null;

var lastFacelets: string = SOLVED_STATE;
var currentScramble: string[] = [];
var scrambleIndex: number = -1;
var accumulatedMoveAmount: number = 0;

const cubies: THREE.Group[] = [];
let isProcessingQueue = false;
const moveQueue: string[] = [];
let cubeStateInitialized = false;

// --- State Application ---

const FACE_NORMALS: Record<string, THREE.Vector3> = {
  'U': new THREE.Vector3(0, 1, 0),
  'D': new THREE.Vector3(0, -1, 0),
  'F': new THREE.Vector3(0, 0, 1),
  'B': new THREE.Vector3(0, 0, -1),
  'L': new THREE.Vector3(-1, 0, 0),
  'R': new THREE.Vector3(1, 0, 0),
};

const SLOT_STICKERS: Record<string, { face: string, index: number }[]> = {
  // Centers
  'U': [{ face: 'U', index: 4 }],
  'D': [{ face: 'D', index: 31 }],
  'F': [{ face: 'F', index: 22 }],
  'R': [{ face: 'R', index: 13 }],
  'L': [{ face: 'L', index: 40 }],
  'B': [{ face: 'B', index: 49 }],
  // Edges
  'UF': [{ face: 'U', index: 7 }, { face: 'F', index: 19 }],
  'UL': [{ face: 'U', index: 3 }, { face: 'L', index: 37 }],
  'UB': [{ face: 'U', index: 1 }, { face: 'B', index: 46 }],
  'UR': [{ face: 'U', index: 5 }, { face: 'R', index: 10 }],
  'DF': [{ face: 'D', index: 28 }, { face: 'F', index: 25 }],
  'DL': [{ face: 'D', index: 30 }, { face: 'L', index: 43 }],
  'DB': [{ face: 'D', index: 34 }, { face: 'B', index: 52 }],
  'DR': [{ face: 'D', index: 32 }, { face: 'R', index: 16 }],
  'FL': [{ face: 'F', index: 21 }, { face: 'L', index: 41 }],
  'FR': [{ face: 'F', index: 23 }, { face: 'R', index: 12 }],
  'BL': [{ face: 'B', index: 50 }, { face: 'L', index: 39 }],
  'BR': [{ face: 'B', index: 48 }, { face: 'R', index: 14 }],
  // Corners
  'UFL': [{ face: 'U', index: 6 }, { face: 'F', index: 18 }, { face: 'L', index: 38 }],
  'UFR': [{ face: 'U', index: 8 }, { face: 'F', index: 20 }, { face: 'R', index: 9 }],
  'UBR': [{ face: 'U', index: 2 }, { face: 'R', index: 11 }, { face: 'B', index: 45 }],
  'UBL': [{ face: 'U', index: 0 }, { face: 'B', index: 47 }, { face: 'L', index: 36 }],
  'DFL': [{ face: 'D', index: 27 }, { face: 'F', index: 24 }, { face: 'L', index: 44 }],
  'DFR': [{ face: 'D', index: 29 }, { face: 'F', index: 26 }, { face: 'R', index: 15 }],
  'DBR': [{ face: 'D', index: 35 }, { face: 'B', index: 51 }, { face: 'R', index: 17 }],
  'DBL': [{ face: 'D', index: 33 }, { face: 'B', index: 53 }, { face: 'L', index: 42 }]
};

const COLOR_TO_FACE: Record<number, string> = {
  [0xffffff]: 'U', // Top
  [0xffff00]: 'D', // Bottom
  [0x00ff00]: 'F', // Front
  [0x0000ff]: 'B', // Back
  [0xffa500]: 'L', // Left
  [0xff0000]: 'R',  // Right
};

function applyFacelets(facelets: string) {
  console.log("Applying facelets to digital cube pieces...");
  for (const slotName in SLOT_STICKERS) {
    const slotInfo = SLOT_STICKERS[slotName];
    const colorsAtSlot = slotInfo.map(s => facelets[s.index]);
    
    // Find the piece that has these colors (regardless of orientation)
    const piece = cubies.find(c => {
      const bc = c.userData.baseColors;
      const pieceColors = Object.entries(bc)
        .filter(([key, val]) => key !== 'Plastic' && val !== undefined)
        .map(([_, val]) => COLOR_TO_FACE[val as number]);
      
      if (pieceColors.length !== colorsAtSlot.length) return false;
      return colorsAtSlot.every(color => pieceColors.includes(color));
    });

    if (!piece) {
      console.warn(`Could not find piece for slot ${slotName} with colors ${colorsAtSlot}`);
      continue;
    }

    // 1. Move piece to slot position
    const slotPos = (SLOTS as any)[slotName];
    piece.position.set(slotPos.x * SPACING, slotPos.y * SPACING, slotPos.z * SPACING);

    // 2. Orient piece
    const bc = piece.userData.baseColors;
    
    // Find local axis for each color of the piece
    const getLocalAxis = (color: string) => {
      if (COLOR_TO_FACE[bc.Top] === color) return new THREE.Vector3(0, 1, 0);
      if (COLOR_TO_FACE[bc.Bottom] === color) return new THREE.Vector3(0, -1, 0);
      if (COLOR_TO_FACE[bc.Front] === color) return new THREE.Vector3(0, 0, 1);
      if (COLOR_TO_FACE[bc.Back] === color) return new THREE.Vector3(0, 0, -1);
      if (COLOR_TO_FACE[bc.Left] === color) return new THREE.Vector3(-1, 0, 0);
      if (COLOR_TO_FACE[bc.Right] === color) return new THREE.Vector3(1, 0, 0);
      return null;
    };

    const targetFace1 = slotInfo[0].face;
    const colorOnFace1 = facelets[slotInfo[0].index];
    const targetNormal1 = FACE_NORMALS[targetFace1];
    const localAxis1 = getLocalAxis(colorOnFace1);

    if (localAxis1 && slotInfo.length > 1) {
      const targetFace2 = slotInfo[1].face;
      const colorOnFace2 = facelets[slotInfo[1].index];
      const targetNormal2 = FACE_NORMALS[targetFace2];
      const localAxis2 = getLocalAxis(colorOnFace2);

      if (localAxis2) {
        const localAxis3 = new THREE.Vector3().crossVectors(localAxis1, localAxis2);
        const targetNormal3 = new THREE.Vector3().crossVectors(targetNormal1, targetNormal2);
        
        const matL = new THREE.Matrix4().makeBasis(localAxis1, localAxis2, localAxis3);
        const matT = new THREE.Matrix4().makeBasis(targetNormal1, targetNormal2, targetNormal3);
        const matM = matT.multiply(matL.invert());
        
        piece.quaternion.setFromRotationMatrix(matM);
      }
    } else if (localAxis1) {
      piece.quaternion.setFromUnitVectors(localAxis1, targetNormal1);
    }

    // Snap to grid
    piece.position.x = Math.round(piece.position.x / SPACING) * SPACING;
    piece.position.y = Math.round(piece.position.y / SPACING) * SPACING;
    piece.position.z = Math.round(piece.position.z / SPACING) * SPACING;
  }
}

// --- Move Execution ---

/**
 * Maps a Face name to its rotation axis and plane coordinate
 */
const FACE_MAP: Record<string, { axis: 'x' | 'y' | 'z', value: number, direction: number }> = {
  'U': { axis: 'y', value: 1,  direction: -1 },
  'D': { axis: 'y', value: -1, direction: 1 },
  'L': { axis: 'x', value: -1, direction: 1 },
  'R': { axis: 'x', value: 1,  direction: -1 },
  'F': { axis: 'z', value: 1,  direction: -1 },
  'B': { axis: 'z', value: -1, direction: 1 },
};

async function animateMove(moveStr: string) {
  // Parse move: e.g., "U", "U'", "U2"
  const faceChar = moveStr[0];
  const modifier = moveStr.substring(1);
  const faceInfo = FACE_MAP[faceChar];

  if (!faceInfo) return;

  let angle = (Math.PI / 2) * faceInfo.direction;
  if (modifier === "'") angle *= -1;
  else if (modifier === "2") angle *= 2;

  const pivot = new THREE.Group();
  mainCubeGroup.add(pivot);

  const piecesInLayer: THREE.Group[] = [];
  const EPS = 0.2; 
  
  cubies.forEach(cubie => {
    cubie.updateMatrix();
    const pos = cubie.position;
    const val = faceInfo.axis === 'x' ? pos.x : (faceInfo.axis === 'y' ? pos.y : pos.z);
    if (Math.abs(val - faceInfo.value * SPACING) < EPS) {
      piecesInLayer.push(cubie);
    }
  });

  // Log debug info
  const logEntry = document.createElement('div');
  logEntry.className = 'console-entry';
  logEntry.style.color = piecesInLayer.length === 9 ? '#0f0' : '#f00';
  logEntry.innerHTML = `<span class="timestamp">[DEBUG]</span> Animating ${moveStr}: Found ${piecesInLayer.length} pieces`;
  document.getElementById('bt-console-body')?.appendChild(logEntry);

  piecesInLayer.forEach(p => pivot.attach(p));

  // 4. Animate pivot using Quaternion Slerp
  const startQuat = pivot.quaternion.clone();
  const rotationAxis = new THREE.Vector3(
    faceInfo.axis === 'x' ? 1 : 0,
    faceInfo.axis === 'y' ? 1 : 0,
    faceInfo.axis === 'z' ? 1 : 0
  );
  const endQuat = new THREE.Quaternion().setFromAxisAngle(rotationAxis, angle).multiply(startQuat);

  const animObj = { t: 0 };
  await gsap.to(animObj, {
    t: 1,
    duration: ANIMATION_DURATION,
    ease: "power2.inOut",
    onUpdate: () => {
      pivot.quaternion.slerpQuaternions(startQuat, endQuat, animObj.t);
    }
  });

  piecesInLayer.forEach(p => {
    mainCubeGroup.attach(p);
    p.position.x = Math.round(p.position.x / SPACING) * SPACING;
    p.position.y = Math.round(p.position.y / SPACING) * SPACING;
    p.position.z = Math.round(p.position.z / SPACING) * SPACING;
  });
  
  mainCubeGroup.remove(pivot);
}

async function processQueue() {
  if (isProcessingQueue || moveQueue.length === 0) return;
  isProcessingQueue = true;

  while (moveQueue.length > 0) {
    const batch: string[] = [];
    const firstMoveStr = moveQueue.shift()!;
    batch.push(firstMoveStr);
    
    const firstMoveInfo = FACE_MAP[firstMoveStr[0]];
    
    // Look for compatible moves immediately following in the queue
    while (moveQueue.length > 0) {
      const nextMoveStr = moveQueue[0];
      const nextMoveInfo = FACE_MAP[nextMoveStr[0]];
      
      // Compatible if same axis but different layer value
      const isCompatible = nextMoveInfo && 
                          nextMoveInfo.axis === firstMoveInfo.axis && 
                          !batch.some(m => FACE_MAP[m[0]].value === nextMoveInfo.value);
      
      if (isCompatible) {
        batch.push(moveQueue.shift()!);
      } else {
        break; // Stop batching to preserve order
      }
    }

    // Run all moves in the batch simultaneously
    await Promise.all(batch.map(move => animateMove(move)));
  }

  isProcessingQueue = false;
}

type Axis = 'x' | 'y' | 'z';
type SignedAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

type BodyProfile =
  | { kind: 'rect' }
  | { kind: 'circle'; radius?: number }
  | { kind: 'd'; radius?: number; roundSide?: SignedAxis }
  | { kind: 'roundedRect'; radius?: number; radiusU?: number; radiusV?: number };

type BodyProfiles = Partial<Record<Axis, BodyProfile>>;

function axisRotate90Map(axis: Axis): Record<SignedAxis, number> {
  // Rotation angles (radians) around the chosen axis that map the canonical "rounded side"
  // direction onto the requested `roundSide`.
  // Canonical D profile is "flat on -U, rounded on +U", where U is:
  // - axis 'z': U = +x (cross-section plane XY)
  // - axis 'y': U = +x (cross-section plane XZ)
  // - axis 'x': U = +y (cross-section plane YZ)
  if (axis === 'z') return { '+x': 0, '+y': Math.PI / 2, '-x': Math.PI, '-y': -Math.PI / 2, '+z': 0, '-z': 0 };
  if (axis === 'y') return { '+x': 0, '+z': Math.PI / 2, '-x': Math.PI, '-z': -Math.PI / 2, '+y': 0, '-y': 0 };
  return { '+y': 0, '+z': Math.PI / 2, '-y': Math.PI, '-z': -Math.PI / 2, '+x': 0, '-x': 0 };
}

function isRoundSideValidForAxis(axis: Axis, side: SignedAxis): boolean {
  if (axis === 'x') return side === '+y' || side === '-y' || side === '+z' || side === '-z';
  if (axis === 'y') return side === '+x' || side === '-x' || side === '+z' || side === '-z';
  return side === '+x' || side === '-x' || side === '+y' || side === '-y';
}

function make2DShape(profile: BodyProfile, half: number): THREE.Shape {
  const kind = profile.kind;
  if (kind === 'rect') {
    const s = new THREE.Shape();
    s.moveTo(-half, -half);
    s.lineTo(-half, half);
    s.lineTo(half, half);
    s.lineTo(half, -half);
    s.lineTo(-half, -half);
    return s;
  }

  if (kind === 'circle') {
    const r = Math.min(half, Math.max(0.000001, profile.radius ?? half));
    const s = new THREE.Shape();
    s.absarc(0, 0, r, 0, Math.PI * 2, false);
    return s;
  }

  if (kind === 'roundedRect') {
    const rU = Math.min(half, Math.max(0.000001, profile.radiusU ?? profile.radius ?? 0));
    const rV = Math.min(half, Math.max(0.000001, profile.radiusV ?? profile.radius ?? 0));
    const innerU = half - rU;
    const innerV = half - rV;

    const s = new THREE.Shape();
    // Trace clockwise starting at the top-right of the top edge (before the corner arc).
    s.moveTo(innerU, half);
    s.lineTo(-innerU, half);
    s.absellipse(-innerU, innerV, rU, rV, Math.PI / 2, Math.PI, false, 0);
    s.lineTo(-half, -innerV);
    s.absellipse(-innerU, -innerV, rU, rV, Math.PI, (Math.PI * 3) / 2, false, 0);
    s.lineTo(innerU, -half);
    s.absellipse(innerU, -innerV, rU, rV, (Math.PI * 3) / 2, 0, false, 0);
    s.lineTo(half, innerV);
    s.absellipse(innerU, innerV, rU, rV, 0, Math.PI / 2, false, 0);
    s.lineTo(innerU, half);
    return s;
  }

  // kind === 'd'
  const r = Math.min(half, Math.max(0.000001, profile.radius ?? half));
  // Canonical D in the XY plane: flat on -X, rounded on +X.
  // Rectangle fills the whole left half, semicircle fills the right half.
  const s = new THREE.Shape();
  s.moveTo(-half, -half);
  s.lineTo(-half, half);
  s.lineTo(0, half);
  s.absarc(0, 0, r, Math.PI / 2, -Math.PI / 2, true);
  s.lineTo(0, -half);
  s.lineTo(-half, -half);
  return s;
}

function buildProfilePrism(axis: Axis, profile: BodyProfile, size: number): THREE.BufferGeometry {
  const half = size / 2;
  const shape = make2DShape(profile, half);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: size,
    steps: 1,
    bevelEnabled: false,
    curveSegments: 64
  });

  // Center the extrusion around origin (it extrudes along +Z by default).
  geo.translate(0, 0, -half);

  // Rotate so the extrusion axis matches the requested axis.
  if (axis === 'y') {
    // z -> y, and shape's y -> z (cross-section becomes XZ)
    geo.rotateX(-Math.PI / 2);
  } else if (axis === 'x') {
    // z -> x, and shape plane becomes YZ (shape x -> y, shape y -> z)
    geo.rotateY(Math.PI / 2);
    geo.rotateX(Math.PI / 2);
  }

  // For D profiles, rotate the cross-section around the extrusion axis so the rounded side points where you want.
  if (profile.kind === 'd' && profile.roundSide) {
    const roundSide = profile.roundSide;
    if (isRoundSideValidForAxis(axis, roundSide)) {
      const rot = axisRotate90Map(axis)[roundSide];
      if (axis === 'x') geo.rotateX(rot);
      else if (axis === 'y') geo.rotateY(rot);
      else geo.rotateZ(rot);
    } else {
      console.warn(`[createCubie] Invalid d.roundSide=${roundSide} for axis=${axis}.`);
    }
  }

  return geo;
}

function createPhysicalMaterial(color: number, isSticker: boolean = false) {
  return new THREE.MeshPhysicalMaterial({
    color: color,
    metalness: 0.1,
    roughness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    reflectivity: 1.0,
    side: THREE.DoubleSide,
    ...(isSticker ? {
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    } : {})
  });
}

function buildSolidBodyFromProfiles(profiles: BodyProfiles, material: THREE.Material, size: number): THREE.Mesh {
  // Start with a cube bounding volume, then intersect cross-section prisms along requested axes.
  let solid: THREE.Mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), material);
  solid.updateMatrix();

  (['x', 'y', 'z'] as Axis[]).forEach(axis => {
    const p = profiles[axis];
    if (!p || p.kind === 'rect') return;
    const prism = new THREE.Mesh(buildProfilePrism(axis, p, size), material);
    prism.updateMatrix();
    solid = CSG.intersect(solid, prism);
    solid.updateMatrix();
  });

  return solid;
}

function addFaceColorPatchesFromBody(params: {
  group: THREE.Group;
  body: THREE.Mesh;
  colors: CubieOptions['colors'];
  size: number;
}) {
  const { group, body, colors, size } = params;
  const half = size / 2;

  // These patches are thin solid "stickers" created by intersecting the body with a thin slab near each face.
  // They are then nudged outward slightly to avoid z-fighting.
  const cover = size * 1.2;
  const thickness = size * 0.02;
  const offset = size * 0.002;

  const faceDefs: Array<{
    key: keyof CubieOptions['colors'];
    slabSize: [number, number, number];
    slabPos: [number, number, number];
    normal: [number, number, number];
  }> = [
    { key: 'Top',    slabSize: [cover, thickness, cover], slabPos: [0,  half - thickness / 2, 0], normal: [0, 1, 0] },
    { key: 'Bottom', slabSize: [cover, thickness, cover], slabPos: [0, -half + thickness / 2, 0], normal: [0, -1, 0] },
    { key: 'Front',  slabSize: [cover, cover, thickness], slabPos: [0, 0,  half - thickness / 2], normal: [0, 0, 1] },
    { key: 'Back',   slabSize: [cover, cover, thickness], slabPos: [0, 0, -half + thickness / 2], normal: [0, 0, -1] },
    { key: 'Left',   slabSize: [thickness, cover, cover], slabPos: [-half + thickness / 2, 0, 0], normal: [-1, 0, 0] },
    { key: 'Right',  slabSize: [thickness, cover, cover], slabPos: [ half - thickness / 2, 0, 0], normal: [1, 0, 0] }
  ];

  body.updateMatrix();

  faceDefs.forEach(f => {
    const c = colors[f.key];
    if (c === undefined) return;

    const slab = new THREE.Mesh(new THREE.BoxGeometry(...f.slabSize), body.material);
    slab.position.set(f.slabPos[0], f.slabPos[1], f.slabPos[2]);
    slab.updateMatrix();

    const patch = CSG.intersect(body, slab);
    patch.material = createPhysicalMaterial(c, true);
    patch.geometry.computeVertexNormals();
    patch.geometry.translate(f.normal[0] * offset, f.normal[1] * offset, f.normal[2] * offset);
    group.add(patch);
  });
}

interface CubieOptions {
  id: string;
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  slot?: { x: number, y: number, z: number, q?: THREE.Quaternion };
  /**
   * Legacy uniform rounding radius (applies to all axes).
   * Prefer `radiusX`/`radiusY`/`radiusZ` for per-axis control.
   */
  radius?: number;
  /** Rounding radius along the X axis (controls X inset; used by edges/corners touching X). */
  radiusX?: number;
  /** Rounding radius along the Y axis (controls Y inset; used by edges/corners touching Y). */
  radiusY?: number;
  /** Rounding radius along the Z axis (controls Z inset; used by edges/corners touching Z). */
  radiusZ?: number;
  /**
   * Optional: generate the *plastic body* as a solid mesh by intersecting per-axis cross-section profiles.
   *
   * This is what you want for shapes like "D in 2 axes" (apply one profile, then "roll" and apply another),
   * which the legacy edge/corner patch system cannot represent.
   *
   * Notes:
   * - When provided, we render a solid plastic body and skip the legacy patch edges/corners/faces.
   * - `colors.Plastic` is still respected; face colors are applied as thin "sticker" patches clipped to the body.
   */
  profiles?: BodyProfiles;
  activeEdges: boolean[]; // Order: [TL, TF, TR, TB, BL, BF, BR, BB, MFL, MFR, MBL, MBR]
  colors: {
    Top?: number;
    Bottom?: number;
    Front?: number;
    Back?: number;
    Left?: number;
    Right?: number;
    Plastic?: number;
  }
}

/**
 * Modernized Cubie Assembly Function
 */
function createCubie(opt: CubieOptions) {
  const x = opt.slot ? opt.slot.x : (opt.x ?? 0);
  const y = opt.slot ? opt.slot.y : (opt.y ?? 0);
  const z = opt.slot ? opt.slot.z : (opt.z ?? 0);
  
  const { radius, radiusX, radiusY, radiusZ, profiles, activeEdges, colors } = opt;
  const half = cubieSize / 2;
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const rX = clamp(radiusX ?? radius ?? 0, 0, half);
  const rY = clamp(radiusY ?? radius ?? 0, 0, half);
  const rZ = clamp(radiusZ ?? radius ?? 0, 0, half);

  const innerX = half - rX;
  const innerY = half - rY;
  const innerZ = half - rZ;

  const cubieGroup = new THREE.Group();
  cubieGroup.userData.pieceId = opt.id;
  cubieGroup.userData.baseColors = opt.colors;

  cubieGroup.position.set(x * cubieSize * SPACING, y * cubieSize * SPACING, z * cubieSize * SPACING);
  
  if (opt.slot?.q) {
    cubieGroup.quaternion.copy(opt.slot.q);
  } else {
    cubieGroup.rotation.set(opt.rx ?? 0, opt.ry ?? 0, opt.rz ?? 0);
  }

  // Store initial transform for Reset State
  (cubieGroup as any)._initialTransform = {
    position: cubieGroup.position.clone(),
    quaternion: cubieGroup.quaternion.clone()
  };

  cubies.push(cubieGroup);

  const plasticMat = createPhysicalMaterial(colors.Plastic ?? 0x111111);

  // --- Solid/profile mode (for "D in 2 axes" and other stacked profile constraints) ---
  if (profiles && (profiles.x || profiles.y || profiles.z)) {
    const body = buildSolidBodyFromProfiles(profiles, plasticMat, cubieSize);
    body.geometry.computeVertexNormals();
    cubieGroup.add(body);
    addFaceColorPatchesFromBody({ group: cubieGroup, body, colors, size: cubieSize });
    mainCubeGroup.add(cubieGroup);
    return;
  }

  // 1. Render 12 Edges
  const EPS = 0.000001;
  const thetaStartForQuadrant = (lx: 1 | -1, lz: 1 | -1) => {
    if (lx === 1 && lz === 1) return 0;
    if (lx === -1 && lz === 1) return Math.PI / 2;
    if (lx === -1 && lz === -1) return Math.PI;
    return (Math.PI * 3) / 2; // (1, -1)
  };

  const edgeConfigs: Array<{ a: boolean; axis: 'x' | 'y' | 'z'; sx: -1 | 0 | 1; sy: -1 | 0 | 1; sz: -1 | 0 | 1 }> = [
    { a: activeEdges[0], axis: 'z', sx: -1, sy: 1,  sz: 0 }, // TL (x-, y+, along z)
    { a: activeEdges[1], axis: 'x', sx: 0,  sy: 1,  sz: 1 }, // TF (y+, z+, along x)
    { a: activeEdges[2], axis: 'z', sx: 1,  sy: 1,  sz: 0 }, // TR (x+, y+, along z)
    { a: activeEdges[3], axis: 'x', sx: 0,  sy: 1,  sz: -1 }, // TB (y+, z-, along x)
    { a: activeEdges[4], axis: 'z', sx: -1, sy: -1, sz: 0 }, // BL (x-, y-, along z)
    { a: activeEdges[5], axis: 'x', sx: 0,  sy: -1, sz: 1 }, // BF (y-, z+, along x)
    { a: activeEdges[6], axis: 'z', sx: 1,  sy: -1, sz: 0 }, // BR (x+, y-, along z)
    { a: activeEdges[7], axis: 'x', sx: 0,  sy: -1, sz: -1 }, // BB (y-, z-, along x)
    { a: activeEdges[8], axis: 'y', sx: -1, sy: 0,  sz: 1 }, // MFL (x-, z+, along y)
    { a: activeEdges[9], axis: 'y', sx: 1,  sy: 0,  sz: 1 }, // MFR (x+, z+, along y)
    { a: activeEdges[10], axis: 'y', sx: -1, sy: 0,  sz: -1 }, // MBL (x-, z-, along y)
    { a: activeEdges[11], axis: 'y', sx: 1,  sy: 0,  sz: -1 }  // MBR (x+, z-, along y)
  ];

  edgeConfigs.forEach(e => {
    if (!e.a) return;

    const length = e.axis === 'x' ? cubieSize - rX * 2 : e.axis === 'y' ? cubieSize - rY * 2 : cubieSize - rZ * 2;
    if (length <= EPS) return;

    // Perpendicular (world) radii for the edge axis
    const rA = e.axis === 'x' ? rY : rX; // first perpendicular axis (Y for X-edges, X for Y/Z-edges)
    const rB = e.axis === 'z' ? rY : rZ; // second perpendicular axis (Y for Z-edges, Z for X/Y-edges)
    if (rA <= EPS || rB <= EPS) return;

    // Map desired world quadrant (signs) to the cylinder's local quadrant (x/z),
    // taking into account the fixed rotations we apply per axis.
    const sx = e.sx as -1 | 1;
    const sy = e.sy as -1 | 1;
    const sz = e.sz as -1 | 1;

    const [lx, lz] =
      e.axis === 'y'
        ? [sx, sz] // world (x, z)
        : e.axis === 'x'
          ? [(-sy) as -1 | 1, sz] // world (y, z) -> local (x, z) with x inverted
          : [sx, (-sy) as -1 | 1]; // world (x, y) -> local (x, z) with y mapped to -z

    const thetaStart = thetaStartForQuadrant(lx, lz);
    const g = new THREE.CylinderGeometry(1, 1, length, 32, 1, true, thetaStart, Math.PI / 2);
    const m = new THREE.Mesh(g, plasticMat);

    // Orient cylinder axis to the edge axis. CylinderGeometry's axis is local +Y.
    if (e.axis === 'x') m.rotation.z = -Math.PI / 2;
    else if (e.axis === 'z') m.rotation.x = Math.PI / 2;

    // Scale radius per axis (local x/z) while keeping length in geometry height.
    if (e.axis === 'x') m.scale.set(rY, 1, rZ);
    else if (e.axis === 'y') m.scale.set(rX, 1, rZ);
    else m.scale.set(rX, 1, rY); // axis === 'z'

    const px = e.sx === 0 ? 0 : e.sx * innerX;
    const py = e.sy === 0 ? 0 : e.sy * innerY;
    const pz = e.sz === 0 ? 0 : e.sz * innerZ;
    m.position.set(px, py, pz);
    cubieGroup.add(m);
  });

  // 2. Render 8 Corners
  const cornerConfigs = [
    { sx: 1,  sy: 1,  sz: 1,  phi: Math.PI/2,   t: 0,         e: [activeEdges[1], activeEdges[2], activeEdges[9]] },  // TFR
    { sx: 1,  sy: 1,  sz: -1, phi: Math.PI,     t: 0,         e: [activeEdges[3], activeEdges[2], activeEdges[11]] }, // TBR
    { sx: -1, sy: 1,  sz: -1, phi: Math.PI*1.5, t: 0,         e: [activeEdges[3], activeEdges[0], activeEdges[10]] }, // TBL
    { sx: -1, sy: 1,  sz: 1,  phi: Math.PI*2,   t: 0,         e: [activeEdges[1], activeEdges[0], activeEdges[8]] },  // TFL
    { sx: 1,  sy: -1, sz: 1,  phi: Math.PI*0.5, t: Math.PI/2, e: [activeEdges[5], activeEdges[6], activeEdges[9]] },  // BFR
    { sx: 1,  sy: -1, sz: -1, phi: Math.PI,     t: Math.PI/2, e: [activeEdges[7], activeEdges[6], activeEdges[11]] }, // BBR
    { sx: -1, sy: -1, sz: -1, phi: Math.PI*1.5, t: Math.PI/2, e: [activeEdges[7], activeEdges[4], activeEdges[10]] }, // BBL
    { sx: -1, sy: -1, sz: 1,  phi: Math.PI*2,   t: Math.PI/2, e: [activeEdges[5], activeEdges[4], activeEdges[8]] }   // BFL
  ];

  cornerConfigs.forEach(c => {
    if (rX <= EPS || rY <= EPS || rZ <= EPS) return;

    // Corner edge flags map to which coordinate should be rounded:
    // - e[0] controls Z (it sits at z = ±innerZ)
    // - e[1] controls X (it sits at x = ±innerX)
    // - e[2] controls Y (it sits at y = ±innerY)
    const roundZ = c.e[0];
    const roundX = c.e[1];
    const roundY = c.e[2];

    const g = new THREE.SphereGeometry(1, 32, 32, c.phi, Math.PI/2, c.t, Math.PI/2);
    const m = new THREE.Mesh(g, plasticMat);

    const COLLAPSE = 0.001;
    m.scale.set(
      rX * (roundX ? 1 : COLLAPSE),
      rY * (roundY ? 1 : COLLAPSE),
      rZ * (roundZ ? 1 : COLLAPSE)
    );

    m.position.set(
      c.sx * (roundX ? innerX : half),
      c.sy * (roundY ? innerY : half),
      c.sz * (roundZ ? innerZ : half)
    );

    cubieGroup.add(m);
  });

  // 3. Render 6 Faces
  const faceConfigs = [
    { ax: 'y', s: 1,  c: colors.Top ?? 0x111111,    e: [activeEdges[0], activeEdges[2], activeEdges[3], activeEdges[1]] },
    { ax: 'y', s: -1, c: colors.Bottom ?? 0x111111, e: [activeEdges[4], activeEdges[6], activeEdges[7], activeEdges[5]] },
    { ax: 'z', s: 1,  c: colors.Front ?? 0x111111,  e: [activeEdges[8], activeEdges[9], activeEdges[5], activeEdges[1]] },
    { ax: 'z', s: -1, c: colors.Back ?? 0x111111,   e: [activeEdges[10], activeEdges[11], activeEdges[7], activeEdges[3]] },
    { ax: 'x', s: -1, c: colors.Left ?? 0x111111,   e: [activeEdges[10], activeEdges[8], activeEdges[4], activeEdges[0]] },
    { ax: 'x', s: 1,  c: colors.Right ?? 0x111111,  e: [activeEdges[11], activeEdges[9], activeEdges[6], activeEdges[2]] }
  ];

  faceConfigs.forEach(f => {
    if (f.c === undefined) return;
    const faceMat = createPhysicalMaterial(f.c);
    const [innerD1, innerD2] =
      f.ax === 'y' ? [innerX, innerZ] :
      f.ax === 'z' ? [innerX, innerY] :
      [innerZ, innerY]; // f.ax === 'x' -> (z, y)

    // If there is *no* rounding along the face normal axis but there *is* rounding in the other two axes,
    // the correct cap is a rounded-rectangle (extruded profile) rather than a tiny plane.
    // Example: radiusY=0 with radiusX/radiusZ>0 should be a rounded-square prism (top/bottom caps are rounded squares).
    const rNormal = f.ax === 'x' ? rX : f.ax === 'y' ? rY : rZ;
    if (rNormal <= EPS) {
      const [rU, rV] =
        f.ax === 'y' ? [rX, rZ] :
        f.ax === 'z' ? [rX, rY] :
        [rZ, rY]; // f.ax === 'x' -> (u=z, v=y)

      if (rU > EPS && rV > EPS) {
        const shape = make2DShape({ kind: 'roundedRect', radiusU: rU, radiusV: rV }, half);
        const cap = new THREE.Mesh(new THREE.ShapeGeometry(shape, 64), faceMat);
        if (f.ax === 'y') { cap.position.set(0, f.s * half, 0); cap.rotation.x = Math.PI / 2; }
        else if (f.ax === 'z') { cap.position.set(0, 0, f.s * half); }
        else { cap.position.set(f.s * half, 0, 0); cap.rotation.y = Math.PI / 2; }
        cubieGroup.add(cap);
        return;
      }
    }

    const d1Min = f.e[0] ? -innerD1 : -half; const d1Max = f.e[1] ? innerD1 : half;
    const d2Min = f.e[2] ? -innerD2 : -half; const d2Max = f.e[3] ? innerD2 : half;

    const w = d1Max - d1Min;
    const h = d2Max - d2Min;

    // If there's no flat face area left (e.g., forming a cylinder), render a cap disc instead.
    if (w <= EPS && h <= EPS) {
      const cap = new THREE.Mesh(new THREE.CircleGeometry(1, 64), faceMat);
      if (f.ax === 'y') { cap.scale.set(rX, rZ, 1); cap.rotation.x = -Math.PI / 2; cap.position.set(0, f.s * half, 0); }
      else if (f.ax === 'z') { cap.scale.set(rX, rY, 1); cap.position.set(0, 0, f.s * half); }
      else { cap.scale.set(rZ, rY, 1); cap.rotation.y = Math.PI / 2; cap.position.set(f.s * half, 0, 0); }
      cubieGroup.add(cap);
      return;
    }

    if (w <= EPS || h <= EPS) return;

    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), faceMat);
    if (f.ax === 'y') { m.position.set((d1Min+d1Max)/2, f.s*half, (d2Min+d2Max)/2); m.rotation.x = Math.PI/2; }
    else if (f.ax === 'z') { m.position.set((d1Min+d1Max)/2, (d2Min+d2Max)/2, f.s*half); }
    else { m.position.set(f.s*half, (d2Min+d2Max)/2, (d1Min+d1Max)/2); m.rotation.y = Math.PI/2; }
    cubieGroup.add(m);
  });

  mainCubeGroup.add(cubieGroup);
}

// --- Scramble & Highlighting ---

function createArrowGeometry() {
  const shape = new THREE.Shape();
  // Simple arrow shape pointing up (+Y)
  shape.moveTo(0, 0.5);
  shape.lineTo(0.3, 0.2);
  shape.lineTo(0.1, 0.2);
  shape.lineTo(0.1, -0.3);
  shape.lineTo(-0.1, -0.3);
  shape.lineTo(-0.1, 0.2);
  shape.lineTo(-0.3, 0.2);
  shape.closePath();

  return new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
}

const arrowGeo = createArrowGeometry();
const arrowMat = new THREE.MeshPhysicalMaterial({ 
  color: 0x00ffff, 
  transparent: true, 
  opacity: 0.9, 
  emissive: 0x00ffff, 
  emissiveIntensity: 2,
  side: THREE.DoubleSide 
});

function updateHighlighter() {
  highlighterGroup.clear();
  if (scrambleIndex < 0 || scrambleIndex >= currentScramble.length) {
    $('#scramble-progress').text(scrambleIndex >= currentScramble.length ? 'Scramble Complete!' : '');
    return;
  }

  console.log(`Updating highlighter for move: ${currentScramble[scrambleIndex]}`);

  const moveStr = currentScramble[scrambleIndex];
  const faceChar = moveStr[0];
  const modifier = moveStr.substring(1);
  const faceInfo = FACE_MAP[faceChar];
  
  if (!faceInfo) return;

  // Create a container for this specific move's highlight
  const moveHighlight = new THREE.Group();
  
  // Put arrows slightly out so they aren't obscured by corners
  const dist = 1.8;
  moveHighlight.position.set(
    faceInfo.axis === 'x' ? faceInfo.value * dist : 0,
    faceInfo.axis === 'y' ? faceInfo.value * dist : 0,
    faceInfo.axis === 'z' ? faceInfo.value * dist : 0
  );

  // Rotate the group to face outwards from the cube face
  if (faceInfo.axis === 'x') {
    moveHighlight.rotation.y = (faceInfo.value > 0 ? 1 : -1) * Math.PI / 2;
  } else if (faceInfo.axis === 'y') {
    moveHighlight.rotation.x = (faceInfo.value > 0 ? -1 : 1) * Math.PI / 2;
  } else if (faceInfo.axis === 'z') {
    moveHighlight.rotation.y = (faceInfo.value > 0 ? 0 : 1) * Math.PI;
  }

  let isCCW = modifier === "'";
  let isDouble = modifier === "2";
  
  // Orbit radius (slightly larger than center piece, smaller than face corners)
  const curveRadius = 1.1;
  const numArrows = 4;
  
  for (let i = 0; i < numArrows; i++) {
    const arrow = new THREE.Mesh(arrowGeo, arrowMat);
    const stepAngle = (i / numArrows) * Math.PI * 2;
    
    // Position tangentially on the ring
    arrow.position.set(Math.cos(stepAngle) * curveRadius, Math.sin(stepAngle) * curveRadius, 0);
    
    // Rotate to point along the circle
    const tangentialRotation = stepAngle + (isCCW ? 0 : Math.PI);
    arrow.rotation.z = tangentialRotation;
    
    if (isDouble) {
      arrow.scale.set(1.5, 1.5, 1.5);
    }

    moveHighlight.add(arrow);
  }

  // Add a glowing ring behind the arrows
  const ringGeo = new THREE.TorusGeometry(curveRadius, 0.05, 16, 64);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.4 });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  moveHighlight.add(ring);

  highlighterGroup.add(moveHighlight);

  $('#scramble-progress').text(`Next move: ${moveStr} (${scrambleIndex + 1}/${currentScramble.length})`);
  
  // Highlight the current move in the scramble text
  const highlightedScramble = currentScramble.map((m, i) => 
    i === scrambleIndex ? `<span style="color: #0ff; font-weight: bold; text-decoration: underline;">${m}</span>` : m
  ).join(' ');
  $('#scramble-text').html(highlightedScramble);
}

/**
 * Fallback scramble generator for when cubing.js workers are blocked (e.g. file:// protocol)
 */
function getSimpleScramble(): string[] {
  const faces = ['U', 'D', 'L', 'R', 'F', 'B'];
  const modifiers = ['', "'", '2'];
  const scramble: string[] = [];
  let lastFace = '';
  
  for (let i = 0; i < 20; i++) {
    let face;
    do {
      face = faces[Math.floor(Math.random() * faces.length)];
    } while (face === lastFace);
    
    const modifier = modifiers[Math.floor(Math.random() * modifiers.length)];
    scramble.push(face + modifier);
    lastFace = face;
  }
  return scramble;
}

async function generateScramble() {
  try {
    // Try the official cubing.js generator first
    const scramble = await randomScrambleForEvent('3x3x3');
    currentScramble = scramble.toString().split(' ');
  } catch (e) {
    console.warn("cubing.js scramble failed (likely file:// protocol), using simple fallback.");
    currentScramble = getSimpleScramble();
  }
  
  scrambleIndex = 0;
  $('#scramble-display').show();
  updateHighlighter();
}

$('#generate-scramble').on('click', () => generateScramble());

// Initialize min2phase
try {
  min2phase.initFull();
} catch (e) {
  console.warn("min2phase init failed", e);
}

async function solveCube() {
  if (lastFacelets === SOLVED_STATE) {
    console.log("Cube is already solved!");
    return;
  }

  const solverType = $('#solver-type').val() as string;
  
  try {
    console.log(`Solving cube (${solverType}) with facelets:`, lastFacelets);
    
    if (solverType === 'cfop') {
      const solver = await CFOPSolver.create();
      const pattern = faceletsToPattern(lastFacelets);
      const steps = await solver.solve(pattern);
      
      let totalSolution: string[] = [];
      let displayHtml = '';
      
      steps.forEach(step => {
        if (step.moves && !step.moves.startsWith('//')) {
          const moveParts = step.moves.split(/\s+/).filter(m => m.trim().length > 0);
          totalSolution.push(...moveParts);
          displayHtml += `<div style="margin-bottom: 4px;"><strong>${step.name}:</strong> ${step.moves}</div>`;
        } else {
          displayHtml += `<div style="margin-bottom: 4px;"><strong>${step.name}:</strong> <span style="color: #888;">${step.moves}</span></div>`;
        }
      });

      currentScramble = totalSolution;
      scrambleIndex = 0;
      accumulatedMoveAmount = 0;
      
      $('#scramble-text').html(displayHtml || "Solution found");
      $('#scramble-display').show();
      console.log("CFOP Solution steps:", steps);
    } else {
      const solutionStr = min2phase.solve(lastFacelets);
      if (solutionStr.startsWith("Error")) {
        throw new Error(solutionStr);
      }
      
      currentScramble = solutionStr.trim().split(/\s+/);
      scrambleIndex = 0;
      accumulatedMoveAmount = 0;
      
      $('#scramble-text').text(solutionStr);
      $('#scramble-display').show();
      console.log("Solution found:", solutionStr);
    }
    
    updateHighlighter();
  } catch (e) {
    console.error("Solver failed", e);
    alert("Could not find a solution: " + e);
  }
}

$('#solve-cube').on('click', () => solveCube());

// --- Connection Handlers ---

function logToUIConsole(event: GanCubeEvent) {
  const body = document.getElementById('bt-console-body');
  if (!body) return;

  // Check toggles
  if (event.type === 'GYRO' && !($('#log-gyro').is(':checked'))) return;
  if (event.type === 'MOVE' && !($('#log-move').is(':checked'))) return;
  if (event.type === 'FACELETS' && !($('#log-facelets').is(':checked'))) return;

  const entry = document.createElement('div');
  entry.className = `console-entry type-${event.type}`;
  
  const timestamp = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ms = new Date().getMilliseconds().toString().padStart(3, '0');
  
  let details = '';
  if (event.type === 'MOVE') details = `: ${event.move}`;
  else if (event.type === 'FACELETS') details = `: ${event.facelets.substring(0, 10)}...`;
  else if (event.type === 'GYRO') details = `: Q(${event.quaternion.x.toFixed(2)}, ${event.quaternion.y.toFixed(2)}...)`;
  else if (event.type === 'BATTERY') details = `: ${event.batteryLevel}%`;
  else if (event.type === 'HARDWARE') details = `: ${event.hardwareName} v${event.hardwareVersion}`;

  entry.innerHTML = `<span class="timestamp">[${timestamp}.${ms}]</span><strong>${event.type}</strong>${details}`;
  
  body.appendChild(entry);
  
  // Limit entries
  while (body.children.length > 100) {
    body.removeChild(body.firstChild!);
  }
  
  // Auto-scroll to bottom
  body.scrollTop = body.scrollHeight;
}

$('#console-clear').on('click', () => {
  const body = document.getElementById('bt-console-body');
  if (body) body.innerHTML = '';
});

$('#console-copy').on('click', () => {
  const body = document.getElementById('bt-console-body');
  if (!body) return;
  const text = body.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('console-copy');
    if (btn) {
      const original = btn.innerText;
      btn.innerText = 'Copied!';
      setTimeout(() => btn.innerText = original, 1000);
    }
  });
});

async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type == "GYRO") {
    let { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    let quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();
    
    if (!basis) {
      const m = new THREE.Matrix4();
      m.lookAt(new THREE.Vector3(0, 0, 0), camera.position, camera.up);
      const targetQuat = new THREE.Quaternion().setFromRotationMatrix(m);
      basis = targetQuat.clone().multiply(quat.clone().conjugate());
    }
    
    cubeQuaternion.copy(basis.clone().multiply(quat));

    // Store velocity for prediction
    if (event.velocity) {
      // Rotate velocity vector by our basis to match world space
      const rawVel = new THREE.Vector3(event.velocity.x, event.velocity.z, -event.velocity.y);
      lastVelocity.copy(rawVel).multiplyScalar(Math.PI / 180); // convert deg/s to rad/s
    }
    
    lastGyroTimestamp = performance.now();
    
    $('#quaternion').val(`x: ${qx.toFixed(3)}, y: ${qy.toFixed(3)}, z: ${qz.toFixed(3)}, w: ${qw.toFixed(3)}`);
  }
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type == "MOVE") {
    console.log(`MOVE event received: ${event.move}, current state: ${timerState}`);
    if (timerState == "READY") {
      setTimerState("RUNNING");
    }
    console.log("Move recorded:", event.move);
    
    // Scramble progression logic
    if (scrambleIndex >= 0 && scrambleIndex < currentScramble.length) {
      const expectedMoveStr = currentScramble[scrambleIndex];
      const expectedFace = expectedMoveStr[0];
      const expectedMod = expectedMoveStr.substring(1);
      
      const moveFace = event.move[0];
      const moveMod = event.move.substring(1);

      if (moveFace === expectedFace) {
        // GAN cubes send singles (' or nothing)
        const amt = moveMod === "'" ? -1 : 1;
        accumulatedMoveAmount += amt;
        
        // Normalize accumulated to [-1, 0, 1, 2]
        // (x % n + n) % n is the standard way to handle negative modulo in JS
        let normalizedAcc = ((accumulatedMoveAmount % 4) + 4) % 4;
        if (normalizedAcc === 3) normalizedAcc = -1;

        let targetAmt = expectedMod === "'" ? -1 : (expectedMod === "2" ? 2 : 1);
        
        // Check if we reached the target orientation for this face
        let reached = false;
        if (targetAmt === 2) {
          reached = (normalizedAcc === 2);
        } else {
          reached = (normalizedAcc === targetAmt);
        }

        if (reached) {
          scrambleIndex++;
          accumulatedMoveAmount = 0;
          updateHighlighter();
        } else if (normalizedAcc === 0) {
          // They went back to start or did a full 360, reset progress for this move
          accumulatedMoveAmount = 0;
        }
      } else {
        // User moved a different face. We reset progress for the current expected move.
        accumulatedMoveAmount = 0;
      }
    }

    // Always push to queue first to maintain chronological order
    moveQueue.push(event.move);
    processQueue();
    
    lastMoves.push(event);
    if (timerState == "RUNNING") {
      solutionMoves.push(event);
    }
    if (lastMoves.length > 256) {
      lastMoves = lastMoves.slice(-256);
    }
    if (lastMoves.length > 10) {
      var skew = cubeTimestampCalcSkew(lastMoves);
      $('#skew').val(skew + '%');
    }
  }
}

async function handleFaceletsEvent(event: GanCubeEvent) {
  if (event.type == "FACELETS") {
    console.log("Facelets:", event.facelets);
    lastFacelets = event.facelets;
    
    // Auto-initialize the digital cube state on the first packet
    if (!cubeStateInitialized) {
      applyFacelets(event.facelets);
      cubeStateInitialized = true;
      console.log("Digital cube initialized from physical state");
    }

    if (event.facelets == SOLVED_STATE) {
      if (timerState == "RUNNING") {
        setTimerState("STOPPED");
      }
    }
  }
}

function handleCubeEvent(event: GanCubeEvent) {
  logToUIConsole(event);
  if (event.type === "MOVE") {
    console.log("Global MOVE event detected");
  }
  if (event.type != "GYRO")
    console.log("GanCubeEvent", event);
  if (event.type == "GYRO") {
    handleGyroEvent(event);
  } else if (event.type == "MOVE") {
    handleMoveEvent(event);
  } else if (event.type == "FACELETS") {
    handleFaceletsEvent(event);
  } else if (event.type == "BATTERY") {
    $('#batteryLevel').val(event.batteryLevel + '%');
  } else if (event.type == "DISCONNECT") {
    $('.info input').val('- n/a -');
    $('#connect').html('Connect');
    cubeStateInitialized = false;
  }
}

const customMacAddressProvider: MacAddressProvider = async (device, isFallbackCall): Promise<string | null> => {
  if (isFallbackCall) {
    const remembered = localStorage.getItem('lastCubeMac');
    if (remembered) return remembered;
    return prompt('Unable do determine cube MAC address!\nPlease enter MAC address manually:');
  } else {
    return typeof device.watchAdvertisements == 'function' ? null :
      prompt('Seems like your browser does not support Web Bluetooth watchAdvertisements() API. Enable following flag in Chrome:\n\nchrome://flags/#enable-experimental-web-platform-features\n\nor enter cube MAC address manually:');
  }
};

async function doConnect() {
  if (conn) {
    conn.disconnect();
    conn = null;
    $('#connect').html('Connect');
    $('.info input').val('- n/a -');
    return;
  }

  const lastName = localStorage.getItem('lastCubeName');
  let originalRequestDevice: any = null;

  try {
    // Hack to bypass the device picker if we already have permission for this device
    if (lastName && navigator.bluetooth && (navigator.bluetooth as any).getDevices) {
      originalRequestDevice = navigator.bluetooth.requestDevice;
      (navigator.bluetooth as any).requestDevice = async (options: any) => {
        const devices = await (navigator.bluetooth as any).getDevices();
        const matched = devices.find((d: any) => d.name === lastName);
        if (matched) {
          console.log("Bypassing picker, found permitted device:", lastName);
          return matched;
        }
        return originalRequestDevice.call(navigator.bluetooth, options);
      };
    }

    conn = await connectGanCube(customMacAddressProvider);
    
    // Restore original requestDevice immediately after the library calls it
    if (originalRequestDevice) {
      (navigator.bluetooth as any).requestDevice = originalRequestDevice;
    }

    conn.events$.subscribe(handleCubeEvent);
    await conn.sendCubeCommand({ type: "REQUEST_HARDWARE" });
    await conn.sendCubeCommand({ type: "REQUEST_FACELETS" });
    await conn.sendCubeCommand({ type: "REQUEST_BATTERY" });
    
    $('#deviceName').val(conn.deviceName);
    $('#deviceMAC').val(conn.deviceMAC);
    localStorage.setItem('lastCubeMac', conn.deviceMAC);
    localStorage.setItem('lastCubeName', conn.deviceName);
    $('#connect').html('Disconnect');
    
    console.log("Connected to cube:", conn.deviceName);
  } catch (e) {
    console.error("Connection failed", e);
    // Ensure restoration on error
    if (originalRequestDevice) {
      (navigator.bluetooth as any).requestDevice = originalRequestDevice;
    }
  }
}

$('#connect').on('click', () => doConnect());

// --- Auto-connect logic ---
// Check if we have permission for any devices already
async function checkRememberedDevices() {
  if (navigator.bluetooth && (navigator.bluetooth as any).getDevices) {
    try {
      const devices = await (navigator.bluetooth as any).getDevices();
      console.log("Found permitted devices:", devices.length);
      if (devices.length > 0) {
        const lastName = localStorage.getItem('lastCubeName');
        if (lastName) {
          const hasLast = devices.some((d: any) => d.name === lastName);
          if (hasLast) {
            console.log(`Bypass available for: ${lastName}`);
            $('#connect').html(`Auto-Reconnect to ${lastName}`);
          }
        }
      }
    } catch (e) {
      console.warn("getDevices failed", e);
    }
  }
}

checkRememberedDevices();

$('#reset-state').on('click', async () => {
  await conn?.sendCubeCommand({ type: "REQUEST_RESET" });
  
  // 1. Kill any active animations
  gsap.killTweensOf("*");

  // 2. Clear move queue and state
  moveQueue.length = 0;
  isProcessingQueue = false;
  cubeStateInitialized = false;

  // Clear scramble state
  scrambleIndex = -1;
  accumulatedMoveAmount = 0;
  currentScramble = [];
  $('#scramble-display').hide();
  highlighterGroup.clear();

  // 3. Reset all pieces
  cubies.forEach(cubie => {
    // If cubie was attached to a pivot, bring it back home first
    if (cubie.parent !== mainCubeGroup) {
      mainCubeGroup.attach(cubie);
    }

    const init = (cubie as any)._initialTransform;
    if (init) {
      cubie.position.copy(init.position);
      cubie.quaternion.copy(init.quaternion);
    }
  });

  // 4. Remove any temporary pivot groups from mainCubeGroup
  const pivots = mainCubeGroup.children.filter(c => !cubies.includes(c as THREE.Group));
  pivots.forEach(p => mainCubeGroup.remove(p));
});

$('#reset-gyro').on('click', async () => {
  basis = null;
});

// --- Timer Logic ---

function setTimerState(state: typeof timerState) {
  console.log(`Timer state transition: ${timerState} -> ${state}`);
  timerState = state;
  switch (state) {
    case "IDLE":
      stopLocalTimer();
      $('#timer').css('color', '#fff');
      break;
    case 'READY':
      setTimerValue(0);
      $('#timer').css('color', '#0f0');
      break;
    case 'RUNNING':
      solutionMoves = [];
      startLocalTimer();
      $('#timer').css('color', '#999');
      break;
    case 'STOPPED':
      stopLocalTimer();
      $('#timer').css('color', '#fff');
      if (solutionMoves.length > 0) {
        var fittedMoves = cubeTimestampLinearFit(solutionMoves);
        var firstMove = fittedMoves[0];
        var lastMove = fittedMoves[fittedMoves.length - 1];
        var duration = lastMove.cubeTimestamp! - firstMove.cubeTimestamp!;
        setTimerValue(duration);
        console.log(`Solve duration: ${duration}ms (based on ${fittedMoves.length} moves)`);
      } else {
        setTimerValue(0);
      }
      break;
  }
}

function setTimerValue(timestamp: number) {
  let t = makeTimeFromTimestamp(timestamp);
  $('#timer').html(`${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}`);
}

function startLocalTimer() {
  console.log("Starting local timer ticker...");
  const startTime = performance.now();
  localTimer = interval(30).subscribe(() => {
    setTimerValue(performance.now() - startTime);
  });
}

function stopLocalTimer() {
  localTimer?.unsubscribe();
  localTimer = null;
}

function activateTimer() {
  if (conn) {
    if (timerState == "IDLE" || timerState == "STOPPED") {
      setTimerState("READY");
    } else {
      setTimerState("IDLE");
    }
  }
}

$(document).on('keydown', (event) => {
  if (event.which == 32) { // Space
    if (event.originalEvent?.repeat) return;
    event.preventDefault();
    console.log("Space pressed, activating timer...");
    activateTimer();
  }
});

$('#cube-container').on('touchstart', () => {
  activateTimer();
});

const DEFAULT_COLORS = {
    Top: 0xffffff,
    Bottom: 0xffff00,
    Front: 0x00ff00,
    Back: 0x0000ff,
    Left: 0xffa500,
    Right: 0xff0000,
    Plastic: 0x111111
} satisfies CubieOptions['colors'];

var COLORS = {
  Top: DEFAULT_COLORS.Top,
  Bottom: DEFAULT_COLORS.Bottom,
  Front: DEFAULT_COLORS.Front,
  Back: DEFAULT_COLORS.Back,
  Left: DEFAULT_COLORS.Left,
  Right: DEFAULT_COLORS.Right,
  Plastic: DEFAULT_COLORS.Plastic
}

const SLOTS = {
  // Centers
  U: { x: 0, y: 1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
  D: { x: 0, y: -1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0)) },
  L: { x: -1, y: 0, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI * 0.5)) },
  R: { x: 1, y: 0, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI * 1.5)) },
  F: { x: 0, y: 0, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 0.5, 0, 0)) },
  B: { x: 0, y: 0, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI * 1.5, 0, 0)) },

  // Top Edges
  UF: { x: 0, y: 1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
  UL: { x: -1, y: 1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.5, 0)) },
  UB: { x: 0, y: 1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, 0)) },
  UR: { x: 1, y: 1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0)) },

  // Bottom Edges
  DF: { x: 0, y: -1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI)) },
  DL: { x: -1, y: -1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.5, Math.PI)) },
  DB: { x: 0, y: -1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, Math.PI)) },
  DR: { x: 1, y: -1, z: 0, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, Math.PI)) },

  // Mid Edges
  FR: { x: 1, y: 0, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI * 1.5)) },
  FL: { x: -1, y: 0, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.5, Math.PI * 1.5)) },
  BR: { x: 1, y: 0, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, Math.PI * 0.5)) },
  BL: { x: -1, y: 0, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, Math.PI * 1.5)) },

  // Top Corners
  UFR: { x: 1, y: 1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, 0)) },
  UBR: { x: 1, y: 1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, 0)) },
  UBL: { x: -1, y: 1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, 0)) },
  UFL: { x: -1, y: 1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.5, 0)) },

  // Bottom Corners
  DFR: { x: 1, y: -1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 0.5, Math.PI)) },
  DBR: { x: 1, y: -1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.0, Math.PI)) },
  DBL: { x: -1, y: -1, z: -1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI * 1.5, Math.PI)) },
  DFL: { x: -1, y: -1, z: 1, q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI)) },
} as const;

//Centers

// Top
createCubie({
  id: 'U',
  slot: SLOTS.U,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Top,
    Plastic: 0x111111
  }
});

// Bottom
createCubie({
  id: 'D',
  slot: SLOTS.D,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Bottom,
    Plastic: 0x111111
  }
});

// Left
createCubie({
  id: 'L',
  slot: SLOTS.L,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Left,
    Plastic: 0x111111
  }
});

// Right
createCubie({
  id: 'R',
  slot: SLOTS.R,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Right,
    Plastic: 0x111111
  }
});

// Front
createCubie({
  id: 'F',
  slot: SLOTS.F,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Front,
    Plastic: 0x111111
  }
});

// Back
createCubie({
  id: 'B',
  slot: SLOTS.B,
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  activeEdges: new Array(12).fill(true),
  colors: {
    Top: COLORS.Back,
    Plastic: 0x111111
  }
});


// Top Edges
// UF
createCubie({
  id: 'UF',
  slot: SLOTS.UF,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// UL
createCubie({
  id: 'UL',
  slot: SLOTS.UL,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// UB
createCubie({
  id: 'UB',
  slot: SLOTS.UB,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// UR
createCubie({
  id: 'UR',
  slot: SLOTS.UR,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Right,
    Plastic: DEFAULT_COLORS.Plastic
  }
});


// Bottom Edges
// DF
createCubie({
  id: 'DF',
  slot: SLOTS.DF,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DL
createCubie({
  id: 'DL',
  slot: SLOTS.DL,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DB
createCubie({
  id: 'DB',
  slot: SLOTS.DB,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DR
createCubie({
  id: 'DR',
  slot: SLOTS.DR,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Right,
    Plastic: DEFAULT_COLORS.Plastic
  }
});


// Mid Edges
// FR
createCubie({
  id: 'FR',
  slot: SLOTS.FR,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Right,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// FL
createCubie({
  id: 'FL',
  slot: SLOTS.FL,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Front,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// BR
createCubie({
  id: 'BR',
  slot: SLOTS.BR,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Right,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// BL
createCubie({
  id: 'BL',
  slot: SLOTS.BL,
  profiles: {
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Left,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});
// TOP CORNERS
// TFR
createCubie({
  id: 'UFR',
  slot: SLOTS.UFR,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Front,
    Right: DEFAULT_COLORS.Right,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TBR
createCubie({
  id: 'UBR',
  slot: SLOTS.UBR,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Right,
    Right: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TBL
createCubie({
  id: 'UBL',
  slot: SLOTS.UBL,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Back,
    Right: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TFL
createCubie({
  id: 'UFL',
  slot: SLOTS.UFL,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Left,
    Right: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// Bottom CORNERS
// DFR
createCubie({
  id: 'DFR',
  slot: SLOTS.DFR,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Right,
    Right: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DBR
createCubie({
  id: 'DBR',
  slot: SLOTS.DBR,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Back,
    Right: DEFAULT_COLORS.Right,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DBL
createCubie({
  id: 'DBL',
  slot: SLOTS.DBL,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Left,
    Right: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// DFL
createCubie({
  id: 'DFL',
  slot: SLOTS.DFL,
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Front,
    Right: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});











let lastFrameTime = performance.now();
function animate() {
  const currentTime = performance.now();
  const delta = (currentTime - lastFrameTime) / 1000;
  lastFrameTime = currentTime;

  requestAnimationFrame(animate);
  controls.update();
  
  if (mainCubeGroup) {
    // 1. Prediction: Extrapolate rotation using angular velocity
    // We only extrapolate for up to 100ms after the last packet to avoid drift
    const timeSinceLastPacket = (currentTime - lastGyroTimestamp) / 1000;
    if (timeSinceLastPacket < 0.1) {
      const axis = lastVelocity.clone().normalize();
      const speed = lastVelocity.length();
      if (speed > 0.001) {
        const stepQuat = new THREE.Quaternion().setFromAxisAngle(axis, speed * delta);
        cubeQuaternion.premultiply(stepQuat);
      }
    }

    // 2. Smoothing: Slerp towards our target
    mainCubeGroup.quaternion.slerp(cubeQuaternion, 0.35);

    // 3. Pulse Highlighter
    if (highlighterGroup.children.length > 0) {
      const pulse = 1.5 + Math.sin(currentTime * 0.01) * 0.5;
      highlighterGroup.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshPhysicalMaterial) {
          child.material.emissiveIntensity = pulse;
        }
      });
    }
  }
  
  renderer.render(scene, camera);
}
animate();
