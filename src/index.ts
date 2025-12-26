import './style.css'
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSG } from 'three-csg-ts';

// --- HMR Cleanup ---
document.getElementById('cube-container')?.querySelectorAll('canvas').forEach(c => c.remove());

// --- Setup ---
const scene = new THREE.Scene();
const container = document.getElementById('cube-container')!;
const camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
camera.position.set(3, 3, 3);
controls.update();

// Basic Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 5, 5);
scene.add(dirLight);

// --- Constants ---
const cubieSize = 1;

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

  const mkMat = (c: number) =>
    new THREE.MeshLambertMaterial({
      color: c,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    });

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
    patch.material = mkMat(c);
    patch.geometry.computeVertexNormals();
    patch.geometry.translate(f.normal[0] * offset, f.normal[1] * offset, f.normal[2] * offset);
    group.add(patch);
  });
}

interface CubieOptions {
  x: number;
  y: number;
  z: number;
  rx?: number;
  ry?: number;
  rz?: number;
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
  const { x, y, z, rx, ry, rz, radius, radiusX, radiusY, radiusZ, profiles, activeEdges, colors } = opt;
  const half = cubieSize / 2;
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const rX = clamp(radiusX ?? radius ?? 0, 0, half);
  const rY = clamp(radiusY ?? radius ?? 0, 0, half);
  const rZ = clamp(radiusZ ?? radius ?? 0, 0, half);

  const innerX = half - rX;
  const innerY = half - rY;
  const innerZ = half - rZ;
  const cubieGroup = new THREE.Group();
  cubieGroup.position.set(x * cubieSize * 1.05, y * cubieSize * 1.05, z * cubieSize * 1.05);
  cubieGroup.rotation.set(rx ?? 0, ry ?? 0, rz ?? 0);

  const plasticMat = new THREE.MeshLambertMaterial({ color: colors.Plastic ?? 0x111111, side: THREE.DoubleSide });

  // --- Solid/profile mode (for "D in 2 axes" and other stacked profile constraints) ---
  if (profiles && (profiles.x || profiles.y || profiles.z)) {
    const body = buildSolidBodyFromProfiles(profiles, plasticMat, cubieSize);
    body.geometry.computeVertexNormals();
    cubieGroup.add(body);
    addFaceColorPatchesFromBody({ group: cubieGroup, body, colors, size: cubieSize });
    scene.add(cubieGroup);
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
    const faceMat = new THREE.MeshLambertMaterial({ color: f.c, side: THREE.DoubleSide });
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

  scene.add(cubieGroup);
}

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
//Centers

// Top
createCubie({
  x: 0, y: 1, z: 0,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: 0, ry: 0, rz: 0,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Top,
    Plastic: 0x111111
  }
});

// Bottom
createCubie({
  x: 0, y: -1, z: 0,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: Math.PI, ry: 0, rz: 0,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Bottom,
    Plastic: 0x111111
  }
});


// Left
createCubie({
  x: -1, y: 0, z: 0,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: 0, ry: 0, rz: Math.PI*0.5,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Left,
    Plastic: 0x111111
  }
});

// Right
createCubie({
  x: 1, y: 0, z: 0,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: 0, ry: 0, rz: Math.PI*1.5,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Right,
    Plastic: 0x111111
  }
});

// Front
createCubie({
  x: 0, y: 0, z: 1,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: Math.PI*0.5, ry: 0, rz: 0,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Front,
    Plastic: 0x111111
  }
});

// Back
createCubie({
  x: 0, y: 0, z: -1,
  // Per-axis radius lets you form cylinders, e.g. (0.5, 0, 0.5) makes a Y-axis cylinder in a 1x1x1 cubie.
  radiusX: 0.5,
  radiusY: 0.0,
  radiusZ: 0.5,
  rx: Math.PI*1.5, ry: 0, rz: 0,
  activeEdges: [
    1,1,1,1, // Top: left, front, right, back
    1,1,1,1, // Bottom: left, front, right, back
    1,1,1,1  // Mid: front-left, front-right, back-left, back-right
  ].map(v => !!v),
  colors: {
    Top: COLORS.Back,
    Plastic: 0x111111
  }
});


