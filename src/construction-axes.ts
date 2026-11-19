import * as THREE from 'three';
import type { ConstructionAxis, Part, Project } from '../shared/types.ts';
import { modelVisibility } from '../shared/model-tree.ts';
import { axisComponentMatrix } from '../shared/assembly-motion.ts';

/** Component references follow a shared rigid move, not an individually exploded child. */
export function axisComponentTransform(axis: ConstructionAxis, parts: ReadonlyMap<string, Part>, meshes: ReadonlyMap<string, THREE.Mesh>): THREE.Matrix4 {
  return axisComponentMatrix(axis, id => {
    const part = parts.get(id), mesh = meshes.get(id);
    return part && mesh ? { part, matrix: mesh.matrixWorld } : undefined;
  });
}

interface AxisVisual { source: ConstructionAxis; group: THREE.Group; line: THREE.Line<THREE.BufferGeometry, THREE.LineDashedMaterial>; label: THREE.Sprite; texture: THREE.CanvasTexture }
export class ConstructionAxes {
  readonly root = new THREE.Group();
  private visuals = new Map<string, AxisVisual>();
  private selected?: string;
  load(project: Project): void {
    this.dispose(); this.selected = undefined;
    for (const source of project.model.constructionAxes ?? []) {
      const origin = new THREE.Vector3(...source.origin), direction = new THREE.Vector3(...source.direction);
      const geometry = new THREE.BufferGeometry().setFromPoints(source.extent.map(t => origin.clone().addScaledVector(direction, t)));
      const material = new THREE.LineDashedMaterial({ color: '#d99831', dashSize: 4, gapSize: 2, transparent: true, opacity: .8 });
      const line = new THREE.Line(geometry, material); line.computeLineDistances(); line.userData.axisId = source.id;
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 64; const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#242629df'; ctx.fillRect(0, 0, 512, 64); ctx.fillStyle = '#ffd16b'; ctx.font = '34px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(source.name, 256, 32, 490);
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
      label.position.copy(origin).addScaledVector(direction, (source.extent[0] + source.extent[1]) / 2); label.visible = false;
      const group = new THREE.Group(); group.add(line, label); this.root.add(group); this.visuals.set(source.id, { source, group, line, label, texture });
    }
  }
  select(id?: string): void { this.selected = id; }
  update(project: Project, meshes: ReadonlyMap<string, THREE.Mesh>, camera: THREE.PerspectiveCamera, height: number): void {
    this.root.visible = project.settings.showConstructionAxes !== false;
    const parts = new Map(project.model.parts.map(part => [part.id, part]));
    const visibility = modelVisibility(project);
    for (const visual of this.visuals.values()) {
      const axis = visual.source, selected = axis.id === this.selected;
      visual.group.visible = visibility.axes.get(axis.id) ?? false;
      visual.group.matrixAutoUpdate = false; visual.group.matrix.copy(axisComponentTransform(axis, parts, meshes));
      visual.group.updateMatrixWorld(true); visual.line.material.color.set(selected ? '#f48b21' : '#d99831'); visual.line.material.opacity = selected ? 1 : .8; visual.line.material.depthTest = !selected;
      visual.label.visible = selected;
      const labelWorld = visual.label.getWorldPosition(new THREE.Vector3()); const pixelsToWorld = 2 * camera.position.distanceTo(labelWorld) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(height, 1);
      visual.label.scale.set(180 * pixelsToWorld, 22.5 * pixelsToWorld, 1);
    }
  }
  pick(raycaster: THREE.Raycaster): string | undefined {
    if (!this.root.visible) return;
    const hits = raycaster.intersectObjects([...this.visuals.values()].filter(v => v.group.visible).map(v => v.line), false);
    return hits.length ? String(hits[0].object.userData.axisId) : undefined;
  }
  center(id: string): THREE.Vector3 | undefined {
    const visual = this.visuals.get(id); if (!visual) return;
    return new THREE.Vector3(...visual.source.origin).addScaledVector(new THREE.Vector3(...visual.source.direction), (visual.source.extent[0] + visual.source.extent[1]) / 2).applyMatrix4(visual.group.matrixWorld);
  }
  dispose(): void { for (const visual of this.visuals.values()) { visual.line.geometry.dispose(); visual.line.material.dispose(); visual.label.material.dispose(); visual.texture.dispose(); } this.root.clear(); this.visuals.clear(); }
}
