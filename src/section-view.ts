import * as THREE from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

interface SectionPart { source: THREE.Mesh; back: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; front: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>; cap: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> }
export class SectionView {
  readonly root = new THREE.Group();
  private parts: SectionPart[] = [];
  active = false;
  private size = 1;
  constructor(readonly plane: THREE.Plane) { this.root.visible = false; }
  load(meshes: Iterable<THREE.Mesh>): void {
    this.dispose();
    let index = 0;
    for (const source of meshes) {
      // Shader clipping normally discards a whole pixel; coverage preserves the cut at MSAA sample resolution.
      const base = new THREE.MeshBasicMaterial({ depthWrite: false, depthTest: false, colorWrite: false, alphaToCoverage: true, stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, clippingPlanes: [this.plane] });
      const backMaterial = base.clone(); backMaterial.side = THREE.BackSide; backMaterial.stencilFail = backMaterial.stencilZFail = backMaterial.stencilZPass = THREE.IncrementWrapStencilOp;
      const frontMaterial = base.clone(); frontMaterial.side = THREE.FrontSide; frontMaterial.stencilFail = frontMaterial.stencilZFail = frontMaterial.stencilZPass = THREE.DecrementWrapStencilOp; base.dispose();
      backMaterial.clippingPlanes = frontMaterial.clippingPlanes = [this.plane];
      const back = new THREE.Mesh(source.geometry, backMaterial), front = new THREE.Mesh(source.geometry, frontMaterial);
      back.matrixAutoUpdate = front.matrixAutoUpdate = false; back.renderOrder = front.renderOrder = 10 + index * 3;
      // Inverse ACES at the viewport exposure (0.95) preserves Bambu's displayed #ff5e00 cut color.
      const capColor = new THREE.Color().setRGB(1.2328740664, .0673313569, -.0161740182);
      const cap = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: capColor, side: THREE.DoubleSide, toneMapped: false, stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp }));
      cap.renderOrder = 11 + index * 3; cap.onAfterRender = renderer => renderer.clearStencil();
      for (const mesh of [back, front, cap]) { mesh.raycast = () => {}; this.root.add(mesh); }
      this.parts.push({ source, back, front, cap }); index++;
    }
  }
  update(bounds: THREE.Box3): void {
    this.size = Math.max(1, bounds.getSize(new THREE.Vector3()).length() * 2);
    const point = this.plane.projectPoint(bounds.getCenter(new THREE.Vector3()), new THREE.Vector3());
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
    for (const { source, back, front, cap } of this.parts) {
      const material = Array.isArray(source.material) ? source.material[0] : source.material;
      const visible = source.visible && material.opacity > .5;
      back.visible = front.visible = cap.visible = visible;
      back.matrix.copy(source.matrixWorld); front.matrix.copy(source.matrixWorld);
      cap.position.copy(point); cap.quaternion.copy(rotation); cap.scale.set(this.size, this.size, 1);
    }
    this.root.updateMatrixWorld(true);
  }
  dispose(): void { for (const part of this.parts) { part.back.material.dispose(); part.front.material.dispose(); part.cap.material.dispose(); part.cap.geometry.dispose(); } this.root.clear(); this.parts = []; }
}

/** Stencil helpers participate only in the scene pass, never in outline depth passes. */
export class SectionRenderPass extends RenderPass {
  constructor(scene: THREE.Scene, camera: THREE.Camera, private section: SectionView, private parts: () => Iterable<THREE.Mesh>) { super(scene, camera); }
  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean): void {
    this.section.root.visible = this.section.active;
    const ghosts = [...this.parts()].filter(mesh => mesh.visible && !Array.isArray(mesh.material) && mesh.material.transparent);
    ghosts.forEach(mesh => { mesh.visible = false; });
    try { super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive); } finally { this.section.root.visible = false; ghosts.forEach(mesh => { mesh.visible = true; }); }
  }
}