// Top Edges
// TF
createCubie({
  x: 0, y: 1, z: 1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TL
createCubie({
  x: -1, y: 1, z: 0,
  rx: Math.PI*2, ry: Math.PI*1.5,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TL
createCubie({
  x: 0, y: 1, z: -1,
  rx: Math.PI*2, ry: Math.PI*1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TR
createCubie({
  x: 1, y: 1, z: 0,
  rx: Math.PI*2, ry: Math.PI/2,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Top,
    Front: DEFAULT_COLORS.Right,
    Plastic: DEFAULT_COLORS.Plastic
  }
});


// Bottom Edges
// BF
createCubie({
  x: 0, y: -1, z: 1,
  rx: Math.PI*0, ry: Math.PI*0, rz: Math.PI*1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TL
createCubie({
  x: -1, y: -1, z: 0,
  rx: Math.PI*2, ry: Math.PI*1.5, rz: Math.PI*1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TL
createCubie({
  x: 0, y: -1, z: -1,
  rx: Math.PI*2, ry: Math.PI*1, rz: Math.PI*1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// TR
createCubie({
  x: 1, y: -1, z: 0,
  rx: Math.PI*2, ry: Math.PI/2, rz: Math.PI*1,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: 1, y: 0, z: 1,
  rx: Math.PI*0, ry: Math.PI*0, rz: Math.PI*1.5,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Right,
    Front: DEFAULT_COLORS.Front,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// FL
createCubie({
  x: -1, y: 0, z: 1,
  rx: Math.PI*2, ry: Math.PI*1.5, rz: Math.PI*1.5,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Front,
    Front: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// BR
createCubie({
  x: 1, y: 0, z: -1,
  rx: Math.PI*2, ry: Math.PI*1, rz: Math.PI*0.5,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Right,
    Front: DEFAULT_COLORS.Back,
    Plastic: DEFAULT_COLORS.Plastic
  }
});

// BL
createCubie({
  x: -1, y: 0, z: -1,
  rx: Math.PI*2, ry: Math.PI*1, rz: Math.PI*1.5,
  profiles: {
    // "From the front" = looking along Z, so the silhouette lives in XY. Round the +Y side (the "top").
    y: { kind: 'd', radius: cubieSize / 2, roundSide: '+z' },    
    z: { kind: 'd', radius: cubieSize / 2, roundSide: '-y' }
  },
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: 1, y: 1, z: 1,
  rx: Math.PI*0, ry: Math.PI*0, rz: Math.PI*0,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: 1, y: 1, z: -1,
  rx: Math.PI*2, ry: Math.PI*0.5, rz: Math.PI*0,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: -1, y: 1, z: -1,
  rx: Math.PI*0, ry: Math.PI*1, rz: Math.PI*0,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: -1, y: 1, z: 1,
  rx: Math.PI*0, ry: Math.PI*1.5, rz: Math.PI*0,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: 1, y: -1, z: 1,
  rx: Math.PI*0, ry: Math.PI*0.5, rz: Math.PI*1,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: 1, y: -1, z: -1,
  rx: Math.PI*2, ry: Math.PI*1, rz: Math.PI*1,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: -1, y: -1, z: -1,
  rx: Math.PI*0, ry: Math.PI*1.5, rz: Math.PI*1,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
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
  x: -1, y: -1, z: 1,
  rx: Math.PI*0, ry: Math.PI*0, rz: Math.PI*1,
  // These are ignored in profile/solid mode today, but kept for API compatibility.
  activeEdges: new Array(12).fill(false),
  colors: { 
    Top: DEFAULT_COLORS.Bottom,
    Front: DEFAULT_COLORS.Front,
    Right: DEFAULT_COLORS.Left,
    Plastic: DEFAULT_COLORS.Plastic
  }
});











function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
