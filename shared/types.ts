export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export interface Pose { position: Vec3; quaternion: Quaternion }
export type AxisReference = { axisId: string } | { origin: Vec3; direction: Vec3; partId?: string };
export interface MotionMembers { partIds?: string[]; groupIds?: string[] }
export interface RigidMotion extends MotionMembers { axis?: AxisReference; distance?: number; angleDegrees?: number; translation?: Vec3 }
export type CenterlineSegment = { kind: 'line'; to: Vec3 } | { kind: 'arc'; center: Vec3; normal: Vec3; angleDegrees: number };
export interface Centerline { partId: string; start: Vec3; segments: CenterlineSegment[] }
export interface FourBarArm extends MotionMembers { axis: AxisReference; joint: { point: Vec3; partId?: string } }
export interface FourBarMotion {
  kind: 'four-bar'; angleDegrees: number; input: FourBarArm; output: FourBarArm; coupler: MotionMembers; branch?: 'positive' | 'negative';
}
export type MotionTrack = FourBarMotion | (MotionMembers & { axis: AxisReference } & (
  | { kind: 'rotate'; angleDegrees: number }
  | { kind: 'follow-rotation'; angleDegrees: number; point: Vec3 }
  | { kind: 'path-through-axis'; path: Centerline; startDistance: number; endDistance: number; halfSpan: number }
));
export interface Camera { eye: Vec3; target: Vec3; up: Vec3; margin: number }
export interface GeometryRef { file: string; offset: number; vertices: number; triangles: number; normalsOffset?: number }
export interface Part {
  id: string; name: string; sourceName: string; objectName: string; objectId: string; path: string; sourceKey?: string; sourceObject: string;
  geometry: GeometryRef; home: Pose; bounds: [Vec3, Vec3]; color: string; material: number;
  sourceStatus: 'active' | 'removed'; initiallyAssembled: boolean;
  assemblyHome?: Pose;
  materialName?: string; materialId?: string; appearanceName?: string; appearanceId?: string;
  nativeToken?: string; occurrenceToken?: string;
  explosionOffset?: Vec3;
  nativeRevision?: string; nativeTransform?: number[];
}
export interface ConstructionAxis { id: string; name: string; sourceName?: string; componentPath: string; nativeToken: string; occurrenceToken?: string; origin: Vec3; direction: Vec3; extent: [number, number]; extentSource?: 'display-cache' | 'definition' | 'mirrored-definition' | 'component-bounds'; isExtended?: boolean; visible: boolean; partIds: string[] }
export interface ModelTreeNode { id: string; name: string; sourceName?: string; kind: 'object' | 'part' | 'axis'; partId?: string; axisId?: string; componentPath?: string; occurrenceToken?: string; children?: ModelTreeNode[]; visible?: boolean }
export interface FusionSource { kind: 'fusion'; fileId?: string; versionId?: string; version?: number; archiveFile: string; documentName: string; originOffset?: Vec3; contentScope?: 'brep-bodies-and-axes' }
export interface FusionImportMetrics { totalSeconds: number; meshSeconds: number; calculatedParts: number; reusedParts: number; archiveReused: boolean; sourceVersionReused?: boolean; openSeconds?: number; archiveSeconds?: number; identitySeconds?: number; bufferSeconds?: number; metadataSeconds?: number; axesSeconds?: number }
export interface Model { id: string; name: string; sourceFile: string; revision: number; importedAt: string; parts: Part[]; materials: string[]; materialNames?: string[]; constructionAxes?: ConstructionAxis[]; browserTree?: ModelTreeNode[]; source?: FusionSource; importMetrics?: FusionImportMetrics }
export type TargetKind = 'point' | 'part' | 'face' | 'band';
export interface SurfaceRegion { kind: 'face' | 'circle' | 'band' | 'brush'; triangles: number[]; center: Vec3; normal: Vec3; radius: number; axis: Vec3; width: number; clipPlanes?: { normal: Vec3; constant: number }[] }
export interface Anchor { partId: string; point: Vec3; normal: Vec3; target: TargetKind; triangle: number; barycentric?: Vec3; region?: SurfaceRegion; needsReview?: boolean }
export type NoteKind = 'clip' | 'glue' | 'screw' | 'remove' | 'text' | 'arrow' | 'circle' | 'rectangle' | 'pencil';
export interface Note { id: string; kind: NoteKind; text: string; color: string; background: string; size: number; anchors: Anchor[]; offset: [number, number]; hidden?: boolean }
export interface FrameLabels { showLabels: boolean; labelMode: 'auto' | 'object' | 'part'; labelFontSize: number; labelOffsets: Record<string, [number, number]>; hiddenLabels: string[] }
export interface Keyframe { id: string; name: string; kind: 'start' | 'transition' | 'end'; poses: Record<string, Pose>; hidden: string[]; xrayPartIds?: string[]; camera?: Camera; notes: Note[]; duration: number; passThrough?: boolean; incomingMotion?: MotionTrack[]; image?: string; labels?: FrameLabels }
export interface Subassembly { id: string; name: string; partIds: string[]; poses: Record<string, Pose>; sourceStepId?: string }
export interface AssemblyStep { id: string; name: string; partIds: string[]; groups: Subassembly[]; removePartIds: string[]; frames: Keyframe[]; final: boolean; description: string; inheritedFrom?: string; removalRestore?: Record<string, { start: Pose; end: Pose; endHidden: boolean }> }
export interface Settings { showLabels: boolean; labelMode: 'auto' | 'object' | 'part'; labelFontSize: number; showAxes: boolean; showConstructionAxes?: boolean; constructionAxisVisibility?: Record<string, boolean>; objectVisibility?: Record<string, boolean>; partVisibility?: Record<string, boolean>; showExplosionColumn: boolean; explodeObjects: boolean; playStrategy: 'sequential' | 'subassembly'; defaultDisplayMode?: DisplayMode; title: string; coverImage?: string; secondPageImage?: string; labelOffsets: Record<string, [number, number]>; hiddenLabels: string[] }
export interface Project { version: 1; id: string; name: string; revision: number; model: Model; steps: AssemblyStep[]; settings: Settings; updatedAt: string }
export type DisplayMode = 'all' | 'xray' | 'current';
export const DEFAULT_DISPLAY_MODE: DisplayMode = 'xray';
export function isDisplayMode(value: unknown): value is DisplayMode {
  return value === 'all' || value === 'xray' || value === 'current';
}
export interface LabelLayoutRequest { frameId: string; progress: number[] }
export interface SyncMatch { oldId: string; newId: string; reason: 'source-key' | 'path' | 'name' | 'geometry' | 'manual'; geometryChanged?: boolean }
export interface SyncPlan { id: string; baseRevision: number; model: Model; matches: SyncMatch[]; added: string[]; removed: string[]; unresolved: { newId: string; candidates: string[] }[]; replacesBaseline?: boolean; removedFromSteps?: { stepId: string; partIds: string[]; noteIds: string[] }[] }
export interface SessionState { stepId: string | null; frameId: string | null; selected: string[]; display: DisplayMode; explosion: number; section: number; sectionNormal?: Vec3; frameProgress?: number; playing: boolean }
export type Command =
  | { type: 'model.pose'; poses: Record<string, Pose> }
  | { type: 'step.add'; name?: string; after?: string; before?: string; inherit?: string; parts?: string[] }
  | { type: 'step.rename'; stepId: string; name: string }
  | { type: 'step.delete'; stepId: string }
  | { type: 'step.reorder'; stepId: string; before?: string }
  | { type: 'step.copy'; stepId: string; inherit?: boolean }
  | { type: 'step.merge'; stepIds: string[]; camera?: Camera }
  | { type: 'step.members'; stepId: string; partIds: string[] }
  | { type: 'step.group'; stepId: string; sourceStepId: string }
  | { type: 'step.final'; stepId: string; value: boolean }
  | { type: 'step.description'; stepId: string; text: string }
  | { type: 'part.rename'; partId: string; name: string }
  | { type: 'object.rename'; nodeId: string; name: string }
  | { type: 'axis.rename'; axisId: string; name: string }
  | { type: 'group.rename'; stepId: string; groupId: string; name: string }
  | { type: 'part.initial'; partIds: string[]; value: boolean }
  | { type: 'part.remove'; stepId: string; partIds: string[]; value: boolean }
  | { type: 'frame.add'; stepId: string; afterId: string; frameId?: string }
  | { type: 'frame.transform'; stepId: string; frameId: string; motions: RigidMotion[] }
  | { type: 'frame.motion'; stepId: string; frameId: string; motions: MotionTrack[]; alignStart?: boolean }
  | { type: 'frame.delete'; stepId: string; frameId: string }
  | { type: 'frame.update'; stepId: string; frameId: string; patch: Partial<Pick<Keyframe, 'poses' | 'hidden' | 'xrayPartIds' | 'camera' | 'duration' | 'name' | 'labels' | 'passThrough'>> & { image?: string | null } }
  | { type: 'frame.cameraAll'; stepId: string; camera: Camera }
  | { type: 'note.put'; stepId: string; frameId: string; note: Note }
  | { type: 'note.update'; stepId: string; frameId: string; noteId: string; patch: Partial<Pick<Note, 'text' | 'color' | 'background' | 'size' | 'offset' | 'hidden'>> }
  | { type: 'note.delete'; stepId: string; frameId: string; noteId: string }
  | { type: 'settings.update'; patch: Partial<Settings> };
